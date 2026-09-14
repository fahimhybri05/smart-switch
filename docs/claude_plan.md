# Smart Switch — Scaffold firmware/ + app/ from docs/plan.md

## Context

`docs/plan.md` is a complete, already-reviewed technical spec (serverless ESP32/Flutter
smart-switch platform — no backend). §12 gives a 14-phase build order. Repo currently: not
git-initialized, `firmware/` and `app/` both exist but are completely empty.

This plan covers **scaffolding only** — the buildable/analyzable skeleton that Phase 1
(firmware) and Phase 8 (app) get real logic built into next session. Not full phase 1-14
implementation. Two Plan agents independently designed each track after reading the spec and
probing this machine's actual toolchain (ESP-IDF v5.5.3 at `~/esp/esp-idf`, Flutter 3.41.6 /
Dart 3.11.4 at `/home/fahim/Downloads/flutter`) — decisions below are verified against those,
not assumed.

Goal after this pass: `idf.py build` succeeds (firmware, no hardware attached — build-only
verification) and `flutter build apk --debug` succeeds (app, no device attached — build-only
verification). Both are real starting points, not throwaway stubs.

---

## Track A — Firmware scaffold (`firmware/`)

**Target:** ESP32 (plain WROOM-32), 4MB flash, ESP-IDF native (per spec §0 — not PlatformIO
despite it being installed). 4-channel GPIO-direct reference board (I2C expander boards are
Phase 4, not now).

**Config storage: LittleFS, not NVS**, for the JSON blob (`/storage/config.json` round-trips
spec §2's schema directly) — NVS still used underneath by `wifi_prov_mgr`/`esp_wifi` for STA
creds and later by OTA's `otadata`. Verified against `esptool_py`/`bootloader_utility.c` in the
installed IDF checkout.

**Partition table — dual-OTA-ready now** (no `factory` partition; bootloader source confirms
it boots `ota_0` when `otadata` is blank and no `factory` slot exists):
```
nvs,      data, nvs,      , 0x6000,
otadata,  data, ota,      , 0x2000,
phy_init, data, phy,      , 0x1000,
ota_0,    app,  ota_0,    , 1536K,
ota_1,    app,  ota_1,    , 1536K,
storage,  data, littlefs, , 256K,
```
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` stays **off** — turning it on before Phase 7 adds the
`esp_ota_mark_app_valid_cancel_rollback()` confirmation call would bootloop. Layout is ready;
logic lands in Phase 7.

**File tree:**
```
firmware/
├── CMakeLists.txt, version.txt, partitions.csv, sdkconfig.defaults, .gitignore
├── main/  (CMakeLists.txt, Kconfig.projbuild, main.c)
└── components/
    ├── config_store/   (LittleFS-backed ss_config_t load/save/default — real, not stub)
    ├── relay_hal/      (GPIO-direct real implementation; I2C_EXPANDER path returns
    │                    ESP_ERR_NOT_SUPPORTED, deferred to Phase 4)
    └── provisioning/   (stub: proves wifi_prov_mgr/protocomm/softap link graph +
                         is-provisioned check; no real SoftAP/credential exchange yet)
```
`Kconfig.projbuild` exposes board pin mapping (not hardcoded): 4 relay GPIOs (16/17/18/19,
active-low default per opto-isolated relay module norms), BOOT button GPIO0 (spec §5 recovery
hold), status LED GPIO2, channel count.

`main.c` boot sequence: NVS init → netif/event loop → `config_store_init()` (mounts LittleFS,
creates default config deriving `device_id` from MAC like the spec's `esp-7a1c2e` example) →
`relay_hal_init()` + apply each switch's `default_boot_state` → `provisioning_init()` stub →
log boot banner. No HTTP server, no mDNS, no scheduler — those are Phases 2/3/5, and adding
even a health-check endpoint now would blur the phase boundary.

**Explicitly not built:** I2C expander HAL, DS3231, `esp_http_server`/any `/api/*` routes, mDNS,
`schedule_exec`, real WiFi provisioning (SoftAP credential exchange + rollback), OTA logic.

**Verification (build-only, no hardware):**
```bash
. ~/esp/esp-idf/export.sh
cd /var/www/html/smart-switch/firmware
idf.py set-target esp32 && idf.py build && idf.py size
```

---

## Track B — Flutter app scaffold (`app/`)

**Assumptions flagged for user override:** org `tech.hybri` (reverse-DNS of hybri.tech, from
user's email domain) / project `smart_switch` → `tech.hybri.smart_switch`. State mgmt:
**Riverpod** (`flutter_riverpod ^3.3.2` — pinned; latest 3.4.x needs Dart `^3.12.0`, installed
is 3.11.4). Storage: **`hive_ce`/`hive_ce_flutter`** fork, not original `hive` (SDK-incompatible)
or `sqflite` (Flutter-version-incompatible with installed 3.41.6). Discovery: **`multicast_dns`**
over `bonsoir` (leaner, no native platform-channel setup needed yet; `bonsoir` is the documented
fallback if Android mDNS proves flaky later). Models: **plain Dart classes, hand-written
`fromJson`/`toJson`** — no `freezed`/codegen, keeps the scaffold buildable with zero
`build_runner` step. Platforms: `android,ios` only (no `web` — `multicast_dns` has no web impl;
no `linux` — local toolchain missing `clang++`/GTK3-dev).

**Setup:**
```bash
flutter create --org tech.hybri --project-name smart_switch --platforms=android,ios \
  /var/www/html/smart-switch/app
flutter pub add 'flutter_riverpod:^3.3.2' http multicast_dns hive_ce hive_ce_flutter
```

**Directory layout** (`app/lib/`):
```
models/device/    — DeviceInfo, DeviceConfig, SwitchConfig, Schedule, ChannelState
                     (mirror spec §2/§3 wire schema exactly, incl. ON_OFF/DIMMER,
                      OFF/ON/LAST, once/daily/weekly/countdown enums)
models/local/     — KnownDevice (§4 registry row), SwitchGroup (§7 phone-local groups)
services/         — DeviceApiClient (1 method per §3 endpoint, bodies throw
                     UnimplementedError), DiscoveryService, DeviceRegistryService,
                     GroupService (all signature-only shells), ZoneAggregationService
providers/        — service_providers.dart, plain Riverpod Provider/Provider.family wiring
routing/           — app_routes.dart (named routes, not go_router yet)
screens/          — home_shell.dart (bottom-nav: Zones/Switches/Schedules/Groups) +
                     one placeholder screen each for zones, switches, schedules, groups,
                     provisioning wizard, settings
test/widget_test.dart — replaces stock counter test with a ProviderScope smoke test
```

**Explicitly not built:** no `http`/`multicast_dns`/`hive_ce` imports actually wired (services
stay `UnimplementedError`), no SoftAP connect flow, no polling loop, no zone-aggregation logic,
no Android/iOS manifest permissions for multicast/Bonjour (Phase 8 concern).

**Verification (build-only, no device attached):**
```bash
cd /var/www/html/smart-switch/app
flutter pub get && flutter analyze && flutter test && flutter build apk --debug
```
(`flutter build ios` unverifiable on this Linux machine — known gap, not skipped from
`--platforms`. `flutter build web` intentionally not gated — web excluded on purpose.)

---

## Execution order

Two independent tracks, no shared files — can build firmware and app scaffolds in either order
or interleaved. Recommend: firmware first (Track A), verify `idf.py build` green, then app
(Track B), verify `flutter build apk --debug` green. Fix any build errors surfaced by real
toolchain output before considering scaffold done — this is a from-scratch build, first-run
issues (e.g. component-manager fetch of `joltwallet/littlefs`, `dependencies.lock` creation) are
expected and should be resolved, not worked around.

## Verification summary

1. `idf.py build` (firmware) — succeeds, `idf.py size` shows image fits in 1536K `ota_0` slot.
2. `flutter analyze` — no errors.
3. `flutter test` — smoke test passes.
4. `flutter build apk --debug` — succeeds.

Neither track is flashed/run on real hardware or an emulator in this pass — no ESP32 board or
Android device/emulator attached to this machine. That's the natural next step once scaffolding
is confirmed building clean.
