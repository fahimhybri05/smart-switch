# Smart Switch — Flutter App Reference (`app/`)

This document describes what the code in `app/` actually does today. It is
derived entirely from reading `app/lib/**`, `app/test/**`, `app/pubspec.yaml`,
and the relevant native (Android) platform-channel implementations.

`docs/plan.md` is the project's original "serverless, no backend" spec and is
frequently referenced in code comments (`// see docs/plan.md`), but the app
has since grown a full backend-integration layer
(`app/lib/services/backend/*`) that coexists with the original direct-to-
device local control. Where a code comment cites docs/plan.md as rationale
for a design decision, that is noted, but the *behavior* described below is
read from the current source, not the old spec. Several stale strings in the
UI/metadata still call the app "serverless" — see §11.

---

## 1. Overview

Smart Switch is a Flutter mobile/web app that controls ESP32/ESP8266-based
relay "smart switch" boards (the `firmware/` and `firmware-esp8266/` trees in
this repo) and, optionally, coordinates multiple users/phones/households
through a self-hosted Node.js backend (`backend/`).

The app supports **two control paths that coexist by design**, not as
alternate modes the user picks — every device interaction goes through the
same abstraction and the app decides per-call which path to use:

1. **Direct LAN control** — the phone talks straight to a device's local HTTP
   API (`http://<device-ip>/api/...`), exactly as a fully "serverless" app
   would. This requires the phone to be on the same network as the device
   (or a VPN/Tailscale route to it) and the device's local IP to be known.
2. **Backend-mediated control** — when the user is logged in and a backend
   URL is configured, the same logical calls are relayed through the backend
   over a persistent WebSocket (foreground app) or a plain REST relay
   endpoint (headless isolates — see §7), which forwards them to the device
   over the device's own outbound connection to the backend. This is what
   makes a device reachable from outside the LAN (e.g. via mobile data) and
   what lets a device claimed on one phone show up automatically on another
   phone logged into the same account.

**How the two paths actually combine** (confirmed in
`services/device_transport.dart` and `providers/service_providers.dart`):

- `DeviceApiClient` (the single class every screen/service calls for device
  operations) never talks HTTP directly — it delegates every call to a
  `DeviceTransport` it's constructed with. `DeviceTransport` is an interface
  with `send(method, path, {body})` implemented three ways:
  - `LocalHttpTransport` — plain `http` calls to `http://<baseUrl>`, with
    optional HTTP Basic auth (username `device`, password = the device's own
    configured API password), 5s timeout.
  - `CloudRelayTransport` — wraps `BackendWsClient.sendCommand`, used by the
    main (foreground) app isolate, which keeps one shared WebSocket open to
    the backend's `/ws` endpoint for as long as the user is logged in.
  - `RestRelayTransport` — `POST /devices/:deviceId/command` against the
    backend's plain REST relay endpoint, used instead of the WebSocket by
    headless isolates that can't hold a persistent connection open (the
    Android home-screen widget's tap handler and the WorkManager background
    monitor — see §7). Its own client-side timeout (15s) is set comfortably
    above the backend's documented 10s device-relay timeout so a genuine
    `device_timeout` response has time to arrive first.
  - `FallbackDeviceTransport` — wraps a `local` transport and an optional
    `cloud` transport; tries `local` first and falls back to `cloud` on *any*
    transport-level exception (timeout, connection refused — a non-2xx HTTP
    status is **not** treated as a failure here, only transport errors are).
- `activeDeviceApiClientProvider` (a `Provider.family<DeviceApiClient,
  KnownDevice>` in `service_providers.dart`) is what screens actually read.
  For a given `KnownDevice` it:
  - builds a `CloudRelayTransport` if a `BackendWsClient` exists (i.e. the
    user is logged in and a backend URL is configured);
  - if the device has a cached `lastKnownIp`, wraps `LocalHttpTransport` +
    that cloud transport in a `FallbackDeviceTransport` (local-first,
    cloud-fallback);
  - if the device has **no** `lastKnownIp` yet (e.g. it was claimed on a
    *different* phone and synced in via the backend, but this phone has
    never seen it on its own LAN), it skips the local attempt entirely and
    uses the cloud transport directly — there's no point spending a timeout
    on a URL that can't exist;
  - if neither a local IP nor a backend/login is available, it still returns
    a `DeviceApiClient` (pointed at a `FallbackDeviceTransport` with `cloud:
    null` and a dummy `0.0.0.0` local URL) so that calls fail with an honest
    "not reachable" error rather than the provider throwing synchronously.
- This means the *same* `DeviceApiClient` API (`getConfig`, `setChannelState`,
  `upsertSchedule`, …) is used everywhere regardless of which transport is
  actually live underneath — screens and services never branch on "local vs.
  cloud" themselves.

Two headless code paths (`services/isolate_device_relay.dart`'s
`viaLocalOrCloud`) re-implement this same local-first/cloud-fallback policy
by hand for contexts that have no Riverpod `Ref`/`ProviderContainer` at all —
see §7.

---

## 2. Architecture

### State management (Riverpod 3)

The app uses `flutter_riverpod: ^3.3.2` exclusively, and specifically its
newer **non-codegen `Notifier`/`NotifierProvider` API** (there is no
`riverpod_generator`/`build_runner` codegen in this project, and the older
`StateNotifier`/`StateNotifierProvider` API is called out in a comment as "no
longer exported by `flutter_riverpod`" in this major version).

`providers/service_providers.dart` is the single file defining almost every
provider in the app:

- **Plain `Provider<T>`** for stateless services/singletons: `DeviceRegistryService`, `GroupService`,
  `SceneService`, `BackupService`, `AppSettingsService`, `AuthSessionService`,
  `DiscoveryService`, `ZoneAggregationService`, and the per-base-URL
  `DeviceApiClient` family (`deviceApiClientProvider`).
- **`Notifier<T>`/`NotifierProvider`** for local, mutable, often
  Hive-backed state: `ThemeModeNotifier` (`themeModeProvider`),
  `BackendUrlNotifier` (`backendUrlProvider`), `AuthNotifier`
  (`authProvider`), `KnownDevicesNotifier` (`knownDevicesProvider`),
  `GroupsNotifier` (`groupsProvider`), `ScenesNotifier` (`scenesProvider`),
  `HouseholdsNotifier` (`householdsProvider`), `HouseholdInvitesNotifier`
  (`householdInvitesProvider`), `AutomationsNotifier`
  (`automationsProvider`), and `ChannelOverrideNotifier`
  (`channelOverrideProvider`, an optimistic-UI cache — see below).
- **`FutureProvider.autoDispose.family`** for one-shot per-device fetches:
  `deviceConfigProvider(KnownDevice)` → `GET /api/config`.
- **`StreamProvider.autoDispose.family`** for the live channel-state poll:
  `channelStatesProvider(KnownDevice)` — polls `GET /api/channels` every 2
  seconds for exactly as long as some widget is watching it; `autoDispose`
  means the poll loop stops the instant nothing is subscribed, so only
  on-screen devices are actively polled.
- `backendWsClientProvider` rebuilds the shared `BackendWsClient` (see §6)
  whenever the backend URL or login state changes — a token refresh means a
  brand new socket rather than a live token swap mid-connection.

**Optimistic toggling**: `ChannelOverrideNotifier` holds a
`Map<(deviceId, channelIdx), ChannelPowerState>` of just-tapped values. Every
toggle (`DeviceTile`, `SwitchTile`, group/zone/scene "turn all on/off")
writes to this map *before* the HTTP call resolves, so a tile flips
instantly instead of waiting for the next 2s poll tick plus a round trip.
Each entry self-expires after 4 seconds regardless of outcome (a `Future.
delayed` clears it unless something re-set the same key in the meantime),
by which point the real polled/invalidated value has long since landed.

**Backend-derived state has no local fallback by design** in several
places: `Household`/`HouseholdInvite` and `Automation` are backend-only with
**no Hive cache** — the corresponding notifiers just return an empty list
when logged out/offline, on the reasoning (stated in the model doc
comments) that a household roster or a server-evaluated automation rule is
meaningless without a live connection. `SwitchGroup`, by contrast, *is*
cached in Hive (`GroupService`) as a read-through fallback so groups remain
viewable (though not editable) offline.

### App entry / bootstrap

- `main.dart`: calls `WidgetsFlutterBinding.ensureInitialized()` and `Hive.
  initFlutter()`, then builds a `ProviderContainer` **by hand** (there's no
  widget tree yet to get a `Ref` from) and eagerly calls `.init()` on
  `DeviceRegistryService`, `GroupService`, `SceneService`,
  `AppSettingsService`, and `AuthSessionService` (each opens its own Hive
  box). It then reads `startupDeviceSyncProvider` once — a `Provider<void>`
  whose only purpose is to give `syncClaimedDevicesFromBackend` a real `Ref`
  at startup (fire-and-forget: pulls in devices/households/invites for an
  already-logged-in session before the UI even renders). Finally, best-effort
  (wrapped in one `try/catch`, so a failure here never blocks app startup):
  `requestNotificationPermission()`, `initializeBackgroundMonitor()`,
  `initializeWidgetSupport()` (all three are Android-only no-ops elsewhere —
  see §7). The container is then handed to the widget tree via
  `UncontrolledProviderScope`.
- `app.dart`: `SmartSwitchApp` is a `ConsumerWidget` building a
  `MaterialApp` with `lightTheme`/`darkTheme` (see §9) and
  `themeMode: ref.watch(themeModeProvider)`. Its `home` is gated directly on
  login state: `ref.watch(authProvider) == null ? AuthScreen(isSignup:
  false) : HomeShell()`. Login is mandatory to reach the rest of the app —
  there is no "local-only, logged-out" mode (a comment on `AuthNotifier`
  notes this is because devices/groups/rooms are now account-wide, so
  nothing meaningful is left to show without a session). The `routes` map
  used is `AppRoutes.routes` with the `home` entry removed (to avoid
  colliding with the `home:` property, which already builds `HomeShell`).

### Navigation

- `routing/app_routes.dart` — a static `AppRoutes` class of route-name
  constants (`home`, `settings`, `addDevice`, `scanDevices`, `provisioning`,
  `login`, `signup`, `household`, `activity`, `automations`) and a
  `Map<String, WidgetBuilder>` wiring each to its screen. All navigation to
  these routes uses `Navigator.pushNamed`/`Navigator.of(context).pushNamed`.
- `screens/home_shell.dart` (`HomeShell`) is the logged-in app's persistent
  frame: six tabs — Home, Rooms (Zones), Switches, Schedules, Groups, Scenes
  — held in an `IndexedStack` so every tab's `autoDispose` polling providers
  (`channelStatesProvider` etc.) stay alive across tab switches instead of
  being torn down and recreated. Tab switches are purely a fade
  (`AnimatedOpacity`), not a rebuild. Below an 840px width breakpoint it uses
  a bottom `NavigationBar`; at/above it, a side `NavigationRail` (a
  desktop/tablet-landscape layout, useful mainly for browser/dev windows
  since the shipped platforms are Android/iOS/web — see §10).

---

## 3. Data models

### Device-wire models (`models/device/*`) — mirror firmware JSON, never persisted locally

These are pure request/response DTOs fetched live from a device (or the
backend relay) on every use; there is no Hive box for any of them.

| Model | Fields | Wire source |
|---|---|---|
| `ChannelState` / `ChannelPowerState` (`channel_state.dart`) | `channelIdx: int`, `state: ON\|OFF` | `GET /api/channels` (one entry per channel) |
| `DeviceConfig` (`device_config.dart`) | `deviceId`, `name`, `boardType`, `channelCount`, `channelDriver` (`GPIO_DIRECT`\|`I2C_EXPANDER`), `fwVersion`, `switches: [SwitchConfig]`, `schedules: [Schedule]`, `utcOffsetMinutes` (default 0) | `GET /api/config` |
| `DeviceInfo` (`device_info.dart`) | `deviceId`, `boardType`, `channelCount`, `fwVersion`, `wifiReconfigState` (`IDLE\|TESTING\|CONNECTED\|FAILED_ROLLED_BACK`), `cloudSecret?` (only present on firmware with the `cloud_client` component; consumed once by the "Enable remote control" claim flow, never stored), `capabilities` (forward-compat list, e.g. `["switch"]`; unused by any UI today) | `GET /api/info` |
| `Schedule` / `ScheduleType` / `ScheduleAction` (`schedule.dart`) | `id`, `channelIdx`, `action` (`ON\|OFF`), `type` (`once\|daily\|weekly\|countdown`), `enabled`, `time?` ("HH:MM", clock types only), `days?` (1=Mon..7=Sun, clock types only), `durationS?` (countdown only) | `GET /api/config`'s `schedules[]`; written via `POST /api/schedules` / `DELETE /api/schedules/:id` |
| `SwitchConfig` / `SwitchType` / `BootState` (`switch_config.dart`) | `channelIdx`, `name`, `zone`, `type` (`ON_OFF`\|`DIMMER` — dimmer is reserved, relay hardware is binary-only today), `defaultBootState` (`OFF\|ON\|LAST`) | `GET /api/config`'s `switches[]`; written via `POST /api/switches` / `DELETE /api/switches/:idx` |

Note the app has **two distinct scheduling concepts** that look similar but
are not the same thing: a device-resident `Schedule` (above — evaluated by
the firmware itself, only for one device/channel) versus a household-wide,
server-evaluated `Automation` (below — evaluated by the backend, can act on
multiple devices and react to another device's state, not just clock time).

### Local models (`models/local/*`) — app-persisted or backend-synced

| Model | Fields | Storage |
|---|---|---|
| `KnownDevice` (`known_device.dart`) | `deviceId`, `mdnsHostname?`, `lastKnownIp?` (null ⇒ never seen on this phone's LAN, e.g. synced in from another phone's claim — routes through the cloud relay instead), `friendlyName` | Hive box `known_devices`, via `DeviceRegistryService`. Equality is overridden to compare `deviceId` **only** (documented as required so family-keyed providers, e.g. `deviceConfigProvider`/`channelStatesProvider`, don't treat an unchanged device as a new cache key on every `upsert`). |
| `SwitchGroup` / `GroupMember` (`switch_group.dart`) | `id`, `name`, `members: [{deviceId, channelIdx}]` | Account-wide via `BackendGroupsClient`; Hive box `groups` (`GroupService`) is a read-through offline cache only — writes require backend reachability. |
| `SmartScene` / `SceneMember` (`smart_scene.dart`) | `id`, `name`, `icon`, `members: [{deviceId, channelIdx, state}]` | Hive box `smart_scenes` (`SceneService`) **only** — scenes are not synced through the backend at all (see §11). |
| `Automation` / `AutomationTrigger` (`ScheduleTrigger`\|`StateTrigger`, sealed) / `AutomationAction` (`automation.dart`) | `id`, `householdId`, `name`, `enabled`, `trigger`, `actions: [{deviceId, channelIdx, state}]`, `lastFiredAt?` | Backend-only (`BackendAutomationsClient`), **no Hive cache** — server-evaluated, runs even with every phone closed. |
| `Household` / `HouseholdMember` / `HouseholdInvite` (`household.dart`) | `id`, `name`, `timezone`, `role` (`owner`\|`member`), `members`; invite: `id`, `householdId`, `householdName`, `invitedByEmail` | Backend-only, **no Hive cache**. |
| `ActivityEntry` (`activity_entry.dart`) | `id`, `deviceId`, `deviceFriendlyName`, `channelIdx`, `state`, `source` (`app\|widget\|group\|scene\|automation\|device`), `actorEmail?`, `automationId?`, `createdAt` | Backend-only feed (`BackendActivityClient`), **no Hive cache** — a history feed is meaningless offline (per doc comment). |
| `PinnedSwitch` (`pinned_switch.dart`) | `deviceId`, `lastKnownIp`, `channelIdx`, `switchName` | Hive box `pinned_switches` (`widget_service.dart`), max 4 (`maxPinnedSwitches`) — backs the Android home-screen widget. |

### All Hive boxes in the app

`known_devices`, `groups`, `smart_scenes`, `pinned_switches`, `app_settings`
(`theme_mode`, `backend_url` keys), `auth_session` (`access_token`,
`refresh_token`, `email` keys), and `last_states` (shared between
`background_monitor_service.dart` and `widget_service.dart` — caches each
device's last-seen reachability + per-channel state, keyed by `deviceId`).

---

## 4. Local device communication

- **`services/device_api_client.dart`** (`DeviceApiClient`) — one method per
  firmware endpoint, transport-agnostic (see §1):
  `getInfo` (`GET /api/info`), `getConfig` (`GET /api/config`), `upsertSwitch`
  (`POST /api/switches`), `deleteSwitch` (`DELETE /api/switches/:idx`),
  `getChannels` (`GET /api/channels`), `setChannelState` (`POST
  /api/channels/:idx/state`), `upsertSchedule` (`POST /api/schedules`),
  `deleteSchedule` (`DELETE /api/schedules/:id`), `requestWifiReconfig`
  (`POST /api/wifi`, always returns 202 immediately — a single-radio ESP32
  can't hold its current AP association while test-connecting to a
  candidate network, so the real outcome must be polled via `getInfo().
  wifiReconfigState`), `setPassword` (`POST /api/auth/password`),
  `setTimezone` (`POST /api/timezone`, minutes local-minus-UTC), and
  `setNetworkConfig` (`POST /api/network`, DHCP or static IP/gateway/subnet/
  DNS — the device reboots right after responding, so the client is
  documented to treat an error here as "probably applied anyway"). `uploadOta`
  is `throw UnimplementedError()` — no OTA upload UI exists (see §11).
- **`services/discovery_service.dart`** (+ `_io.dart`/`_stub.dart`) — mDNS
  browsing of `_esp-switch._tcp.local` via the `multicast_dns` package,
  selected at compile time via a conditional import
  (`dart.library.io` ? real client : empty-stream stub, since raw sockets
  aren't available on web). The real implementation
  (`_MdnsDiscoveryService`) resolves PTR → SRV → TXT → A records per
  discovered instance and yields a `DiscoveredDevice{deviceId, host, port,
  txt}`; `deviceId` comes from the TXT record's `device_id=` key (falling
  back to the raw PTR domain name). On Android it acquires a
  `WifiManager.MulticastLock` through a native `MethodChannel`
  (`tech.hybri.smart_switch/multicast_lock`, implemented in
  `MainActivity.kt`) because Android silently drops incoming multicast
  packets otherwise — `multicast_dns` itself doesn't do this. Remote/
  Tailscale sessions don't reach this path at all (multicast typically
  doesn't traverse a subnet route), which is exactly why `KnownDevice.
  lastKnownIp` exists as a durable fallback.
- **`services/device_registry_service.dart`** — plain CRUD over the
  `known_devices` Hive box; `updateLastKnownIp` is called after every
  successful poll/connect so the cached IP stays fresh (this is what makes
  the Tailscale/remote-access fallback work without mDNS).
- **Timeouts/retries**: `LocalHttpTransport`/`DeviceTransportResponse`
  default request timeout is **5s** (`device_transport.dart`).
  `RestRelayTransport`'s own timeout is **15s** (intentionally above the
  backend's documented 10s relay timeout). `BackendWsClient.sendCommand`
  times out a pending request after **10s**. `channelStatesProvider` polls
  every **2s** while watched (no backoff/retry logic — a failed poll just
  yields an empty list for that tick and tries again next tick).
  `ScanDevicesScreen` scans continuously until the user stops it or leaves
  the screen; `ProvisioningWizardScreen`'s inline "Scan for device" runs a
  fixed 6-second window; `AddDeviceWizardScreen`'s post-provisioning device
  search waits up to 30s for mDNS to find the freshly-provisioned device.

---

## 5. Provisioning

The initial WiFi hand-off implements (for ESP32) a faithful, from-scratch
Dart port of **ESP-IDF's `protocomm`/`wifi_provisioning` "Security1"
scheme** — confirmed directly in code: `security1_session.dart`'s own doc
comment states it is "Ported byte-for-byte from ESP-IDF's own reference
implementation (`esp_prov/security/security1.py`)". ESP8266 firmware has no
equivalent secure-session component, so it gets a simpler, unencrypted flow
instead (details below).

### Wire encoding — `provisioning/proto_wire.dart`

A minimal, hand-rolled protobuf reader/writer (`ProtoWriter`/
`decodeMessage`) — no `protoc`/codegen dependency. It supports exactly what
ESP-IDF's `.proto` schemas need for this flow: wire type 0 (varint) and wire
type 2 (length-delimited bytes/nested message); no repeated fields, maps, or
fixed-width ints. A `oneof` needs no special handling — encoding "whichever
field is set" is already correct on the wire, and `decodeMessage` naturally
implements oneof semantics by letting a later field-number occurrence
override an earlier one.

### Handshake — `provisioning/security1_session.dart`

`Security1Session(pop: <proof-of-possession string>)` implements the two-
message Security1 handshake:

1. `buildHandshakeRequest0()` generates a fresh X25519 keypair and wraps the
   client's public key in a `SessionCmd0` (Sec1 message type
   `SessionCommand0` inside a `SessionData{sec_ver: 1}` envelope).
2. `consumeHandshakeResponse0(bytes)` unwraps the device's `SessionResp0`,
   derives the ECDH shared secret from the device's public key, and — if a
   non-empty POP was supplied — XORs the shared secret with `SHA256(pop)`.
   The result seeds an **AES-256-CTR** keystream (via `pointycastle`'s
   `CTRStreamCipher(AESEngine())`), with the device's supplied 128-bit
   random value as the initial counter block.
3. `buildHandshakeRequest1()` sends the device's own public key, encrypted
   through that keystream, as proof the client derived the same secret
   (`SessionCmd1`).
4. `consumeHandshakeResponse1(bytes)` decrypts the device's
   `device_verify_data` and checks it equals the client's own public key;
   only if this matches does the session become "verified" and
   `encrypt`/`decrypt` (an identical AES-CTR XOR in both directions — kept
   as two names purely for call-site readability) become usable for every
   subsequent request/response.

The **proof-of-possession value is the device ID itself** (see
`SoftApProvisioningClient.provision(pop: deviceId, ...)`, called from both
`AddDeviceWizardScreen` and `ProvisioningWizardScreen`).

### WiFi config payloads — `provisioning/wifi_config_proto.dart`

Implements the `wifi_provisioning` component's `WiFiConfigPayload` messages:
`buildSetConfigRequest` (ssid + passphrase), `buildApplyConfigRequest` (no
fields — and, matching the ESP-IDF reference exactly, the request doesn't
even populate the oneof for this one, only the `msg` discriminator),
`buildGetStatusRequest`, and response parsers mapping wire ints to
`WifiStationState` (`connected|connecting|disconnected|failed|unknown`) and
`WifiFailReason` (`authError|networkNotFound|unknown`).

### ESP32 flow — `provisioning/softap_provisioning_client.dart`

`SoftApProvisioningClient` talks to `http://192.168.4.1` (the device's
default SoftAP address) via `POST /prov-session` (handshake, twice) then
`POST /prov-config` (Security1-encrypted SetConfig → ApplyConfig →
GetStatus, each as `application/octet-stream`). After ApplyConfig it polls
GetStatus every 5s, retrying up to 3 times on a non-terminal state before
giving up and reporting `authError`/`networkNotFound`/unknown failure.

### ESP8266 flow — `provisioning/esp8266_provisioning_client.dart`

The ESP8266 port has **no Security1/protocomm equivalent** (stated directly
in its doc comment). Instead, WiFi credentials go over a **plain JSON
`POST /api/wifi`** to the same `http://192.168.4.1` SoftAP address, protected
only by the SoftAP's own WPA2 password (which is the device ID). It then
polls `GET /api/info`'s `wifi_reconfig_state` every 3s for up to ~36s (12
polls), treating an unreachable poll as an implicit success (since the
SoftAP disappears the moment the device joins the home network, an
unreachable poll is usually just that).

### Android network-routing workaround — `provisioning/network_binding.dart`

Both provisioning clients call `bindToCurrentWifi()` before starting and
`unbindNetwork()` in a `finally` block. On Android this invokes a
`MethodChannel` (`tech.hybri.smart_switch/network_binding`) whose native
implementation (`MainActivity.kt`) calls
`ConnectivityManager.requestNetwork()` for a WiFi transport with the
`NET_CAPABILITY_INTERNET` requirement explicitly removed, then
`bindProcessToNetwork()`s the whole app process to it. This is necessary
because Android otherwise deprioritizes (and often fully routes traffic away
from) a WiFi network with no internet access — exactly what an ESP32/8266
SoftAP looks like — so HTTP calls during provisioning would silently go out
over mobile data and never reach the device. iOS/web are no-ops that return
`true` (no equivalent issue for this manual-join flow on those platforms).

### UI entry points

- **`screens/onboarding/add_device_wizard_screen.dart`** (`AddDeviceWizardScreen`)
  — the primary, guided "+ Add device" flow (linear step machine: intro →
  scan QR/manual entry → found → wifi → find-device → room → name → done).
  The QR code (generated at flash time) encodes
  `smartapp://device/setup?id=...&secret=...&chip=esp32|esp8266`; `chip`
  picks which provisioning client to use (`Esp8266ProvisioningClient` vs
  `SoftApProvisioningClient`), defaulting to `esp32` if the field is absent
  (older stickers). After WiFi succeeds it re-runs mDNS discovery to find the
  device on the home LAN (with a manual-IP fallback,
  confirmed by checking the answering device's `getInfo().deviceId` matches
  before accepting it), then best-effort sets the device's timezone and, if
  logged in with a backend configured, calls `BackendDevicesClient.claim()`
  with the QR's cloud secret to enable remote control (non-fatal if the
  firmware predates the `cloud_client` component).
- **`screens/provisioning/provisioning_wizard_screen.dart`**
  (`ProvisioningWizardScreen`) — an older, three-section, non-linear screen:
  (1) manual SoftAP-name entry + first-time provisioning (same
  `SoftApProvisioningClient`, POP parsed from the `SmartSwitch-<pop>` SSID
  the user types in) plus a "scan for device" mDNS button; (2) reconfigure
  an already-claimed device's WiFi via the plain REST `requestWifiReconfig`
  path; (3) a static help card about the BOOT-button recovery gestures.
  `AppRoutes.provisioning`'s own doc comment describes this screen as "kept
  as 'Advanced provisioning'... reachable from Settings" — **this is not
  actually true in the current UI**; see §11.
- **`screens/scan/scan_devices_screen.dart`** (`ScanDevicesScreen`) — a
  second, WiFi-only path (no provisioning/handshake at all) for a device
  that's already on the home network but not yet known to this phone (a
  second household phone, or a device removed from "Known devices"
  locally). Just mDNS discovery + `KnownDevicesNotifier.upsert`.

---

## 6. Backend integration

Every `backend/*.dart` client is a thin, stateless class constructed with a
`baseUrl` (+ `accessToken` where auth is required) and one method per REST
endpoint; all use an 8-second request timeout and throw
`BackendApiException(statusCode, message)` on any non-2xx response (decoded
via the shared `decodeBackendResponseOrThrow` helper in
`backend_api_exception.dart`).

| Client | Backend route(s) (method + path, as called from the client) | Purpose |
|---|---|---|
| `BackendAuthClient` (`backend_auth_client.dart`) | `POST /auth/signup`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout` | Email/password signup & login, refresh-token rotation, logout. No auth header (these *establish* auth). |
| `BackendDevicesClient` (`backend_devices_client.dart`) | `POST /devices/claim` (`deviceId`, `cloudSecret`, optional `friendlyName`), `GET /devices`, `PATCH /devices/:deviceId` (rename), `DELETE /devices/:deviceId` (unclaim) | Claiming a device to an account (proves ownership via the QR/serial-log `cloudSecret`), listing every device claimed to the account (`CloudDeviceSummary{deviceId, friendlyName, isOnline}`), renaming (propagates to every other phone on the account), unclaiming. |
| `BackendGroupsClient` (`backend_groups_client.dart`) | `GET /groups`, `POST /groups` (upsert — `id` omitted creates), `DELETE /groups/:id` | Account-wide switch groups; the backend validates every member device is already claimed by the same account. |
| `BackendHouseholdsClient` (`backend_households_client.dart`) | `GET /households`, `PATCH /households/:id` (`name` or `timezone`), `POST /households/:id/invite`, `GET /households/invites`, `POST /households/invites/:id/accept`, `POST /households/invites/:id/decline`, `DELETE /households/:id/members/:userId` | Multi-user household membership: rename, set timezone, invite by email (in-app only, no email is sent — a 404 means no such account), accept/decline a received invite, remove a member. |
| `BackendAutomationsClient` (`backend_automations_client.dart`) | `GET /automations[?householdId=]`, `POST /automations` (upsert), `DELETE /automations/:id` | Household-wide, server-evaluated automation rules — "owner-only server-side" per its own comment. |
| `BackendActivityClient` (`backend_activity_client.dart`) | `GET /activity?householdId=&limit=&before=` | Cursor-paginated (`nextCursor`/`before`) feed of confirmed channel-state changes; "keep everything, no retention job" per its doc comment. |
| `BackendWsClient` (`backend_ws_client.dart`) | `WS /ws?token=<accessToken>` | See below. |

Also: `device_transport.dart`'s `RestRelayTransport` calls `POST
/devices/:deviceId/command` (not a dedicated client class — it's the
transport itself) as the plain-REST equivalent of the WebSocket relay, for
callers that can't hold a socket open.

### WebSocket relay protocol (`BackendWsClient`)

One shared connection per login session, reused for every claimed device
(commands are addressed by `deviceId` per message, not one socket per
device). Outgoing request: `{reqId, deviceId, method, path, body}`; the
server replies `{reqId, status, body}` on success or `{reqId, status: 0,
error}` on failure, matched back to the pending `Completer` by `reqId`
(`req-<incrementing int>`). A 10s client-side timeout removes the pending
entry and throws `CloudRelayException` if no reply arrives. Unsolicited
frames with an `event` key (currently just `state_changed`: `{event,
deviceId, channelIdx, state}`) are pushed to a broadcast `stateChanges`
stream — **exposed but not consumed by any provider/screen today** (see
§11); the app still relies purely on `channelStatesProvider`'s 2s poll for
live state, even though the backend already supports push updates.

### Auth flow

- **`AuthNotifier`** (in `service_providers.dart`) is the actual login state
  machine: `login`/`signup` call `BackendAuthClient`, then persist via
  `AuthSessionService.saveSession` and kick off
  `syncClaimedDevicesFromBackend` + a `householdsProvider`/
  `householdInvitesProvider` refresh. `logout` is best-effort against the
  backend (`try/catch`, swallowed) but **always** clears local session
  state. `refreshAccessToken` calls `BackendAuthClient.refresh` and, on any
  failure (including the backend's rotate-on-use single-use refresh tokens
  rejecting an already-used token), logs the user out rather than trying to
  recover client-side.
- **`ensureFreshAccessToken(WidgetRef)`** / **`ensureFreshAccessTokenForNotifier
  (Ref)`** — near-duplicate helper functions (kept as two because
  `WidgetRef` and `Ref` are unrelated types in Riverpod 3, not a subtype
  relationship as in Riverpod 2) that check `isJwtExpiredOrExpiringSoon`
  and, if so, proactively refresh before returning a token — called by
  every screen/notifier immediately before constructing a `Backend*Client`.
- **`jwt.dart`** — `decodeJwtPayload`/`jwtExpiry`/`isJwtExpiredOrExpiringSoon`
  decode a JWT's payload **without verifying its signature** (explicitly
  client-side-only, "the backend remains the actual source of truth for
  validity"); used only to decide whether a proactive refresh is worth
  doing, with a 30-second expiry buffer.
- **`AuthSessionService`** — Hive box `auth_session` (`access_token`,
  `refresh_token`, `email`).
- **`IsolateBackendAuth`** (`isolate_backend_auth.dart`) — a static helper
  that lets a headless isolate (widget tap, background monitor — neither has
  a `ProviderContainer`) read and, if needed, silently refresh the
  persisted session on its own by reopening the same `auth_session` Hive
  box directly. On the rotate-on-use race (the main app isolate refreshes
  first, so this isolate's refresh token is already revoked), it just
  returns `null` rather than retrying or attempting a cross-isolate lock —
  documented as an acceptable narrow race window given WorkManager's 15-
  minute floor and sporadic widget taps.

---

## 7. Background / system integration

- **`services/background_monitor_service.dart`** — Android-only (every
  entry point checks `!kIsWeb && defaultTargetPlatform ==
  TargetPlatform.android`), built on the **`workmanager`** package.
  `initializeBackgroundMonitor()` registers a ~15-minute periodic task
  (`registerPeriodicTask`, `NetworkType.connected` constraint — 15 minutes
  is WorkManager's practical floor). `backgroundMonitorCallbackDispatcher`
  (top-level, `@pragma('vm:entry-point')`) is the headless-isolate entry
  point WorkManager invokes; it has no access to the running app's widget
  tree/`ProviderContainer`, so `_runMonitorPass()` re-initializes its own
  Hive instance, `DeviceRegistryService`, and `AppSettingsService` from
  scratch. For every known device it calls `viaLocalOrCloud` (local HTTP
  first, cloud REST relay fallback via `IsolateBackendAuth` — see §1/§6) to
  fetch channel states, diffs them against the shared `last_states` Hive
  box, and fires a `flutter_local_notifications` local notification
  (channel `smart_switch_monitor`) when a device goes offline/comes back
  online, or when any channel's state flips. It ends by calling
  `refreshWidgetStorage()` so the home-screen widget also stays fresh.
  `requestNotificationPermission()` (Android 13+ `POST_NOTIFICATIONS`) must
  run from the *foreground* app — a background isolate can't prompt — so
  `main.dart` calls it at startup.
- **`services/widget_service.dart`** — also Android-only
  (`_widgetSupported`), built on the **`home_widget`** package.
  `initializeWidgetSupport()` registers `widgetInteractionCallback` (also a
  top-level `@pragma('vm:entry-point')` function) as the interactivity
  callback. `getPinnedSwitches`/`setPinnedSwitches` persist up to 4
  `PinnedSwitch` entries to the `pinned_switches` Hive box.
  `refreshWidgetStorage()` rebuilds the widget's display JSON, resolving
  each pinned switch's shown state by preferring the shared `last_states`
  cache (written by the monitor above, or by the widget itself) and falling
  back to one live `viaLocalOrCloud` fetch, defaulting to `'OFF'` only on a
  genuinely first-ever render (never as a silent overwrite of a previously-
  known state). `widgetInteractionCallback(Uri)` parses a
  `smartswitch://toggle?device_id=&ip=&channel_idx=&current_state=` URI
  (fired from the native widget), flips the channel via `viaLocalOrCloud`,
  and refreshes the widget storage. On the Android/Kotlin side,
  `SmartSwitchWidgetProvider.kt` (an `HomeWidgetProvider`) renders up to 4
  `RemoteViews` rows from the same `pinned_switches` JSON and wires each
  row's tap to a `HomeWidgetBackgroundIntent` carrying that same
  `smartswitch://toggle` URI — the whole loop never needs to launch the
  full Flutter app UI. There is no iOS widget extension; iOS gets neither
  the widget nor the background monitor.
- **Notifications**: `flutter_local_notifications` is used **only** by the
  background monitor (device-offline / back-online / channel-flip alerts).
  There is no in-app notification center/list screen.
- **`services/backup_service.dart`** (`BackupService`) — pure, synchronous
  JSON builder/parser (`format_version: 1`) with no Hive/HTTP access of its
  own. `buildExportJson` serializes `known_devices` + `groups` (the only
  phone-local state that matters for a phone swap) plus a best-effort,
  diagnostic-only `device_snapshots` map (each device's live `DeviceConfig.
  toJson()`, or `null` if unreachable) that is **never re-applied on
  import** — a device already holds its own real config, and silently
  pushing a stale snapshot back over HTTP on restore could overwrite it
  unexpectedly. The glue functions `exportBackup`/`importBackup`
  (`service_providers.dart`) do the actual live-provider read/write and are
  invoked from `SettingsScreen` via the `file_picker` package
  (`FilePicker.saveFile`/`pickFile`).

---

## 8. Screens

- **`activity/activity_screen.dart`** (`ActivityScreen`) — a paginated
  (cursor/"load more on scroll") feed of confirmed channel-state changes for
  the user's household, via `BackendActivityClient`. Purely online, no
  offline cache (matches `ActivityEntry`'s design). Depends on
  `householdsProvider` (to pick which household's feed to show, with a
  dropdown if the user belongs to more than one), `backendUrlProvider`, and
  `ensureFreshAccessToken`.
- **`auth/auth_screen.dart`** (`AuthScreen`) — one screen serving both login
  and signup (toggled by an `isSignup` flag and an in-page "switch mode"
  link) against `authProvider.notifier`'s `login`/`signup`. Responsive:
  a single scrolling form on narrow widths, a two-pane hero + form layout
  above 900px. Disables submission if no backend URL is configured yet.
- **`automations/automations_screen.dart`** (`AutomationsScreen`) — lists
  household automations with an enable/disable `Switch` and, for an owner,
  edit/delete via a `PopupMenuButton` and a bottom-sheet editor
  (`_AutomationEditor`) that builds either a `ScheduleTrigger` (day
  checkboxes + time picker) or a `StateTrigger` (device+channel+ON/OFF
  picker), plus one or more `AutomationAction`s across every known device's
  switches. Depends on `automationsProvider`, `knownDevicesProvider`,
  `householdsProvider` (to gate create/edit UI on `isOwnerSomewhere`), and
  `deviceConfigProvider` per device shown in the picker lists.
- **`device_detail/device_detail_screen.dart`** (`DeviceDetailScreen`) — a
  single device's detail page: a `DeviceVisualization` hero reflecting
  overall on/off/offline status, board type/firmware version, and a list of
  per-channel toggle rows. Depends on `deviceConfigProvider` and
  `channelStatesProvider` for the given `KnownDevice`, plus
  `channelOverrideProvider`/`activeDeviceApiClientProvider` for toggling.
- **`groups/groups_screen.dart`** (`GroupsScreen`) — lists `SwitchGroup`s as
  tiles showing an aggregate on/off/partially-on/offline state (computed
  live per member's `channelStatesProvider`/override), a big
  `DeviceVisualization` tap target to toggle the whole group, and a
  `PopupMenuButton` for turn-all-on/off/edit/delete. Group toggles fire
  every member's command **in parallel** (`Future.wait`, explicitly noted
  as a fix for a previous serial-await slowdown) with the same optimistic
  override each individual tile gets. A bottom-sheet editor
  (`_GroupEditorSheet`) picks a name and a set of `deviceId:channelIdx`
  members across every known device. Depends on `groupsProvider`,
  `knownDevicesProvider`, `channelOverrideProvider`,
  `activeDeviceApiClientProvider`, `deviceConfigProvider`.
- **`home/home_dashboard_screen.dart`** (`HomeDashboardScreen`) — the app's
  real landing screen: a Google Home/Nest-style dashboard with a greeting
  header, a gradient "everything is in rhythm"/"a little attention needed"
  hero summarizing online/offline device counts and active-switch counts, a
  horizontal strip of room ("Zone") shortcuts that jump to the Rooms tab,
  and a responsive grid of every switch as a `DeviceTile` (staggered
  fade/scale-in via `flutter_animate`). Also renders `_InviteBanner`, a
  dismissible-per-session card listing pending household invites with
  accept/decline actions. Depends on `knownDevicesProvider`,
  `deviceConfigProvider`/`channelStatesProvider` per device,
  `zoneAggregationServiceProvider`, and `householdInvitesProvider`.
- **`home_shell.dart`** — see §2.
- **`household/household_screen.dart`** (`HouseholdScreen`) — lists every
  household the user belongs to, with rename (owner-only, tap the title),
  invite-by-email (owner-only, dialog), and per-member removal (owner-only,
  confirmation dialog); members see a read-only roster. Depends entirely on
  `householdsProvider`.
- **`onboarding/add_device_wizard_screen.dart`** (`AddDeviceWizardScreen`) —
  see §5. Depends on `discoveryServiceProvider`,
  `deviceApiClientProvider`/`activeDeviceApiClientProvider`,
  `knownDevicesProvider`, `deviceRegistryServiceProvider`,
  `authProvider`/`backendUrlProvider`/`ensureFreshAccessToken`, and the
  `mobile_scanner`-based `_QrScanPage` for QR capture.
- **`provisioning/provisioning_wizard_screen.dart`** (`ProvisioningWizardScreen`)
  — see §5.
- **`scan/scan_devices_screen.dart`** (`ScanDevicesScreen`) — a live mDNS
  scan (auto-starts on entry) of devices not already in `knownDevicesProvider`,
  each addable via a name-prompt dialog straight to `KnownDevicesNotifier.
  upsert` (no WiFi/provisioning work happens here at all). Includes a
  custom hand-rolled "radar pulse" animation (`_RadarPulse`, a single
  repeating `AnimationController` driving three phase-offset expanding
  rings — deliberately not built from `flutter_animate`'s per-widget
  `.animate()` delay chaining, which the code notes would drift out of sync
  after the first loop).
- **`scenes/scenes_screen.dart`** (`ScenesScreen`) — lists `SmartScene`s as
  run/delete cards; running a scene fires every member's `setChannelState`
  in parallel with the same optimistic-override pattern as Groups, then
  shows a confirmation snackbar. A bottom sheet (`_SceneEditor`) picks a
  name, a single ON/OFF action, and a set of member switches. Depends on
  `scenesProvider`, `knownDevicesProvider`, `channelOverrideProvider`,
  `activeDeviceApiClientProvider`.
- **`schedules/schedules_screen.dart`** (`SchedulesScreen`) — per-device
  (not household-wide) schedule management: a device picker dropdown, then
  a list of that device's `Schedule`s with enable `Switch`/delete, tapping
  opens a bottom-sheet editor (`_ScheduleEditorSheet`) covering all four
  `ScheduleType`s (once/daily/weekly/countdown) with the appropriate
  time/day-picker/duration fields per type. Writes go straight to the
  device via `DeviceApiClient.upsertSchedule`/`deleteSchedule` (not a
  backend call — schedules are device-resident). Depends on
  `knownDevicesProvider`, `deviceConfigProvider`,
  `activeDeviceApiClientProvider`.
- **`settings/settings_screen.dart`** (`SettingsScreen`) — the catch-all
  preferences screen: theme mode (`themeModeProvider`), backend server URL
  + login/signup/logout (`_CloudAccountCard`), links to Household/Activity/
  Automations, a "Known devices" list per `KnownDevice` with a
  `PopupMenuButton` (enable remote control / edit timezone / edit
  network / remove), the pinned-switches-for-widget dialog, and backup
  export/import. This is also where the "Enable remote control" claim flow
  lives outside the add-device wizard (fetches `DeviceInfo.cloudSecret` live
  and calls `BackendDevicesClient.claim`).
- **`shared/device_tile.dart`** (`DeviceTile`) — the big square tap-to-
  toggle card used on the Home dashboard grid; whole tile toggles the
  switch, a corner `PopupMenuButton` opens the device detail page or a
  rename/zone dialog. Reads `channelStatesProvider` + `channelOverrideProvider`
  to compute a `DeviceVisualState`.
- **`shared/device_visualization.dart`** (`DeviceVisualization` /
  `DeviceVisualKind`) — a `CustomPainter`-based hand-drawn illustration
  (switch plate, plug, socket, bulb, LED strip, fish tank, fan, multi-plug,
  TV, router, generic appliance) reused by tiles/cards throughout the app;
  `DeviceVisualKind.fromName(String)` picks an illustration from a switch's
  free-text name via keyword matching (e.g. "lamp"/"bulb"/"light" → `light`).
  Purely presentational — no provider dependencies.
- **`shared/edit_switch_dialog.dart`** — a simple rename + zone-text dialog
  returning `(name, zone)` to the caller, which is responsible for the
  actual `upsertSwitch` call.
- **`shared/empty_devices_view.dart`** / **`empty_state_view.dart`** —
  generic "nothing here yet" placeholders (icon + title + subtitle),
  reused across Zones/Switches/Schedules/Groups/Scenes/Automations.
- **`shared/error_view.dart`** / **`loading_view.dart`** — generic
  error-with-retry and pulsing-icon loading placeholders for async device
  fetches.
- **`shared/pinned_switches_dialog.dart`** — the Settings-launched picker
  for the Android home-screen widget; fetches every known device's switches
  directly (only over local HTTP — the widget's own headless callback
  can't use the cloud relay, so a device with no `lastKnownIp` is skipped
  entirely) and lets the user check up to 4.
- **`shared/skeleton_loader.dart`** (`SkeletonShimmer`/`SkeletonBox`/
  `SkeletonListPlaceholder`/`SkeletonGridPlaceholder`) — `shimmer`-based
  loading placeholders shaped like a list row or the dashboard's tile grid.
- **`shared/switch_tile.dart`** (`SwitchTile`) — the compact list-row
  equivalent of `DeviceTile`, reused by the Switches and Rooms/Zones
  screens; same optimistic-override + live-poll state logic.
- **`switches/switches_screen.dart`** (`SwitchesScreen`) — every known
  device's switches grouped into one card per device (via `SwitchTile`
  rows), pull-to-refresh via `refreshAllDevices`. Depends on
  `knownDevicesProvider`, `deviceConfigProvider`.
- **`zones/zones_screen.dart`** (`ZonesScreen`, the "Rooms" tab) — groups
  every known device's switches by their free-text `zone` string (computed
  live, in-memory, by `ZoneAggregationService` — no zone entity is
  persisted anywhere) into per-room cards with a room icon (keyword-matched
  from the zone name) and bulk on/off `IconButton`s. Depends on
  `knownDevicesProvider`, `deviceConfigProvider`, `zoneAggregationServiceProvider`,
  `channelOverrideProvider`.

---

## 9. Theming

- **`theme/app_theme.dart`** — Material 3 (`useMaterial3: true`),
  `ColorScheme.fromSeed` from two different seed colors for light
  (`0xFF007F82`, a teal) and dark (`0xFF67D8D1`) with `contrastLevel: 0.1`,
  then several surface/secondary/tertiary tones manually overridden on top
  of the generated scheme for a specific look (rather than using the
  generated scheme as-is). Platform-aware `PageTransitionsTheme`:
  `PredictiveBackPageTransitionsBuilder` on Android,
  `CupertinoPageTransitionsBuilder` on iOS, `FadeForwardsPageTransitionsBuilder`
  on Linux/macOS/Windows (dead code today — see §10, no desktop runner
  exists in this repo). Component-level theme overrides cover `AppBar`,
  `Card` (elevation 0, 24px radius), `NavigationBar`/`NavigationRail`,
  `FilledButton`, `InputDecoration` (filled, 16px radius), `ListTile`,
  `Chip`, `SnackBar` (floating), `Switch` (custom check/close thumb icons),
  and `FloatingActionButton`.
- **`theme/motion.dart`** (`Motion`) — one shared animation scale:
  `fast`/`medium`/`slow` durations (150/300/450ms) and a `standard` curve
  (`Curves.easeInOutCubic`), used throughout `flutter_animate` chains
  instead of ad hoc literal durations/curves per screen.
- **`theme/spacing.dart`** (`Spacing`) — one shared spacing scale
  (`xs`=4, `sm`=8, `md`=16, `lg`=24, `xl`=32), used in place of literal
  `EdgeInsets`/`SizedBox` values across nearly every screen.

---

## 10. Build & run

- **Package identifiers**: Android `applicationId` =
  `tech.hybri.smart_switch` (`android/app/build.gradle.kts`); iOS
  `PRODUCT_BUNDLE_IDENTIFIER` = `tech.hybri.smartSwitch` (note the casing
  difference between the two platforms' identifiers — both are valid for
  their platform's convention, just inconsistent with each other).
- **Platforms actually present in this repo**: `android/`, `ios/`, `web/`.
  There are no `linux/`, `macos/`, or `windows/` runner directories, even
  though `app_theme.dart` defines page-transition behavior for all three
  desktop `TargetPlatform`s (harmless forward-looking/dead code, not a bug).
- **Native platform-channel code** (Android, Kotlin, `MainActivity.kt`):
  implements `tech.hybri.smart_switch/multicast_lock` (acquire/release a
  `WifiManager.MulticastLock` for mDNS) and
  `tech.hybri.smart_switch/network_binding` (bind/unbind the process to the
  current WiFi network for provisioning). `SmartSwitchWidgetProvider.kt` +
  `res/layout/widget_smart_switch.xml` implement the Android home-screen
  widget. `AndroidManifest.xml` declares `INTERNET`,
  `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`,
  `CHANGE_WIFI_MULTICAST_STATE`, `CHANGE_NETWORK_STATE`,
  `POST_NOTIFICATIONS`, and `CAMERA` (for `mobile_scanner`) permissions.
- **SDK constraint**: `environment.sdk: ^3.11.4` in `pubspec.yaml` — a very
  recent/pre-release Dart SDK requirement; note this if reproducing the
  build environment.

### `pubspec.yaml` dependencies and why they're there

| Package | Purpose in this app |
|---|---|
| `flutter_riverpod ^3.3.2` | State management — the non-codegen `Notifier`/`Provider` API (§2). |
| `http ^1.6.0` | REST calls to devices (`LocalHttpTransport`) and the backend (`Backend*Client`s). |
| `multicast_dns ^0.3.3+1` | mDNS discovery of `_esp-switch._tcp.local` (§4). |
| `hive_ce ^2.19.3` / `hive_ce_flutter ^2.3.4` | Local NoSQL storage — the "Community Edition" fork of Hive; backs every Hive box listed in §3. |
| `file_picker ^12.3.0` | Save/pick the backup JSON file in Settings. |
| `workmanager ^0.10.10` | Android periodic background task scheduling (`background_monitor_service.dart`, §7). |
| `flutter_local_notifications ^22.3.1` | Device offline/back-online/state-change alerts fired by the background monitor. |
| `home_widget ^0.9.4` | Bridge to the Android home-screen widget (`widget_service.dart`, §7). |
| `shimmer ^3.0.0` | Skeleton-loading shimmer effect (`skeleton_loader.dart`). |
| `flutter_animate ^4.5.2` | Declarative entrance/transition animations used across nearly every screen. |
| `cryptography ^2.9.0` | X25519 ECDH + SHA-256 for the Security1 provisioning handshake. |
| `pointycastle ^4.0.0` | AES-256-CTR stream cipher for Security1 encrypt/decrypt. |
| `web_socket_channel ^3.0.3` | `BackendWsClient`'s WebSocket connection to the backend relay. |
| `mobile_scanner ^7.4.1` | QR code scanning in the Add Device wizard. |
| `cupertino_icons ^1.0.8` | Default Flutter template dependency (iOS-style icon set). |
| `flutter_lints ^6.0.0` (dev) | Lint rule set (`analysis_options.yaml` includes it with no custom overrides beyond commented-out examples). |
| `flutter_test` (dev) | Test framework. |

### Tests (`app/test/`)

- `widget_test.dart` — one widget smoke test: pumps `SmartSwitchApp` with
  every stateful service (`DeviceRegistryService`, `GroupService`,
  `AppSettingsService`, `AuthSessionService`) overridden by trivial
  **in-memory fakes** (real Hive I/O is explicitly noted as hanging under
  `flutter_test`'s widget binding — "a known category of issue unrelated to
  real app behavior on a real engine" — so the test fakes the data layer
  rather than exercising real storage) and asserts a signed-out session
  lands on the login form. Uses `pumpAndSettle` (not a single `pump`)
  because the nav rail/bar icons carry a one-shot `flutter_animate`
  entrance animation.
- `test/screens/onboarding/add_device_wizard_screen_test.dart` — pure unit
  tests of `parseDeviceSetupUri` (the QR sticker URI parser): valid parse,
  whitespace trimming, malformed URI, missing `id`/`secret`, empty values.
- `test/services/provisioning/proto_wire_test.dart` — round-trips varint,
  multi-byte varint, bytes, and nested-message fields through
  `ProtoWriter`/`decodeMessage`; confirms oneof-style "later field wins"
  semantics; and checks an exact expected byte sequence for a known message
  shape.
- `test/services/provisioning/security1_session_test.dart` — a from-scratch,
  independent `_FakeDevice` mirror of the *device* side of the Security1
  handshake (deliberately not sharing code with `Security1Session`, "so this
  test catches real protocol/framing bugs rather than testing a bug against
  itself"); verifies a full handshake completes and both sides derive a
  matching key, that post-handshake encrypt/decrypt stay in sync in both
  directions, and that a POP mismatch fails verification rather than
  silently succeeding.
- `test/services/provisioning/wifi_config_proto_test.dart` — unit tests for
  `buildSetConfigRequest`/`parseSetConfigResponse`/`buildApplyConfigRequest`/
  `parseApplyConfigResponse`/`buildGetStatusRequest`/`parseGetStatusResponse`,
  including the "ApplyConfig sends only the msg field, no oneof payload"
  detail and status/fail-reason mapping.

**Run tests**: `cd app && flutter test`
**Lint**: `cd app && flutter analyze`

---

## 11. Known gaps / TODOs visible in code

1. **`DeviceApiClient.uploadOta()` is unimplemented** — `throw
   UnimplementedError()`, with a comment: "Out of scope for this pass — no
   OTA upload UI." There is no firmware-update flow anywhere in the app.
2. **`DeviceInfo.cloudSecret`/`capabilities` are forward-looking fields not
   yet meaningfully populated everywhere** — `cloudSecret` is null on any
   firmware without the `cloud_client` component (comment: "null on all
   firmware today" at the time the field was added); `capabilities` is
   described as existing purely so a future non-binary product (dimmer, fan,
   power meter) won't need a breaking schema change, and isn't read by any
   UI yet.
3. **`BackendWsClient.stateChanges`** (unsolicited `state_changed` push
   events from the backend) **is wired up but never consumed** — its own
   comment says "not wired into any provider yet... explicitly out of scope
   this pass." The app relies entirely on `channelStatesProvider`'s 2-second
   poll for live updates even though server-push already exists on the
   wire.
4. **Scenes are Hive-only, unlike Groups/Automations** — `SmartScene` has no
   backend client at all (no `BackendScenesClient`), so scenes don't sync
   across a household's multiple phones/accounts the way groups and
   automations do. Confirmed by a comment in `automation.dart`: "Scenes are
   still Hive-only/unsynced."
5. **`ProvisioningWizardScreen` ("Advanced provisioning") appears to be
   unreachable from the UI**, contradicting its own route's doc comment.
   `app_routes.dart` registers `AppRoutes.provisioning` with a comment
   claiming it is "reachable from Settings," but a repo-wide search finds
   no `pushNamed(AppRoutes.provisioning)` call anywhere in `lib/`, and
   `SettingsScreen`'s own source has no menu entry linking to it. The
   guided `AddDeviceWizardScreen` appears to be the only in-app path to
   provisioning today; the older screen is only reachable by a manual deep
   link.
6. **The Android home-screen widget and background monitor are Android-only
   by explicit runtime checks** (`defaultTargetPlatform ==
   TargetPlatform.android`) — there is no iOS equivalent for either
   feature; iOS users get no offline/state-change notifications and no
   home-screen widget.
7. **iOS background execution is explicitly called out as unsupported** —
   `background_monitor_service.dart`'s doc comment states "iOS background
   execution is unreliable under this model and untestable in this
   environment," and `initializeBackgroundMonitor()` simply no-ops there.
8. **Stale "serverless" framing in user-facing/metadata strings** — despite
   the fully-implemented backend integration layer, `pubspec.yaml`'s
   `description` field, `app/README.md`, and `SettingsScreen`'s About
   footer text ("Smart Switch — serverless ESP32/8266 relay control") all
   still describe the app as serverless. This matches the task's framing
   that `docs/plan.md`/`README.md` are historical and the code has moved
   on, but the *shipped app copy itself* hasn't been updated to match.
9. **Automations' owner-gated UI is checked account-wide, not per-automation's
   household** — `AutomationsScreen` computes `isOwnerSomewhere =
   households.any((h) => h.isOwner)` once and uses it to show/hide every
   automation's edit/delete controls and the "new automation" FAB,
   regardless of which household a given automation actually belongs to.
   A user who owns one household but is only a member of another would see
   edit affordances for automations listed from the household they don't
   own (the backend is presumably the real authorization boundary — see
   `BackendAutomationsClient`'s "owner-only server-side" comment — so this
   looks like a client-side UX looseness rather than a security hole, but
   it can surface a misleading "you can edit this" control).
10. **`setNetworkConfig` races the device's own reboot by design** — its doc
    comment acknowledges the device reboots immediately after responding,
    so an error at the HTTP layer may just be the reboot itself; the
    Settings screen surfaces this ambiguity to the user in the error
    message rather than resolving it, which is a known/accepted rough edge,
    not a bug.
