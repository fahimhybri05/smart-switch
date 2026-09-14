#include "http_api.h"

#include <ArduinoJson.h>
#include <uri/UriBraces.h>

#include "cloud_client.h"
#include "config_store.h"
#include "http_auth.h"
#include "relay_hal.h"
#include "schedule_exec.h"
#include "wifi_provisioning.h"

ESP8266WebServer httpServer(80);

static void replyError(int code, const char *message) {
  JsonDocument doc;
  doc["error"] = message;
  String out;
  serializeJson(doc, out);
  httpServer.send(code, "application/json", out);
}

// -------------------------------------------------------------- GET /api/info

static void handleGetInfo() {
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
  httpServer.send(200, "application/json", out);
}

// ------------------------------------------------------------- GET /api/config

static void handleGetConfig() {
  if (!httpAuthCheck(httpServer)) return;

  const SsConfig &cfg = configStore.cfg();
  JsonDocument doc;
  doc["device_id"] = cfg.device_id;
  doc["name"] = cfg.name;
  doc["board_type"] = cfg.board_type;
  doc["channel_count"] = relayHalChannelCount();
  doc["channel_driver"] = cfg.channel_driver;
  doc["fw_version"] = cfg.fw_version;
  doc["utc_offset_min"] = cfg.utc_offset_min;

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
    item["enabled"] = s.enabled;
  }

  String out;
  serializeJson(doc, out);
  httpServer.send(200, "application/json", out);
}

// ---------------------------------------------------------- POST /api/switches

static void handlePostSwitches() {
  if (!httpAuthCheck(httpServer)) return;

  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
    return replyError(400, "invalid JSON");
  }
  int idx = doc["channel_idx"] | -1;
  if (idx < 0 || idx >= relayHalChannelCount()) {
    return replyError(400, "channel_idx out of range");
  }

  SsSwitch sw;
  sw.channel_idx = (uint8_t)idx;
  strlcpy(sw.name, doc["name"] | "", sizeof(sw.name));
  strlcpy(sw.zone, doc["zone"] | "", sizeof(sw.zone));
  strlcpy(sw.type, "ON_OFF", sizeof(sw.type)); // this board is ON/OFF only
  strlcpy(sw.default_boot_state, doc["default_boot_state"] | "OFF",
          sizeof(sw.default_boot_state));

  configStore.upsertSwitch(sw);

  JsonDocument resp;
  resp["channel_idx"] = sw.channel_idx;
  resp["name"] = sw.name;
  resp["zone"] = sw.zone;
  resp["type"] = sw.type;
  resp["default_boot_state"] = sw.default_boot_state;
  String out;
  serializeJson(resp, out);
  httpServer.send(200, "application/json", out);
}

static void handleDeleteSwitch() {
  if (!httpAuthCheck(httpServer)) return;
  int idx = httpServer.pathArg(0).toInt();
  configStore.deleteSwitch((uint8_t)idx);
  httpServer.send(204, "application/json", "");
}

// ----------------------------------------------------------- GET /api/channels

static void handleGetChannels() {
  if (!httpAuthCheck(httpServer)) return;
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (uint8_t i = 0; i < relayHalChannelCount(); i++) {
    JsonObject item = arr.add<JsonObject>();
    item["channel_idx"] = i;
    item["state"] = relayHalGetState(i) ? "ON" : "OFF";
  }
  String out;
  serializeJson(doc, out);
  httpServer.send(200, "application/json", out);
}

// ------------------------------------------------- POST /api/channels/{idx}/state

static void handlePostChannelState() {
  if (!httpAuthCheck(httpServer)) return;
  int idx = httpServer.pathArg(0).toInt();
  if (idx < 0 || idx >= relayHalChannelCount()) {
    return replyError(400, "channel_idx out of range");
  }

  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
    return replyError(400, "expected {\"state\":\"ON\"|\"OFF\"}");
  }
  const char *state = doc["state"] | "";
  if (strcmp(state, "ON") != 0 && strcmp(state, "OFF") != 0) {
    return replyError(400, "expected {\"state\":\"ON\"|\"OFF\"}");
  }

  bool on = strcmp(state, "ON") == 0;
  relayHalSetState((uint8_t)idx, on);
  cloudClientNotifyStateChanged((uint8_t)idx, on);

  JsonDocument resp;
  resp["channel_idx"] = idx;
  resp["state"] = state;
  String out;
  serializeJson(resp, out);
  httpServer.send(200, "application/json", out);
}

// ---------------------------------------------------------- POST /api/schedules

static void handlePostSchedules() {
  if (!httpAuthCheck(httpServer)) return;

  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
    return replyError(400, "invalid JSON");
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
    return replyError(400, "channel_idx out of range");
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
    return replyError(404, "schedule not found");
  }

  JsonDocument resp;
  resp["id"] = s.id;
  resp["channel_idx"] = s.channel_idx;
  resp["action"] = s.action;
  resp["type"] = s.type;
  resp["time"] = s.time;
  resp["enabled"] = s.enabled;
  String out;
  serializeJson(resp, out);
  httpServer.send(200, "application/json", out);
}

static void handleDeleteSchedule() {
  if (!httpAuthCheck(httpServer)) return;
  String id = httpServer.pathArg(0);
  if (!configStore.deleteSchedule(id.c_str())) {
    return replyError(404, "schedule not found");
  }
  httpServer.send(204, "application/json", "");
}

// ------------------------------------------------------- POST /api/auth/password

static void handlePostAuthPassword() {
  // Same conditional gate as the ESP32 firmware: only auth-checked once a
  // password already exists (a fresh device is open until first claimed).
  if (configStore.cfg().auth_password_set && !httpAuthCheck(httpServer)) return;

  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
    return replyError(400, "invalid JSON");
  }
  const char *password = doc["password"] | "";
  if (strlen(password) == 0) {
    return replyError(400, "password required");
  }

  br_sha256_context ctx;
  uint8_t hash[32];
  br_sha256_init(&ctx);
  br_sha256_update(&ctx, password, strlen(password));
  br_sha256_out(&ctx, hash);
  configStore.setAuthHash(hash);

  httpServer.send(200, "application/json", "{\"ok\":true}");
}

// ------------------------------------------------------------ POST /api/timezone

static void handlePostTimezone() {
  if (!httpAuthCheck(httpServer)) return;
  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
    return replyError(400, "invalid JSON");
  }
  int offset = doc["utc_offset_min"] | 0;
  configStore.setUtcOffset((int16_t)offset);
  httpServer.send(200, "application/json", "{\"ok\":true}");
}

// ------------------------------------------------------------- POST /api/network
//
// {"mode":"static", "ip":..., "gateway":..., "subnet":..., "dns":...} or
// {"mode":"dhcp"}. Persists via configStore, then reboots so
// wifiProvisioningBegin() applies it cleanly at the next connect — mirrors
// the ESP32 firmware's equivalent. Solves the "device is hard to
// rediscover via mDNS" flakiness by letting the app remember a fixed
// address instead of relying on rediscovery at all.

static void handlePostNetwork() {
  if (!httpAuthCheck(httpServer)) return;

  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
    return replyError(400, "invalid JSON");
  }
  const char *mode = doc["mode"] | "";
  if (strcmp(mode, "dhcp") != 0 && strcmp(mode, "static") != 0) {
    return replyError(400, "expected {\"mode\":\"static\"|\"dhcp\", ...}");
  }

  if (strcmp(mode, "dhcp") == 0) {
    configStore.setStaticIp(false, nullptr, nullptr, nullptr, nullptr);
  } else {
    const char *ip = doc["ip"] | "";
    const char *gateway = doc["gateway"] | "";
    const char *subnet = doc["subnet"] | "";
    const char *dns = doc["dns"] | "";
    if (strlen(ip) == 0 || strlen(gateway) == 0 || strlen(subnet) == 0) {
      return replyError(400, "static mode requires \"ip\", \"gateway\", \"subnet\"");
    }
    configStore.setStaticIp(true, ip, gateway, subnet, dns);
  }

  httpServer.send(200, "application/json", "{\"ok\":true,\"rebooting\":true}");
  delay(500);
  ESP.restart();
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
  httpServer.on("/api/wifi", HTTP_POST, wifiProvisioningHandlePost);
  httpServer.on("/api/network", HTTP_POST, handlePostNetwork);

  httpServer.begin();
}

void httpApiLoop() { httpServer.handleClient(); }
