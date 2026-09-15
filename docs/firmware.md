# Smart Switch Firmware (`firmware/`) — Technical Reference

This document describes the ESP32/ESP-IDF firmware in `firmware/` **as actually
implemented in source**, not as originally envisioned. `docs/plan.md` and
`docs/claude_plan.md` describe an older, aspirational "serverless, no backend"
design; where the running code has since diverged (most importantly: the
firmware now includes a `cloud_client` component that talks to a real
`backend/` service over a WebSocket tunnel), this doc calls the discrepancy out
explicitly in place. Everything below is grounded in the source under
`firmware/` (main app + components), cross-checked in a few places against
`backend/src/ws/deviceServer.js`.

A separate, independently-maintained port lives in `firmware-esp8266/`
(PlatformIO/Arduino, not ESP-IDF). It is out of scope here, but is referenced
in a few places below where the ESP32 code contains a comment or QR-code field
that explicitly differentiates the two (`chip=esp32` vs the ESP8266 port's
"plain JSON form", see main.c).

---

## 1. Overview

Smart Switch firmware turns an ESP32 into a WiFi relay-switch controller with:

- A local HTTP REST API (`http_api`) for the Flutter app to control relays,
  manage switches/schedules, and reconfigure WiFi/network/auth directly over
  the LAN — no cloud dependency required for local control.
- A persistent outbound WebSocket tunnel to a backend server (`cloud_client`)
  that lets the same app (and the backend's automation engine) reach the
  device from off-LAN, by relaying HTTP-shaped commands over the socket and
  proxying them into the device's own local HTTP server via loopback.
- An on-device RTC (DS3231) + scheduler (`schedule_exec`) that fires clock- and
  countdown-based switch actions with no dependency on the app or backend
  being reachable.
- mDNS advertisement (`mdns_advertise`) for LAN discovery.
- SoftAP WiFi provisioning (`provisioning`, via ESP-IDF's `wifi_prov_mgr`) for
  first-time setup, plus a live test-before-commit-rollback WiFi reconfig path
  (`wifi_reconfig`) and a physical recovery button (`recovery_button`) for
  devices that have fallen off the network.
- Dual-partition OTA with ECDSA-signature verification and boot-health
  rollback (`ota`).

**Target hardware** (locked in, per `sdkconfig.defaults` and
`main/Kconfig.projbuild`): a plain ESP32 (WROOM-class), **4MB flash**
(`CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y`), **6-channel GPIO-direct relay board**
(`CONFIG_SS_CHANNEL_COUNT=6`, `SS_MAX_CHANNELS` in `config_store.h` is
hard-coded to 6). There is no I2C-expander channel tier implemented — the
`relay_hal` component defines an `SS_CHANNEL_DRIVER_I2C_EXPANDER` enum value
for a future higher-channel-count board, but `relay_hal_init()` returns
`ESP_ERR_NOT_SUPPORTED` for it (see §5). A DS3231 RTC shares an I2C bus with
(currently) nothing else (its only consumer is `schedule_exec`).

**Relationship to the rest of the platform:**
- The Flutter app (`app/`) is the primary local-control client: it discovers
  devices via mDNS (or a cached IP) and talks directly to `http_api`'s REST
  surface on the LAN, exactly per `docs/plan.md` §3/§4.
- `backend/` is a Node.js service the device also dials out to (WebSocket,
  `cloud_client`) for off-LAN reachability, cross-device automations, and
  activity logging — this is the part `docs/plan.md`'s "no backend" framing
  does **not** describe; it was added after that plan was written. See §14.

`version.txt` currently reads `0.1.0-scaffold` — the firmware still identifies
itself as a scaffold build even though most components (auth, OTA signature
verification, cloud tunnel, WiFi rollback) are fully implemented, not stubs.

---

## 2. Boot sequence (`main/main.c`)

`app_main()` runs the following steps, in order. Comments in the source are
detailed and are quoted below where they explain *why* an ordering choice was
made.

1. **Chip info log** — `esp_chip_info()` logged for diagnostics.
2. **`init_nvs()`** — `nvs_flash_init()`; on `ESP_ERR_NVS_NO_FREE_PAGES` or
   `ESP_ERR_NVS_NEW_VERSION_FOUND` it erases and reinitializes. Standard IDF
   idiom.
3. **`esp_netif_init()`** + **`esp_event_loop_create_default()`** — required
   before any WiFi/IP event handler registration.
4. **`ota_init()`** — cheap, non-blocking: inspects the running OTA partition's
   state and remembers (in a static `s_pending_verify` flag) whether this boot
   is a "first boot after an OTA update" that still needs confirmation. Does
   not block.
5. **`config_store_init()`** then **`config_store_load(&s_cfg)`** — mounts the
   LittleFS `storage` partition and loads (or generates-and-persists) the
   on-device JSON config into a **static** `ss_config_t s_cfg`. It's `static`
   deliberately: `network_services_task` (step 10) outlives `app_main`'s own
   stack frame, so the config can't live on `app_main`'s stack.
6. **QR sticker log line** — logs
   `smartapp://device/setup?id=%s&secret=%s&chip=esp32` with `device_id` and
   `cloud_secret` from config, once per boot, so a fresh board's provisioning
   QR sticker can be generated straight off the serial monitor after flashing.
   The `chip=esp32` field is explicitly there to let the app's QR wizard pick
   the right provisioning method versus the ESP8266 port's "plain JSON form."
7. **`init_relays_from_config(&s_cfg)`** — builds a `relay_hal_config_t` from
   the `CONFIG_SS_RELAY_CH0..5_GPIO` Kconfig pins and
   `CONFIG_SS_RELAY_ACTIVE_LOW`, calls `relay_hal_init()`, then for each
   configured switch (`cfg->switch_count` entries) sets its boot state: **only
   `ON` and `OFF` are actually applied** — `"LAST"` is not implemented (see
   §5); a code comment explicitly says persisting live channel state across
   reboots "isn't modeled yet."
8. **`init_i2c_and_rtc()`** — creates a new-style `i2c_master_bus_handle_t` on
   `CONFIG_SS_I2C_SDA_GPIO`/`CONFIG_SS_I2C_SCL_GPIO` (internal pull-ups
   enabled, glitch filter 7), calls `ds3231_init(i2c_bus)`, then
   `schedule_exec_start()`.
9. **`provisioning_init(s_cfg.device_id)`** — starts WiFi (STA+AP netifs,
   `esp_wifi_init`), disables modem sleep (`esp_wifi_set_ps(WIFI_PS_NONE)`,
   justified in a comment: this is mains-powered, not battery, and modem sleep
   was observed to add multi-second latency on the ESP8266 port), and either
   starts SoftAP provisioning (`wifi_prov_mgr`) or reconnects with stored
   credentials, depending on `wifi_prov_mgr_is_provisioned()`.
10. **`wifi_reconfig_init()`** — registers its own WiFi/IP event handlers and
    starts a background worker task (idle for now, awaiting a reconfig
    request).
11. **`recovery_button_init()`** — starts the BOOT-button poll task.
12. **`xTaskCreate(network_services_task, ...)`** — a dedicated, self-deleting
    task that: blocks on `provisioning_wait_wifi_ready(portMAX_DELAY)`, then
    calls `http_api_start()`, registers `wifi_reconfig`'s and `ota`'s HTTP
    handlers onto the same server handle, then calls `mdns_advertise_start()`.
    It runs on its own task specifically so it never blocks `app_main`'s
    boot-complete log or the OTA confirmation step (step 14) — SoftAP
    provisioning can leave WiFi unready indefinitely.
13. **`cloud_client_init()`** — starts the **persistent** (never self-deletes)
    cloud-tunnel task, called directly from `app_main` (not from
    `network_services_task`), so it begins its own
    `provisioning_wait_wifi_ready(portMAX_DELAY)` wait and later
    connect/reconnect loop independently.
14. **`ota_confirm_if_healthy(pdMS_TO_TICKS(45000))`** — fast no-op on any
    normal boot; only on the first boot after an OTA update does it block (up
    to 45s) for WiFi, then either confirms the image
    (`esp_ota_mark_app_valid_cancel_rollback()`) or forces a rollback+reboot to
    the previous slot.
15. Final boot-complete log line, printing `device_id`, `board_type`,
    `channel_count`, `fw_version`, and `provisioning_is_provisioned()`.

Notably, `http_api_start()` (and therefore the whole REST API) is *not*
started synchronously in `app_main` — it's deferred to `network_services_task`
until WiFi is actually up, so `app_main` itself returns quickly regardless of
provisioning state.

---

## 3. Partition layout (`partitions.csv`)

```
# Name,     Type, SubType,  Offset,  Size,   Flags
nvs,        data, nvs,      ,        0x6000,
otadata,    data, ota,      ,        0x2000,
phy_init,   data, phy,      ,        0x1000,
ota_0,      app,  ota_0,    ,        1536K,
ota_1,      app,  ota_1,    ,        1536K,
storage,    data, littlefs, ,        256K,
```

- **`nvs`** (24KB) — standard ESP-IDF key-value store. Used underneath by
  `esp_wifi`/`wifi_prov_mgr` for STA credentials (and their WIFI_STORAGE_FLASH
  persistence in `wifi_reconfig`), and by `nvs_flash_init()` generically. The
  device's own JSON config is **not** stored here (see §4).
- **`otadata`** (8KB) — the OTA selector partition (`esp_ota_ops` state:
  which of `ota_0`/`ota_1` is active, and per-slot `ESP_OTA_IMG_*` state such
  as `PENDING_VERIFY`).
- **`phy_init`** (4KB) — RF calibration data, standard IDF partition.
- **`ota_0` / `ota_1`** (1536KB each) — the two app-image slots for dual-OTA.
  A source comment explains there is **no `factory` slot** deliberately: this
  IDF's bootloader (`bootloader_utility.c`, verified against the installed
  checkout) boots `ota_0` by default when `otadata` is blank, so a `factory`
  partition isn't needed to get a fresh device booting.
- **`storage`** (256KB) — a LittleFS partition (`joltwallet/littlefs`
  managed component) that holds the device's own JSON config file (see §4).

`sdkconfig.defaults` sets `CONFIG_PARTITION_TABLE_CUSTOM=y`,
`CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"`, and
`CONFIG_PARTITION_TABLE_OFFSET=0x8000`, plus
`CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y` to match this budget
(6KB+8KB+4KB+1536KB+1536KB+256KB ≈ 3.34MB, comfortably inside 4MB with the
bootloader/partition-table region at the start).

`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` is turned **on** in
`sdkconfig.defaults`. A comment explains the history: it was previously left
off deliberately, because turning it on without a confirmation call in the
app would leave every boot stuck in `PENDING_VERIFY` and rollback-loop on the
next reset — it's enabled now specifically because `main.c` provides the
matching `ota_confirm_if_healthy()` call (see §13).

---

## 4. Config storage (`config_store`)

### Storage medium: **LittleFS, not NVS**

`config_store_init()` mounts the `storage` partition as LittleFS at
`/storage` via `esp_vfs_littlefs_register()` (`format_if_mount_failed = true`).
The config is a single JSON file at `/storage/config.json`, written atomically
via a temp file + `rename()`:  `write_json_locked()` writes to
`/storage/config.json.tmp` then renames it over `/storage/config.json`. NVS
is used elsewhere in the firmware (WiFi credentials via `wifi_prov_mgr`), but
**not** for this component's data.

An in-RAM cache (`static ss_config_t s_cfg`, guarded by a FreeRTOS mutex
`s_mutex`) is the source of truth for reads; `config_store_get()` /
`config_store_load()` (an alias — `config_store_load()` is kept only because
it's `main.c`'s existing call site, per a comment) do a mutex-protected
`memcpy`, no flash I/O.

### Schema (`ss_config_t`, `config_store.h`)

```c
#define SS_MAX_CHANNELS 6
#define SS_MAX_SCHEDULES 16

typedef struct {
    uint8_t channel_idx;
    char    name[32];
    char    zone[32];
    char    type[8];               // "ON_OFF" (DIMMER reserved)
    char    default_boot_state[8]; // "OFF" | "ON" | "LAST"
} ss_switch_t;

typedef struct {
    char     id[12];                 // "s-<n>", server-generated
    uint8_t  channel_idx;
    char     action[4];              // "ON" | "OFF"
    char     type[10];               // "once" | "daily" | "weekly" | "countdown"
    char     time[6];                // "HH:MM", clock types only
    uint8_t  days_mask;              // bit0=Mon..bit6=Sun (ISO weekday-1), weekly only
    uint32_t duration_s;             // countdown only
    int64_t  countdown_started_at;   // internal-only, NOT part of the HTTP wire schema
    bool     enabled;
} ss_schedule_t;

typedef struct {
    char        device_id[16];
    char        name[32];
    char        board_type[16];
    uint8_t     channel_count;
    char        channel_driver[16]; // "GPIO_DIRECT" | "I2C_EXPANDER" (unused on this board)
    char        fw_version[32];
    ss_switch_t   switches[SS_MAX_CHANNELS];
    uint8_t       switch_count;
    ss_schedule_t schedules[SS_MAX_SCHEDULES];
    uint8_t       schedule_count;
    uint32_t    next_schedule_id;        // monotonic, persisted so ids never reuse
    uint8_t     auth_password_hash[32];  // raw SHA-256 digest
    bool        auth_password_set;
    int16_t     utc_offset_min;          // local = UTC + utc_offset_min; RTC/SNTP stay UTC-only
    char        cloud_secret[33];        // hex-encoded 16-byte random secret
    bool        static_ip_enabled;       // false = DHCP (default)
    char        static_ip[16];
    char        static_gateway[16];
    char        static_subnet[16];
    char        static_dns[16];          // empty = fall back to gateway as DNS
} ss_config_t;
```

On-disk JSON keys mirror the struct closely; some fields not part of the
plan.md "spec" wire schema are persisted with a leading underscore to mark
them as config-store-internal: `_next_schedule_id`, `_static_ip_enabled`,
`_static_ip`, `_static_gateway`, `_static_subnet`, `_static_dns`,
`_auth_password_set`, `_auth_password_hash` (hex string), `_cloud_secret`, and
(inside each schedule object) `_countdown_started_at`. `http_api.c` builds its
own response JSON separately and always omits `_countdown_started_at` from
what it sends to callers — that field is disk-format/internal only.

### Default config generation (`config_store_default()`)

Called when `/storage/config.json` doesn't exist (`ESP_ERR_NOT_FOUND` from
`read_json`):
- `device_id` = `"esp-%02x%02x%02x"` from the last 3 bytes of the station MAC
  (`esp_read_mac(ESP_MAC_WIFI_STA)`), matching the plan's `esp-7a1c2e` example
  format.
- `name` = `"Smart Switch <device_id>"`.
- `board_type` = `"6CH_GPIO"`, `channel_driver` = `"GPIO_DIRECT"`.
- `channel_count` = `SS_MAX_CHANNELS` (6).
- `fw_version` from `esp_app_get_description()->version` (i.e. the build's
  actual version, not hardcoded).
- 6 switches generated, named `"Channel 0"`..`"Channel 5"`, `type="ON_OFF"`,
  `default_boot_state="OFF"`, empty `zone`.
- No schedules (`schedule_count = 0`), `next_schedule_id = 1`.
- `auth_password_set = false` (device ships/reset "open").
- `utc_offset_min = 0`.
- `cloud_secret` — a **fresh random 16-byte secret, hex-encoded**, generated
  unconditionally via `esp_fill_random()` at first boot, *before any
  provisioning* — this is the device's WS-tunnel credential (see §14) and
  also what the printed/QR setup sticker encodes alongside `device_id`.

There's also a migration path in `config_store_init()`: if an existing config
loads successfully but has an empty `cloud_secret` (i.e. it predates that
field), a new secret is generated and persisted on the spot, rather than
requiring a factory reset.

### Persistence API surface

`config_store_save()` (whole-struct write), plus narrower mutex-protected
accessors used by `http_api`/`schedule_exec`: `config_store_get_schedules()`,
`config_store_set_schedule()` (create-if-`id==""`, else update-by-id, returns
`ESP_ERR_NOT_FOUND` if the id doesn't exist, `ESP_ERR_NO_MEM` if
`SS_MAX_SCHEDULES` is full), `config_store_delete_schedule()`,
`config_store_set_switch()` / `config_store_delete_switch()` (upsert/delete
keyed by `channel_idx`), `config_store_set_auth_hash()` /
`config_store_get_auth_hash()`, `config_store_set_utc_offset()`, and
`config_store_set_static_ip()`. Every mutating call persists to flash before
returning `ESP_OK` (there is no deferred/batched flush).

---

## 5. Relay HAL (`relay_hal`)

`relay_hal_config_t` carries a `driver` enum
(`SS_CHANNEL_DRIVER_GPIO_DIRECT` or `SS_CHANNEL_DRIVER_I2C_EXPANDER`),
`channel_count`, a `gpio_pins[]` array, and `active_low`.

- **GPIO-direct is the only implemented driver.** `relay_hal_init()`
  configures each pin as `GPIO_MODE_OUTPUT` (no pull resistors, interrupts
  disabled) and drives it to its "off" level immediately
  (`gpio_set_level(pin, active_low ? 1 : 0)`).
- **`SS_CHANNEL_DRIVER_I2C_EXPANDER` is explicitly not implemented**:
  `relay_hal_init()` logs an error ("I2C expander HAL is not implemented —
  this board is GPIO-direct only") and returns `ESP_ERR_NOT_SUPPORTED`
  immediately. The header marks this "phase 4 — not implemented in scaffold."
- `channel_count` is capped at a component-local `SS_RELAY_HAL_MAX_CHANNELS`
  (hardcoded to 6) — a code comment flags that this **must track**
  `config_store.h`'s `SS_MAX_CHANNELS` by convention only; nothing enforces
  they move together at compile time (the component deliberately doesn't
  include `config_store.h`).
- State is tracked in a `static bool s_state[]` array and mutated/read under
  a mutex with a 50ms timeout (`relay_hal_set_state`/`relay_hal_get_state`
  return `ESP_ERR_TIMEOUT` on contention).
- `relay_hal_channel_count()` returns the configured count for other
  components (`http_api`, `mdns_advertise`, `schedule_exec`) to bound
  channel-index validation against.

### Boot-state handling: OFF/ON implemented, LAST is not

`ss_switch_t.default_boot_state` supports the strings `"OFF"`, `"ON"`, and
`"LAST"` at the schema level (`http_api`'s switch-body parser even validates
and accepts all three), but `main.c`'s `init_relays_from_config()` only acts
on `strcmp(sw->default_boot_state, "ON") == 0` — anything else (including
`"LAST"`) is treated as OFF at boot. The code comment is explicit: *`"LAST"
requires persisting live channel state across reboots, which isn't modeled
yet — OFF/ON only at boot for now.*` This is a real, named gap: the field can
be set via the API but has no boot-time effect for `"LAST"`.

---

## 6. HTTP API (`http_api` + `http_uri_parse` + `http_auth`)

`http_api_start()` starts one `esp_http_server` instance
(`HTTPD_DEFAULT_CONFIG()` base, `max_uri_handlers = 14`, `stack_size = 8192`
for the cJSON + mbedtls stack frames on the auth path, and
`uri_match_fn = httpd_uri_match_wildcard` to allow `/*` wildcard registrations
for path-parameter routes). It registers 11 handlers directly; `wifi_reconfig`
and `ota` each register one more onto the same server handle
(`http_api_get_server_handle()`), for 13 total. This is the single HTTP
surface both the LAN app and `cloud_client`'s loopback proxy hit.

Body reads use a shared `read_body()` helper: `ESP_ERR_INVALID_SIZE` (body
too large for the stack buffer, mapped to 400) vs `ESP_FAIL` (a real socket
error, in which case the handler must return `ESP_FAIL` without sending a
response so `httpd` can close the connection) are distinguished explicitly in
comments.

Every authenticated handler starts with `if (!http_auth_check(req)) { return
ESP_OK; }` — `http_auth_check()` (see below) has already sent the appropriate
error response in that case.

### Full endpoint table

| Method | Path | Auth | Request body | Response | Notes |
|---|---|---|---|---|---|
| GET | `/api/info` | **none** (unauthenticated by design) | — | `{device_id, board_type, channel_count, fw_version, wifi_reconfig_state, cloud_secret, time_known_good, now_epoch, capabilities:["switch"]}` | Discovery/confirm endpoint. `cloud_secret` is deliberately exposed here unauthenticated — same reachability boundary as the rest of this endpoint, read by the app's manual/advanced add-device fallback. `wifi_reconfig_state` is a non-spec extension letting the app poll the outcome of an async `/api/wifi` call. |
| GET | `/api/config` | required | — | `{device_id, name, board_type, channel_count, channel_driver, fw_version, utc_offset_min, network:{mode, ip?, gateway?, subnet?, dns?}, switches:[...], schedules:[...]}` | Full config dump. |
| POST | `/api/switches` | required | `{channel_idx (required), name?, zone?, default_boot_state?}` | 200: the stored switch object | `type` is always forced to `"ON_OFF"` server-side. `default_boot_state` accepted values: `ON`/`OFF`/`LAST` (else defaults to `OFF`). 400 if `channel_idx` missing/invalid or out of `relay_hal_channel_count()` range; 500 on persist failure. |
| DELETE | `/api/switches/*` (path form `/api/switches/:channel_idx`) | required | — | `{"status":"deleted"}` | 400 on unparsable index; 404 if no switch at that channel; 500 on persist failure. |
| GET | `/api/channels` | required | — | `[{channel_idx, state:"ON"|"OFF"}, ...]` | Live relay state snapshot, for polling. |
| POST | `/api/channels/*` (path form `/api/channels/:idx/state`) | required | `{"state":"ON"|"OFF"}` | `{channel_idx, state}` | **Hot path** — deliberately kept synchronous/trivial, touches only `relay_hal` (no flash I/O). Also calls `cloud_client_notify_state_changed()`. 400 on bad index/body. |
| POST | `/api/schedules` | required | `{id? (empty=create), channel_idx, action:"ON"|"OFF", type:"once"|"daily"|"weekly"|"countdown", time?, days?[1-7], duration_s?, enabled?(default true)}` | The stored schedule object | Delegates to `schedule_exec_upsert()` for validation/id-generation/countdown-arming, then `config_store`. 400 invalid fields, 404 unknown id (update), 400 schedule-limit-reached (create), 500 persist failure. |
| DELETE | `/api/schedules/*` (path form `/api/schedules/:id`) | required | — | `{"status":"deleted"}` | 400 bad id in path, 404 not found, 500 persist failure. |
| POST | `/api/auth/password` | **conditional**: required only if a password is *already* set | `{"password": "1-128 chars"}` | `{"status":"ok"}` | SHA-256-hashes the password (`mbedtls_sha256`) and stores the raw digest via `config_store_set_auth_hash()`. This is how a fresh/unclaimed device gets its first password (no auth needed then); once set, changing it requires the current password. |
| POST | `/api/timezone` | required | `{"utc_offset_min": -720..840}` | `{"utc_offset_min": N}` | Persists via `config_store_set_utc_offset()`. Applied only at schedule-match time in `schedule_exec`, never to the RTC itself. |
| POST | `/api/network` | required | `{"mode":"dhcp"}` or `{"mode":"static","ip","gateway","subnet","dns"?}` | `{"ok":true,"rebooting":true}` then the device reboots (`esp_restart()` after a 500ms delay) | Persists via `config_store_set_static_ip()`; `provisioning.c`'s `apply_static_ip_if_configured()` applies it on the next connect. |
| POST | `/api/wifi` (registered by `wifi_reconfig.c`) | required | `{"ssid":"1-32 chars","password":"0 or 8-63 chars"}` | **202 Accepted** `{"state":"TESTING"}` (always async) | See §9. 400 invalid ssid/password length, 409 a test is already in progress. |
| POST | `/api/ota` (registered by `ota.c`) | required, plus `X-Firmware-Signature` header | raw firmware binary | 200 `{"status":"ok","rebooting":true}` then reboot | See §13. 400 missing/invalid signature header, image too large, or signature verification failed; 409 if the running image itself is still unconfirmed; 500 on flash/finalize failure. |

### `http_uri_parse` helpers

Two small parsing helpers used for the path-parameter routes above (since
`esp_http_server`'s wildcard matching doesn't itself extract path segments):
- `http_uri_parse_uint(uri, prefix, suffix, &out)` — extracts a non-negative
  integer between `prefix` and `suffix` (`suffix == NULL` means "must reach
  end of string, optionally followed by `?query`"). Used for
  `/api/switches/:idx` and `/api/channels/:idx/state`.
- `http_uri_parse_str(uri, prefix, out, out_size)` — copies the remainder
  after `prefix` (trimmed at `?`) for non-numeric params like schedule ids.
  Used for `/api/schedules/:id`.

### `http_auth` — Basic Auth, loopback bypass, and lockout

`http_auth_check(req)`:
1. **Loopback bypass**: if the peer socket's address is `127.0.0.1` (IPv4,
   IPv6 `::1`, or IPv4-mapped-IPv6 `::ffff:127.0.0.1` — all three checked via
   `getpeername()`), the request is authorized unconditionally, no password
   check at all. The comment explains this is intentional and safe: only a
   process *on the device itself* can present a loopback source address to
   lwIP, and it's specifically how `cloud_client`'s relayed-command loopback
   proxy (see §14) reaches password-protected endpoints — cloud-side auth
   already happened at the WS tunnel layer (`deviceId` + `cloud_secret`)
   before that loopback call is ever made.
2. **Unclaimed device**: if `config_store_get_auth_hash()` reports no
   password set, the request is authorized (`true`) — "open until a password
   is configured" (matches `POST /api/auth/password`'s conditional-auth
   behavior above).
3. **Lockout check**: a **global** (not per-source-IP), **RAM-only**
   (resets on reboot) failure counter. After `LOCKOUT_THRESHOLD = 5`
   consecutive failures, an escalating backoff window is armed:
   `LOCKOUT_BASE_S=30` doubling per additional failure
   (`30,60,120,240,480→capped`), capped at `LOCKOUT_MAX_S=300`. While locked
   out, requests get `429 Too Many Requests` + `Retry-After` header. The
   comment notes this is safe as a plain global (not per-connection) because
   `esp_http_server`'s default config runs a single worker task here, so
   handler dispatch is already serialized.
4. **Basic Auth parse + check**: requires an `Authorization: Basic
   <base64(user:pass)>` header (username is ignored — only the part after
   the first `:` is used as the password); the presented password is
   SHA-256'd and compared to the stored hash using
   `mbedtls_ct_memcmp` (constant-time comparison, to resist timing attacks).
   On any failure: `record_failure()` then `401 Unauthorized` +
   `WWW-Authenticate: Basic realm="smart-switch"`. On success, the failure
   counter and lockout are both reset to zero.

---

## 7. mDNS advertisement (`mdns_advertise`)

`mdns_advertise_start(device_id, name, board_type, channel_count)`:
- `mdns_init()`, then `mdns_hostname_set(device_id)` and
  `mdns_instance_name_set(name)`.
- Registers one service: `mdns_service_add(name, "_esp-switch", "_tcp", 80,
  txt, 3)` — i.e. **service type `_esp-switch._tcp`**, advertised instance
  name = the device's configured `name` (e.g. `"Smart Switch esp-a1b2c3"`),
  port 80.
- **TXT records**: exactly three — `device_id`, `board_type`,
  `channel_count` (the last stringified via `snprintf` into a 4-byte buffer).

This matches `docs/plan.md` §4's description of mDNS discovery
(`_esp-switch._tcp.local` with `device_id`/`board_type`/`channel_count` TXT
records) essentially verbatim. Uses the `espressif/mdns` managed component
(`^1.12` per `idf_component.yml`, resolved to `1.12.0` in
`dependencies.lock`).

`mdns_advertise_stop()` calls `mdns_free()` if previously started; not
observed to be called anywhere in the read call sites (it's provided but
appears unused in the current boot flow).

---

## 8. Provisioning (`provisioning`)

Built directly on ESP-IDF's `wifi_provisioning` component
(`wifi_prov_mgr` + `scheme_softap`) — this is a real implementation, not a
stub (contrast with `docs/claude_plan.md`'s scaffold notes, which describe an
earlier stub-only state before real SoftAP/credential exchange was added).

`provisioning_init(device_id)`:
1. Creates default STA and AP netifs, `esp_wifi_init()`,
   `esp_wifi_set_ps(WIFI_PS_NONE)` (see §2 rationale).
2. Registers its own `WIFI_EVENT`/`IP_EVENT` handler
   (`wifi_event_handler`): auto-reconnects on `WIFI_EVENT_STA_START` and
   `WIFI_EVENT_STA_DISCONNECTED` (unless
   `provisioning_set_auto_reconnect_suspended(true)` has been called — used
   by `wifi_reconfig` to avoid racing its own test-connect), and on
   `IP_EVENT_STA_GOT_IP` sets `PROVISIONING_WIFI_READY_BIT` in an event group
   — a one-shot "safe to start HTTP/mDNS" gate that, per the header comment,
   is **never cleared** again once set (transient WiFi drops don't undo it).
3. Initializes `wifi_prov_mgr` with `scheme = wifi_prov_scheme_softap` and
   `scheme_event_handler = WIFI_PROV_EVENT_HANDLER_NONE`, then checks
   `wifi_prov_mgr_is_provisioned()`.
4. **If not provisioned**: registers a `WIFI_PROV_EVENT` handler
   (`prov_event_handler` — logs start/cred-received/cred-fail/cred-success,
   calls `wifi_prov_mgr_reset_sm_state_on_failure()` on auth failure, and
   `wifi_prov_mgr_deinit()` on `WIFI_PROV_END`), then starts provisioning via
   `wifi_prov_mgr_start_provisioning(WIFI_PROV_SECURITY_1, pop, service_name,
   NULL)` where:
   - `service_name` = `"SmartSwitch-<device_id>"` (the SoftAP SSID).
   - **Proof-of-possession (POP) == `device_id` itself.** A comment marks
     this as a known limitation, not a bug: since `device_id` is also visible
     in the broadcast SoftAP SSID, this only proves "you can read a WiFi scan
     list," not real physical possession — accepted given the physical-
     proximity threat model and the fact that this hardware has no secure
     element and no display for a per-device printed secret.
   - Security scheme is `WIFI_PROV_SECURITY_1` (encrypted handshake, not
     the low-security/no-encryption scheme).
5. **If already provisioned**: deinits the prov manager,
   `apply_static_ip_if_configured()` (reads `config_store`'s
   `static_ip_enabled`/`static_ip`/`static_gateway`/`static_subnet`/
   `static_dns`, and if enabled, stops the DHCP client and calls
   `esp_netif_set_ip_info()`/`esp_netif_set_dns_info()` on the STA netif —
   falling back to DHCP with a logged error if any of the stored IP strings
   fail to parse), sets `WIFI_MODE_STA`, `esp_wifi_start()`. The actual
   connect happens via the `WIFI_EVENT_STA_START` handler registered in step
   2.

Other exposed functions: `provisioning_is_provisioned()`,
`provisioning_get_event_group()`, `provisioning_wait_wifi_ready(ticks)`
(convenience wrapper waiting on `PROVISIONING_WIFI_READY_BIT`, used
extensively by `network_services_task`, `ota_confirm_if_healthy`, and
`cloud_client_task`), and `provisioning_set_auto_reconnect_suspended(bool)`.

**Hand-off to `wifi_reconfig`**: `wifi_reconfig.c` registers its own,
*independent* `WIFI_EVENT`/`IP_EVENT` handler instance on the same default
event loop (IDF dispatches to every registered handler) — there's no direct
call from `provisioning` into `wifi_reconfig`; they cooperate only via the
shared event loop and the `provisioning_set_auto_reconnect_suspended()` flag
that lets `wifi_reconfig`'s worker task suppress `provisioning`'s auto-
reconnect while it runs its own test-connect.

---

## 9. WiFi reconfig (`wifi_reconfig`)

Implements a real **test-before-commit-rollback** flow, matching
`docs/plan.md` §5's design intent (though delivered asynchronously — see the
"DEVIATION #1" note in the header, referenced from the source itself).

State machine (`wifi_reconfig_state_t`): `IDLE → TESTING → CONNECTED` or
`TESTING → FAILED_ROLLED_BACK`.

- **`wifi_reconfig_request(ssid, password)`** (called from the HTTP handler,
  see below) validates `ssid` length (1-32) and `password` length (0, or
  8-63), rejects with `ESP_ERR_INVALID_STATE` if a test is already running,
  caches the current STA config (`esp_wifi_get_config`), builds the candidate
  config, sets state to `TESTING`, and arms a one-shot `esp_timer`
  (`DEFER_MS = 700`ms) — the defer exists specifically so the HTTP 202
  response has time to round-trip to the client before the radio drops.
- The timer callback (`defer_timer_cb`, runs on IDF's shared `esp_timer`
  task — kept trivial per its comment) just notifies a dedicated
  `worker_task` via `xTaskNotifyGive`, so the actual up-to-~20s wait never
  stalls other timers (e.g. `schedule_exec`'s 1Hz tick).
- **`worker_task`**: suspends `provisioning`'s auto-reconnect
  (`provisioning_set_auto_reconnect_suspended(true)`), switches WiFi storage
  to RAM (`WIFI_STORAGE_RAM` — so a failed test never touches flash),
  disconnects, applies the candidate config, arms its own event handler
  (`s_test_armed = true`), reconnects, and waits up to `TEST_TIMEOUT_MS =
  20000` ms on an event group for either `TEST_CONNECTED_BIT`
  (`IP_EVENT_STA_GOT_IP`) or `TEST_DISCONNECTED_BIT`
  (`WIFI_EVENT_STA_DISCONNECTED`).
  - **On success**: switches storage back to `WIFI_STORAGE_FLASH`, re-applies
    the candidate config (now persisted to flash), state →
    `WIFI_RECONFIG_STATE_CONNECTED`.
  - **On failure/timeout**: disconnects, restores flash storage with the
    **cached** config, reconnects, state →
    `WIFI_RECONFIG_STATE_FAILED_ROLLED_BACK`.
  - Either way, re-enables `provisioning`'s auto-reconnect afterward.
- `on_wifi_event()` only reacts `if (s_test_armed)` — this specifically
  avoids the pre-test `esp_wifi_disconnect()` call's own disconnect event
  being mistaken for "candidate connect failed."

**Trigger**: `POST /api/wifi` (`handle_post_wifi`, registered by
`wifi_reconfig_register_http_handlers()` onto the shared `http_api` server).
Requires `http_auth_check()`. Parses `{"ssid", "password"?}`, calls
`wifi_reconfig_request()`, and **always responds asynchronously**:
`ESP_ERR_INVALID_ARG → 400`, `ESP_ERR_INVALID_STATE → 409 Conflict` ("a
reconfig test is already in progress"), otherwise `ESP_OK → 202 Accepted
{"state":"TESTING"}`. The header's own comment ("DEVIATION #1") states this
can never be synchronous on a single-radio ESP32 — the app is expected to
learn the real outcome later via `GET /api/info`'s `wifi_reconfig_state`
field (§6), which calls `wifi_reconfig_state_str(wifi_reconfig_get_state())`.

---

## 10. Recovery button (`recovery_button`)

Polls `CONFIG_SS_BOOT_BUTTON_GPIO` (default GPIO0, active-low, internal
pull-up enabled) every `POLL_MS = 100`ms from a dedicated task
(`recovery_button_init()` → `xTaskCreate(button_task, ...)`).

Exact logic (`button_task`), confirmed from source — **do not** assume the
plan doc's numbers/behavior without checking the actual thresholds, which are
Kconfig-configurable but default to:
- `CONFIG_SS_BOOT_SHORT_HOLD_MS = 5000` (5s)
- `CONFIG_SS_BOOT_LONG_HOLD_MS = 12000` (12s)

```c
if (button is pressed /* level == 0 */) {
    held_ms += POLL_MS;
    if (held_ms >= CONFIG_SS_BOOT_LONG_HOLD_MS) {
        do_factory_reset();  // fires immediately, WHILE STILL HELD, never returns
    }
} else /* released */ {
    if (held_ms >= CONFIG_SS_BOOT_SHORT_HOLD_MS) {
        do_network_reset();  // fires ONLY on release, never returns
    }
    held_ms = 0;
}
```

So concretely:
- **Held ≥ 12s** (long hold): `do_factory_reset()` fires the instant the
  12000ms threshold is crossed, *without waiting for release*. This calls
  `wifi_prov_mgr_reset_provisioning()` (equivalent to `esp_wifi_restore()` —
  scoped to WiFi-only NVS state) **and** `esp_littlefs_format("storage")`
  (wipes switches/schedules/auth/cloud_secret — the whole config_store
  partition), then `esp_restart()`. Log: *"long hold: full factory reset
  (WiFi + switches/schedules wiped)"*.
- **Held ≥ 5s but released before 12s** (short hold): on release,
  `do_network_reset()` fires: calls only `wifi_prov_mgr_reset_provisioning()`
  (WiFi credentials only — explicitly does **not** touch the `storage`
  LittleFS partition, per its comment) then `esp_restart()`. Log: *"short
  hold: resetting WiFi provisioning only (switches/schedules kept)"*.
- **Held < 5s**: `held_ms` resets to 0 on release, no action.

This matches `docs/plan.md` §5/§10's intent (short=network-only,
long=factory-reset, kept distinct so a router change doesn't cost switch
labels) with concrete, Kconfig-adjustable thresholds of 5000/12000ms rather
than the plan's approximate "~5s"/"~10–15s" language.

---

## 11. DS3231 RTC (`ds3231`)

A minimal register-level I2C driver against the new-style
`driver/i2c_master.h` API (`i2c_master_bus_handle_t` / `i2c_master_dev_handle_t`).

- **`ds3231_init(bus)`** — adds the DS3231 as a 7-bit-address device
  (`DS3231_ADDR = 0x68`) on an already-created bus (100kHz,
  `I2C_TIMEOUT_MS = 1000`); does not create the bus itself (owned by
  `main.c`'s `init_i2c_and_rtc()`).
- **`ds3231_get_time(ds3231_time_t *out)`** — reads 7 bytes starting at
  register `0x00` (seconds/minutes/hours/day/date/month/year), converts
  BCD→decimal (`bcd2dec`), masks the 12/24-hour bit out of the hours byte
  (`& 0x3F`, i.e. always read as 24h), ignores the century bit in the month
  byte ("valid through 2099"), and derives `year = 2000 + bcd2dec(byte6)`.
- **`ds3231_set_time(const ds3231_time_t *in)`** — writes the same 7 registers,
  forcing 24h mode (clears bit 6 of the hours byte) and encoding
  `year - 2000` back to BCD.
- **`ds3231_get_osf(bool *osf_set)`** / **`ds3231_clear_osf()`** — read/clear
  the oscillator-stop-flag, status register `0x0F` bit 7
  (`DS3231_OSF_BIT = 0x80`). This flag is set whenever the RTC has lost power
  or has never had its time set.

### Dependency from `schedule_exec`

`schedule_exec_start()` calls `ds3231_get_osf()` at boot: if the read fails
or OSF is set, `s_time_known_good` starts `false` and the scheduler will not
fire any schedule until the clock is proven trustworthy. SNTP
(`esp_netif_sntp_init`, non-blocking, `pool.ntp.org`) runs in parallel; its
sync callback (`sntp_sync_cb`) writes the SNTP-derived wall time back into
the DS3231 via `ds3231_set_time()` + `ds3231_clear_osf()` ("RTC healed from
SNTP sync") and sets `s_time_known_good = true` regardless of whether the I2C
write to the RTC itself succeeded (the system clock is already correct from
SNTP by that point). At scheduling-tick time, `get_now()` prefers the DS3231
reading and only falls back to the SNTP-synced system clock
(`time(NULL)`/`localtime_r`) if the I2C read fails.

---

## 12. Schedule execution (`schedule_exec`)

A single 1Hz FreeRTOS task (`scheduler_task` → `scheduler_tick()`,
`xTaskCreate(..., "schedule_exec", 4096, ..., tskIDLE_PRIORITY + 3, ...)`),
started by `schedule_exec_start()` (called from `main.c`'s
`init_i2c_and_rtc()`, so it's running well before WiFi comes up).

`schedule_exec_start()` also forces `TZ=UTC0` (`setenv`+`tzset`) — **all
internal time handling stays UTC**; the device's configured
`utc_offset_min` (§4) is only ever applied at match-time in `scheduler_tick`,
never to the RTC or system clock.

### Data model recap (from `ss_schedule_t`, §4)

Two families, distinguished by `type`:
- **Clock-based**: `"once"`, `"daily"`, `"weekly"` — matched against
  `time` (`"HH:MM"`, validated by `parse_hhmm()`) in **local** time
  (`epoch + utc_offset_min*60`, `gmtime_r`'d to get local `tm`). `"weekly"`
  additionally checks `days_mask` against the ISO weekday
  (`bit0=Mon..bit6=Sun`).
- **Countdown**: matched against `duration_s` and the internal
  `countdown_started_at` (a raw UTC epoch, set by `schedule_exec_upsert()`),
  **not** wall-clock/local-time adjusted.

### Firing logic (`scheduler_tick`, runs every 1s)

1. If `!s_time_known_good`, returns immediately — no schedule fires on
   unverified clock data.
2. Gets current time (`get_now`), and separately computes `local_tm` by
   applying `cfg.utc_offset_min`.
3. For each enabled schedule:
   - **Countdown**: fires if `epoch >= countdown_started_at + duration_s`
     (and `countdown_started_at > 0`); on fire, calls `fire()` then
     `self_disable()` (persists `enabled=false` via
     `config_store_set_schedule()`) — countdown schedules are one-shot per
     arm.
   - **Clock types**: requires `parse_hhmm(s->time)` to succeed; matches if
     `local_tm.tm_hour==h && local_tm.tm_min==m && tmv.tm_sec < 5` — a
     **5-second window**, not an exact-second match. A comment explains why:
     the tick is ~1Hz but not guaranteed to land exactly on `:00` (HTTP/WS
     traffic can delay an iteration), so requiring an exact match risked
     silently skipping the whole day's fire. A per-schedule "fire guard"
     (`s_fire_guard[]`, keyed by schedule id, storing `last_fired_minute`)
     prevents firing more than once inside that 5-second window even though
     multiple ticks can land in it. `"weekly"` additionally requires
     `days_mask` to include the current ISO weekday. `"once"` self-disables
     after firing (like countdown); `"daily"`/`"weekly"` do not.
4. **`fire(sched)`**: calls `relay_hal_set_state(channel_idx, action=="ON")`
   then `cloud_client_notify_state_changed(channel_idx, on)` — so a
   schedule-driven change is pushed up the cloud tunnel too, if connected.

### Validation/CRUD (`schedule_exec_upsert`, called from `POST /api/schedules`)

Validates `channel_idx < relay_hal_channel_count()`, `action` is `ON`/`OFF`,
`type` is one of the 4 known values, clock types have a parseable `time`, and
countdown types have `duration_s != 0`. On create (`id==""`), a countdown
schedule gets `countdown_started_at = time(NULL)` immediately. On update, a
countdown schedule only gets its start time reset if it's transitioning
`enabled: false → true` ("re-arm"); a plain edit that stays enabled does not
restart the countdown. Delegates the actual id-generation/persistence to
`config_store_set_schedule()`.

`schedule_exec_time_is_known_good()` and `schedule_exec_now_epoch()` back the
diagnostic fields on `GET /api/info` (§6).

---

## 13. OTA (`ota`)

Built on ESP-IDF's `esp_ota_ops` + a **detached ECDSA-P256 signature**
verified via mbedTLS — this is real, implemented signature verification, not
a plain checksum.

- **`ota_init()`** (called early in `main.c`, right after the event loop is
  created): checks if the *running* partition's OTA state is
  `ESP_OTA_IMG_PENDING_VERIFY` and if so sets `s_pending_verify = true`
  (logged as "running image is pending verification (post-OTA first boot)").
- **`ota_confirm_if_healthy(timeout_ticks)`** (called at the very end of
  `app_main`, §2 step 14): fast no-op unless `s_pending_verify`. If pending,
  waits (up to `timeout_ticks`, called with 45000ms from `main.c`) for
  `provisioning_wait_wifi_ready()`; on success calls
  `esp_ota_mark_app_valid_cancel_rollback()` (image confirmed good — this is
  the counterpart that makes `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` safe,
  see §3); on timeout calls
  `esp_ota_mark_app_invalid_rollback_and_reboot()` (does not return — forces
  a hard rollback to the previous slot).
- **Upload session** (`ota_apply_update_begin/write/finish/abort`, an opaque
  `ota_session_handle_t` pointing at a single static `s_session` — only one
  concurrent OTA session is supported):
  - `ota_apply_update_begin(size_hint, &handle)`: refuses
    (`ESP_ERR_OTA_ROLLBACK_INVALID_STATE`) if the *currently running* image
    is itself still `PENDING_VERIFY` — a device must confirm its current
    firmware before accepting another update (this is enforced early with a
    clearer error, though `esp_ota_begin()` would refuse it anyway per the
    comment). Picks the next update partition
    (`esp_ota_get_next_update_partition`), validates the size hint against
    its capacity (`ESP_ERR_INVALID_SIZE` if too big), then
    `esp_ota_begin(..., OTA_WITH_SEQUENTIAL_WRITES, &handle)` and initializes
    a running `mbedtls_sha256_context`.
  - `ota_apply_update_write(handle, data, len)`: `esp_ota_write()` then
    `mbedtls_sha256_update()` over the same bytes — streams straight to flash
    with no separate read-back pass to compute the hash.
  - `ota_apply_update_finish(handle, base64_signature)`: finalizes the SHA-256
    digest, calls `esp_ota_end()` (fails if the image itself is structurally
    invalid), base64-decodes the signature header, parses the **embedded**
    public key (`ota_pubkey_pem_start/end`, embedded via
    `EMBED_TXTFILES "ota_pubkey.pem"` in the component's `CMakeLists.txt` —
    the file `firmware/components/ota/ota_pubkey.pem` exists in the tree),
    and calls `mbedtls_pk_verify(..., MBEDTLS_MD_SHA256, digest, ..., sig,
    ...)`. **Only on verification success** does it call
    `esp_ota_set_boot_partition()` to make the new slot bootable — a bad
    signature returns `ESP_ERR_INVALID_CRC` and the partition is never marked
    bootable.
  - `ota_apply_update_abort(handle)`: cleans up on a truncated/aborted upload.
- **`POST /api/ota`** (`handle_post_ota`, registered by
  `ota_register_http_handlers()`): requires auth, requires an
  `X-Firmware-Signature` header (≤200 chars) carrying the base64 signature,
  streams the raw body in 4096-byte chunks straight into
  `ota_apply_update_write()`, then calls `ota_apply_update_finish()`. Maps
  `ESP_ERR_OTA_ROLLBACK_INVALID_STATE → 409`, `ESP_ERR_INVALID_SIZE → 400`,
  `ESP_ERR_INVALID_CRC → 400` (signature failed), other errors → 500. On
  success: `200 {"status":"ok","rebooting":true}`, a 500ms delay to let the
  response flush, then `esp_restart()`.

This directly implements `docs/plan.md` §9's "OTA binary upload should verify
a signature/checksum before flashing (embed a build-time public key, sign
releases)" recommendation — it is fully implemented, not a stub.

---

## 14. Cloud client (`cloud_client`)

**This is the component that most clearly diverges from `docs/plan.md`**,
which frames the whole platform as serverless/backend-free. `cloud_client.c`
implements a persistent **outbound WebSocket** connection from the device to
a real backend (`backend/src/ws/deviceServer.js`, confirmed by reading both
sides), used for off-LAN reachability and cloud-side automation/activity
logging.

### Transport & connection lifecycle

- Uses the `espressif/esp_websocket_client` managed component (`^1.8` per
  `idf_component.yml`, resolved to `1.8.0`).
- `cloud_client_init()` starts a dedicated task (`cloud_client_task`, stack
  6144) that blocks on `provisioning_wait_wifi_ready(portMAX_DELAY)`, then
  builds an `esp_websocket_client_config_t` with `.uri =
  CONFIG_SS_CLOUD_WS_URL` (Kconfig-hardcoded, default
  `"ws://192.168.100.143:3000/device"` — see §16),
  `reconnect_timeout_ms = 5000`, `network_timeout_ms = 10000`, registers
  `websocket_event_handler` for `WEBSOCKET_EVENT_ANY`, calls
  `esp_websocket_client_start()`, then **deletes itself**
  (`vTaskDelete(NULL)`) — from that point on, the underlying library's own
  background task owns the connection/reconnect loop (auto-reconnect is the
  library's default behavior; the app-level task's only job was to own the
  handle long enough to start it).
- Reconnection itself is therefore handled entirely by
  `esp_websocket_client`'s built-in logic, not custom code in this component.

### Auth mechanism

On `WEBSOCKET_EVENT_CONNECTED`, `send_auth_frame()` sends
`{"deviceId": cfg.device_id, "cloudSecret": cfg.cloud_secret}` as a text
frame — both values sourced straight from `config_store`. This is a
**device-secret** scheme (random 16-byte hex secret generated at first boot,
§4), not a token issued by the backend. Confirmed against
`backend/src/ws/deviceServer.js`: it expects exactly `{deviceId,
cloudSecret}` as the first message, hashes the presented secret
(`hashDeviceSecret`) and compares/trust-on-first-use registers it in
Postgres, closing the socket (`4001`/`4003`) on a missing or mismatched
secret, with a 5s auth timeout.

### What it sends

- **Auth frame** (above), once per connection, immediately on connect.
- **`publish_full_state()`**, also on every connect (right after the auth
  frame): iterates every configured switch, reads its live state via
  `relay_hal_get_state()`, and calls `cloud_client_notify_state_changed()`
  for each — so the backend's cached view resyncs even if changes happened
  while the tunnel was down (a comment ties this to "physical-
  switch/offline-schedule state must reach the app once cloud connectivity
  returns").
- **`cloud_client_notify_state_changed(channel_idx, on)`** — sends
  `{"event":"state_changed","channelIdx":channel_idx,"state":"ON"|"OFF"}`.
  Called from: `http_api`'s `POST /api/channels/*` handler (every local
  toggle), `schedule_exec`'s `fire()` (every schedule-driven toggle), and the
  full-state republish above. It's a **best-effort, non-blocking send**
  (`esp_websocket_client_send_text(..., 0)` timeout) that silently no-ops if
  `!s_connected` — there is no outbound queue; a dropped event is only
  recovered via the next connect's full-state republish. Matches
  `backend/src/ws/deviceServer.js`'s handling exactly: it treats
  `{event:"state_changed", channelIdx, state}` as "the ONE true 'a channel
  actually changed' signal," logging activity and evaluating
  state-triggered automations from it.
- **Relayed-command replies**: `{"reqId", "status", "body"}` (see below).

### What it receives / how relayed commands work

`websocket_event_handler` on `WEBSOCKET_EVENT_DATA` only processes complete
text frames (`op_code == 0x1 && payload_len == data_len`; fragmented frames
are explicitly not reassembled — "not needed for the small control-plane
JSON this tunnel carries"). `handle_incoming_frame()` parses JSON and, if it
finds string fields `reqId`, `method`, `path` (plus optional `body`), calls
`proxy_and_reply()`.

**`proxy_and_reply(req_id, method, path, body)`** — the core cloud→device
command path:
1. Builds `http://127.0.0.1<path>` (loopback — this is exactly the
   `is_loopback_peer()` bypass path documented in `http_auth.c`, §6: cloud
   auth already happened at the WS layer, so the loopback call skips local
   Basic Auth entirely).
2. Maps `method` to `HTTP_METHOD_GET`/`POST`/`DELETE` (anything else is
   logged and dropped — no PUT/PATCH support).
3. Uses `esp_http_client` (a second, separate HTTP client stack from
   `esp_http_server` used by `http_api`) with a 5s timeout
   (`HTTP_LOOPBACK_TIMEOUT_MS`) to actually call the device's own running
   `http_api` server, capturing the response body into a 4096-byte buffer via
   an `HTTP_EVENT_ON_DATA` handler.
4. Sends `{"reqId": req_id, "status": <http status code>, "body": <parsed
   JSON or null>}` back up the socket.

This means **no HTTP handler logic is duplicated for the cloud path** — every
`/api/*` endpoint documented in §6 is reachable identically whether the
caller is on the LAN or relayed through the cloud tunnel, confirmed by a
comment in the source itself ("No handler logic is duplicated").

### Divergence from `docs/plan.md`

`docs/plan.md` §0/§1/§8 explicitly describe *no backend, no database, no
broker*, with remote access recommended via a Tailscale subnet route instead.
The implemented firmware clearly does not follow that path: `cloud_client`
is a first-class, always-running component wired into `main.c`, `http_api`
(auth-loopback carve-out, `cloud_client_notify_state_changed` calls), and
`schedule_exec` (same notify call). `backend/` is a real Node/Postgres
service with its own device WebSocket endpoint, REST routes, activity
logging, and an automation engine — this is a genuine architecture change
from the plan doc, not a minor implementation detail, and should be treated
as superseding §0/§1/§7/§8/§13 of `docs/plan.md` (cross-device groups/
automations, in particular, now plausibly *can* be backend-authoritative,
though verifying that is out of scope for a firmware-only review).

---

## 15. Build & flash

Standard ESP-IDF project layout; `firmware/CMakeLists.txt` just includes
`$ENV{IDF_PATH}/tools/cmake/project.cmake` and sets
`idf_build_set_property(MINIMAL_BUILD ON)`. `firmware/dependencies.lock`
confirms the toolchain was resolved against **ESP-IDF 5.5.3**, target
`esp32`.

```bash
. ~/esp/esp-idf/export.sh          # or wherever your IDF export.sh lives
cd /var/www/html/smart-switch/firmware
idf.py set-target esp32
idf.py build
idf.py -p <PORT> flash monitor
```

### Managed components (component manager, `idf_component.yml` per component)

Confirmed from each component's `idf_component.yml` and the root
`dependencies.lock` (which pins exact resolved versions):

| Dependency | Declared (component) | Locked version | Used by |
|---|---|---|---|
| `espressif/esp_websocket_client` | `^1.8` (`cloud_client`) | `1.8.0` | `cloud_client` — the cloud WS tunnel |
| `espressif/mdns` | `^1.12` (`mdns_advertise`) | `1.12.0` | `mdns_advertise` — LAN service advertisement |
| `joltwallet/littlefs` | `~=1.20.0` (`config_store`, also declared again in `recovery_button`) | `1.20.4` | `config_store` (mount `/storage`), `recovery_button` (`esp_littlefs_format("storage")` on factory reset) |

All three land under `firmware/managed_components/` after `idf.py`'s
component-manager fetch step (already present in this checkout as
`espressif__esp_websocket_client`, `espressif__mdns`, `joltwallet__littlefs`).
No other component declares its own `idf_component.yml` — everything else
(`relay_hal`, `provisioning`, `http_api`, `http_auth`, `ds3231`,
`schedule_exec`, `wifi_reconfig`, `ota`) depends only on in-tree IDF
components (`REQUIRES`/`PRIV_REQUIRES` in each `CMakeLists.txt`, e.g.
`esp_driver_gpio`, `esp_driver_i2c`, `esp_http_server`, `esp_wifi`,
`wifi_provisioning`, `app_update`, `mbedtls`, `lwip`, `esp_timer`, `json`
(cJSON), `log`).

`firmware/main/CMakeLists.txt` lists every component the app links against as
`PRIV_REQUIRES`: `config_store relay_hal provisioning mdns_advertise ds3231
schedule_exec http_api wifi_reconfig recovery_button ota cloud_client
nvs_flash esp_event esp_netif esp_wifi esp_app_format esp_driver_i2c
app_update log`.

---

## 16. Kconfig options (`main/Kconfig.projbuild`, menu "Smart Switch Reference Board")

No component under `firmware/components/` defines its own `Kconfig`/
`Kconfig.projbuild` — every user-configurable option lives in this single
main-component file:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `SS_CHANNEL_COUNT` | int (range 1-6) | 6 | Relay channel count. Comment notes this board never exceeds 6 (no I2C-expander tier). |
| `SS_RELAY_ACTIVE_LOW` | bool | y | Relay outputs active-low (matches most opto-isolated relay modules). |
| `SS_RELAY_CH0_GPIO` | int | 16 | Relay channel 0 GPIO |
| `SS_RELAY_CH1_GPIO` | int | 17 | Relay channel 1 GPIO |
| `SS_RELAY_CH2_GPIO` | int | 18 | Relay channel 2 GPIO |
| `SS_RELAY_CH3_GPIO` | int | 19 | Relay channel 3 GPIO |
| `SS_RELAY_CH4_GPIO` | int | 25 | Relay channel 4 GPIO |
| `SS_RELAY_CH5_GPIO` | int | 26 | Relay channel 5 GPIO |
| `SS_I2C_SDA_GPIO` | int | 21 | I2C SDA (DS3231 RTC) |
| `SS_I2C_SCL_GPIO` | int | 22 | I2C SCL (DS3231 RTC) |
| `SS_BOOT_BUTTON_GPIO` | int | 0 | BOOT button GPIO (recovery_button) |
| `SS_BOOT_SHORT_HOLD_MS` | int | 5000 | Short-hold threshold — network-only reset |
| `SS_BOOT_LONG_HOLD_MS` | int | 12000 | Long-hold threshold — full factory reset |
| `SS_STATUS_LED_GPIO` | int | 2 | Status LED GPIO — **declared but not observed to be driven anywhere** in the components read (no `gpio_set_level` call against this Kconfig symbol was found; likely reserved for a future status-indication feature) |
| `SS_CLOUD_WS_URL` | string | `"ws://192.168.100.143:3000/device"` | Cloud backend WebSocket URL. Comment explains this is intentionally build-time/Kconfig-hardcoded rather than runtime-configurable, since this is a single self-hosted backend with no multi-tenant need; also notes to switch to `wss://` once the backend is behind TLS, and that the path must be the *device* tunnel endpoint (`/device`), not `/ws` (the app/dashboard client endpoint). |

`sdkconfig.defaults` (project-wide, not this menu) sets:
`CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y`, `CONFIG_PARTITION_TABLE_CUSTOM=y` (+
filename `partitions.csv`, offset `0x8000`), `CONFIG_LOG_DEFAULT_LEVEL_INFO=y`,
`CONFIG_SS_CHANNEL_COUNT=6` (redundant with the Kconfig default above, but
pinned explicitly), and `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y` (see §3).

---

## 17. Known gaps / TODOs / stubs (from code comments and direct reading)

- **`relay_hal`'s I2C-expander driver is unimplemented** — `relay_hal_init()`
  returns `ESP_ERR_NOT_SUPPORTED` for `SS_CHANNEL_DRIVER_I2C_EXPANDER`; the
  header labels it "phase 4." This is the clearest "stub" in the codebase:
  the type exists in the API surface but has zero implementation.
- **`default_boot_state = "LAST"` is accepted by the API/schema but has no
  effect at boot** — `init_relays_from_config()` in `main.c` only implements
  `OFF`/`ON`; the comment says persisting live state across reboots "isn't
  modeled yet." A switch configured with `"LAST"` currently behaves exactly
  like `"OFF"` on power-up.
- **`relay_hal`'s `SS_RELAY_HAL_MAX_CHANNELS` (hardcoded 6) is not
  compile-time-linked to `config_store.h`'s `SS_MAX_CHANNELS`** — a comment
  flags this as a maintenance hazard (the two must be changed together by
  convention, with nothing enforcing it).
- **`mdns_advertise_stop()` is defined but not observed to be called** from
  any of the read call sites (not in `main.c`, `recovery_button.c`, or
  elsewhere) — mDNS advertisement appears to run for the device's whole life
  once started.
- **`SS_STATUS_LED_GPIO` Kconfig option exists but no code drives it** in any
  of the components read — likely a placeholder for a not-yet-implemented
  status-LED feature.
- **`version.txt` still says `0.1.0-scaffold`** despite the bulk of the
  system (auth, OTA signing, WiFi rollback, cloud tunnel) being fully
  implemented — the version string hasn't been bumped to reflect the
  project's actual maturity.
- **WiFi reconfig is inherently asynchronous** (documented as "DEVIATION #1"
  directly in `wifi_reconfig.h`) — `docs/plan.md` §5 describes it as if the
  app gets a synchronous `CONNECTED`/`FAILED_ROLLED_BACK` response; the real
  API always returns `202 Accepted` and the caller must poll `GET /api/info`.
- **`cloud_client` has no send queue** — `cloud_client_notify_state_changed()`
  silently drops the event if the WS tunnel isn't connected at that instant;
  correctness depends entirely on the next connection's `publish_full_state()`
  full resync, not on retrying the specific missed event.
- **`GET /api/info` is unauthenticated by design** and returns the device's
  `cloud_secret` in plaintext to anyone who can reach it on the LAN — this is
  a deliberate tradeoff (documented inline: "Local-LAN-only... same
  reachability boundary as the rest of `/api/info`") but is worth flagging
  explicitly as a security-relevant design choice, not an oversight.
- **`http_auth`'s lockout state is global and RAM-only** — by design (per
  its own comment, referencing `docs/plan.md` §9), but this means a reboot
  clears any active lockout, and the counter is shared across all clients
  rather than tracked per-source-IP.
- **The provisioning POP (proof-of-possession) equals the device_id**, which
  is itself visible in the broadcast SoftAP SSID — explicitly called out
  in-source as a known/accepted limitation given the physical-proximity
  threat model and lack of a secure element or display on this hardware.
- **`docs/plan.md`/`docs/claude_plan.md` predate `cloud_client` entirely** —
  treat every mention of "no backend"/"serverless" in those docs as
  superseded; see §14 above for the full extent of the divergence.

---

*This document was produced by reading `firmware/` source directly (every
`.c`/`.h`/`CMakeLists.txt`/`Kconfig*`/`partitions.csv`/`sdkconfig.defaults`/
`version.txt` listed in the task scope), cross-checked in one place
(`cloud_client` ↔ `backend/src/ws/deviceServer.js`) against the backend to
confirm the wire protocol match.*
