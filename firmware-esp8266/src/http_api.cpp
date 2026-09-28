#include "http_api.h"

#include <ArduinoJson.h>
#include <uri/UriBraces.h>

#include "channel_control.h"
#include "cloud_client.h"
#include "config_store.h"
#include "local_schedule.h"
#include "local_web.h"
#include "recovery_button.h"
#include "relay_hal.h"
#include "wifi_provisioning.h"

ESP8266WebServer httpServer(80);

// The backend is authoritative for every /api/* decision now (see
// docs/plan.md's server-authoritative rewrite) — this device holds no
// config of its own to answer these from. Every route below (other than
// GET /, /api/wifi, GET /api/info, and POST /api/network's device-local
// network reconfig) is a thin call into httpApiForward(), which forwards the
// request to the backend over the cloud WS tunnel and blocks (bounded by a
// short timeout) for its response. No local password/auth check is applied
// here — a raw LAN request has no user identity to check against a
// JWT-based backend anyway; the trust boundary is "this request came from a
// device that already holds a valid, backend-issued cloud_secret" (checked
// at the WS auth-frame layer, not per-request here).

static String makeErrorBody(const char *message) {
  JsonDocument doc;
  doc["error"] = message;
  String out;
  serializeJson(doc, out);
  return out;
}

// Matches UriBraces("/api/channels/{}/state"): a single path segment
// between the fixed prefix and suffix. Used both to build the forwarded
// path from a live request's pathArg(0) and, inside httpApiForward(), to
// recognize the response that needs a local channelControlSetState() call.
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

// Bounded wait for the backend's response to a device-initiated forward —
// long enough for a normal round-trip, short enough that a physical-switch
// press landing during this window (this chip's single cooperative loop()
// blocks on this call) isn't delayed for long. See docs/plan.md's disclosed
// trade-off.
static const uint32_t kForwardTimeoutMs = 4000;

bool httpApiForward(const char *method, const char *path, const char *bodyJson,
                     int *outStatus, String *outBody) {
  if (!cloudClientIsConnected()) {
    *outStatus = 503;
    *outBody = makeErrorBody("cloud tunnel not connected");
    return false;
  }

  int status = 0;
  String body;
  if (!cloudClientForward(method, path, bodyJson, &status, &body, kForwardTimeoutMs)) {
    *outStatus = 504;
    *outBody = makeErrorBody("backend did not respond in time");
    return false;
  }

  // Apply a channel-state change locally BEFORE replying to the LAN
  // caller — the device still owns its own relay hardware; the backend's
  // job here is authorize + attribute, not touch GPIOs directly.
  String seg;
  if (strcmp(method, "POST") == 0 && status >= 200 && status < 300 &&
      extractChannelIdxForState(String(path), &seg)) {
    JsonDocument doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      const char *state = doc["state"] | "";
      if (strcmp(state, "ON") == 0) {
        channelControlSetState((uint8_t)seg.toInt(), true);
      } else if (strcmp(state, "OFF") == 0) {
        channelControlSetState((uint8_t)seg.toInt(), false);
      }
    }
  }

  *outStatus = status;
  *outBody = body;
  return true;
}

// -------------------------------------------------------- forwarded routes

static void forwardAndReply(const char *method, const String &path, const String &bodyJson) {
  int status;
  String body;
  httpApiForward(method, path.c_str(), bodyJson.c_str(), &status, &body);
  httpServer.send(status, "application/json", body);
}

// GET /api/info stays on-device: it's identity/runtime facts only this
// device knows (cloud_secret in plaintext, wifi_reconfig_state), and the
// app polls it during SoftAP provisioning, before any cloud link exists.
String httpApiBuildInfo() {
  const SsConfig &cfg = configStore.cfg();
  JsonDocument doc;
  doc["device_id"] = cfg.device_id;
  doc["board_type"] = cfg.board_type;
  doc["channel_count"] = relayHalChannelCount();
  doc["fw_version"] = cfg.fw_version;
  doc["wifi_reconfig_state"] = wifiReconfigStateStr(wifiProvisioningGetState());
  doc["cloud_secret"] = cfg.cloud_secret;
  JsonArray capabilities = doc["capabilities"].to<JsonArray>();
  capabilities.add("switch");
  String out;
  serializeJson(doc, out);
  return out;
}

static void handleGetInfo() { httpServer.send(200, "application/json", httpApiBuildInfo()); }

// ------------------------------------------------ local fallback (no cloud)
//
// The backend owns config/schedules, but when this device can't reach it a
// phone on the same LAN can still see and switch the relays: GET
// /api/config and /api/channels are answered from the device's own cache
// (names, input modes, live relay state) and channel commands are applied
// directly. `local_only: true` tells the app it's looking at this reduced,
// offline view. Edits (switches, schedules, settings) still need the
// backend and keep failing with 503 until the link is back.

static String buildLocalConfig() {
  const SsConfig &cfg = configStore.cfg();
  JsonDocument doc;
  doc["device_id"] = cfg.device_id;
  doc["name"] = cfg.device_id;
  doc["board_type"] = cfg.board_type;
  doc["channel_count"] = relayHalChannelCount();
  doc["channel_driver"] = cfg.channel_driver;
  doc["fw_version"] = cfg.fw_version;
  JsonArray switches = doc["switches"].to<JsonArray>();
  for (uint8_t i = 0; i < relayHalChannelCount(); i++) {
    JsonObject sw = switches.add<JsonObject>();
    sw["channel_idx"] = i;
    const SsChannelHw *hw = nullptr;
    for (uint8_t j = 0; j < cfg.channelHwCount; j++) {
      if (cfg.channelHw[j].channel_idx == i) { hw = &cfg.channelHw[j]; break; }
    }
    sw["name"] = hw != nullptr ? hw->name : "";
    sw["zone"] = "";
    sw["type"] = "ON_OFF";
    sw["default_boot_state"] = "OFF";
    sw["input_mode"] = hw != nullptr ? hw->inputMode : "DISABLED";
    sw["inching_ms"] = hw != nullptr ? hw->inchingMs : 0;
    sw["locked"] = false;
  }
  doc["schedules"].to<JsonArray>(); // backend-owned — unknown offline
  doc["utc_offset_min"] = localClockTzOffsetMin();
  doc["interlock_enabled"] = cfg.interlockEnabled;
  doc["local_only"] = true;
  String out;
  serializeJson(doc, out);
  return out;
}

static String buildLocalChannels() {
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (uint8_t i = 0; i < relayHalChannelCount(); i++) {
    JsonObject c = arr.add<JsonObject>();
    c["channel_idx"] = i;
    c["state"] = relayHalGetState(i) ? "ON" : "OFF";
  }
  String out;
  serializeJson(doc, out);
  return out;
}

static void handleGetConfig() {
  if (!cloudClientIsConnected()) {
    httpServer.send(200, "application/json", buildLocalConfig());
    return;
  }
  forwardAndReply("GET", "/api/config", "");
}

static void handlePostSwitches() {
  forwardAndReply("POST", "/api/switches", httpServer.arg("plain"));
}

static void handleDeleteSwitch() {
  forwardAndReply("DELETE", "/api/switches/" + httpServer.pathArg(0), "");
}

static void handleGetChannels() {
  if (!cloudClientIsConnected()) {
    httpServer.send(200, "application/json", buildLocalChannels());
    return;
  }
  forwardAndReply("GET", "/api/channels", "");
}

static void handlePostChannelState() {
  if (!cloudClientIsConnected()) {
    // Offline LAN control — same "device owns its relays" exception as a
    // physical wall switch: backend-only lock/min-off rules can't be
    // checked, so they don't apply here.
    String arg = httpServer.pathArg(0);
    int idx = arg.toInt();
    JsonDocument doc;
    bool okBody = deserializeJson(doc, httpServer.arg("plain")) == DeserializationError::Ok;
    const char *state = okBody ? (doc["state"] | "") : "";
    bool validState = strcmp(state, "ON") == 0 || strcmp(state, "OFF") == 0;
    if (arg.length() == 0 || idx < 0 || idx >= relayHalChannelCount() || !validState) {
      httpServer.send(400, "application/json", makeErrorBody("invalid channel state request"));
      return;
    }
    channelControlSetState((uint8_t)idx, strcmp(state, "ON") == 0);
    JsonDocument resp;
    resp["channel_idx"] = idx;
    resp["state"] = state;
    String out;
    serializeJson(resp, out);
    httpServer.send(200, "application/json", out);
    return;
  }
  forwardAndReply("POST", "/api/channels/" + httpServer.pathArg(0) + "/state",
                   httpServer.arg("plain"));
}

static void handlePostSchedules() {
  forwardAndReply("POST", "/api/schedules", httpServer.arg("plain"));
}

static void handleDeleteSchedule() {
  forwardAndReply("DELETE", "/api/schedules/" + httpServer.pathArg(0), "");
}

static void handlePostAuthPassword() {
  forwardAndReply("POST", "/api/auth/password", httpServer.arg("plain"));
}

static void handlePostTimezone() {
  forwardAndReply("POST", "/api/timezone", httpServer.arg("plain"));
}

static void handlePostSettings() {
  forwardAndReply("POST", "/api/settings", httpServer.arg("plain"));
}

// ------------------------------------------------------------- POST /api/network
//
// {"mode":"static", "ip":..., "gateway":..., "subnet":..., "dns":...} or
// {"mode":"dhcp"}. Persists via configStore, then reboots so
// wifiProvisioningBegin() applies it cleanly at the next connect — mirrors
// the ESP32 firmware's equivalent. Kept fully local/never forwarded (see
// http_api.h) — genuine device-local network reconfiguration, unrelated to
// the backend's business-logic decisions.

void httpApiHandleNetworkConfig(const String &bodyJson, int *outStatus, String *outBody) {
  JsonDocument doc;
  if (deserializeJson(doc, bodyJson) != DeserializationError::Ok) {
    *outStatus = 400;
    *outBody = makeErrorBody("invalid JSON");
    return;
  }
  const char *mode = doc["mode"] | "";
  if (strcmp(mode, "dhcp") != 0 && strcmp(mode, "static") != 0) {
    *outStatus = 400;
    *outBody = makeErrorBody("expected {\"mode\":\"static\"|\"dhcp\", ...}");
    return;
  }

  if (strcmp(mode, "dhcp") == 0) {
    configStore.setStaticIp(false, nullptr, nullptr, nullptr, nullptr);
  } else {
    const char *ip = doc["ip"] | "";
    const char *gateway = doc["gateway"] | "";
    const char *subnet = doc["subnet"] | "";
    const char *dns = doc["dns"] | "";
    if (strlen(ip) == 0 || strlen(gateway) == 0 || strlen(subnet) == 0) {
      *outStatus = 400;
      *outBody = makeErrorBody("static mode requires \"ip\", \"gateway\", \"subnet\"");
      return;
    }
    configStore.setStaticIp(true, ip, gateway, subnet, dns);
  }

  *outStatus = 200;
  *outBody = "{\"ok\":true,\"rebooting\":true}";
}

static void handlePostNetwork() {
  int status;
  String body;
  httpApiHandleNetworkConfig(httpServer.arg("plain"), &status, &body);
  httpServer.send(status, "application/json", body);
  if (status == 200) {
    delay(500);
    ESP.restart();
  }
}

// ----------------------------------------------- POST /api/reboot, /factory-reset
//
// Device-local maintenance, never forwarded. Factory reset requires
// {"confirm":"FACTORY_RESET"} so a stray/replayed request can't wipe the
// device. Both reply 202 first and act ~800ms later.

bool httpApiHandleMaintenance(const char *method, const String &path, const String &bodyJson,
                               int *outStatus, String *outBody) {
  if (strcmp(method, "POST") != 0) return false;
  if (path == "/api/reboot") {
    recoveryRequestReboot(800);
    *outStatus = 202;
    *outBody = "{\"ok\":true,\"rebooting\":true}";
    return true;
  }
  if (path == "/api/factory-reset") {
    JsonDocument doc;
    bool ok = deserializeJson(doc, bodyJson) == DeserializationError::Ok &&
              strcmp(doc["confirm"] | "", "FACTORY_RESET") == 0;
    if (!ok) {
      *outStatus = 400;
      *outBody = makeErrorBody("send {\"confirm\":\"FACTORY_RESET\"} to confirm");
      return true;
    }
    recoveryRequestFactoryReset(800);
    *outStatus = 202;
    *outBody = "{\"ok\":true,\"resetting\":true}";
    return true;
  }
  return false;
}

static void handleMaintenance(const char *path) {
  int status;
  String body;
  httpApiHandleMaintenance("POST", path, httpServer.arg("plain"), &status, &body);
  httpServer.send(status, "application/json", body);
}

// ------------------------------------------------------------------- setup

void httpApiBegin() {
  httpServer.collectHeaders("Authorization");
  httpServer.enableCORS(true);

  localWebRegister(); // GET / + /local/* (offline hotspot page)
  httpServer.on("/api/info", HTTP_GET, handleGetInfo);
  httpServer.on("/api/config", HTTP_GET, handleGetConfig);
  httpServer.on("/api/switches", HTTP_POST, handlePostSwitches);
  httpServer.on(UriBraces("/api/switches/{}"), HTTP_DELETE, handleDeleteSwitch);
  httpServer.on("/api/channels", HTTP_GET, handleGetChannels);
  httpServer.on(UriBraces("/api/channels/{}/state"), HTTP_POST, handlePostChannelState);
  httpServer.on("/api/schedules", HTTP_POST, handlePostSchedules);
  httpServer.on(UriBraces("/api/schedules/{}"), HTTP_DELETE, handleDeleteSchedule);
  httpServer.on("/api/auth/password", HTTP_POST, handlePostAuthPassword);
  httpServer.on("/api/timezone", HTTP_POST, handlePostTimezone);
  httpServer.on("/api/settings", HTTP_POST, handlePostSettings);
  httpServer.on("/api/wifi/scan", HTTP_GET, wifiProvisioningHandleScan);
  httpServer.on("/api/wifi", HTTP_GET, wifiProvisioningHandleGet);
  httpServer.on("/api/wifi", HTTP_POST, wifiProvisioningHandlePost);
  httpServer.on("/api/network", HTTP_POST, handlePostNetwork);
  httpServer.on("/api/reboot", HTTP_POST, [] { handleMaintenance("/api/reboot"); });
  httpServer.on("/api/factory-reset", HTTP_POST, [] { handleMaintenance("/api/factory-reset"); });

  httpServer.begin();
}

void httpApiLoop() { httpServer.handleClient(); }
