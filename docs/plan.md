# Smart Switch IoT Platform — Technical Specification & Build Plan (Serverless)

firmware path : firmware
app path : app


**No backend, no database, no broker.** Two components only: ESP32/ESP8266 relay
nodes (each self-hosting its own config + HTTP API) and a Flutter app that talks to
them directly. Multi-zone, multi-ESP, dynamic switch/schedule creation, remote WiFi
reconfig — all without a server to run or maintain.

---

## 0. Assumptions & What Changed From a Server-Based Design

- Each ESP is the **source of truth for its own config** (switches, zone tag,
  schedules) — this is what makes multi-phone use work without a sync backend: any
  phone that talks to a device sees the same data.
- **Remote/away-from-home access** is recommended via your existing MikroTik
  Tailscale subnet-routing setup rather than a cloud relay — zero new infra, reuses
  what's already deployed. ESP32 cannot run a Tailscale/WireGuard client itself, so
  this only works because the router does the routing, not the device.
- **Cross-device Groups and group-targeted schedules are a known limitation.** No
  device can authoritatively own config that spans other devices without a shared
  store. v1 keeps Groups phone-local (not synced across users) — flagged explicitly
  below, not silently dropped.
- **OTA** is handled via a direct binary-upload endpoint on the device; the app
  fetches release binaries from a static host (e.g. GitHub Releases) — not "a
  server" in the sense of anything you run or maintain.
- Firmware still **ESP-IDF native**: `esp_http_server`, `mdns`, `wifi_prov_mgr`,
  I2C expander HAL, DS3231 RTC, `esp_https_ota` adapted for local upload.

---

## 1. Architecture Overview

```
┌────────────────┐    mDNS discovery     ┌───────────────┐
│  Flutter App    │◄─────────────────────►│ ESP32/8266     │
│  local device    │   HTTP REST — LAN    │ Relay Node     │
│  registry +      │   or via Tailscale   │ (HTTP server + │
│  groups cache    │   subnet route       │  mDNS + local  │
│  (Hive/sqflite)   │                     │  config JSON)  │
└────────────────┘                       └───────────────┘
        direct connections to N devices, no intermediary
```

**Remote path:** phone runs the Tailscale app → MikroTik (already subnet-routing)
advertises the home LAN → phone reaches each ESP's static-reserved LAN IP directly,
same as being home. No VPN client on the ESP itself.

---

## 2. Device-Resident Data Model

No DB — config lives as JSON in NVS/LittleFS on each device, served via REST.

```json
// GET /api/config
{
  "device_id": "esp-7a1c2e",
  "name": "Utility Panel A",
  "board_type": "8CH_EXP",
  "channel_count": 8,
  "channel_driver": "I2C_EXPANDER",
  "fw_version": "1.3.0",
  "switches": [
    {
      "channel_idx": 0,
      "name": "Living Room Ceiling",
      "zone": "Living Room",
      "type": "ON_OFF",
      "default_boot_state": "LAST"
    }
  ],
  "schedules": [
    {"id": "s-1", "channel_idx": 0, "action": "ON", "type": "daily", "time": "18:30", "days": [1,2,3,4,5,6,7], "enabled": true},
    {"id": "s-2", "channel_idx": 3, "action": "OFF", "type": "countdown", "duration_s": 1800, "enabled": true}
  ]
}
```

`type` on switches stays `ON_OFF` today, `DIMMER` reserved — same forward-compat
note as before, relay modules are ON/OFF only. `schedule.type` covers both
clock-based (`once`/`daily`/`weekly`) and **countdown** (`duration_s`, auto-reverses
the action after N seconds) — the "timer on/off" requirement.

---

## 3. HTTP API (device-hosted)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/info` | device_id, board_type, channel_count, fw_version — discovery confirm |
| GET | `/api/config` | full config: switches, schedules, zone tags |
| POST | `/api/switches` | create/update a switch (label a channel) |
| DELETE | `/api/switches/:channel_idx` | unlabel a channel (wiring stays) |
| GET | `/api/channels` | live state snapshot (for polling) |
| POST | `/api/channels/:idx/state` | `{"state":"ON"}` manual toggle |
| POST | `/api/schedules` | create/update schedule (clock or countdown) |
| DELETE | `/api/schedules/:id` | |
| POST | `/api/wifi` | change WiFi creds, test-before-commit-rollback |
| POST | `/api/ota` | multipart firmware binary upload |
| POST | `/api/auth/password` | set/change local API password |

Real-time push (WebSocket on-device) is a viable v2 upgrade; default to short-poll
(`GET /api/channels` every 2–3s, only for the zone currently on screen) — simpler,
fewer connection-state edge cases, robust across LAN/Tailscale switching.

---

## 4. Discovery & App-Side Device Registry

- Device advertises `_esp-switch._tcp.local` via mDNS with TXT records
  (`device_id`, `board_type`, `channel_count`).
- Flutter: `multicast_dns` or `bonsoir` to browse for the service on LAN.
- App persists a local **known-devices table** (Hive/sqflite): `{device_id,
  mdns_hostname, last_known_ip, friendly_name}`. On launch: try mDNS refresh (LAN)
  → fall back to `last_known_ip` (this is what makes remote/Tailscale sessions work,
  since multicast typically doesn't traverse subnet routes).
- **Reserve a static DHCP lease per ESP on the MikroTik.** Without this,
  `last_known_ip` goes stale whenever DHCP reassigns an address, and remote control
  silently breaks. Non-optional for the remote-access path to be reliable.

---

## 5. Provisioning & WiFi Reconfig

**First claim (no backend to register with):**
1. First boot, no NVS creds → SoftAP + HTTP provisioning endpoint (`wifi_prov_mgr`,
   same transport as a server-based design).
2. App connects to the SoftAP, sends home WiFi creds directly — no claim_token,
   nothing to register.
3. Device joins home WiFi, starts advertising via mDNS.
4. App discovers it on the home network, sets name/zone/switch labels directly via
   `POST /api/switches` and `/api/config`.

**Later reconfig (device already on home WiFi):**
1. App already knows the device's current LAN IP from its registry.
2. `POST /api/wifi` with new creds, direct to the device.
3. Device caches current creds, tests new ones (~20s timeout).
4. Success → persist, respond `CONNECTED`. Failure → **revert to cached creds**,
   respond `FAILED_ROLLED_BACK`. This is more critical now than in a server-based
   design — there's no backend to resend a corrective command if it goes wrong.

**Recovering a device that's already off the network** (router SSID/password
already changed, device can't reconnect):

This is a distinct case from "later reconfig" above. If the device has no network
path at all, nothing — app, VPN, Tailscale — can reach it; reconfiguration requires
physical proximity, same as first claim. Design for it explicitly:

1. Hold the device's BOOT button (GPIO0) ~5s → re-enters SoftAP provisioning mode
   **without erasing switches/schedules**, only network credentials are reset. A
   longer hold (~10–15s) does a true factory reset/NVS erase — keep these distinct
   so a router change doesn't cost you a re-do of every switch label.
2. App shows the known device as unreachable (failed poll against its cached IP)
   and offers "Reconnect via device Wi-Fi," reusing the same SoftAP-connect UI
   component as first-time provisioning rather than a separate flow.
3. Phone joins the device's SoftAP, app pushes the new home WiFi creds, device
   reconnects and re-advertises via mDNS — existing switch/schedule config is
   untouched throughout.

**Practical tip**: if you're planning a router SSID/password change, reconfigure
devices via the app *before* applying the change on the router, while they can still
be reached on the old network — it sidesteps the physical-proximity requirement
entirely and is the main thing "change network config whenever I want" buys you in
practice.

---

## 6. Scheduling

On-device `schedule_exec` (DS3231 + SNTP) is no longer "primary with a backend
fallback" — it's the **sole execution path**. Both clock and countdown schedules run
fully on-device; the app is purely a config UI, not part of the execution chain, and
doesn't need to be open for a schedule to fire.

---

## 7. Zones & Groups (client-side aggregation)

- **Zones**: no zone entity anywhere. The app builds its "Zones" screen by grouping
  the switches of all currently-known devices by their `zone` string tag, live, in
  memory. Editing a switch's zone is just a `POST /api/switches` to the owning
  device. A local autocomplete cache of zone names the user has typed before is a
  nice-to-have, not authoritative.
- **Groups** (multi-switch, possibly cross-device master toggle): stored **locally
  per phone** (Hive/sqflite) — no device can own a definition that spans other
  devices. **This will not sync across multiple family members' phones.** If that
  starts to matter, the fix is one small always-on local service (e.g. an LXC on
  your existing Proxmox box) holding just that shared bit of state — deliberately
  left out of v1 given "just app and ESP."
- **Group-targeted schedules**: same limitation. Implement by having the app expand
  a group schedule into N individual per-switch schedule calls at creation time —
  execution still happens fully on-device, but "this is one group schedule" only
  exists as a concept in the phone's local UI layer.

---

## 8. Remote Access

- Reuse the existing MikroTik Tailscale subnet route: phone joins the tailnet,
  reaches each ESP's static-reserved IP exactly as if on the home LAN.
- mDNS discovery only works on LAN — remote sessions rely entirely on the cached
  `last_known_ip`, which is why the static DHCP reservation above isn't optional.
- No Tailscale, no remote control — by design, this is the direct tradeoff of going
  serverless. If away-from-home control turns out not to matter, this whole section
  can be dropped and the system is LAN-only, which simplifies everything else too.

---

## 9. Security Checklist

- Local HTTP API protected by a **device-set password** (Basic Auth or token),
  configured during provisioning — LAN/Tailscale reachability alone isn't a strong
  trust boundary once a tailnet or household is shared.
- WiFi creds only ever transmitted over the encrypted SoftAP provisioning session or
  the already-authenticated home LAN — never leaves the local network.
- OTA binary upload should verify a signature/checksum before flashing (embed a
  build-time public key, sign releases) — there's no backend vouching for firmware
  authenticity anymore; the phone pulling straight from GitHub Releases is the only
  checkpoint.
- Consider TLS on the device's local HTTP server (self-signed cert, pinned in-app)
  if the tailnet includes other people's devices; optional for a private home-only
  LAN.

## 10. Reliability Checklist

- DS3231 RTC is now non-negotiable — it's the only clock for the only scheduler.
- WiFi reconfig test-before-commit-rollback — more critical than before, since
  there's no backend fallback if a bad push gets through.
- Static IP reservation per device, with a "device unreachable — rescan" affordance
  in the app for when it inevitably happens anyway.
- Manual provisioning-mode trigger (BOOT button hold) kept distinct from factory
  reset, so recovering a device that's already off-network doesn't cost you its
  switch/schedule config.
- Dual OTA partition + auto-rollback on failed boot/connect — unchanged, essential.
- Per-switch configurable boot state (OFF/ON/LAST) — unchanged.
- App caches the last full `/api/config` + channel states locally so the UI shows
  something sensible even when a device is briefly unreachable (offline-first read
  model, not just a spinner).

## 11. Hardware BOM

Unchanged from the server-based plan: ESP32 + PCF8574/MCP23017 I2C expanders for
8–14ch boards, direct GPIO fine for 2–6ch, DS3231 RTC on the shared I2C bus,
opto-isolated relay modules rated for the load.

---

## 12. Phased Build Order (for Claude Code)

1. **Firmware core** — device-resident JSON config schema, GPIO-direct relay HAL,
   `wifi_prov_mgr` SoftAP+HTTP, build against a 4ch reference board.
2. **Firmware HTTP API** — `esp_http_server`: `/api/info`, `/api/config`,
   `/api/channels`, `/api/switches`, local password auth.
3. **Firmware mDNS** — advertise `_esp-switch._tcp`, TXT records.
4. **Firmware I2C expander HAL + DS3231** — extend to 8/10/12/14ch reference configs.
5. **Firmware schedule_exec** — on-device clock + countdown schedules,
   `/api/schedules` CRUD.
6. **Firmware WiFi reconfig** — test-before-commit-rollback via `/api/wifi`, plus
   BOOT-button-triggered re-entry into provisioning mode (short hold = network reset
   only, long hold = full factory reset) for devices already off the network.
7. **Firmware OTA** — local binary upload endpoint, dual partition, rollback,
   signature check.
8. **Flutter app core** — local device registry (Hive/sqflite), mDNS discovery
   (`multicast_dns`/`bonsoir`), direct HTTP client per device.
9. **Flutter provisioning wizard** — SoftAP connect flow, WiFi creds entry, initial
   switch/zone labeling; reused for the "reconnect unreachable device" recovery
   flow (same UI, different entry trigger).
10. **Flutter zones/switches UI** — client-side zone aggregation across devices,
    poll-based manual toggle.
11. **Flutter scheduling UI** — clock + countdown schedule creation, per switch.
12. **Flutter groups (phone-local)** — multi-switch grouping, expanded into
    per-device schedule calls where relevant.
13. **Flutter remote access** — Tailscale-aware reachability (LAN vs cached IP
    fallback), "device unreachable — rescan" UX.
14. **Hardening pass** — security + reliability checklists, multi-board test matrix,
    verify behavior with 2+ phones controlling the same devices concurrently.

---

## 13. Open Decisions / Recommended Defaults

| Decision | Default | Alternative |
|---|---|---|
| Config storage | Device-resident (NVS/LittleFS JSON) | — (this replaces the DB entirely) |
| Discovery | mDNS (LAN) + cached IP fallback | Static IP-only, skip mDNS complexity |
| Remote access | Existing MikroTik Tailscale subnet route | LAN-only, no remote control |
| Real-time state | Short-poll (2–3s, foregrounded zone only) | WebSocket on-device (snappier, more complex) |
| Cross-device groups | Phone-local only, not synced | Small local LXC config store (adds a component) |
| OTA hosting | GitHub Releases (static, not "a server") | Bundle binaries in-app, manual sideload |
| Local API auth | Device-set password (Basic Auth/token) | Open on LAN, trust the network boundary only |