#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#define SS_MAX_CHANNELS 6 // fixed: 6ch GPIO-direct reference board, no I2C expander tier
#define SS_MAX_SCHEDULES 16

typedef struct {
    uint8_t channel_idx;
    char    name[32];
    char    zone[32];
    char    type[8];               // "ON_OFF" (DIMMER reserved, spec §2)
    char    default_boot_state[8]; // "OFF" | "ON" | "LAST"
} ss_switch_t;

typedef struct {
    char     id[12];                 // "s-<n>", server-generated
    uint8_t  channel_idx;
    char     action[4];              // "ON" | "OFF"
    char     type[10];               // "once" | "daily" | "weekly" | "countdown"
    char     time[6];                // "HH:MM", clock types only ("" for countdown)
    uint8_t  days_mask;              // bit0=Mon..bit6=Sun (ISO weekday-1); weekly only
    uint32_t duration_s;             // countdown only
    int64_t  countdown_started_at;   // unix epoch; internal-only, NOT part of spec §2
                                      // wire JSON — set by schedule_exec on create/re-arm
    bool     enabled;
} ss_schedule_t;

typedef struct {
    char        device_id[16];
    char        name[32];
    char        board_type[16];
    uint8_t     channel_count;
    char        channel_driver[16]; // "GPIO_DIRECT" | "I2C_EXPANDER" (unused on this board)
    char        fw_version[32];
    ss_switch_t switches[SS_MAX_CHANNELS];
    uint8_t     switch_count;
    ss_schedule_t schedules[SS_MAX_SCHEDULES];
    uint8_t     schedule_count;
    uint32_t    next_schedule_id;        // monotonic counter, persisted so ids never reuse
    uint8_t     auth_password_hash[32];  // raw SHA-256 digest; all-zero + !auth_password_set = unset
    bool        auth_password_set;
    int16_t     utc_offset_min;          // local = UTC + utc_offset_min; RTC/SNTP stay UTC-only
    char        cloud_secret[33];        // hex-encoded 16-byte random secret, generated once at
                                          // first boot (unconditionally, before any provisioning) —
                                          // the device's credential for the cloud WS tunnel; also
                                          // what the flash-time QR sticker encodes alongside device_id
    bool        static_ip_enabled;       // false = DHCP (default)
    char        static_ip[16];           // dotted-quad, only meaningful if static_ip_enabled
    char        static_gateway[16];
    char        static_subnet[16];
    char        static_dns[16];          // empty = fall back to static_gateway as DNS
} ss_config_t;

// Mounts the LittleFS "storage" partition at /storage and loads (or creates
// a default) config into the internal in-RAM cache. Call once at boot
// before any other config_store_* function.
esp_err_t config_store_init(void);

// Thread-safe copy of the whole in-RAM config into *out. RAM-only, no flash
// I/O — safe to call from hot paths. (Also the historical/primary way to
// read config right after config_store_init(), unchanged call site in
// main.c.)
esp_err_t config_store_load(ss_config_t *out);

// Alias of config_store_load() — RAM-only snapshot. Prefer this name in new
// call sites; config_store_load() is kept for main.c's existing call.
esp_err_t config_store_get(ss_config_t *out);

// Serializes cfg to /storage/config.json (atomic write via temp file +
// rename) AND replaces the in-RAM cache with *cfg. Most callers should use
// the narrower setters below instead of calling this directly.
esp_err_t config_store_save(const ss_config_t *cfg);

// Fills out with a fresh default config: device_id derived from the station
// MAC (matches the spec §2 "esp-7a1c2e" example), board_type "6CH_GPIO",
// channel_driver "GPIO_DIRECT", fw_version from the app description, and
// SS_CHANNEL_COUNT switches named "Channel N" defaulted to boot state OFF.
// No schedules, no auth password set.
void config_store_default(ss_config_t *out);

// --- Narrower, mutex-protected accessors (used by http_api / schedule_exec) ---

// Copies up to `max` schedules into out; *count receives how many were
// copied. RAM-only.
esp_err_t config_store_get_schedules(ss_schedule_t *out, uint8_t max, uint8_t *count);

// Create-or-update-by-id. If in->id[0] == '\0' a new id is generated
// (device-unique, monotonic) and written into *out_stored; else in->id must
// match an existing schedule (updated in place) or ESP_ERR_NOT_FOUND is
// returned. Persists to flash before returning ESP_OK.
esp_err_t config_store_set_schedule(const ss_schedule_t *in, ss_schedule_t *out_stored);
esp_err_t config_store_delete_schedule(const char *id);

// Upsert-by-channel_idx / delete-by-channel_idx for switches[].
esp_err_t config_store_set_switch(const ss_switch_t *in);
esp_err_t config_store_delete_switch(uint8_t channel_idx);

// hash is a raw 32-byte SHA-256 digest (not hex/base64) — caller hashes the
// plaintext password before calling this.
esp_err_t config_store_set_auth_hash(const uint8_t hash[32]);

// Copies the stored hash into out (undefined if *is_set comes back false —
// caller must check is_set first, don't compare against a zeroed hash as a
// stand-in for "no password").
esp_err_t config_store_get_auth_hash(uint8_t out[32], bool *is_set);

// Sets the device's local-time offset from UTC, in minutes (e.g. +330 for
// IST, -300 for EST) — applied only at schedule-match time (schedule_exec),
// never to the RTC/SNTP clock itself, which stays UTC-only. Persists to
// flash before returning ESP_OK.
esp_err_t config_store_set_utc_offset(int16_t offset_min);

// Persists a static IP config (applied at next connect, by provisioning.c —
// see docs/plan.md's /api/network). Pass enabled=false to revert to DHCP;
// ip/gateway/subnet/dns are ignored in that case (dns may be "" to fall
// back to gateway).
esp_err_t config_store_set_static_ip(bool enabled, const char *ip, const char *gateway,
                                      const char *subnet, const char *dns);
