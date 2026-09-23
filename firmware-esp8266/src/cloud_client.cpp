#include "cloud_client.h"

#include <ArduinoJson.h>
#include <ESP8266WiFi.h>
#include <WebSocketsClient.h>

#include "board_config.h"
#include "channel_control.h"
#include "config_store.h"
#include "http_api.h"
#include "relay_hal.h"
#include "wifi_provisioning.h"

static WebSocketsClient s_ws;
static bool s_connected = false;
static bool s_started = false;
static uint32_t s_consecutiveFailures = 0;

// Exponential backoff, capped, plus jitter, applied here so a persistently
// unreachable backend must not keep retrying at a fixed short interval
// forever. Every failed attempt still costs up to WEBSOCKETS_TCP_TIMEOUT
// (platformio.ini) of stalled cooperative loop() — during a prolonged
// outage that tax is what actually degrades local LAN control, not the
// reconnect itself. Base/max chosen to keep the healthy case's reconnect
// latency unchanged (first attempt still ~4-9s) while a sustained outage
// backs off to at most once a minute.
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

// ------------------------------------------------ device-initiated forward

// Single in-flight slot for cloudClientForward() — ESP8266WebServer serves
// one client synchronously, so there is never more than one LAN request
// being forwarded at a time.
struct PendingForward {
  bool inFlight = false;
  bool resolved = false;
  char reqId[16] = {0};
  int status = 0;
  String body;
};
static PendingForward s_pending;
static uint32_t s_nextReqId = 1;

bool cloudClientForward(const char *method, const char *path, const char *bodyJson,
                         int *outStatus, String *outBody, uint32_t timeoutMs) {
  if (!s_connected || s_pending.inFlight) {
    return false;
  }

  snprintf(s_pending.reqId, sizeof(s_pending.reqId), "d-%lu", (unsigned long)(s_nextReqId++));
  s_pending.inFlight = true;
  s_pending.resolved = false;

  JsonDocument doc;
  doc["reqId"] = s_pending.reqId;
  doc["method"] = method;
  doc["path"] = path;
  if (bodyJson != nullptr && bodyJson[0] != '\0') {
    JsonDocument parsedBody;
    if (deserializeJson(parsedBody, bodyJson) == DeserializationError::Ok) {
      doc["body"] = parsedBody;
    }
  }
  String out;
  serializeJson(doc, out);
  s_ws.sendTXT(out);

  uint32_t start = millis();
  while (!s_pending.resolved && s_connected && (millis() - start) < timeoutMs) {
    s_ws.loop();
    delay(1); // yield — avoid a tight spin starving the WiFi/TCP stack
  }

  bool ok = s_pending.resolved;
  if (ok) {
    *outStatus = s_pending.status;
    *outBody = s_pending.body;
  }
  s_pending.inFlight = false;
  s_pending.resolved = false;
  return ok;
}

// ------------------------------------------------- backend-initiated frame

// Matches UriBraces("/api/channels/{}/state"): a single path segment
// between the fixed prefix and suffix. Small local copy of the same
// matcher http_api.cpp uses — kept private to each file rather than shared,
// same as the rest of this codebase's static-helper convention.
static bool extractChannelIdxForState(const String &path, String *segment) {
  static const char *kPrefix = "/api/channels/";
  static const char *kSuffix = "/state";
  size_t prefixLen = strlen(kPrefix);
  size_t suffixLen = strlen(kSuffix);
  if (path.length() <= prefixLen + suffixLen) return false;
  if (!path.startsWith(kPrefix) || !path.endsWith(kSuffix)) return false;
  String middle = path.substring(prefixLen, path.length() - suffixLen);
  if (middle.length() == 0 || middle.indexOf('/') != -1) return false;
  *segment = middle;
  return true;
}

static void sendReply(const char *reqId, int status, JsonVariant body) {
  JsonDocument reply;
  reply["reqId"] = reqId;
  reply["status"] = status;
  if (!body.isNull()) {
    reply["body"] = body;
  } else {
    reply["body"] = (char *)nullptr;
  }
  String out;
  serializeJson(reply, out);
  s_ws.sendTXT(out);
}

// Only three backend-initiated request paths exist: apply a channel state
// (the disclosed hardware-actuation exception — the device still owns its
// own relay hardware), device identity info, and device-local network reconfig (reachable here
// when the app uses a cloud transport instead of LAN). Every other /api/*
// path a LAN caller might hit is answered entirely server-side and never
// reaches the device at all (see docs/plan.md's wire protocol section).
static void handleBackendRequest(const char *reqId, const char *method, const char *path,
                                  JsonVariant body) {
  String p(path != nullptr ? path : "");
  String seg;

  if (strcmp(method, "POST") == 0 && extractChannelIdxForState(p, &seg)) {
    int idx = seg.toInt();
    const char *state = body["state"] | "";
    bool validState = strcmp(state, "ON") == 0 || strcmp(state, "OFF") == 0;
    if (idx < 0 || idx >= relayHalChannelCount() || !validState) {
      JsonDocument err;
      err["error"] = "invalid channel state request";
      sendReply(reqId, 400, err.as<JsonVariant>());
      return;
    }
    channelControlSetState((uint8_t)idx, strcmp(state, "ON") == 0);

    JsonDocument resp;
    resp["channel_idx"] = idx;
    resp["state"] = state;
    sendReply(reqId, 200, resp.as<JsonVariant>());
    return;
  }

  if (strcmp(method, "GET") == 0 && p == "/api/info") {
    JsonDocument info;
    deserializeJson(info, httpApiBuildInfo());
    sendReply(reqId, 200, info.as<JsonVariant>());
    return;
  }

  if (strcmp(method, "POST") == 0 && p == "/api/network") {
    String bodyStr;
    if (!body.isNull()) {
      serializeJson(body, bodyStr);
    }
    int status;
    String outBody;
    httpApiHandleNetworkConfig(bodyStr, &status, &outBody);

    JsonDocument parsed;
    JsonVariant replyBody;
    if (outBody.length() > 0 && deserializeJson(parsed, outBody) == DeserializationError::Ok) {
      replyBody = parsed.as<JsonVariant>();
    }
    sendReply(reqId, status, replyBody);

    // Same "respond, then reboot" ordering as http_api.cpp's local
    // /api/network handler — the reply above must actually reach the
    // backend before this device disappears off the WS to restart.
    if (status == 200) {
      delay(500);
      ESP.restart();
    }
    return;
  }

  // No other backend-initiated request path exists anymore — the device
  // holds no other config to mutate.
  JsonDocument err;
  err["error"] = "not found";
  sendReply(reqId, 404, err.as<JsonVariant>());
}

// New per-channel hardware-actuation config pushed by the backend, fire-
// and-forget, once right after auth on every connect and again whenever an
// admin edits one of these fields. This is the only config the device still
// caches locally (see config_store.h) — required for the instant/offline
// physical-input exception to work correctly.
static void handleHwConfigPush(JsonDocument &doc) {
  // The push is the complete picture: a channel it omits (e.g. its switch
  // was deleted server-side) goes back to DISABLED rather than keeping a
  // stale input mode.
  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    configStore.setChannelHw(i, "DISABLED", 0);
  }
  JsonArray channels = doc["channels"];
  for (JsonObject ch : channels) {
    int idx = ch["channelIdx"] | -1;
    if (idx < 0 || idx >= SS_CHANNEL_COUNT) continue;
    const char *inputMode = ch["inputMode"] | "DISABLED";
    uint32_t inchingMs = ch["inchingMs"] | 0;
    configStore.setChannelHw((uint8_t)idx, inputMode, inchingMs);
  }
  if (!doc["interlockEnabled"].isNull()) {
    configStore.setInterlockEnabled(doc["interlockEnabled"] | false);
  }
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
// cached view resyncs even if changes happened while offline. No config to
// publish anymore (the device owns none) — just replays lastState[], which
// channelControlSetState() keeps current on every change.
static void publishFullState() {
  const SsConfig &cfg = configStore.cfg();
  for (uint8_t i = 0; i < relayHalChannelCount(); i++) {
    cloudClientNotifyStateChanged(i, cfg.lastState[i]);
  }
}

static void handleIncomingFrame(uint8_t *payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length) != DeserializationError::Ok) {
    return;
  }

  const char *reqId = doc["reqId"] | (const char *)nullptr;
  if (reqId == nullptr) {
    const char *event = doc["event"] | (const char *)nullptr;
    if (event != nullptr && strcmp(event, "hw_config_push") == 0) {
      handleHwConfigPush(doc);
    }
    return;
  }

  if (!doc["status"].isNull()) {
    // A response to our own cloudClientForward() call.
    if (s_pending.inFlight && strcmp(reqId, s_pending.reqId) == 0) {
      s_pending.status = doc["status"] | 500;
      JsonVariant body = doc["body"];
      if (!body.isNull()) {
        String bodyOut;
        serializeJson(body, bodyOut);
        s_pending.body = bodyOut;
      } else {
        s_pending.body = "";
      }
      s_pending.resolved = true;
    }
    return;
  }

  const char *method = doc["method"] | (const char *)nullptr;
  const char *path = doc["path"] | (const char *)nullptr;
  if (method != nullptr && path != nullptr) {
    handleBackendRequest(reqId, method, path, doc["body"]);
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

bool cloudClientIsConnected() { return s_connected; }
