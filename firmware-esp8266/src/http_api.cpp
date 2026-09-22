#include "http_api.h"

#include <ArduinoJson.h>
#include <uri/UriBraces.h>

#include "channel_control.h"
#include "cloud_client.h"
#include "config_store.h"
#include "http_auth.h"
#include "relay_hal.h"
#include "schedule_exec.h"
#include "wifi_provisioning.h"

ESP8266WebServer httpServer(80);

// Every handler is split into:
//  - a "Logic" function taking explicit parameters (path params already
//    extracted, raw body JSON string) and returning an HttpResult — this is
//    the actual behavior (config_store/relay_hal calls, response JSON
//    construction), with zero dependency on the live ESP8266WebServer
//    request object.
//  - a thin wrapper (the original handleXxx name) that does auth, pulls
//    httpServer.pathArg(0)/httpServer.arg("plain"), calls the Logic
//    function, and sends the result via httpServer.send().
// This lets httpApiDispatch() (see http_api.h) invoke the same logic
// in-process — e.g. from cloud_client.cpp's relayed-command path — without
// a live WebServer request at all.
struct HttpResult {
  int status;
  String body;
};

static String makeErrorBody(const char *message) {
  JsonDocument doc;
  doc["error"] = message;
  String out;
  serializeJson(doc, out);
  return out;
}

static HttpResult errorResult(int code, const char *message) {
  return HttpResult{code, makeErrorBody(message)};
}

// -------------------------------------------------------------- GET /api/info

static HttpResult handleGetInfoLogic() {
  const SsConfig &cfg = configStore.cfg();
  JsonDocument doc;
  doc["device_id"] = cfg.device_id;
  doc["board_type"] = cfg.board_type;
  doc["channel_count"] = relayHalChannelCount();
  doc["fw_version"] = cfg.fw_version;
  doc["wifi_reconfig_state"] = wifiReconfigStateStr(wifiProvisioningGetState());
  // Local-LAN-only, unauthenticated by design (same boundary as the rest of
  // /api/info) — read once by the app's QR/manual claim flow. See
  // docs/plan.md.
  doc["cloud_secret"] = cfg.cloud_secret;
  // Diagnostic — lets the app (or a curl) confirm the scheduler actually
  // has a trustworthy clock without guessing. See docs/plan.md.
  doc["time_known_good"] = scheduleExecTimeIsKnownGood();
  doc["rtc_present"] = scheduleExecRtcPresent();
  doc["now_epoch"] = scheduleExecNowEpoch();
  JsonArray capabilities = doc["capabilities"].to<JsonArray>();
  capabilities.add("switch");
  String out;
  serializeJson(doc, out);
  return HttpResult{200, out};
}

static void handleGetInfo() {
  HttpResult r = handleGetInfoLogic();
  httpServer.send(r.status, "application/json", r.body);
}

// ------------------------------------------------------------- GET /api/config

static HttpResult handleGetConfigLogic() {
  const SsConfig &cfg = configStore.cfg();
  JsonDocument doc;
  doc["device_id"] = cfg.device_id;
  doc["name"] = cfg.name;
  doc["board_type"] = cfg.board_type;
  doc["channel_count"] = relayHalChannelCount();
  doc["channel_driver"] = cfg.channel_driver;
  doc["fw_version"] = cfg.fw_version;
  doc["utc_offset_min"] = cfg.utc_offset_min;
  doc["interlock_enabled"] = cfg.interlockEnabled;
  doc["latitude"] = cfg.latitude;
  doc["longitude"] = cfg.longitude;
  doc["location_set"] = cfg.locationSet;

  JsonObject network = doc["network"].to<JsonObject>();
  network["mode"] = cfg.staticIpEnabled ? "static" : "dhcp";
  if (cfg.staticIpEnabled) {
    network["ip"] = cfg.staticIp;
    network["gateway"] = cfg.staticGateway;
    network["subnet"] = cfg.staticSubnet;
    network["dns"] = cfg.staticDns;
  }

  JsonArray switches = doc["switches"].to<JsonArray>();
  for (uint8_t i = 0; i < cfg.switch_count; i++) {
    JsonObject sw = switches.add<JsonObject>();
    sw["channel_idx"] = cfg.switches[i].channel_idx;
    sw["name"] = cfg.switches[i].name;
    sw["zone"] = cfg.switches[i].zone;
    sw["type"] = cfg.switches[i].type;
    sw["default_boot_state"] = cfg.switches[i].default_boot_state;
    sw["input_mode"] = cfg.switches[i].inputMode;
    sw["inching_ms"] = cfg.switches[i].inchingMs;
  }

  JsonArray schedules = doc["schedules"].to<JsonArray>();
  for (uint8_t i = 0; i < cfg.schedule_count; i++) {
    const SsSchedule &s = cfg.schedules[i];
    JsonObject item = schedules.add<JsonObject>();
    item["id"] = s.id;
    item["channel_idx"] = s.channel_idx;
    item["action"] = s.action;
    item["type"] = s.type;
    if (strcmp(s.type, "countdown") != 0) item["time"] = s.time;
    if (strcmp(s.type, "weekly") == 0) {
      JsonArray days = item["days"].to<JsonArray>();
      for (uint8_t bit = 0; bit < 7; bit++) {
        if (s.days_mask & (1 << bit)) days.add(bit + 1);
      }
    }
    if (strcmp(s.type, "countdown") == 0) item["duration_s"] = s.duration_s;
    if (strcmp(s.type, "sunrise") == 0 || strcmp(s.type, "sunset") == 0) {
      item["solar_offset_min"] = s.solarOffsetMin;
    }
    item["enabled"] = s.enabled;
  }

  String out;
  serializeJson(doc, out);
  return HttpResult{200, out};
}

static void handleGetConfig() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handleGetConfigLogic();
  httpServer.send(r.status, "application/json", r.body);
}

// ---------------------------------------------------------- POST /api/switches

static HttpResult handlePostSwitchesLogic(const String &bodyJson) {
  JsonDocument doc;
  if (deserializeJson(doc, bodyJson) != DeserializationError::Ok) {
    return errorResult(400, "invalid JSON");
  }
  int idx = doc["channel_idx"] | -1;
  if (idx < 0 || idx >= relayHalChannelCount()) {
    return errorResult(400, "channel_idx out of range");
  }

  SsSwitch sw;
  sw.channel_idx = (uint8_t)idx;
  strlcpy(sw.name, doc["name"] | "", sizeof(sw.name));
  strlcpy(sw.zone, doc["zone"] | "", sizeof(sw.zone));
  strlcpy(sw.type, "ON_OFF", sizeof(sw.type)); // this board is ON/OFF only
  strlcpy(sw.default_boot_state, doc["default_boot_state"] | "OFF",
          sizeof(sw.default_boot_state));
  strlcpy(sw.inputMode, doc["input_mode"] | "DISABLED", sizeof(sw.inputMode));
  uint32_t inchingMs = doc["inching_ms"] | 0;
  if (inchingMs > 600000) inchingMs = 600000;
  sw.inchingMs = inchingMs;

  configStore.upsertSwitch(sw);

  JsonDocument resp;
  resp["channel_idx"] = sw.channel_idx;
  resp["name"] = sw.name;
  resp["zone"] = sw.zone;
  resp["type"] = sw.type;
  resp["default_boot_state"] = sw.default_boot_state;
  resp["input_mode"] = sw.inputMode;
  resp["inching_ms"] = sw.inchingMs;
  String out;
  serializeJson(resp, out);
  return HttpResult{200, out};
}

static void handlePostSwitches() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handlePostSwitchesLogic(httpServer.arg("plain"));
  httpServer.send(r.status, "application/json", r.body);
}

static HttpResult handleDeleteSwitchLogic(const String &idxArg) {
  int idx = idxArg.toInt();
  configStore.deleteSwitch((uint8_t)idx);
  return HttpResult{204, ""};
}

static void handleDeleteSwitch() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handleDeleteSwitchLogic(httpServer.pathArg(0));
  httpServer.send(r.status, "application/json", r.body);
}

// ----------------------------------------------------------- GET /api/channels

static HttpResult handleGetChannelsLogic() {
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (uint8_t i = 0; i < relayHalChannelCount(); i++) {
    JsonObject item = arr.add<JsonObject>();
    item["channel_idx"] = i;
    item["state"] = relayHalGetState(i) ? "ON" : "OFF";
  }
  String out;
  serializeJson(doc, out);
  return HttpResult{200, out};
}

static void handleGetChannels() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handleGetChannelsLogic();
  httpServer.send(r.status, "application/json", r.body);
}

// ------------------------------------------------- POST /api/channels/{idx}/state

static HttpResult handlePostChannelStateLogic(const String &idxArg, const String &bodyJson) {
  int idx = idxArg.toInt();
  if (idx < 0 || idx >= relayHalChannelCount()) {
    return errorResult(400, "channel_idx out of range");
  }

  JsonDocument doc;
  if (deserializeJson(doc, bodyJson) != DeserializationError::Ok) {
    return errorResult(400, "expected {\"state\":\"ON\"|\"OFF\"}");
  }
  const char *state = doc["state"] | "";
  if (strcmp(state, "ON") != 0 && strcmp(state, "OFF") != 0) {
    return errorResult(400, "expected {\"state\":\"ON\"|\"OFF\"}");
  }

  bool on = strcmp(state, "ON") == 0;
  channelControlSetState((uint8_t)idx, on);

  JsonDocument resp;
  resp["channel_idx"] = idx;
  resp["state"] = state;
  String out;
  serializeJson(resp, out);
  return HttpResult{200, out};
}

static void handlePostChannelState() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handlePostChannelStateLogic(httpServer.pathArg(0), httpServer.arg("plain"));
  httpServer.send(r.status, "application/json", r.body);
}

// ---------------------------------------------------------- POST /api/schedules

static HttpResult handlePostSchedulesLogic(const String &bodyJson) {
  JsonDocument doc;
  if (deserializeJson(doc, bodyJson) != DeserializationError::Ok) {
    return errorResult(400, "invalid JSON");
  }

  SsSchedule s;
  strlcpy(s.id, doc["id"] | "", sizeof(s.id));
  s.channel_idx = doc["channel_idx"] | 0;
  strlcpy(s.action, doc["action"] | "OFF", sizeof(s.action));
  strlcpy(s.type, doc["type"] | "once", sizeof(s.type));
  strlcpy(s.time, doc["time"] | "", sizeof(s.time));
  s.duration_s = doc["duration_s"] | 0;
  s.enabled = doc["enabled"] | true;
  s.days_mask = 0;
  JsonArray days = doc["days"];
  for (JsonVariant d : days) {
    int dv = d.as<int>();
    if (dv >= 1 && dv <= 7) s.days_mask |= (1 << (dv - 1));
  }

  if (s.channel_idx >= relayHalChannelCount()) {
    return errorResult(400, "channel_idx out of range");
  }

  bool isSolar = strcmp(s.type, "sunrise") == 0 || strcmp(s.type, "sunset") == 0;
  if (isSolar && !configStore.cfg().locationSet) {
    return errorResult(400, "device location not configured");
  }

  if (!doc["solar_offset_min"].isNull()) {
    int solarOffset = doc["solar_offset_min"] | 0;
    if (solarOffset < -180 || solarOffset > 180) {
      return errorResult(400, "solar_offset_min out of range");
    }
    s.solarOffsetMin = (int16_t)solarOffset;
  } else {
    s.solarOffsetMin = 0;
  }

  // Countdown schedules need countdown_started_at armed here — the wire
  // protocol never carries it (internal-only, see config_store.h) — or
  // schedulerTick()'s `countdown_started_at > 0` check never trips and the
  // schedule silently never fires. Mirrors the ESP32 firmware's
  // schedule_exec_upsert(): arm on create, re-arm only on a
  // disabled->enabled transition, otherwise preserve the existing start
  // time so a plain edit doesn't restart the countdown.
  bool isNew = s.id[0] == '\0';
  bool isCountdown = strcmp(s.type, "countdown") == 0;
  if (isCountdown) {
    if (isNew) {
      s.countdown_started_at = time(nullptr);
    } else {
      bool wasEnabled = false;
      int64_t existingStart = 0;
      const SsConfig &cfg = configStore.cfg();
      for (uint8_t i = 0; i < cfg.schedule_count; i++) {
        if (strcmp(cfg.schedules[i].id, s.id) == 0) {
          wasEnabled = cfg.schedules[i].enabled;
          existingStart = cfg.schedules[i].countdown_started_at;
          break;
        }
      }
      s.countdown_started_at = (!wasEnabled && s.enabled) ? time(nullptr) : existingStart;
    }
  }

  if (!configStore.upsertSchedule(s)) {
    return errorResult(404, "schedule not found");
  }

  JsonDocument resp;
  resp["id"] = s.id;
  resp["channel_idx"] = s.channel_idx;
  resp["action"] = s.action;
  resp["type"] = s.type;
  resp["time"] = s.time;
  if (isSolar) resp["solar_offset_min"] = s.solarOffsetMin;
  resp["enabled"] = s.enabled;
  String out;
  serializeJson(resp, out);
  return HttpResult{200, out};
}

static void handlePostSchedules() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handlePostSchedulesLogic(httpServer.arg("plain"));
  httpServer.send(r.status, "application/json", r.body);
}

static HttpResult handleDeleteScheduleLogic(const String &id) {
  if (!configStore.deleteSchedule(id.c_str())) {
    return errorResult(404, "schedule not found");
  }
  return HttpResult{204, ""};
}

static void handleDeleteSchedule() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handleDeleteScheduleLogic(httpServer.pathArg(0));
  httpServer.send(r.status, "application/json", r.body);
}

// ------------------------------------------------------- POST /api/auth/password

static HttpResult handlePostAuthPasswordLogic(const String &bodyJson) {
  JsonDocument doc;
  if (deserializeJson(doc, bodyJson) != DeserializationError::Ok) {
    return errorResult(400, "invalid JSON");
  }
  const char *password = doc["password"] | "";
  if (strlen(password) == 0) {
    return errorResult(400, "password required");
  }

  br_sha256_context ctx;
  uint8_t hash[32];
  br_sha256_init(&ctx);
  br_sha256_update(&ctx, password, strlen(password));
  br_sha256_out(&ctx, hash);
  configStore.setAuthHash(hash);

  return HttpResult{200, "{\"ok\":true}"};
}

static void handlePostAuthPassword() {
  // Same conditional gate as the ESP32 firmware: only auth-checked once a
  // password already exists (a fresh device is open until first claimed).
  if (configStore.cfg().auth_password_set && !httpAuthCheck(httpServer)) return;
  HttpResult r = handlePostAuthPasswordLogic(httpServer.arg("plain"));
  httpServer.send(r.status, "application/json", r.body);
}

// ------------------------------------------------------------ POST /api/timezone

static HttpResult handlePostTimezoneLogic(const String &bodyJson) {
  JsonDocument doc;
  if (deserializeJson(doc, bodyJson) != DeserializationError::Ok) {
    return errorResult(400, "invalid JSON");
  }
  int offset = doc["utc_offset_min"] | 0;
  configStore.setUtcOffset((int16_t)offset);
  return HttpResult{200, "{\"ok\":true}"};
}

static void handlePostTimezone() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handlePostTimezoneLogic(httpServer.arg("plain"));
  httpServer.send(r.status, "application/json", r.body);
}

// ------------------------------------------------------------ POST /api/settings
//
// {"interlock_enabled"?: bool, "latitude"?: number, "longitude"?: number}

static HttpResult handlePostSettingsLogic(const String &bodyJson) {
  JsonDocument doc;
  if (deserializeJson(doc, bodyJson) != DeserializationError::Ok) {
    return errorResult(400, "invalid JSON");
  }

  bool hasLat = !doc["latitude"].isNull();
  bool hasLon = !doc["longitude"].isNull();
  bool hasInterlock = !doc["interlock_enabled"].isNull();

  if (!hasLat && !hasLon && !hasInterlock) {
    return errorResult(400, "no recognized fields");
  }

  if (hasLat != hasLon) {
    return errorResult(400, "latitude and longitude must be set together");
  }

  if (hasLat && hasLon) {
    double lat = doc["latitude"] | 0.0;
    double lon = doc["longitude"] | 0.0;
    if (lat < -90.0 || lat > 90.0 || lon < -180.0 || lon > 180.0) {
      return errorResult(400, "latitude/longitude out of range");
    }
    configStore.setLocation(lat, lon);
  }

  if (hasInterlock) {
    bool enabled = doc["interlock_enabled"] | false;
    configStore.setInterlockEnabled(enabled);
  }

  const SsConfig &cfg = configStore.cfg();
  JsonDocument resp;
  resp["interlock_enabled"] = cfg.interlockEnabled;
  resp["latitude"] = cfg.latitude;
  resp["longitude"] = cfg.longitude;
  resp["location_set"] = cfg.locationSet;
  String out;
  serializeJson(resp, out);
  return HttpResult{200, out};
}

static void handlePostSettings() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handlePostSettingsLogic(httpServer.arg("plain"));
  httpServer.send(r.status, "application/json", r.body);
}

// ------------------------------------------------------------- POST /api/network
//
// {"mode":"static", "ip":..., "gateway":..., "subnet":..., "dns":...} or
// {"mode":"dhcp"}. Persists via configStore, then reboots so
// wifiProvisioningBegin() applies it cleanly at the next connect — mirrors
// the ESP32 firmware's equivalent. Solves the "device is hard to
// rediscover via mDNS" flakiness by letting the app remember a fixed
// address instead of relying on rediscovery at all.
//
// The restart is deliberately kept OUT of the logic function: it must
// happen only after the response has actually been handed to whichever
// transport is in play (httpServer.send() for a live request,
// outStatus/outBody for a dispatched one) — see the call sites below and
// in httpApiDispatch(). Restarting inside the logic function would run
// before a live request's httpServer.send() ever executes.

static HttpResult handlePostNetworkLogic(const String &bodyJson) {
  JsonDocument doc;
  if (deserializeJson(doc, bodyJson) != DeserializationError::Ok) {
    return errorResult(400, "invalid JSON");
  }
  const char *mode = doc["mode"] | "";
  if (strcmp(mode, "dhcp") != 0 && strcmp(mode, "static") != 0) {
    return errorResult(400, "expected {\"mode\":\"static\"|\"dhcp\", ...}");
  }

  if (strcmp(mode, "dhcp") == 0) {
    configStore.setStaticIp(false, nullptr, nullptr, nullptr, nullptr);
  } else {
    const char *ip = doc["ip"] | "";
    const char *gateway = doc["gateway"] | "";
    const char *subnet = doc["subnet"] | "";
    const char *dns = doc["dns"] | "";
    if (strlen(ip) == 0 || strlen(gateway) == 0 || strlen(subnet) == 0) {
      return errorResult(400, "static mode requires \"ip\", \"gateway\", \"subnet\"");
    }
    configStore.setStaticIp(true, ip, gateway, subnet, dns);
  }

  return HttpResult{200, "{\"ok\":true,\"rebooting\":true}"};
}

static void handlePostNetwork() {
  if (!httpAuthCheck(httpServer)) return;
  HttpResult r = handlePostNetworkLogic(httpServer.arg("plain"));
  httpServer.send(r.status, "application/json", r.body);
  if (r.status == 200) {
    delay(500);
    ESP.restart();
  }
}

// ------------------------------------------------------- in-process dispatch

// Matches a UriBraces("<prefix>{}") route with no further '/' after the
// prefix (the same "one path segment" semantics UriBraces's {} capture
// has). On match, *segment holds the captured text (matching what
// httpServer.pathArg(0) would have returned).
static bool extractSingleSegment(const String &path, const char *prefix, String *segment) {
  size_t prefixLen = strlen(prefix);
  if (path.length() <= prefixLen || !path.startsWith(prefix)) return false;
  String rest = path.substring(prefixLen);
  if (rest.length() == 0 || rest.indexOf('/') != -1) return false;
  *segment = rest;
  return true;
}

// Matches UriBraces("/api/channels/{}/state"): a single path segment
// between the fixed prefix and suffix.
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

void httpApiDispatch(const char *method, const char *path, const char *bodyJson,
                      int *outStatus, String *outBody) {
  String m(method != nullptr ? method : "");
  String p(path != nullptr ? path : "");
  String body(bodyJson != nullptr ? bodyJson : "");
  String seg;
  HttpResult r{404, makeErrorBody("not found")};
  bool isNetworkPost = false;

  if (m == "GET" && p == "/api/info") {
    r = handleGetInfoLogic();
  } else if (m == "GET" && p == "/api/config") {
    r = handleGetConfigLogic();
  } else if (m == "POST" && p == "/api/switches") {
    r = handlePostSwitchesLogic(body);
  } else if (m == "DELETE" && extractSingleSegment(p, "/api/switches/", &seg)) {
    r = handleDeleteSwitchLogic(seg);
  } else if (m == "GET" && p == "/api/channels") {
    r = handleGetChannelsLogic();
  } else if (m == "POST" && extractChannelIdxForState(p, &seg)) {
    r = handlePostChannelStateLogic(seg, body);
  } else if (m == "POST" && p == "/api/schedules") {
    r = handlePostSchedulesLogic(body);
  } else if (m == "DELETE" && extractSingleSegment(p, "/api/schedules/", &seg)) {
    r = handleDeleteScheduleLogic(seg);
  } else if (m == "POST" && p == "/api/auth/password") {
    r = handlePostAuthPasswordLogic(body);
  } else if (m == "POST" && p == "/api/timezone") {
    r = handlePostTimezoneLogic(body);
  } else if (m == "POST" && p == "/api/settings") {
    r = handlePostSettingsLogic(body);
  } else if (m == "POST" && p == "/api/network") {
    r = handlePostNetworkLogic(body);
    isNetworkPost = true;
  }

  *outStatus = r.status;
  *outBody = r.body;

  // Same "respond, then reboot" ordering as handlePostNetwork()'s wrapper —
  // see the comment above handlePostNetworkLogic().
  if (isNetworkPost && r.status == 200) {
    delay(500);
    ESP.restart();
  }
}

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
