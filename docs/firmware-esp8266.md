# Smart Switch — `firmware-esp8266/` Reference

This document describes the **ESP8266 port** of the Smart Switch device firmware, in
`firmware-esp8266/`. It is a from-scratch, independent PlatformIO/Arduino-framework
project — it does **not** share a build system, headers, or generated code with the
ESP-IDF `firmware/` tree (the native ESP32 firmware, documented separately). Every claim
below is grounded in the actual source under `firmware-esp8266/include/` and
`firmware-esp8266/src/`, read in full, plus targeted comparison reads of the equivalent
ESP32 files under `firmware/components/*` where noted.

`docs/plan.md` describes an older, aspirational "serverless, no backend" design. That is
**not** what this code does: this firmware has a working `cloud_client` that opens a
persistent WebSocket tunnel to the real `backend/` service. Treat `docs/plan.md` as
historical background only; this document describes the code as it actually exists today.

---

## 1. Overview

- **Target hardware**: NodeMCU / Wemos D1 mini boards built on the **ESP-12E/F** module
  (ESP8266 SoC). Confirmed by `platformio.ini`'s `board = nodemcuv2` and the pin
  commentary in `include/board_config.h` ("NodeMCU/Wemos D1 mini (ESP-12E/F) pin map").
- **Framework**: Arduino core for ESP8266 (`framework = arduino` in `platformio.ini`),
  not ESP-IDF. All code is written against Arduino-style APIs (`Arduino.h`, `ESP8266WiFi.h`,
  `ESP8266WebServer.h`, `LittleFS.h`, `Wire.h`, etc.) rather than FreeRTOS/ESP-IDF APIs.
- **Why a separate project, not just a second build target of `firmware/`**: this is a
  genuine architectural fork, not merely a different toolchain choice. The ESP8266 (a
  single Tensilica L106 core running the Arduino core's bare event loop) has **no RTOS
  task scheduler available to application code** the way the ESP32's FreeRTOS does. The
  ESP32 firmware structures each subsystem as its own FreeRTOS task (`cloud_client`'s
  "own task, does not self-delete", `recovery_button`'s `xTaskCreate(button_task, ...)`,
  `http_api_start()` blocking "on its own internal task"). On the ESP8266 there is exactly
  one `loop()`, called cooperatively forever, and **every** subsystem — WiFi provisioning,
  the HTTP API, the schedule executor, the cloud WebSocket client, the recovery button —
  is serviced from that single call chain (see §4). Anything that blocks inside `loop()`
  freezes literally everything else on the device, including the LAN-facing HTTP server
  that the app depends on for instant local control. This constraint shapes almost every
  design decision in this tree (most visibly the `WEBSOCKETS_TCP_TIMEOUT` build flag, §2,
  and the widened time-match window in `schedule_exec.cpp`, §10). `platformio.ini`'s own
  header comment states this plainly: "Separate PlatformIO/Arduino-core project, no
  shared build system with the ESP-IDF `firmware/` tree... JSON wire shapes are
  hand-mirrored to stay app/backend/dashboard-compatible, not shared via include."
- **Relationship to app/backend**: this firmware is a peer implementation of the same
  device contract the ESP32 firmware implements — same local REST API paths/methods/JSON
  shapes (`http_api.cpp`'s own comment: "mirrors the ESP32 firmware's http_api.c endpoint
  list exactly"), same `SsConfig`/`ss_config_t` field layout (`config_store.h`: "Field
  names/shapes deliberately mirror the ESP32 firmware's `ss_config_t`... so the app,
  backend, and future React dashboard need zero per-chip special-casing"), and the same
  cloud WebSocket tunnel protocol to `backend/`'s `/device` route (§11). The one place the
  app *does* need to know which chip it's talking to is WiFi provisioning: the boot-time
  QR sticker log line encodes `&chip=esp8266` specifically so the app's QR wizard picks
  this chip's plain-JSON SoftAP flow instead of the ESP32's Security1/protocomm handshake
  (§8, `main.cpp` lines 59-61).

---

## 2. Build system — `platformio.ini`

Full contents:

```ini
; Smart Switch — ESP8266 port (NodeMCU/Wemos D1 mini, ESP-12E/F).
; Separate PlatformIO/Arduino-core project, no shared build system with the
; ESP-IDF firmware/ tree — see docs/plan.md. JSON wire shapes are hand-
; mirrored to stay app/backend/dashboard-compatible, not shared via include.
[env:nodemcuv2]
platform = espressif8266
board = nodemcuv2
framework = arduino
board_build.filesystem = littlefs
monitor_speed = 115200
monitor_filters = esp8266_exception_decoder
lib_deps =
    bblanchon/ArduinoJson @ ^7.4.3
    adafruit/RTClib @ ^2.1.4
    links2004/WebSockets @ ^2.7.2
build_flags =
    ; Defense-in-depth: arduinoWebSockets' TCP connect blocks the whole
    ; device (single cooperative loop() — no RTOS tasks on this chip,
    ; unlike the ESP32 firmware) for up to this long on every failed
    ; reconnect attempt to the cloud backend. The real fix is pointing
    ; SS_CLOUD_WS_HOST (board_config.h) at a reachable host so it doesn't
    ; fail in the first place — this just bounds the worst case if it ever
    ; is unreachable (backend down, network hiccup) instead of leaving the
    ; library's 5000ms default free to stall local LAN control that long.
    -D WEBSOCKETS_TCP_TIMEOUT=800
```

**Environment**: single env, `[env:nodemcuv2]` — one board target, no variant/OTA
partition envs (contrast with §13).

**Board / platform / framework**: `platform = espressif8266`, `board = nodemcuv2` (the
generic NodeMCU v2 / Wemos-compatible ESP-12E board definition PlatformIO ships), and
`framework = arduino` (Arduino core, not ESP-IDF or bare-metal SDK).

**Filesystem**: `board_build.filesystem = littlefs` — selects LittleFS as the on-flash
filesystem image format instead of the older SPIFFS. All persistent config
(`config_store.cpp`) lives in a LittleFS-formatted flash region, mounted via
`LittleFS.begin()`.

**Monitor settings**: `monitor_speed = 115200` matches the `Serial.begin(115200)` call in
`main.cpp::setup()`. `monitor_filters = esp8266_exception_decoder` runs PlatformIO's
built-in ESP8266 crash decoder over serial output, symbolicating raw exception/stack
addresses from a firmware panic back into function names/line numbers using the build's
`.elf` — purely a developer-experience aid for `pio device monitor`, no runtime effect.

**`lib_deps`** (each with what it's used for):

| Library | Version | Used for |
|---|---|---|
| `bblanchon/ArduinoJson` | `^7.4.3` | All JSON (de)serialization: the on-disk `/config.json` (`config_store.cpp`), every `/api/*` request/response body (`http_api.cpp`), the WiFi-provisioning JSON body (`wifi_provisioning.cpp`), and every cloud-tunnel frame in both directions (`cloud_client.cpp`). Uses the v7 `JsonDocument` API (no fixed-capacity `StaticJsonDocument<N>` sizing) throughout. |
| `adafruit/RTClib` | `^2.1.4` | Talks to the DS3231 real-time clock over I2C (`RTC_DS3231` class used in `schedule_exec.cpp`) — the wall-clock source schedules match against. |
| `links2004/WebSockets` | `^2.7.2` | `WebSocketsClient` in `cloud_client.cpp` — the persistent outbound WebSocket tunnel to `backend/`'s `/device` endpoint. This is the library whose blocking-connect behavior motivates the build flag below. |

**`build_flags`**: exactly one, `-D WEBSOCKETS_TCP_TIMEOUT=800`. Per the inline comment
(quoted above verbatim), this overrides the `links2004/WebSockets` library's own internal
TCP-connect timeout, which defaults to 5000ms. Because this whole firmware runs on one
cooperative `loop()` with no RTOS tasks (§1, §4), a blocked TCP connect attempt inside
`WebSocketsClient` — which happens synchronously on every reconnect attempt
(`s_ws.setReconnectInterval(5000)` in `cloud_client.cpp`, see §11) — blocks the *entire*
device, including the LAN-facing `ESP8266WebServer` that the app uses for direct local
control. The flag doesn't fix connectivity to an unreachable host; it just bounds the
device-wide stall from "up to 5s" to "up to 0.8s" per failed attempt, so that a
misconfigured or temporarily-down cloud endpoint degrades local LAN latency rather than
making the whole device intermittently unresponsive. `board_config.h`'s own comment on
`SS_CLOUD_WS_HOST` describes exactly this failure mode having been reproduced live: "this
placeholder value caused every local LAN request to randomly stall for seconds... it
wasn't the app, or even really 'the firmware', it was this pointed at nothing reachable."

---

## 3. Board config — `include/board_config.h`

`SS_CHANNEL_COUNT` is **7** — 6 plain relay channels plus 1 MOSFET-driven channel that is
"kept plain on/off for this pass, no PWM" (per the file's own comment). All channels are
active-low relays: `SS_RELAY_ACTIVE_LOW = true`.

**Pin map** (`SS_RELAY_GPIO[SS_CHANNEL_COUNT]`, index = channel index):

| Channel idx | GPIO | NodeMCU label | Role |
|---|---|---|---|
| 0 | 5 | D1 | relay 1 |
| 1 | 4 | D2 | relay 2 |
| 2 | 14 | D5 | relay 3 |
| 3 | 12 | D6 | relay 4 |
| 4 | 13 | D7 | relay 5 |
| 5 | 16 | D0 | relay 6 |
| 6 | 0 | D3 | relay 7 — MOSFET channel, plain on/off |

**I2C**: `SS_I2C_SDA_GPIO = 2` (D4), `SS_I2C_SCL_GPIO = 15` (D8) — used for the DS3231 RTC
(§10).

**Boot-strapping constraints** (documented at length in the header, since this chip only
breaks out ~9 usable GPIOs and every "spare" pin double-books with a boot-strap role):
- GPIO0 (D3, relay 7): must read HIGH at boot; the active-low relay convention makes
  "off" = HIGH, which the header notes is safe "as long as the relay driver holds it HIGH
  before boot-mode latch."
- GPIO2 (D4, I2C SDA + onboard LED on most boards): must read HIGH at boot; I2C SDA idles
  HIGH between transactions so this is compatible, at the cost of the onboard LED
  "flicker[ing] faintly during RTC reads, cosmetic only."
- GPIO15 (D8, I2C SCL): must read LOW at boot; NodeMCU boards have an onboard pulldown
  already satisfying this before I2C init runs.
- GPIO1/GPIO3 (TX/RX) are explicitly left free for UART (flashing + the boot-time
  identity log line) and "never repurposed."

The header flags these pin assignments as **defaults for a common wiring convention**,
not hardware-verified constants — "verify against your actual PCB before flashing if your
board differs."

**Status LED**: `SS_STATUS_LED_GPIO = 2`, sharing the pin with I2C SDA. This constant is
declared but — per a full read of `main.cpp`, `relay_hal.cpp`, and every other `.cpp` in
this tree — **never referenced anywhere in the source**. There is no status-LED driver
code in this firmware; the constant appears to be a placeholder/leftover. This is a
concrete gap worth flagging (see §14).

**Recovery button**: `SS_BOOT_BUTTON_GPIO = -1` — **disabled by default**. The comment
explains why: this board has no dedicated user button wired to a free GPIO, and GPIO0 (the
usual "BOOT" button pin on ESP32 designs) is already a relay output here. The header
instructs wiring an external momentary button to GND on whatever GPIO you assign,
following "the ESP32 board's same active-low + internal-pullup convention," and
explicitly warns builders to assign a real GPIO before relying on this feature (see §9 for
what happens while it's `-1`). Thresholds: `SS_BOOT_SHORT_HOLD_MS = 5000`,
`SS_BOOT_LONG_HOLD_MS = 12000`.

**Cloud endpoint**: `SS_CLOUD_WS_HOST = "192.168.100.143"`, `SS_CLOUD_WS_PORT = 3000`,
`SS_CLOUD_WS_PATH = "/device"`, `SS_CLOUD_WS_USE_TLS = false`. The host is a **hardcoded
bench/dev IP literal** that must be edited before flashing a real deployment — same
"single self-hosted backend, no runtime configurability needed" reasoning the comment
attributes to the ESP32 firmware's Kconfig-hardcoded `CONFIG_SS_CLOUD_WS_URL`. The comment
stresses this is not a harmless placeholder (see the WEBSOCKETS_TCP_TIMEOUT discussion in
§2): an unreachable host here previously caused visible, intermittent local-LAN latency
that was misdiagnosed as an app-side bug.

---

## 4. Boot sequence — `src/main.cpp`

### `setup()` (runs once)

In order:
1. `Serial.begin(115200)`, `delay(200)` — fixed startup settle delay (one-time, at boot
   only).
2. `configStore.begin()` — mounts LittleFS and loads (or creates+saves a default)
   `/config.json` (§5). Must run before anything that reads `configStore.cfg()`.
3. `relayHalInit()` — sets every relay GPIO to `OUTPUT` and drives every channel OFF
   (§6), *before* any network/HTTP subsystem starts, so relays never float in an
   undefined state while WiFi is coming up.
4. `applyBootStates()` (local static function) — walks `cfg.switches[]` and sets each
   channel to ON only if its `default_boot_state == "ON"`; anything else (including the
   unimplemented `"LAST"` value) is treated as OFF. The code comment is explicit that
   `"LAST"` isn't implemented, "matches the ESP32 firmware's scaffold — relay_hal has no
   persisted last-state read-back."
5. A `Serial.printf` logs a ready-to-use QR payload:
   `smartapp://device/setup?id=%s&secret=%s&chip=esp8266`, filled with `device_id` and
   `cloud_secret`. Comment: "so a fresh board's QR sticker can be generated right after
   flashing" and "the app's QR wizard reads &chip= to pick the right WiFi-provisioning
   method (this chip's plain JSON form vs the ESP32's Security1 handshake)."
6. `wifiProvisioningBegin()` — connects STA using stored credentials if any (**blocks the
   boot sequence for up to 20000ms** while retrying, see §8), otherwise opens the
   `SmartSwitch-<device_id>` SoftAP. This blocking wait happens entirely within `setup()`,
   before the HTTP server or any other subsystem exists yet, so it does not stall an
   already-running LAN-facing service — it just delays first boot-readiness.
7. `httpApiBegin()` — registers all `/api/*` handlers plus `GET /` and starts
   `ESP8266WebServer`.
8. `scheduleExecBegin()` — starts I2C/DS3231 and SNTP.
9. `cloudClientBegin()` — arms the WebSocket client (does not block; see §11).
10. `recoveryButtonBegin()` — sets the button GPIO to `INPUT_PULLUP` (only compiled in if
    `SS_BOOT_BUTTON_GPIO >= 0`; a no-op stub otherwise, §9).
11. A final `Serial.printf("boot complete: ...")` log line with device_id, board_type,
    channel_count, fw_version.

### `loop()` (runs forever, cooperatively)

```cpp
void loop() {
  wifiProvisioningLoop();
  startMdnsIfNeeded();
  if (s_mdnsStarted) {
    MDNS.update();
  }
  httpApiLoop();
  scheduleExecLoop();
  cloudClientLoop();
  recoveryButtonLoop();
}
```

Every subsystem is serviced once per `loop()` iteration, in this fixed order, with no
`delay()` calls and no RTOS tasks/threads anywhere in this tree. Confirmed non-blocking
patterns, function by function:

- **`wifiProvisioningLoop()`** — pure `millis()`-based state machine: a deferred-connect
  timer (`DEFER_MS = 700`) and a connect-attempt timeout (`CONNECT_TIMEOUT_MS = 15000`)
  are both polled by comparing `millis()` deltas; no blocking calls. (Contrast with the
  boot-time blocking wait in `wifiProvisioningBegin()`, §4/§8, which only runs once,
  before `loop()` starts.)
- **`httpApiLoop()`** — calls `httpServer.handleClient()`, the standard
  `ESP8266WebServer` per-iteration pump; it services at most the currently pending
  client per call, matching the cooperative model.
- **`scheduleExecLoop()`** — self-throttles: `if (now - s_lastTickMs < 1000) return;`
  before doing any real work, so the actual `schedulerTick()` body only runs at ~1Hz
  regardless of how often `loop()` spins; work inside `schedulerTick()` is pure
  arithmetic/string comparison, no I/O waits.
- **`cloudClientLoop()`** — calls `s_ws.loop()` (the `WebSocketsClient` pump), gated on
  `wifiProvisioningIsConnected()`. **This is the one component that can genuinely block
  the whole cooperative loop**, exactly as the `WEBSOCKETS_TCP_TIMEOUT` build flag (§2)
  and `board_config.h`'s `SS_CLOUD_WS_HOST` comment (§3) describe: on every reconnect
  attempt, the underlying TCP connect can stall for up to `WEBSOCKETS_TCP_TIMEOUT`
  (800ms) before `s_ws.loop()` returns control to the rest of `loop()`. There is no
  other blocking call in the whole cooperative chain.
- **`recoveryButtonLoop()`** — plain `digitalRead()`/`millis()` diff, no blocking (real
  implementation only compiled in when `SS_BOOT_BUTTON_GPIO >= 0`; otherwise an empty
  stub).
- **`MDNS.update()`** — standard lightweight housekeeping call, gated behind
  `startMdnsIfNeeded()` which itself only does real work (`MDNS.begin()` +
  `addService`/`addServiceTxt`) once, the first time `wifiProvisioningIsConnected()`
  becomes true (`s_mdnsStarted` latch).

The only other intentional blocking calls in the whole tree happen immediately before a
device reboot (where blocking briefly is harmless because the device is about to reset
anyway): `handlePostNetwork()` in `http_api.cpp` does `delay(500); ESP.restart();`, and
`recovery_button.cpp`'s `doNetworkReset()`/`doFactoryReset()` each do `delay(200)` before
`ESP.restart()`.

---

## 5. Config storage — `config_store.h` / `config_store.cpp`

### Schema (`SsConfig`, in `include/config_store.h`)

```cpp
struct SsSwitch {
  uint8_t channel_idx = 0;
  char name[32] = {0};
  char zone[32] = {0};
  char type[8] = "ON_OFF";           // this board never sets anything else
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
  int64_t countdown_started_at = 0;  // internal-only, not part of the wire schema
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
  SsSchedule schedules[SS_MAX_SCHEDULES];   // SS_MAX_SCHEDULES = 16
  uint8_t schedule_count = 0;
  uint32_t next_schedule_id = 1;
  uint8_t auth_password_hash[32] = {0};     // raw SHA-256 digest
  bool auth_password_set = false;
  int16_t utc_offset_min = 0;
  char cloud_secret[33] = {0};              // hex-encoded 16-byte random secret

  bool staticIpEnabled = false;             // false = DHCP (default)
  char staticIp[16] = {0};
  char staticGateway[16] = {0};
  char staticSubnet[16] = {0};
  char staticDns[16] = {0};                 // empty = fall back to staticGateway as DNS
};
```

### Comparison against the ESP32 firmware's `ss_config_t`

The header comment states the field layout is deliberately mirrored from
`firmware/components/config_store/include/config_store.h`'s `ss_config_t`. A direct
field-by-field read of both confirms this holds, with these notable, deliberate
differences:

| Aspect | ESP8266 (`SsConfig`) | ESP32 (`ss_config_t`) | Note |
|---|---|---|---|
| Max channels | `SS_CHANNEL_COUNT = 7` (board_config.h) | `SS_MAX_CHANNELS = 6` | ESP8266 board has an extra MOSFET channel; ESP32's comment calls its board "6ch GPIO-direct reference board, no I2C expander tier" |
| `board_type` default | `"ESP8266_7CH"` | `"6CH_GPIO"` | Chip-specific identity strings, as expected |
| `channel_driver` | hardcoded `"GPIO_DIRECT"`, never anything else in code | `"GPIO_DIRECT"` \| `"I2C_EXPANDER"` (unused on ESP32's reference board too) | Same field, same only-value-actually-used in practice on both chips |
| Field naming (C++ struct members) | camelCase for static-IP fields (`staticIpEnabled`, `staticIp`, ...) | snake_case throughout (`static_ip_enabled`, `static_ip`, ...) | In-memory naming only — does not affect the wire/on-disk JSON, see below |
| Everything else (`device_id`, `name`, `fw_version`, `switches[]`/`ss_switch_t`, `schedules[]`/`ss_schedule_t`, `auth_password_hash`/`auth_password_set`, `utc_offset_min`, `cloud_secret[33]`, static-IP fields' semantics) | Identical field names, sizes, and semantics | Identical | No schema drift found |

**On-disk/wire JSON field names are identical across ports**, confirmed by comparing
`ConfigStore::save()` (`config_store.cpp`) against `firmware/components/config_store/config_store.c`:
both write `_static_ip_enabled`, `_static_ip`, `_static_gateway`, `_static_subnet`,
`_static_dns`, `_cloud_secret`, `utc_offset_min`, `device_id`, etc. — the same key
spellings, including the underscore-prefix convention for internal-only fields. No schema
drift found between the two ports' JSON.

`SsSchedule.countdown_started_at` is explicitly called out (in both ports' headers) as
**internal-only, not part of the wire schema** — it's persisted to disk (as
`_countdown_started_at` in `ConfigStore::save()`) but never accepted from or returned to
HTTP clients.

### Persistence model

- Single file, `/config.json`, on LittleFS. `ConfigStore::begin()` calls
  `LittleFS.begin()`, then `loadFromDisk()`; if that fails (no file, or a parse error via
  `deserializeJson`), falls back to `loadDefault()` followed immediately by `save()` so a
  fresh device always has a valid config file on disk after first boot.
- **Atomic write pattern**: `save()` serializes to a *temp* file `/config.json.tmp`,
  closes it, then `LittleFS.remove(CONFIG_PATH)` followed by
  `LittleFS.rename(CONFIG_TMP_PATH, CONFIG_PATH)` — the same "atomic write-via-temp-file
  pattern as the ESP32 firmware" the header comment claims.
- **Defaults** (`loadDefault()`): `device_id` derived as `esp8266-<last 3 MAC octets in
  hex>` (e.g. `esp8266-a1b2c3`); `name` = `"Smart Switch <device_id>"`; one `SsSwitch` per
  physical channel (`switch_count = SS_CHANNEL_COUNT`), each named `"Channel <i>"` with
  default fields; a fresh random 16-byte `cloud_secret` generated via `secureRandom(256)`
  per byte and hex-encoded. No schedules, no auth password.
- **Migration path**: `loadFromDisk()` explicitly handles configs written before
  `cloud_secret` existed — if `_cloud_secret` isn't present/valid hex (`strlen != 32`), it
  generates a fresh random secret on load rather than leaving the field empty. This is the
  only migration logic present; there is no schema-version field.
- **Not mutex-protected**: the class comment is explicit — "Not thread-safe by mutex
  (single-core Arduino loop() — everything runs on one task), but callers must not
  re-enter `save()` from within a WebServer handler that's still using a pointer into
  `cfg` — copy fields out first if unsure." This is safe *only* because of the
  single-cooperative-loop model (§1/§4); it would not be safe if ported to a
  multi-tasking environment without adding real locking.
- **Mutators**: `upsertSwitch`/`deleteSwitch` (by `channel_idx`),
  `upsertSchedule`/`deleteSchedule` (create-or-update by `id`; a schedule with empty
  `id` is treated as a new record and assigned `"s-<next_schedule_id++>"`),
  `setAuthHash`, `setUtcOffset`, `setStaticIp`. Every mutator calls `save()` internally —
  there's no batched/deferred write path.
- `upsertSchedule` has one subtlety worth noting: when updating an existing schedule by
  `id`, it preserves the existing `countdown_started_at` unless the caller explicitly set
  a nonzero one — the comment: "Preserve the existing countdown_started_at unless the
  caller (schedule_exec, re-arming) set one." (See §10 for how `http_api.cpp` decides
  when to arm/re-arm it.)

---

## 6. Relay HAL — `relay_hal.h` / `relay_hal.cpp`

Minimal, direct-GPIO driver — no I2C expander tier on this board (matches
`channel_driver = "GPIO_DIRECT"` being the only value ever set).

```cpp
void relayHalInit();
void relayHalSetState(uint8_t channelIdx, bool on);
bool relayHalGetState(uint8_t channelIdx);
uint8_t relayHalChannelCount();
```

- `relayHalInit()` iterates all `SS_CHANNEL_COUNT` channels, calls `pinMode(..., OUTPUT)`
  then `relayHalSetState(i, false)` for each — **every channel is forced OFF at HAL
  init**, before `main.cpp`'s `applyBootStates()` later applies any per-switch
  `default_boot_state == "ON"` override. This means a relay briefly asserts its "off"
  GPIO level during `relayHalInit()` regardless of configured boot state, then flips to
  "on" a few lines later in `setup()` if configured to do so — there is no single-step
  "restore last/configured state" at hardware init time.
- `relayHalSetState()` computes the physical GPIO level as
  `on != SS_RELAY_ACTIVE_LOW ? HIGH : LOW` — since `SS_RELAY_ACTIVE_LOW` is a compile-time
  `true` constant, this simplifies to: `on == true` → `LOW` (active-low, relay energized),
  `on == false` → `HIGH` (relay de-energized). State is cached in a static in-RAM array
  `s_state[SS_CHANNEL_COUNT]`, read back by `relayHalGetState()` — there is **no
  persisted or hardware-read-back last-known state**; a reboot always re-derives state
  from `applyBootStates()` (i.e., from configured `default_boot_state`, not from
  whatever the relay was physically doing before reset). This is the same limitation
  `main.cpp`'s comment calls out re: `"LAST"` boot state not being implemented.
- Bounds-checked: both `SetState`/`GetState` silently no-op / return `false` on an
  out-of-range `channelIdx` rather than asserting.

---

## 7. HTTP API — `http_api.h`/`.cpp` + `http_auth.h`/`.cpp`

`ESP8266WebServer httpServer(80)` — one server instance, serving both SoftAP clients
during first-time setup and normal LAN clients afterward (per `http_api.h`'s comment).
CORS is enabled unconditionally (`httpServer.enableCORS(true)`), and the `Authorization`
header is explicitly collected (`httpServer.collectHeaders("Authorization")` — required
because `ESP8266WebServer` does not forward arbitrary headers to handlers by default).

### Registered handlers

| Method | Path | Handler | Auth | Notes |
|---|---|---|---|---|
| GET | `/` | `wifiProvisioningHandleFormPage` | none | Plain HTML fallback WiFi-setup form (§8) |
| GET | `/api/info` | `handleGetInfo` | **none** (always open) | Device identity + diagnostics |
| GET | `/api/config` | `handleGetConfig` | `httpAuthCheck` | Full config snapshot |
| POST | `/api/switches` | `handlePostSwitches` | `httpAuthCheck` | Create/update a switch |
| DELETE | `/api/switches/{}` | `handleDeleteSwitch` | `httpAuthCheck` | Delete by `channel_idx` in path |
| GET | `/api/channels` | `handleGetChannels` | `httpAuthCheck` | Current ON/OFF per channel |
| POST | `/api/channels/{}/state` | `handlePostChannelState` | `httpAuthCheck` | Set one channel's state |
| POST | `/api/schedules` | `handlePostSchedules` | `httpAuthCheck` | Create/update a schedule |
| DELETE | `/api/schedules/{}` | `handleDeleteSchedule` | `httpAuthCheck` | Delete by `id` in path |
| POST | `/api/auth/password` | `handlePostAuthPassword` | **conditional** — only if a password is already set | Claim/change device password |
| POST | `/api/timezone` | `handlePostTimezone` | `httpAuthCheck` | Set `utc_offset_min` |
| POST | `/api/wifi` | `wifiProvisioningHandlePost` | **conditional** — only if a password is already set | Arm a WiFi (re)connect attempt (§8) |
| POST | `/api/network` | `handlePostNetwork` | `httpAuthCheck` | Static IP / DHCP switch, reboots device |

Path-parameter routes (`/api/switches/{}`, `/api/channels/{}/state`,
`/api/schedules/{}`) use `UriBraces` from `<uri/UriBraces.h>`, read via
`httpServer.pathArg(0)`.

This registered path list, compared against the ESP32 firmware's
`firmware/components/http_api/http_api.c` handler table (`handlers[]` array), is
**identical in paths and methods** for every shared endpoint — confirming the header
comment's claim that this "mirrors the ESP32 firmware's http_api.c endpoint list
exactly." The ESP8266 tree adds one route the ESP32 tree doesn't need at this layer
(`GET /`, the fallback provisioning form — the ESP32 uses `wifi_prov_mgr`'s own
SoftAP/BLE flow instead, see §8) and is **missing** the ESP32's `POST /api/ota` (that
device has no OTA capability at all — see §13/§14).

### Per-endpoint detail

- **`GET /api/info`** — unauthenticated by design (device identity/discovery). Returns
  `device_id`, `board_type`, `channel_count`, `fw_version`, `wifi_reconfig_state` (string
  from `wifiReconfigStateStr`), `cloud_secret` (plaintext — "Local-LAN-only,
  unauthenticated by design... read once by the app's QR/manual claim flow"),
  `time_known_good` (bool), `rtc_present` (bool), `now_epoch` (int), and a
  `capabilities` array (currently just `["switch"]`). **Note**: `rtc_present` is an
  ESP8266-only addition to this endpoint — the ESP32 firmware's equivalent
  `handle_get_info()` (`firmware/components/http_api/http_api.c`) does **not** expose an
  `rtc_present` field (it has `device_id`, `board_type`, `channel_count`, `fw_version`,
  `wifi_reconfig_state`, `cloud_secret`, `time_known_good`, `now_epoch`, `capabilities`
  only) — a genuine, small API-surface difference between the two ports.
- **`GET /api/config`** — full config dump: identity fields, `utc_offset_min`, a
  `network` object (`mode: "static"|"dhcp"`, plus `ip`/`gateway`/`subnet`/`dns` only when
  static), the `switches[]` array (`channel_idx`, `name`, `zone`, `type`,
  `default_boot_state`), and the `schedules[]` array (`id`, `channel_idx`, `action`,
  `type`, conditionally `time`/`days`/`duration_s`, `enabled`).
- **`POST /api/switches`** — body `{channel_idx, name?, zone?, default_boot_state?}`;
  `type` is always forced to `"ON_OFF"` server-side regardless of input ("this board is
  ON/OFF only"). 400 if `channel_idx` is out of `[0, relayHalChannelCount())`. Returns the
  stored switch as 200 JSON.
- **`DELETE /api/switches/{idx}`** — 204 empty body on success (no existence check
  before delete — deleting an unknown idx is a silent no-op that still returns 204).
- **`GET /api/channels`** — array of `{channel_idx, state: "ON"|"OFF"}` for every
  physical channel, read live from `relayHalGetState()`.
- **`POST /api/channels/{idx}/state`** — body `{"state":"ON"|"OFF"}`; 400 on bad
  `channel_idx` or a `state` value other than exactly `"ON"`/`"OFF"`. On success, calls
  both `relayHalSetState()` and `cloudClientNotifyStateChanged()` (so the cloud stays in
  sync with locally-originated changes too), then echoes `{channel_idx, state}` as 200.
- **`POST /api/schedules`** — body `{id?, channel_idx, action, type, time?, days?,
  duration_s?, enabled?}`. 400 on out-of-range `channel_idx`. `days` (1-7, ISO weekday)
  is packed into a `days_mask` bitfield. For `type == "countdown"`, the handler itself
  computes and injects `countdown_started_at`: `time(nullptr)` on create, or on an
  edit only if the schedule is transitioning `disabled → enabled` (otherwise the
  existing start time is preserved so "a plain edit doesn't restart the countdown," per
  the inline comment, matching the ESP32 firmware's `schedule_exec_upsert()` behavior).
  404 if an `id` is supplied that doesn't match any existing schedule.
- **`DELETE /api/schedules/{id}`** — 404 if the id doesn't exist, else 204.
- **`POST /api/auth/password`** — the one endpoint with a state-dependent auth gate:
  `if (configStore.cfg().auth_password_set && !httpAuthCheck(...)) return;` — i.e. **open**
  until a password has ever been set (first-claim flow), then requires auth for any
  subsequent password change. Hashes the plaintext `password` with SHA-256
  (`bearssl/bearssl.h`'s `br_sha256_*`), stores the raw digest via
  `configStore.setAuthHash()`. 400 if `password` is empty/missing.
- **`POST /api/timezone`** — body `{utc_offset_min}`, persists via
  `configStore.setUtcOffset()`.
- **`POST /api/network`** — body `{"mode":"dhcp"}` or `{"mode":"static", ip, gateway,
  subnet, dns?}`. 400 if `mode` isn't one of those two, or if static mode is missing
  `ip`/`gateway`/`subnet`. On success, responds `{"ok":true,"rebooting":true}`, then
  **`delay(500); ESP.restart();`** — the new network config takes effect at the next
  boot's `wifiProvisioningBegin()`, not live.

### Auth (`http_auth.cpp`)

`bool httpAuthCheck(ESP8266WebServer &server)`:
- **Loopback bypass**: `server.client().remoteIP() == IPAddress(127, 0, 0, 1)` always
  returns `true` immediately — this is how `cloud_client.cpp`'s `proxyAndReply()` (§11)
  reaches auth-gated endpoints on behalf of an already-cloud-authenticated relayed
  command, without re-entering HTTP Basic auth. The comment notes this is safe because an
  external request "can never carry a spoofed 127.0.0.1 source."
- **Open-until-claimed**: if `!configStore.cfg().auth_password_set`, returns `true`
  unconditionally — a fresh/unclaimed device has no auth barrier at all on the LAN.
- **Lockout**: a rolling `s_lockoutUntilMs` computed from `s_consecutiveFailures` —
  once failures reach `LOCKOUT_THRESHOLD = 5`, backoff is
  `min(LOCKOUT_BASE_S << min(failures-5, 4), LOCKOUT_MAX_S)` seconds, i.e. `30s, 60s,
  120s, 240s, 300s (capped)`. While locked out, every request gets **429** with a
  `Retry-After` header, before even checking credentials.
- **Scheme**: HTTP Basic auth only (`Authorization: Basic <base64(user:pass)>`, decoded
  via `libb64/cdecode.h`'s `base64_decode_chars`; only the password half after the first
  `:` is checked, the username is ignored). Missing/malformed header, malformed base64,
  or a wrong password all: increment the failure counter and respond **401** with
  `WWW-Authenticate: Basic realm="smart-switch"`.
- **Comparison**: SHA-256 of the supplied password (again via `bearssl`) is compared to
  the stored hash using a hand-rolled `constantTimeEqual()` (ORs all byte diffs rather
  than short-circuiting) — a real, if simple, timing-attack mitigation.
- On success, both failure counters are reset to zero.

This auth flow is described as mirroring "the ESP32 firmware's http_auth.c" rationale
(same loopback-bypass and open-until-claimed logic), though this task did not require a
line-by-line read of `firmware/components/http_auth/http_auth.c` to confirm identical
lockout constants — that would need to be checked separately if exact numeric parity
matters.

---

## 8. WiFi provisioning — `wifi_provisioning.h`/`.cpp`

This is **not** a protocomm/Security1 handshake like the ESP32 firmware. It is a
plain-JSON, SoftAP-based flow with no cryptographic pairing protocol layered on top of
WPA2 — confirmed directly from the source, not assumed:

- **Boot-time decision** (`wifiProvisioningBegin()`): if `WiFi.SSID().length() > 0`
  (the ESP8266 Arduino core's own persistent STA config already has stored credentials),
  it sets `WIFI_STA` mode, applies static IP if configured
  (`applyStaticIpIfConfigured()`), and calls `WiFi.begin()` — then **blocks** in a
  `while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) delay(250);` loop for
  up to 20 seconds. If that succeeds, state becomes `Connected` and the function returns.
  If no stored SSID exists, or the 20s connect attempt fails, it falls through to opening
  a SoftAP: `WiFi.mode(WIFI_AP)`, SSID `"SmartSwitch-<device_id>"`, and — this is the key
  simplification vs. the ESP32 — **the SoftAP's WPA2 password is simply the device_id
  string itself** (`WiFi.softAP(apName.c_str(), configStore.cfg().device_id)`). The
  comment is explicit: "No Security1/protocomm equivalent on this chip... the SoftAP
  itself is WPA2-protected using device_id as the password, the same physically-visible
  identity already used as the pairing secret" (i.e., the same value printed on the boot
  QR sticker and physically on the device).
- **Two ways to provision once on the SoftAP**: (1) the app hits the JSON endpoint
  directly, or (2) a phone joins the SoftAP manually and browses to
  `http://192.168.4.1/`, which serves `wifiProvisioningHandleFormPage()` — a small
  inline `<form>`/`fetch()` HTML page (served via `PROGMEM`) that itself POSTs to
  `/api/wifi`. This is the header's "spec §8's 'fall back gracefully' path" for a user
  not using the app.
- **`POST /api/wifi`** (`wifiProvisioningHandlePost`) — body `{ssid, password}`; 400 if
  `ssid` is empty. Auth-gated the same conditional way as `/api/auth/password` (open only
  until the device has ever had a password set). On success it captures the *current*
  STA credentials as rollback targets (`s_previousSsid`/`s_previousPassword` via
  `WiFi.SSID()`/`WiFi.psk()`), stores the new pending credentials, sets state to
  `Testing`, arms a deferred-apply timer (`s_deferAt = millis() + DEFER_MS` where
  `DEFER_MS = 700`), and **immediately responds 202** `{"state":"TESTING"}` — the actual
  connect attempt happens later, inside `wifiProvisioningLoop()`, specifically so the
  radio reconfiguration doesn't happen synchronously inside the HTTP request handler
  itself (comment: "can't act on a new SSID/password synchronously inside the HTTP
  handler that received it, same reasoning as the ESP32 firmware's 700ms defer").
- **Deferred connect state machine** (`wifiProvisioningLoop()`): once the defer timer
  elapses, switches to `WIFI_AP_STA` (keeping the AP alive as a fallback), calls
  `WiFi.begin(pendingSsid, pendingPassword)`, and starts a
  `CONNECT_TIMEOUT_MS = 15000` window. If `WL_CONNECTED` is reached within that window:
  state → `Connected`, mode drops to pure `WIFI_STA` (AP torn down), and
  `WiFi.setSleepMode(WIFI_NONE_SLEEP)` is re-asserted. If the timeout elapses first: if a
  previous SSID existed, `WiFi.begin(previousSsid, previousPassword)` is issued to roll
  back, and state becomes `FailedRolledBack`.
- **State enum** (`WifiReconfigState`: `Idle`/`Testing`/`Connected`/`FailedRolledBack`,
  string-mapped by `wifiReconfigStateStr()`) is deliberately the same 4 states/strings as
  the ESP32 firmware's `wifi_reconfig` component (`WIFI_RECONFIG_STATE_*`), confirmed by
  reading `firmware/components/wifi_reconfig/include/wifi_reconfig.h` — same
  `IDLE`/`TESTING`/`CONNECTED`/`FAILED_ROLLED_BACK` strings. This lets the app's existing
  `GET /api/info` polling loop (reading `wifi_reconfig_state`) work unmodified against
  either chip, per the header's comment.
- **Radio sleep**: `WiFi.setSleepMode(WIFI_NONE_SLEEP)` is set unconditionally at the top
  of `wifiProvisioningBegin()`. The comment gives a concretely reproduced justification:
  with the Arduino core's default modem-sleep behavior left enabled, "`/api/config` took
  3.8s cold, 2.7s on a second attempt a moment later, then 0.2s once the radio was fully
  awake" — i.e. real, measured latency that would otherwise hit every "tap a switch after
  a while idle" interaction, unacceptable for a mains-powered device with no battery
  motivation to sleep the radio.
- **Static IP** (`applyStaticIpIfConfigured()`): reads `staticIpEnabled` and the
  `staticIp`/`staticGateway`/`staticSubnet` fields from config, calling `WiFi.config(...)`
  before `WiFi.begin()`; falls back to DHCP silently if any of those three fail to parse
  as valid `IPAddress`es ("fall back to DHCP rather than fail closed"). If `staticDns` is
  empty or invalid, DNS falls back to the gateway address.

This confirms the task's expectation directly: the ESP8266 port is a **simpler
captive-portal/plain-JSON flow**, not a port of the ESP32's `wifi_prov_mgr`
Security1/protocomm handshake (`firmware/components/provisioning/provisioning.c`, which
uses `wifi_prov_mgr` SoftAP provisioning with `security1, POP=device_id` per its header
comment) — same POP-like secret (`device_id`) reused as the trust anchor, but carried as
a plain WPA2 SoftAP password plus unauthenticated-until-claimed plain JSON, rather than a
proof-of-possession cryptographic handshake.

---

## 9. Recovery button — `recovery_button.h`/`.cpp`

Two build variants selected entirely by preprocessor, keyed off
`SS_BOOT_BUTTON_GPIO` (`board_config.h`):

- **`SS_BOOT_BUTTON_GPIO >= 0`** (real implementation, `#if SS_BOOT_BUTTON_GPIO >= 0`):
  - `recoveryButtonBegin()`: `pinMode(SS_BOOT_BUTTON_GPIO, INPUT_PULLUP)`.
  - `recoveryButtonLoop()`: tracks press/release edges via `s_pressed` +
    `s_pressStartMs` (both `millis()`-based, no blocking):
    - While held, if elapsed hold time reaches `SS_BOOT_LONG_HOLD_MS = 12000` (12s) and
      the long-action hasn't already fired this press (`s_longFired` latch), calls
      `doFactoryReset()` **immediately while still held** — does not wait for release.
    - On release, if the button was held for at least `SS_BOOT_SHORT_HOLD_MS = 5000` (5s)
      *and* the long-hold action never fired during this press, calls
      `doNetworkReset()`.
  - So the exact behavior is: **hold 5-11.9s then release → network reset**; **hold
    ≥12s (regardless of when/whether you release) → factory reset**, and the factory
    reset preempts the network reset (the 5s short-hold path is skipped once
    `s_longFired` is set).
  - `doNetworkReset()`: `ESP.eraseConfig()` (wipes the ESP8266 SDK's own persistent WiFi
    STA credentials only) then `delay(200); ESP.restart();`.
  - `doFactoryReset()`: `LittleFS.format()` (wipes the config filesystem — switches,
    schedules, auth password, cloud_secret, everything in `/config.json`) **and**
    `ESP.eraseConfig()`, then restart. This is a strictly bigger wipe than the network
    reset.
- **`SS_BOOT_BUTTON_GPIO == -1`** (the shipped default per `board_config.h`): both
  functions compile to empty no-ops. **The recovery button feature is entirely disabled
  out of the box on this board.** The header's own comment states the fallback for
  factory reset in this configuration is re-flashing over USB with `erase_flash`
  ("the bench setup already has access to").

These hold-duration semantics (short-hold = WiFi-only, long-hold = full factory reset)
match the ESP32 firmware's `recovery_button.c` in spirit (same two-tier design,
confirmed by reading `firmware/components/recovery_button/recovery_button.c`), though the
ESP32 implementation runs as a dedicated polling FreeRTOS task
(`xTaskCreate(button_task, ...)`, 100ms poll interval) rather than being folded into a
shared cooperative `loop()` — another concrete instance of the architectural split
described in §1.

---

## 10. Schedule execution — `schedule_exec.h`/`.cpp`

### Clock source

- **Primary**: a DS3231 RTC accessed via **RTClib**'s `RTC_DS3231` class over I2C
  (`Wire.begin(SS_I2C_SDA_GPIO, SS_I2C_SCL_GPIO)` in `scheduleExecBegin()`).
  `s_rtcOk = s_rtc.begin()` records whether the chip ACKed on the bus.
- **Fallback**: if the RTC didn't initialize (`!s_rtcOk`), `getNowEpoch()` falls back to
  `time(nullptr)` — the ESP8266 Arduino core's own system clock, which is fed by SNTP.
  `configTime(0, 0, "pool.ntp.org")` is started unconditionally in `scheduleExecBegin()`
  regardless of RTC presence (UTC0, "never touches local-time math" per the comment), and
  a `settimeofday_cb(onTimeSynced)` callback fires once SNTP actually syncs.
- **RTC healing from SNTP**: `onTimeSynced()` — triggered by the SNTP callback — writes
  the newly-synced system time into the DS3231 (`s_rtc.adjust(DateTime((uint32_t)epoch))`,
  which "also clears the OSF bit" per the comment) whenever the RTC is present. This
  mirrors the role the header attributes to "the ESP32 firmware's sntp_sync_cb."
- **"Known good" gating**: `s_timeKnownGood` starts as `!s_rtc.lostPower()` (RTClib's
  `lostPower()` reads the DS3231's Oscillator Stop Flag — i.e., trust an RTC-backed clock
  immediately at boot only if the RTC itself reports it never lost power) if the RTC is
  present, else `false` until SNTP syncs. `schedulerTick()` refuses to evaluate any
  schedule at all while `!s_timeKnownGood` — "so it never fires on garbage time," matching
  the ESP32 firmware's `schedule_exec.h` comment on the same guarantee.
- Both `scheduleExecTimeIsKnownGood()` and `scheduleExecRtcPresent()` are exposed purely
  as diagnostics via `GET /api/info` (§7) — the header is explicit that RTC presence
  "says nothing about whether its time is trustworthy," only `time_known_good` speaks to
  that.

### Tick / matching model

`scheduleExecLoop()` self-throttles the actual scheduler work to ~1Hz via a
`millis()`-based guard (`if (now - s_lastTickMs < 1000) return;`), then calls
`schedulerTick()`, which for every enabled schedule (`cfg.schedules[i]`, `enabled ==
true`):

- **Countdown schedules** (`type == "countdown"`): fire once
  `epoch >= countdown_started_at + duration_s` (raw UTC epoch arithmetic, no timezone
  involved), then self-disable via `selfDisable()` (which calls
  `configStore.upsertSchedule()` with `enabled = false`). `countdown_started_at` is armed
  entirely by `http_api.cpp`'s `handlePostSchedules()` (§7/§5), not by `schedule_exec`
  itself — `schedule_exec.cpp` only *reads* it.
- **Clock-type schedules** (`"once"`, `"daily"`, `"weekly"`): `time` (`"HH:MM"`) is
  parsed by `parseHhMm()`; matched against **local** time, computed as
  `localEpoch = epoch + utc_offset_min * 60` then `gmtime_r()` on that shifted value (the
  comment stresses "the RTC/SNTP clock itself is never touched by the offset — it's
  applied here, at match time, only"). Weekly schedules additionally check `days_mask`
  against an ISO weekday derived from `tm_wday` (`0` (Sunday) is remapped to `7`).
- **Widened match window, not an exact-second check**: the match condition is
  `localTm.tm_hour == h && localTm.tm_min == m && nowTm.tm_sec < 5` — a 5-second window at
  the top of the target minute, not `tm_sec == 0`. The comment explains why this is
  necessary and safe specifically *because* this is a cooperative single-loop firmware:
  "loop() is cooperative and single-threaded (shares time with the HTTP server, WS
  client, mDNS), so a given tick isn't guaranteed to land exactly on the second boundary
  — requiring an exact match could silently skip a whole day's fire." Double-firing
  within that 5-second window is prevented by a **fire-guard** table
  (`FireGuard s_fireGuard[SS_MAX_SCHEDULES]`, keyed by schedule `id`, storing
  `lastFiredMinute`) — a schedule already fired for the current `epoch/60` minute is
  skipped even if `schedulerTick()` re-enters the match window again.
- **`"once"` schedules self-disable** after firing (`selfDisable()`), matching typical
  one-shot semantics; `"daily"`/`"weekly"` do not.
- **`fire(s)`**: sets the relay via `relayHalSetState()` and pushes the change to the
  cloud via `cloudClientNotifyStateChanged()` — the same dual-effect pattern
  `handlePostChannelState()` uses for locally-originated changes (§7).

This whole design — 1Hz cooperative tick, RTC-primary/SNTP-fallback, offset applied only
at match time, fire-guard against a widened window — is explicitly described in the
source as a "ported to millis()-based cooperative scheduling instead of a FreeRTOS task"
version of "the ESP32 firmware's schedule_exec.c... same match logic." The ESP32 side
uses a custom bare I2C `ds3231` component (`firmware/components/ds3231`) rather than
RTClib, since RTClib is an Arduino-ecosystem library not available under ESP-IDF — the
underlying chip (DS3231) and healing/known-good logic are conceptually the same, just
implemented against different low-level APIs.

---

## 11. Cloud client — `cloud_client.h`/`.cpp`

Uses `links2004/WebSockets`' `WebSocketsClient` to hold one persistent connection to
`backend/`'s device-facing WebSocket route.

### Connection setup

`cloudClientBegin()` (called once from `main.cpp::setup()`, non-blocking itself):
```cpp
if (SS_CLOUD_WS_USE_TLS) {
  s_ws.beginSSL(SS_CLOUD_WS_HOST, SS_CLOUD_WS_PORT, SS_CLOUD_WS_PATH);
} else {
  s_ws.begin(SS_CLOUD_WS_HOST, SS_CLOUD_WS_PORT, SS_CLOUD_WS_PATH);
}
s_ws.onEvent(onWsEvent);
s_ws.setReconnectInterval(5000);
```
With the default `board_config.h` values this dials `ws://192.168.100.143:3000/device`
(TLS disabled). `cloudClientLoop()` only pumps `s_ws.loop()` once
`wifiProvisioningIsConnected()` is true — it's a no-op before STA connects.

### Auth mechanism

On `WStype_CONNECTED`, `sendAuthFrame()` immediately sends a JSON text frame:
```json
{"deviceId": "<device_id>", "cloudSecret": "<cloud_secret>"}
```
i.e. the device authenticates itself to `backend/` using the same `cloud_secret` that was
generated at first boot and printed on the QR sticker (§4, §5) — a shared-secret model,
not a signed token or TLS client cert. A brief cross-check of `backend/src/routes/devices.js`
confirms the backend's device-claim route accepts exactly `{deviceId, cloudSecret}` and
stores `hashDeviceSecret(cloudSecret)`, and `backend/src/server.js` routes the `/device`
WS upgrade path — consistent with what this firmware sends.

### Message shapes

- **Outbound, on connect** — auth frame above, immediately followed by
  `publishFullState()`: one `state_changed` event per configured switch, replaying
  current state for every channel so "the cloud's cached view resyncs even if changes
  happened while offline" (comment references "spec §18").
- **Outbound, state-changed event** (`cloudClientNotifyStateChanged`, called from
  `http_api.cpp`'s channel-state handler and `schedule_exec.cpp`'s `fire()`):
  ```json
  {"event": "state_changed", "channelIdx": <n>, "state": "ON"|"OFF"}
  ```
  No-op (frame is simply not sent) if `s_connected` is false — "the next reconnect
  republishes full current state anyway," so there is no send queue/retry for this frame.
- **Inbound, relayed command** — the cloud sends a JSON frame shaped like
  `{"reqId": "...", "method": "GET"|"POST"|"DELETE", "path": "/api/...", "body": {...}?}`.
  `handleIncomingFrame()` parses it and, if all three of `reqId`/`method`/`path` are
  present, calls `proxyAndReply()`.
- **`proxyAndReply()`** — this is the mechanism by which the cloud can invoke *any*
  already-registered local `/api/*` handler without duplicating a single line of handler
  logic: it makes a real HTTP request to `http://127.0.0.1<path>` using
  `ESP8266HTTPClient`, forwarding the method and (for non-GET, serialized) body, then
  wraps the real HTTP status + parsed JSON body (or `null` if empty/unparseable) into:
  ```json
  {"reqId": "...", "status": <int>, "body": <object>|null}
  ```
  and sends that back over the WebSocket. This is exactly the loopback call
  `http_auth.cpp`'s `httpAuthCheck()` bypasses (§7) — cloud-relayed commands reach
  auth-gated endpoints as `127.0.0.1`, trusted because auth already happened at the WS
  tunnel layer via the auth frame.
- **Reconnect/backoff**: `s_ws.setReconnectInterval(5000)` is the *only* explicit
  backoff configuration — `WebSocketsClient` handles the actual reconnect loop
  internally once `begin()` is called; there is no exponential backoff or jitter added
  on top by this firmware (contrast with the ESP32's own `cloud_client.h`, whose comment
  promises "reconnects with backoff for as long as the device is powered" via
  `esp_websocket_client`, which does implement exponential backoff internally — the two
  ports rely on their respective underlying libraries' own reconnect policies rather than
  implementing a shared one).

### Interaction with `WEBSOCKETS_TCP_TIMEOUT`

Every 5-second reconnect attempt (`setReconnectInterval(5000)`) that fails to reach
`SS_CLOUD_WS_HOST` synchronously blocks `cloudClientLoop()` — and therefore the entire
cooperative `loop()` — for up to `WEBSOCKETS_TCP_TIMEOUT` (800ms, per the build flag in
§2) while the underlying TCP `connect()` call times out. This is the single largest
remaining source of device-wide latency in the whole firmware, bounded but not
eliminated by the build flag; the only real fix, per both the build-flag comment and
`board_config.h`'s comment, is ensuring `SS_CLOUD_WS_HOST` actually points at a reachable
backend before flashing a real deployment.

---

## 12. Build & flash

Standard PlatformIO CLI workflow, run from `firmware-esp8266/` (the directory containing
`platformio.ini`):

```sh
# Compile only
pio run

# Build the LittleFS filesystem image (from a data/ dir, if one is added later) and
# upload it to the device's filesystem partition
pio run -t uploadfs

# Compile and flash the firmware binary over USB
pio run -t upload

# Open a serial monitor at the configured baud rate (115200), with the
# ESP8266 exception decoder filter active
pio device monitor
```

Notes:
- There is currently **no `data/` directory** in `firmware-esp8266/` to seed a
  filesystem image from — `board_build.filesystem = littlefs` only governs the *format*
  PlatformIO uses when you do choose to build/upload one via `uploadfs`; the running
  firmware itself creates `/config.json` on first boot via `ConfigStore::begin()`
  regardless (§5), so an initial `uploadfs` is not required to get a working device.
- `-e nodemcuv2` is implicit/default since it's the only environment defined in
  `platformio.ini`; it can be passed explicitly (`pio run -e nodemcuv2 ...`) but isn't
  required.
- A build already exists under `firmware-esp8266/.pio/build/nodemcuv2/` (`firmware.bin`,
  `firmware.elf`) from a prior `pio run`, confirming the project builds under this
  toolchain as configured.

---

## 13. Comparison vs. `firmware/` (ESP32)

| Aspect | `firmware-esp8266/` (this port) | `firmware/` (ESP32) |
|---|---|---|
| Concurrency model | Single cooperative `loop()`, no RTOS; every subsystem's `*Loop()`/`*_loop()` is called in sequence from one function (`main.cpp::loop()`) | FreeRTOS multi-task: `http_api_start()` runs on its own task, `cloud_client_init()` starts a dedicated long-lived task, `recovery_button_init()` spawns `xTaskCreate(button_task, ...)`, etc. |
| Toolchain / framework | PlatformIO, Arduino core (`framework = arduino`) | ESP-IDF (native), CMake/idf.py build |
| Board / channels | NodeMCU/Wemos D1 mini (ESP-12E/F), **7 channels** (6 relay + 1 MOSFET), direct GPIO only | Reference 6-channel board, **6 channels**, direct GPIO (`I2C_EXPANDER` driver value defined but unused on the reference board) |
| WiFi provisioning | Plain-JSON SoftAP: SSID `SmartSwitch-<device_id>`, WPA2 password = `device_id` itself, JSON `POST /api/wifi` or an HTML fallback form at `/`. No cryptographic pairing layer. | `wifi_prov_mgr`-based SoftAP provisioning using **Security1** with **POP = device_id** — a real proof-of-possession handshake, not just a WPA2 password equal to a known string |
| RTC handling | DS3231 via **RTClib** (Arduino library); SNTP fallback via `configTime()`/`settimeofday_cb`; RTC healed from SNTP on sync | DS3231 via a custom bare-I2C `ds3231` ESP-IDF component (no RTClib — Arduino-only library); same known-good-gating concept |
| Partition / OTA scheme | **No OTA support at all** — single `[env:nodemcuv2]`, no `POST /api/ota` route, no signature verification, no rollback logic anywhere in this tree. Firmware updates require physical USB reflashing (`pio run -t upload`). | Full OTA: dedicated `ota` component (`firmware/components/ota`) with `POST /api/ota`, ECDSA-P256 signature verification (`X-Firmware-Signature` header) before marking a partition bootable, and self-healing rollback (`ota_confirm_if_healthy` reboots back to the previous slot if a fresh OTA image doesn't reach a "confirmed" state within a timeout) |
| HTTP API surface | Same `/api/*` paths/methods as ESP32 for every shared endpoint, **plus** `GET /` (provisioning fallback form) and an extra `rtc_present` field on `GET /api/info`. **Missing** `POST /api/ota`. | Same core `/api/*` set, **plus** `POST /api/ota` (registered by the `ota` component onto the same server handle). No `GET /` route (provisioning is handled by `wifi_prov_mgr`'s own mechanism, not this HTTP server) |
| Recovery button | Wired to a single GPIO (`SS_BOOT_BUTTON_GPIO`), polled from the cooperative `loop()`; **disabled by default** (`-1`, no free GPIO on this board's default wiring) | Dedicated FreeRTOS polling task (`button_task`, 100ms interval), always active on `CONFIG_SS_BOOT_BUTTON_GPIO` |
| Cloud reconnect backoff | Fixed 5000ms retry interval (`WebSocketsClient::setReconnectInterval`), no explicit backoff/jitter added by this firmware | `esp_websocket_client`'s own internal exponential backoff, per the ESP32 `cloud_client.h` comment |
| Config schema | `SsConfig` — same field names/semantics as ESP32's `ss_config_t` (confirmed field-by-field, §5), differing only in channel count (7 vs 6), default `board_type` string, and in-memory-only C++ naming style for the static-IP fields | `ss_config_t` |
| Auth model | HTTP Basic + SHA-256 (BearSSL) + loopback bypass + exponential-ish lockout (30s→300s cap after 5 failures) | Described as mirrored in intent by this port's own comments; this task did not re-derive the ESP32 `http_auth.c` lockout constants line-by-line to confirm exact numeric parity |
| Status LED | `SS_STATUS_LED_GPIO` constant declared but **unused** anywhere in the source | Not reviewed as part of this task |
| Tests | **None** — `firmware-esp8266/test/` does not exist | Not reviewed as part of this task |

---

## 14. Known gaps / TODOs

Concrete gaps found while reading the source, not speculation:

- **No test directory.** `find firmware-esp8266/test -type f` returns nothing —
  `firmware-esp8266/test/` doesn't exist at all (not even empty-but-present). There is no
  unit or integration test coverage anywhere in this tree.
- **No README.** `firmware-esp8266/` has no `README.md` (or any `README*` file) — the
  only project-level documentation is the `platformio.ini` header comment and this
  document.
- **No OTA support.** Confirmed by the absence of any `/api/ota` route in
  `httpApiBegin()`, no signature-verification code, and no partition-management logic
  anywhere in `firmware-esp8266/`. Firmware updates require physical USB access
  (`pio run -t upload`). This is a genuine capability gap versus the ESP32 firmware's
  `ota` component (§13), not an oversight in this documentation — the code for
  in-the-field updates simply isn't present.
- **Recovery button disabled out of the box.** `SS_BOOT_BUTTON_GPIO = -1` in
  `board_config.h`'s shipped defaults means neither the short-hold network reset nor the
  long-hold factory reset is reachable without a hardware change first (wiring an
  external button to a chosen free GPIO) and a firmware edit to point
  `SS_BOOT_BUTTON_GPIO` at it. Until then, the only recovery path is USB reflash with
  `erase_flash`, per the header's own comment.
- **`SS_STATUS_LED_GPIO` is declared but never used.** No `.cpp` file in this tree
  references it — there is no status-LED driver logic at all, despite the constant's
  existence in `board_config.h` implying one might have been planned.
- **`"LAST"` boot-state value is accepted in schema but not implemented.**
  `SsSwitch::default_boot_state` allows any string but only `"ON"` is ever treated
  specially by `main.cpp::applyBootStates()` — anything else, including a client that
  sets `"LAST"`, behaves identically to `"OFF"`. `relay_hal` has no persisted or
  read-back last-known hardware state to restore from, so this isn't a simple oversight;
  implementing it would require either persisting last state on every relay change or
  reading back some hardware signal, neither of which exists today.
- **No exponential backoff on cloud reconnects.** `s_ws.setReconnectInterval(5000)` is a
  flat retry interval; unlike the ESP32 port (whose underlying `esp_websocket_client`
  library backs off exponentially), a persistently unreachable backend means this device
  retries — and therefore risks hitting the `WEBSOCKETS_TCP_TIMEOUT`-bounded stall (§11)
  — every 5 seconds, indefinitely, with no growing delay to reduce that cost over time.
  This is a real, if minor, operational difference worth being aware of when the cloud
  backend is down for an extended period.
- **Static IP config only takes effect after a reboot.** `POST /api/network` persists
  the new setting then unconditionally calls `ESP.restart()` — there is no live-apply
  path; this matches the documented ESP32 behavior (per this port's own comment
  referencing "mirrors the ESP32 firmware's equivalent") rather than being unique to this
  chip, but is worth noting as an experience characteristic either way.
- **`SS_CLOUD_WS_HOST` ships as a literal bench IP** (`192.168.100.143`) that must be
  edited and reflashed for any real deployment; there is no runtime (HTTP-configurable)
  way to point this firmware at a different backend host — by design, per the comment
  ("Single self-hosted backend, no runtime configurability needed").
- **`http_auth.cpp`'s exact lockout constants were not cross-checked against
  `firmware/components/http_auth/http_auth.c`** line-by-line as part of this task — the
  ESP8266 side's own comments claim behavioral parity with the ESP32 firmware, but this
  document only confirms the *design* (loopback bypass, open-until-claimed, Basic auth +
  SHA-256 + lockout) matches, not that every numeric constant (`LOCKOUT_THRESHOLD=5`,
  `LOCKOUT_BASE_S=30`, `LOCKOUT_MAX_S=300`) is identical on both chips.
