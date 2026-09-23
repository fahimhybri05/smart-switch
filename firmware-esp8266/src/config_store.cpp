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

void ConfigStore::loadDefault() {
  _cfg = SsConfig();

  uint8_t mac[6];
  WiFi.macAddress(mac);
  snprintf(_cfg.device_id, sizeof(_cfg.device_id), "esp8266-%02x%02x%02x",
           mac[3], mac[4], mac[5]);

  _cfg.channelHwCount = SS_CHANNEL_COUNT;
  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    _cfg.channelHw[i].channel_idx = i;
    strlcpy(_cfg.channelHw[i].inputMode, "DISABLED", sizeof(_cfg.channelHw[i].inputMode));
    _cfg.channelHw[i].inchingMs = 0;
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
  strlcpy(_cfg.board_type, doc["board_type"] | _cfg.board_type, sizeof(_cfg.board_type));
  _cfg.channel_count = doc["channel_count"] | SS_CHANNEL_COUNT;
  strlcpy(_cfg.channel_driver, doc["channel_driver"] | _cfg.channel_driver,
          sizeof(_cfg.channel_driver));
  strlcpy(_cfg.fw_version, doc["fw_version"] | _cfg.fw_version, sizeof(_cfg.fw_version));

  // Identity/network keys keep the pre-rewrite on-disk spelling so a device
  // reflashed from the old firmware keeps its cloud_secret (a fresh one would
  // no longer match the backend's stored hash and lock the device out).
  const char *secretHex = doc["_cloud_secret"] | "";
  if (strlen(secretHex) == 32) {
    strlcpy(_cfg.cloud_secret, secretHex, sizeof(_cfg.cloud_secret));
  } else {
    // Missing/corrupt on-disk secret — generate a fresh one rather than
    // leave the device unable to authenticate to the backend at all.
    uint8_t secretBytes[16];
    for (auto &b : secretBytes) b = (uint8_t)secureRandom(256);
    hexEncode(secretBytes, sizeof(secretBytes), _cfg.cloud_secret);
  }

  _cfg.staticIpEnabled = doc["_static_ip_enabled"] | false;
  strlcpy(_cfg.staticIp, doc["_static_ip"] | "", sizeof(_cfg.staticIp));
  strlcpy(_cfg.staticGateway, doc["_static_gateway"] | "", sizeof(_cfg.staticGateway));
  strlcpy(_cfg.staticSubnet, doc["_static_subnet"] | "", sizeof(_cfg.staticSubnet));
  strlcpy(_cfg.staticDns, doc["_static_dns"] | "", sizeof(_cfg.staticDns));

  JsonArray channelHw = doc["channel_hw"];
  _cfg.channelHwCount = 0;
  for (JsonObject ch : channelHw) {
    if (_cfg.channelHwCount >= SS_CHANNEL_COUNT) break;
    SsChannelHw &out = _cfg.channelHw[_cfg.channelHwCount++];
    out.channel_idx = ch["channel_idx"] | 0;
    strlcpy(out.inputMode, ch["input_mode"] | "DISABLED", sizeof(out.inputMode));
    out.inchingMs = ch["inching_ms"] | 0;
  }

  _cfg.interlockEnabled = doc["interlock_enabled"] | false;

  JsonArray lastState = doc["last_state"];
  uint8_t i = 0;
  for (JsonVariant v : lastState) {
    if (i >= SS_CHANNEL_COUNT) break;
    _cfg.lastState[i++] = v.as<bool>();
  }

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
  doc["board_type"] = _cfg.board_type;
  doc["channel_count"] = _cfg.channel_count;
  doc["channel_driver"] = _cfg.channel_driver;
  doc["fw_version"] = _cfg.fw_version;
  doc["_cloud_secret"] = _cfg.cloud_secret;

  doc["_static_ip_enabled"] = _cfg.staticIpEnabled;
  doc["_static_ip"] = _cfg.staticIp;
  doc["_static_gateway"] = _cfg.staticGateway;
  doc["_static_subnet"] = _cfg.staticSubnet;
  doc["_static_dns"] = _cfg.staticDns;

  JsonArray channelHw = doc["channel_hw"].to<JsonArray>();
  for (uint8_t i = 0; i < _cfg.channelHwCount; i++) {
    JsonObject ch = channelHw.add<JsonObject>();
    ch["channel_idx"] = _cfg.channelHw[i].channel_idx;
    ch["input_mode"] = _cfg.channelHw[i].inputMode;
    ch["inching_ms"] = _cfg.channelHw[i].inchingMs;
  }

  doc["interlock_enabled"] = _cfg.interlockEnabled;

  JsonArray lastState = doc["last_state"].to<JsonArray>();
  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    lastState.add(_cfg.lastState[i]);
  }

  File f = LittleFS.open(CONFIG_TMP_PATH, "w");
  if (!f) {
    Serial.println("ConfigStore::save: failed to open tmp file for writing; config NOT persisted");
    return;
  }
  serializeJson(doc, f);
  f.close();
  // lfs_rename() (which LittleFS::rename() wraps) already atomically replaces
  // an existing destination file in a single filesystem transaction — there
  // is no window where neither file exists. An explicit remove() beforehand
  // would *introduce* exactly that window (power loss between remove() and
  // rename() would leave the device with no config at all, silently falling
  // back to loadDefault() + a brand-new random device_id on next boot), so
  // it must not be done.
  if (!LittleFS.rename(CONFIG_TMP_PATH, CONFIG_PATH)) {
    // In-RAM _cfg reflects the intended state but is NOT durably persisted —
    // no additional recovery here beyond logging; the next successful save()
    // will still write it out fine.
    Serial.println("ConfigStore::save: rename tmp->config failed; config NOT durably persisted");
  }
}

// Marks the in-RAM config as needing a flush to flash — picked up by loop()
// once _dirty has been stable for >=500ms. See config_store.h.
static inline void markDirty(bool *dirty, uint32_t *dirtySinceMs) {
  *dirty = true;
  *dirtySinceMs = millis();
}

void ConfigStore::setChannelHw(uint8_t channel_idx, const char *inputMode, uint32_t inchingMs) {
  for (uint8_t i = 0; i < _cfg.channelHwCount; i++) {
    if (_cfg.channelHw[i].channel_idx == channel_idx) {
      strlcpy(_cfg.channelHw[i].inputMode, inputMode, sizeof(_cfg.channelHw[i].inputMode));
      _cfg.channelHw[i].inchingMs = inchingMs;
      markDirty(&_dirty, &_dirtySinceMs);
      return;
    }
  }
  if (_cfg.channelHwCount < SS_CHANNEL_COUNT) {
    SsChannelHw &out = _cfg.channelHw[_cfg.channelHwCount++];
    out.channel_idx = channel_idx;
    strlcpy(out.inputMode, inputMode, sizeof(out.inputMode));
    out.inchingMs = inchingMs;
    markDirty(&_dirty, &_dirtySinceMs);
  }
}

void ConfigStore::setInterlockEnabled(bool enabled) {
  _cfg.interlockEnabled = enabled;
  markDirty(&_dirty, &_dirtySinceMs);
}

void ConfigStore::setLastState(uint8_t channel_idx, bool on) {
  if (channel_idx >= SS_CHANNEL_COUNT) {
    return;
  }
  _cfg.lastState[channel_idx] = on;
  markDirty(&_dirty, &_dirtySinceMs);
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
  // Deliberately NOT deferred like the other mutators above: this is the one
  // config setter whose callers (POST /api/network's local handler in
  // http_api.cpp, and cloud_client.cpp's backend-relayed equivalent) do a
  // short delay() and then ESP.restart() right after calling it, with no
  // further loop() iteration in between to ever pick up a debounced write.
  // Writing synchronously here is simpler than adding a special early-flush
  // call at each of those call sites.
  save();
}

void ConfigStore::loop() {
  if (_dirty && (int32_t)(millis() - _dirtySinceMs) >= 500) {
    save();
    _dirty = false;
  }
}
