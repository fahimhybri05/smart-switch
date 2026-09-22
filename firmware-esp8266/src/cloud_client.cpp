#include "cloud_client.h"

#include <ArduinoJson.h>
#include <ESP8266WiFi.h>
#include <WebSocketsClient.h>

#include "board_config.h"
#include "config_store.h"
#include "http_api.h"
#include "relay_hal.h"
#include "wifi_provisioning.h"

static WebSocketsClient s_ws;
static bool s_connected = false;
static bool s_started = false;
static uint32_t s_consecutiveFailures = 0;

// Exponential backoff, capped, plus jitter — same doubling-capped shape as
// http_auth.cpp's lockout backoff, applied here for the same reason: a
// persistently unreachable backend must not keep retrying at a fixed short
// interval forever. Every failed attempt still costs up to
// WEBSOCKETS_TCP_TIMEOUT (platformio.ini) of stalled cooperative loop() —
// during a prolonged outage that tax is what actually degrades local LAN
// control, not the reconnect itself. Base/max chosen to keep the healthy
// case's reconnect latency unchanged (first attempt still ~4-9s) while a
// sustained outage backs off to at most once a minute.
static const uint32_t kReconnectBaseMs = 4000;
static const uint32_t kReconnectMaxMs = 60000;

static uint32_t computeReconnectIntervalMs() {
  uint32_t shift = s_consecutiveFailures > 4 ? 4 : s_consecutiveFailures; // cap shift, avoid overflow
  uint32_t backoff = kReconnectBaseMs << shift; // 4s,8s,16s,32s,64s->capped below
  if (backoff > kReconnectMaxMs) {
    backoff = kReconnectMaxMs;
  }
  return backoff + secureRandom(0, 3000); // jitter, avoids fleet-wide lockstep retries
}

// Dispatches one relayed {reqId, method, path, body} command in-process
// (see http_api.h's httpApiDispatch()) and sends the real response back up
// the tunnel as {reqId, status, body}. No handler logic is duplicated —
// same overall shape as the ESP32 firmware's cloud_client design, but
// in-process rather than a loopback HTTP call: this chip has no RTOS, so a
// blocking loopback call to its own ESP8266WebServer would self-deadlock
// (handleClient() can't re-enter while this call blocks waiting on it in
// the same loop() iteration).
static void proxyAndReply(const char *reqId, const char *method, const char *path,
                           JsonVariant body) {
  String bodyStr;
  if (!body.isNull()) {
    serializeJson(body, bodyStr);
  }

  int status;
  String responseBody;
  httpApiDispatch(method, path, bodyStr.c_str(), &status, &responseBody);

  JsonDocument reply;
  reply["reqId"] = reqId;
  reply["status"] = status;
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
      s_consecutiveFailures = 0;
      sendAuthFrame();
      publishFullState();
      break;
    case WStype_DISCONNECTED:
      s_connected = false;
      s_consecutiveFailures++;
      s_ws.setReconnectInterval(computeReconnectIntervalMs());
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
  // Ping every 20s, allow 5s for a pong, disconnect (triggering the normal
  // reconnect path) after 2 consecutive misses — lets this device notice a
  // dead backend/NAT-dropped connection well before any OS-level timeout.
  s_ws.enableHeartbeat(20000, 5000, 2);
  s_ws.onEvent(onWsEvent);
  // Randomized once per boot (not per reconnect attempt) so every device in
  // the fleet doesn't retry in lockstep after a shared backend restart —
  // just needs to differ device-to-device. secureRandom() (hardware RNG,
  // no seeding needed) is already this codebase's convention for
  // randomness — see config_store.cpp's secret generation.
  uint32_t reconnectMs = secureRandom(4000, 9000);
  s_ws.setReconnectInterval(reconnectMs);
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
