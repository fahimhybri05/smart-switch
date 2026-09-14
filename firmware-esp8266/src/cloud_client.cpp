#include "cloud_client.h"

#include <ArduinoJson.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <WebSocketsClient.h>

#include "board_config.h"
#include "config_store.h"
#include "relay_hal.h"
#include "wifi_provisioning.h"

static WebSocketsClient s_ws;
static bool s_connected = false;
static bool s_started = false;

// Proxies one relayed {reqId, method, path, body} command to this device's
// own already-running local HTTP server (127.0.0.1) and sends the real
// response back up the tunnel as {reqId, status, body}. No handler logic
// is duplicated — mirrors the ESP32 firmware's cloud_client design.
static void proxyAndReply(const char *reqId, const char *method, const char *path,
                           JsonVariant body) {
  String url = String("http://127.0.0.1") + path;

  WiFiClient client;
  HTTPClient http;
  http.begin(client, url);

  String bodyStr;
  if (!body.isNull()) {
    serializeJson(body, bodyStr);
    http.addHeader("Content-Type", "application/json");
  }

  int status;
  if (strcmp(method, "GET") == 0) {
    status = http.GET();
  } else if (strcmp(method, "POST") == 0) {
    status = http.POST(bodyStr);
  } else if (strcmp(method, "DELETE") == 0) {
    status = http.sendRequest("DELETE", bodyStr);
  } else {
    http.end();
    return;
  }

  String responseBody = status > 0 ? http.getString() : "";
  http.end();

  JsonDocument reply;
  reply["reqId"] = reqId;
  reply["status"] = status > 0 ? status : 0;
  if (responseBody.length() > 0) {
    JsonDocument parsed;
    if (deserializeJson(parsed, responseBody) == DeserializationError::Ok) {
      reply["body"] = parsed;
    } else {
      reply["body"] = (char *)nullptr;
    }
  } else {
    reply["body"] = (char *)nullptr;
  }

  String out;
  serializeJson(reply, out);
  s_ws.sendTXT(out);
}

static void sendAuthFrame() {
  const SsConfig &cfg = configStore.cfg();
  JsonDocument doc;
  doc["deviceId"] = cfg.device_id;
  doc["cloudSecret"] = cfg.cloud_secret;
  String out;
  serializeJson(doc, out);
  s_ws.sendTXT(out);
}

// On (re)connect, republish every channel's current state so the cloud's
// cached view resyncs even if changes happened while offline (spec §18).
static void publishFullState() {
  const SsConfig &cfg = configStore.cfg();
  for (uint8_t i = 0; i < cfg.switch_count; i++) {
    uint8_t idx = cfg.switches[i].channel_idx;
    cloudClientNotifyStateChanged(idx, relayHalGetState(idx));
  }
}

static void handleIncomingFrame(uint8_t *payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length) != DeserializationError::Ok) {
    return;
  }
  const char *reqId = doc["reqId"] | (const char *)nullptr;
  const char *method = doc["method"] | (const char *)nullptr;
  const char *path = doc["path"] | (const char *)nullptr;
  if (reqId != nullptr && method != nullptr && path != nullptr) {
    proxyAndReply(reqId, method, path, doc["body"]);
  }
}

static void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      s_connected = true;
      sendAuthFrame();
      publishFullState();
      break;
    case WStype_DISCONNECTED:
      s_connected = false;
      break;
    case WStype_TEXT:
      handleIncomingFrame(payload, length);
      break;
    default:
      break;
  }
}

void cloudClientBegin() {
  if (SS_CLOUD_WS_USE_TLS) {
    s_ws.beginSSL(SS_CLOUD_WS_HOST, SS_CLOUD_WS_PORT, SS_CLOUD_WS_PATH);
  } else {
    s_ws.begin(SS_CLOUD_WS_HOST, SS_CLOUD_WS_PORT, SS_CLOUD_WS_PATH);
  }
  s_ws.onEvent(onWsEvent);
  s_ws.setReconnectInterval(5000);
  s_started = true;
}

void cloudClientLoop() {
  if (!s_started || !wifiProvisioningIsConnected()) {
    return;
  }
  s_ws.loop();
}

void cloudClientNotifyStateChanged(uint8_t channelIdx, bool on) {
  if (!s_connected) {
    return;
  }
  JsonDocument doc;
  doc["event"] = "state_changed";
  doc["channelIdx"] = channelIdx;
  doc["state"] = on ? "ON" : "OFF";
  String out;
  serializeJson(doc, out);
  s_ws.sendTXT(out);
}
