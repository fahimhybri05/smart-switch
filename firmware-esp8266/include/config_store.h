#pragma once

#include <Arduino.h>
#include "board_config.h"

// Server-authoritative rewrite (see docs/plan.md): the backend now owns
// every switch name/zone/schedule/timezone/location/auth decision — this
// device stores none of it. What's left here is identity + networking (so
// the device can find/be found and configure its own network before any
// cloud link exists) plus the tiny hardware-actuation cache the on-device
// physical-input/interlock/inching exception needs to keep working
// instantly and correctly even while offline.
//
// Field names/shapes still deliberately mirror the ESP32 firmware's
// ss_config_t (firmware/components/config_store/include/config_store.h)
// where they overlap, so the app/backend/dashboard need zero per-chip
// special-casing for the fields that remain.

// Per-channel hardware-actuation config, populated only by the backend's
// {event:"hw_config_push", ...} frames (see cloud_client.cpp) — never by a
// local HTTP write, since this device holds no config of its own anymore.
struct SsChannelHw {
  uint8_t channel_idx = 0;
  char inputMode[10] = "DISABLED";  // "DISABLED" | "TOGGLE" | "EDGE"
  uint32_t inchingMs = 0;  // 0 = disabled; ms before an ON channel auto-reverses to OFF
};

struct SsConfig {
  char device_id[16] = {0};
  char board_type[16] = "ESP8266_6CH";
  uint8_t channel_count = SS_CHANNEL_COUNT;
  char channel_driver[16] = "GPIO_DIRECT";
  char fw_version[32] = "1.0.0";
  char cloud_secret[33] = {0}; // hex-encoded 16-byte random secret

  bool staticIpEnabled = false; // false = DHCP (default)
  char staticIp[16] = {0};
  char staticGateway[16] = {0};
  char staticSubnet[16] = {0};
  char staticDns[16] = {0}; // empty = fall back to staticGateway as DNS

  SsChannelHw channelHw[SS_CHANNEL_COUNT];
  uint8_t channelHwCount = 0;

  bool interlockEnabled = false;  // true: turning any channel ON forces every other channel OFF

  // Last state this device was ever told to hold for each channel — kept in
  // sync by channelControlSetState() (channel_control.cpp) regardless of
  // what triggered the change, and restored verbatim by main.cpp at boot.
  // Replaces the old default_boot_state business logic now that the
  // backend, not this device, decides what a channel's state should be:
  // while offline, the relay simply holds whatever it was last commanded to
  // do.
  bool lastState[SS_CHANNEL_COUNT] = {false};
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

  // Call once per loop() iteration. Flushes a pending debounced save() to
  // flash once _dirty has been stable for >=500ms — see the mutators below,
  // which set the dirty flag instead of writing to flash synchronously on
  // every call (same "debounce, don't write on every toggle" principle as
  // channel-state persistence elsewhere in this project's architecture).
  void loop();

  // Upserts one channel's hardware-actuation config — called from
  // cloud_client.cpp's hw_config_push handler.
  void setChannelHw(uint8_t channel_idx, const char *inputMode, uint32_t inchingMs);

  void setInterlockEnabled(bool enabled);

  // Called from channelControlSetState() on every state change, whatever
  // triggered it (physical input, backend command, or a LAN-forwarded
  // request the device just applied).
  void setLastState(uint8_t channel_idx, bool on);

  // Pass enabled=false to revert to DHCP (ip/gateway/subnet/dns ignored).
  // Applied at next connect — see wifiProvisioningBegin(). dns may be ""
  // to fall back to gateway.
  void setStaticIp(bool enabled, const char *ip, const char *gateway, const char *subnet,
                    const char *dns);

 private:
  SsConfig _cfg;
  bool _dirty = false;
  uint32_t _dirtySinceMs = 0;
  void loadDefault();
  bool loadFromDisk();
};

extern ConfigStore configStore;
