#include "config_store.h"

#include <ArduinoJson.h>
#include <ESP8266WiFi.h>
#include <LittleFS.h>

ConfigStore configStore;

static const char *CONFIG_PATH = "/config.json";
static const char *CONFIG_TMP_PATH = "/config.json.tmp";

static void hexEncode(const uint8_t *in, size_t len, char *out) {
  static const char *hex = "0123456789abcdef";
  for (size_t i = 0; i < len; i++) {
    out[i * 2] = hex[(in[i] >> 4) & 0xF];
    out[i * 2 + 1] = hex[in[i] & 0xF];
  }
  out[len * 2] = '\0';
}

static void hexDecode(const char *in, uint8_t *out, size_t outLen) {
  for (size_t i = 0; i < outLen; i++) {
    char hi = in[i * 2];
    char lo = in[i * 2 + 1];
    auto nibble = [](char c) -> uint8_t {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return 0;
    };
    out[i] = (nibble(hi) << 4) | nibble(lo);
  }
}

void ConfigStore::loadDefault() {
  _cfg = SsConfig();

  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(_cfg.device_id, sizeof(_cfg.device_id), "esp8266-%02x%02x%02x",
           mac[3], mac[4], mac[5]);
  snprintf(_cfg.name, sizeof(_cfg.name), "Smart Switch %s", _cfg.device_id);

  _cfg.switch_count = SS_CHANNEL_COUNT;
  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    _cfg.switches[i].channel_idx = i;
    snprintf(_cfg.switches[i].name, sizeof(_cfg.switches[i].name), "Channel %d", i);
  }

  uint8_t secretBytes[16];
  for (auto &b : secretBytes) {
    b = (uint8_t)secureRandom(256);
  }
  hexEncode(secretBytes, sizeof(secretBytes), _cfg.cloud_secret);
}

bool ConfigStore::loadFromDisk() {
  File f = LittleFS.open(CONFIG_PATH, "r");
  if (!f) {
    return false;
  }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) {
    return false;
  }

  _cfg = SsConfig();
  strlcpy(_cfg.device_id, doc["device_id"] | _cfg.device_id, sizeof(_cfg.device_id));
  strlcpy(_cfg.name, doc["name"] | _cfg.name, sizeof(_cfg.name));
  strlcpy(_cfg.board_type, doc["board_type"] | _cfg.board_type, sizeof(_cfg.board_type));
  _cfg.channel_count = doc["channel_count"] | SS_CHANNEL_COUNT;
  strlcpy(_cfg.channel_driver, doc["channel_driver"] | _cfg.channel_driver,
          sizeof(_cfg.channel_driver));
  strlcpy(_cfg.fw_version, doc["fw_version"] | _cfg.fw_version, sizeof(_cfg.fw_version));

  JsonArray switches = doc["switches"];
  _cfg.switch_count = 0;
  for (JsonObject sw : switches) {
    if (_cfg.switch_count >= SS_CHANNEL_COUNT) break;
    SsSwitch &out = _cfg.switches[_cfg.switch_count++];
    out.channel_idx = sw["channel_idx"] | 0;
    strlcpy(out.name, sw["name"] | "", sizeof(out.name));
    strlcpy(out.zone, sw["zone"] | "", sizeof(out.zone));
    strlcpy(out.type, sw["type"] | "ON_OFF", sizeof(out.type));
    strlcpy(out.default_boot_state, sw["default_boot_state"] | "OFF",
            sizeof(out.default_boot_state));
  }

  JsonArray schedules = doc["schedules"];
  _cfg.schedule_count = 0;
  for (JsonObject s : schedules) {
    if (_cfg.schedule_count >= SS_MAX_SCHEDULES) break;
    SsSchedule &out = _cfg.schedules[_cfg.schedule_count++];
    strlcpy(out.id, s["id"] | "", sizeof(out.id));
    out.channel_idx = s["channel_idx"] | 0;
    strlcpy(out.action, s["action"] | "OFF", sizeof(out.action));
    strlcpy(out.type, s["type"] | "once", sizeof(out.type));
    strlcpy(out.time, s["time"] | "", sizeof(out.time));
    out.days_mask = 0;
    JsonArray days = s["days"];
    for (JsonVariant d : days) {
      int dv = d.as<int>();
      if (dv >= 1 && dv <= 7) out.days_mask |= (1 << (dv - 1));
    }
    out.duration_s = s["duration_s"] | 0;
    out.countdown_started_at = s["_countdown_started_at"] | 0;
    out.enabled = s["enabled"] | true;
  }

  _cfg.next_schedule_id = doc["_next_schedule_id"] | 1;
  _cfg.utc_offset_min = doc["utc_offset_min"] | 0;
  _cfg.auth_password_set = doc["_auth_password_set"] | false;
  const char *hashHex = doc["_auth_password_hash"] | "";
  if (strlen(hashHex) == 64) {
    hexDecode(hashHex, _cfg.auth_password_hash, 32);
  }
  const char *secretHex = doc["_cloud_secret"] | "";
  if (strlen(secretHex) == 32) {
    strlcpy(_cfg.cloud_secret, secretHex, sizeof(_cfg.cloud_secret));
  } else {
    // Migration path: upgrading from a config predating cloud_secret.
    uint8_t secretBytes[16];
    for (auto &b : secretBytes) b = (uint8_t)secureRandom(256);
    hexEncode(secretBytes, sizeof(secretBytes), _cfg.cloud_secret);
  }

  _cfg.staticIpEnabled = doc["_static_ip_enabled"] | false;
  strlcpy(_cfg.staticIp, doc["_static_ip"] | "", sizeof(_cfg.staticIp));
  strlcpy(_cfg.staticGateway, doc["_static_gateway"] | "", sizeof(_cfg.staticGateway));
  strlcpy(_cfg.staticSubnet, doc["_static_subnet"] | "", sizeof(_cfg.staticSubnet));
  strlcpy(_cfg.staticDns, doc["_static_dns"] | "", sizeof(_cfg.staticDns));

  return true;
}

bool ConfigStore::begin() {
  if (!LittleFS.begin()) {
    return false;
  }
  if (!loadFromDisk()) {
    loadDefault();
    save();
  }
  return true;
}

void ConfigStore::save() {
  JsonDocument doc;
  doc["device_id"] = _cfg.device_id;
  doc["name"] = _cfg.name;
  doc["board_type"] = _cfg.board_type;
  doc["channel_count"] = _cfg.channel_count;
  doc["channel_driver"] = _cfg.channel_driver;
  doc["fw_version"] = _cfg.fw_version;

  JsonArray switches = doc["switches"].to<JsonArray>();
  for (uint8_t i = 0; i < _cfg.switch_count; i++) {
    JsonObject sw = switches.add<JsonObject>();
    sw["channel_idx"] = _cfg.switches[i].channel_idx;
    sw["name"] = _cfg.switches[i].name;
    sw["zone"] = _cfg.switches[i].zone;
    sw["type"] = _cfg.switches[i].type;
    sw["default_boot_state"] = _cfg.switches[i].default_boot_state;
  }

  JsonArray schedules = doc["schedules"].to<JsonArray>();
  for (uint8_t i = 0; i < _cfg.schedule_count; i++) {
    const SsSchedule &s = _cfg.schedules[i];
    JsonObject item = schedules.add<JsonObject>();
    item["id"] = s.id;
    item["channel_idx"] = s.channel_idx;
    item["action"] = s.action;
    item["type"] = s.type;
    if (strcmp(s.type, "countdown") != 0) {
      item["time"] = s.time;
    }
    if (strcmp(s.type, "weekly") == 0) {
      JsonArray days = item["days"].to<JsonArray>();
      for (uint8_t bit = 0; bit < 7; bit++) {
        if (s.days_mask & (1 << bit)) days.add(bit + 1);
      }
    }
    if (strcmp(s.type, "countdown") == 0) {
      item["duration_s"] = s.duration_s;
      item["_countdown_started_at"] = s.countdown_started_at;
    }
    item["enabled"] = s.enabled;
  }

  doc["_next_schedule_id"] = _cfg.next_schedule_id;
  doc["utc_offset_min"] = _cfg.utc_offset_min;
  doc["_auth_password_set"] = _cfg.auth_password_set;
  if (_cfg.auth_password_set) {
    char hex[65];
    hexEncode(_cfg.auth_password_hash, 32, hex);
    doc["_auth_password_hash"] = hex;
  }
  doc["_cloud_secret"] = _cfg.cloud_secret;

  doc["_static_ip_enabled"] = _cfg.staticIpEnabled;
  doc["_static_ip"] = _cfg.staticIp;
  doc["_static_gateway"] = _cfg.staticGateway;
  doc["_static_subnet"] = _cfg.staticSubnet;
  doc["_static_dns"] = _cfg.staticDns;

  File f = LittleFS.open(CONFIG_TMP_PATH, "w");
  if (!f) {
    return;
  }
  serializeJson(doc, f);
  f.close();
  LittleFS.remove(CONFIG_PATH);
  LittleFS.rename(CONFIG_TMP_PATH, CONFIG_PATH);
}

void ConfigStore::upsertSwitch(const SsSwitch &sw) {
  for (uint8_t i = 0; i < _cfg.switch_count; i++) {
    if (_cfg.switches[i].channel_idx == sw.channel_idx) {
      _cfg.switches[i] = sw;
      save();
      return;
    }
  }
  if (_cfg.switch_count < SS_CHANNEL_COUNT) {
    _cfg.switches[_cfg.switch_count++] = sw;
    save();
  }
}

void ConfigStore::deleteSwitch(uint8_t channel_idx) {
  for (uint8_t i = 0; i < _cfg.switch_count; i++) {
    if (_cfg.switches[i].channel_idx == channel_idx) {
      for (uint8_t j = i; j < _cfg.switch_count - 1; j++) {
        _cfg.switches[j] = _cfg.switches[j + 1];
      }
      _cfg.switch_count--;
      save();
      return;
    }
  }
}

bool ConfigStore::upsertSchedule(SsSchedule &inOut) {
  if (inOut.id[0] == '\0') {
    if (_cfg.schedule_count >= SS_MAX_SCHEDULES) {
      return false;
    }
    snprintf(inOut.id, sizeof(inOut.id), "s-%lu", (unsigned long)_cfg.next_schedule_id++);
    _cfg.schedules[_cfg.schedule_count++] = inOut;
    save();
    return true;
  }
  for (uint8_t i = 0; i < _cfg.schedule_count; i++) {
    if (strcmp(_cfg.schedules[i].id, inOut.id) == 0) {
      // Preserve the existing countdown_started_at unless the caller (schedule_exec, re-arming) set one.
      if (inOut.countdown_started_at == 0) {
        inOut.countdown_started_at = _cfg.schedules[i].countdown_started_at;
      }
      _cfg.schedules[i] = inOut;
      save();
      return true;
    }
  }
  return false;
}

bool ConfigStore::deleteSchedule(const char *id) {
  for (uint8_t i = 0; i < _cfg.schedule_count; i++) {
    if (strcmp(_cfg.schedules[i].id, id) == 0) {
      for (uint8_t j = i; j < _cfg.schedule_count - 1; j++) {
        _cfg.schedules[j] = _cfg.schedules[j + 1];
      }
      _cfg.schedule_count--;
      save();
      return true;
    }
  }
  return false;
}

void ConfigStore::setAuthHash(const uint8_t hash[32]) {
  memcpy(_cfg.auth_password_hash, hash, 32);
  _cfg.auth_password_set = true;
  save();
}

void ConfigStore::setUtcOffset(int16_t offset) {
  _cfg.utc_offset_min = offset;
  save();
}

void ConfigStore::setStaticIp(bool enabled, const char *ip, const char *gateway,
                               const char *subnet, const char *dns) {
  _cfg.staticIpEnabled = enabled;
  if (enabled) {
    strlcpy(_cfg.staticIp, ip, sizeof(_cfg.staticIp));
    strlcpy(_cfg.staticGateway, gateway, sizeof(_cfg.staticGateway));
    strlcpy(_cfg.staticSubnet, subnet, sizeof(_cfg.staticSubnet));
    strlcpy(_cfg.staticDns, dns ? dns : "", sizeof(_cfg.staticDns));
  }
  save();
}
