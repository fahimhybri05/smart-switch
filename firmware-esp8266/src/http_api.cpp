#include "http_api.h"

#include <ArduinoJson.h>
#include <uri/UriBraces.h>

#include "channel_control.h"
#include "cloud_client.h"
#include "config_store.h"
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

static void handleGetConfig() { forwardAndReply("GET", "/api/config", ""); }

static void handlePostSwitches() {
  forwardAndReply("POST", "/api/switches", httpServer.arg("plain"));
}

static void handleDeleteSwitch() {
  forwardAndReply("DELETE", "/api/switches/" + httpServer.pathArg(0), "");
}

static void handleGetChannels() { forwardAndReply("GET", "/api/channels", ""); }

static void handlePostChannelState() {
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

// ------------------------------------------------------------------- setup

void httpApiBegin() {
  httpServer.collectHeaders("Authorization");
  httpServer.enableCORS(true);

  httpServer.on("/", HTTP_GET, wifiProvisioningHandleFormPage);
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
  httpServer.on("/api/wifi", HTTP_POST, wifiProvisioningHandlePost);
  httpServer.on("/api/network", HTTP_POST, handlePostNetwork);

  httpServer.begin();
}

void httpApiLoop() { httpServer.handleClient(); }
