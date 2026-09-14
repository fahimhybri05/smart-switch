#pragma once

#include <Arduino.h>
#include "board_config.h"

#define SS_MAX_SCHEDULES 16

// Field names/shapes deliberately mirror the ESP32 firmware's ss_config_t
// (firmware/components/config_store/include/config_store.h) so the app,
// backend, and future React dashboard need zero per-chip special-casing.
struct SsSwitch {
  uint8_t channel_idx = 0;
  char name[32] = {0};
  char zone[32] = {0};
  char type[8] = "ON_OFF"; // this board never sets anything else
  char default_boot_state[8] = "OFF";
};

struct SsSchedule {
  char id[12] = {0};
  uint8_t channel_idx = 0;
  char action[4] = {0};
  char type[10] = {0};
  char time[6] = {0};
  uint8_t days_mask = 0;
  uint32_t duration_s = 0;
  int64_t countdown_started_at = 0; // internal-only, not part of the wire schema
  bool enabled = true;
};

struct SsConfig {
  char device_id[16] = {0};
  char name[32] = {0};
  char board_type[16] = "ESP8266_7CH";
  uint8_t channel_count = SS_CHANNEL_COUNT;
  char channel_driver[16] = "GPIO_DIRECT";
  char fw_version[32] = "1.0.0";
  SsSwitch switches[SS_CHANNEL_COUNT];
  uint8_t switch_count = 0;
  SsSchedule schedules[SS_MAX_SCHEDULES];
  uint8_t schedule_count = 0;
  uint32_t next_schedule_id = 1;
  uint8_t auth_password_hash[32] = {0}; // raw SHA-256 digest
  bool auth_password_set = false;
  int16_t utc_offset_min = 0;
  char cloud_secret[33] = {0}; // hex-encoded 16-byte random secret

  bool staticIpEnabled = false; // false = DHCP (default)
  char staticIp[16] = {0};
  char staticGateway[16] = {0};
  char staticSubnet[16] = {0};
  char staticDns[16] = {0}; // empty = fall back to staticGateway as DNS
};

// LittleFS-backed, single JSON file (/config.json), same atomic
// write-via-temp-file pattern as the ESP32 firmware. Not thread-safe by
// mutex (single-core Arduino loop() — everything runs on one task), but
// callers must not re-enter save() from within a WebServer handler that's
// still using a pointer into cfg — copy fields out first if unsure.
class ConfigStore {
 public:
  bool begin();
  SsConfig &cfg() { return _cfg; }
  void save();

  void upsertSwitch(const SsSwitch &sw);
  void deleteSwitch(uint8_t channel_idx);

  // Create (in.id[0]=='\0') or update (in.id matches an existing schedule).
  // Returns false if in.id is set but doesn't match anything.
  bool upsertSchedule(SsSchedule &inOut);
  bool deleteSchedule(const char *id);

  void setAuthHash(const uint8_t hash[32]);
  void setUtcOffset(int16_t offset);

  // Pass enabled=false to revert to DHCP (ip/gateway/subnet/dns ignored).
  // Applied at next connect — see wifiProvisioningBegin(). dns may be ""
  // to fall back to gateway.
  void setStaticIp(bool enabled, const char *ip, const char *gateway, const char *subnet,
                    const char *dns);

 private:
  SsConfig _cfg;
  void loadDefault();
  bool loadFromDisk();
};

extern ConfigStore configStore;
