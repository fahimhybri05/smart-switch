# Offline Behavior Contract

What happens to the app and the switches when the home internet connection goes down. This
documents *already-working* behavior, verified against the current firmware and app source,
plus the one gap that has no software fix.

## 1. Overview

"Internet down" in this system means: the home router loses its WAN (ISP) connection, so no
device on the LAN can reach the public internet — but the LAN itself (WiFi, local routing,
mDNS multicast) keeps working exactly as before.

**Bottom line:** local control of switches — toggling, schedules, automations that don't
require cloud calls — keeps working through an internet outage with zero code changes needed.
The only thing that becomes unreachable is a device from a phone that is *not* on the same LAN
(e.g. the user is out of the house) while the internet is down — and that case is physically
unsolvable in software, not a bug to fix.

## 2. Local control path (HTTP API + mDNS, independent of cloud_client)

On both chip targets, the local HTTP API and mDNS advertisement are started and run
independently of the cloud/WebSocket client — they do not wait on, check, or get gated by
`cloud_client`'s connection state.

**ESP32** (`firmware/main/main.c`):
- `network_services_task` (lines 90–108) waits only for WiFi, then starts `http_api_start()`
  (line 96) and `mdns_advertise_start()` (line 101). It runs as its own FreeRTOS task, created
  at line 143 (`xTaskCreate(network_services_task, "net_svc", ...)`).
- `cloud_client_init()` is a **separate** call in `app_main` (line 148), which spins up its own
  independent task (`cloud_client_task`, see `cloud_client.c` below). Neither task's startup or
  main loop reads the other's state — there is no `if (cloud connected)` gate anywhere around
  the HTTP server or mDNS calls.

**ESP8266** (`firmware-esp8266/src/main.cpp`):
- `setup()` (lines 46–72) calls `httpApiBegin()` (line 64) and `cloudClientBegin()` (line 66) as
  unconditional, sequential, independent calls.
- `loop()` (lines 74–84) calls `httpApiLoop()` (line 80) and `startMdnsIfNeeded()` /
  `MDNS.update()` (lines 76–79) every iteration, unconditionally — `cloudClientLoop()` (line 82)
  is a separate call in the same loop with no shared gating. `cloudClientLoop()` internally
  no-ops if the cloud isn't reachable (`cloud_client.cpp` lines 131–136), but that only affects
  the cloud connection itself, not the HTTP/mDNS calls sitting next to it in `loop()`.

Net effect: a phone on the same WiFi network can always reach a device's local HTTP API
(discovered via mDNS `_esp-switch._tcp`) regardless of whether that device's cloud WebSocket is
connected, reconnecting, or has no internet path at all.

## 3. On-device scheduling (DS3231-driven, fire-and-forget cloud notify)

Schedules are evaluated and fired entirely from the device's own hardware RTC (DS3231), not
from any cloud-delivered tick or command.

- **ESP32** (`firmware/components/schedule_exec/schedule_exec.c`): `scheduler_task` (lines
  203–210) runs a free-running 1Hz loop calling `scheduler_tick()`, which reads time via
  `get_now()` (lines 87–110, DS3231 primary, SNTP-synced system clock only as an I2C-failure
  fallback — no network dependency for the time source itself in the normal case) and applies
  the switch action directly via `relay_hal_set_state()` inside `fire()` (lines 112–118).
  `fire()` then calls `cloud_client_notify_state_changed()` (line 116) — this happens *after*
  the relay has already switched, so a cloud outage cannot block or delay the physical action.
- **ESP8266** (`firmware-esp8266/src/schedule_exec.cpp`): same structure — `schedulerTick()`
  (lines 76–132) is driven by `getNowEpoch()` (lines 58–63, DS3231 primary), and `fire()` (lines
  65–69) calls `relayHalSetState()` before `cloudClientNotifyStateChanged()`.

The cloud notify call itself is non-blocking, best-effort, and silently no-ops when
disconnected:
- `cloud_client.c`'s `cloud_client_notify_state_changed()` (lines 222–240) returns immediately
  if `!s_connected` (line 224), and even when connected, sends with a `0` tick timeout (line
  237) with an explicit comment: *"Non-blocking best-effort — this is called from hot paths
  (http_api's channel-state handler, schedule_exec's fire()); a slow/stalled tunnel must never
  stall a relay toggle."* (lines 234–236).
- `cloud_client.cpp`'s `cloudClientNotifyStateChanged()` (lines 138–149) likewise returns
  immediately if `!s_connected` (line 139) — no retry queue, no blocking wait.

So: a schedule fires on time whether or not the internet is up; the only thing that's lost
during an outage is the real-time cloud notification of that state change, which is recovered
on reconnect (§4).

## 4. Reconnect resync (full-state republish)

Both firmware targets republish every channel's current state to the cloud immediately upon
(re)connecting, so anything that happened while offline (a fired schedule, a local-LAN toggle
via a phone on-site, a physical button press) is resynced to the cloud/app's view once
connectivity returns.

- **ESP32** (`cloud_client.c`): `publish_full_state()` (lines 140–150) iterates every configured
  switch and calls `cloud_client_notify_state_changed()` for its current relay state. It's
  invoked from `websocket_event_handler` on `WEBSOCKET_EVENT_CONNECTED` (line 178), right after
  `send_auth_frame()` (line 177). The function's own comment: *"On (re)connect, republish every
  channel's current state so the cloud's cached view resyncs even if changes happened while
  offline (spec §18 — physical-switch/offline-schedule state must reach the app once cloud
  connectivity returns)."* (lines 136–139).
- **ESP8266** (`cloud_client.cpp`): `publishFullState()` (lines 81–87) does the same, invoked
  from `onWsEvent` on `WStype_CONNECTED` (line 107), with an identical intent comment (lines
  79–80).

This means the reconnect path is not just "resume where we left off" — it's an explicit
full-state broadcast, so the app doesn't need any special "was this device ever offline"
tracking of its own to end up correct.

## 5. App-side transport strategy (local-first, cloud-fallback)

The app already tries the device's local LAN address first for every API call, and only falls
back to the cloud relay if that fails — this is the `FallbackDeviceTransport` class in
`app/lib/services/device_transport.dart` (lines 176–198):

```dart
class FallbackDeviceTransport implements DeviceTransport {
  FallbackDeviceTransport({required this.local, this.cloud});

  final DeviceTransport local;
  final DeviceTransport? cloud;

  @override
  Future<DeviceTransportResponse> send(...) async {
    try {
      return await local.send(method, path, body: body);
    } catch (_) {
      final cloudTransport = cloud;
      if (cloudTransport == null) {
        rethrow;
      }
      return cloudTransport.send(method, path, body: body);
    }
  }
}
```

The class doc comment (lines 171–175) is explicit about the contract: *"Tries `[local]` first;
on *any* failure (timeout, connection refused, non-2xx is NOT a failure here — only
transport-level exceptions are) falls back to `[cloud]` if one was supplied."* A non-2xx HTTP
response (e.g. a 4xx from the device itself) is deliberately **not** treated as a transport
failure — only connection-level errors (timeout, refused, DNS failure, etc.) trigger the
fallback to cloud relay.

Practical effect: when the phone is on the same WiFi network as the device, every call —
toggle, schedule edit, channel poll — is served locally and never touches the internet at all,
whether or not the internet is up. An outage is invisible to a phone on the home LAN.

## 6. The one real gap: phone off-LAN + internet down

If the phone is **not** on the device's LAN (user is away from home) **and** the home internet
is down at the same time, there is no path from phone to device: the cloud relay needs the
device's own internet connection to reach the backend, and that's exactly what's down. This is
not a bug — it's a physical impossibility (no software combinator can route around both sides
of a connection being unavailable simultaneously), so it is intentionally out of scope for a
fix.

What currently happens in this case is more of a UX issue than a networking one. In
`app/lib/providers/service_providers.dart`, `channelStatesProvider` (lines 701–712) polls a
device's channel state every 2 seconds and, on any failure, swallows it silently:

```dart
final channelStatesProvider = StreamProvider.autoDispose
    .family<List<ChannelState>, KnownDevice>((ref, device) async* {
      final client = ref.watch(activeDeviceApiClientProvider(device));
      while (true) {
        try {
          yield await client.getChannels();
        } catch (_) {
          yield const [];
        }
        await Future.delayed(const Duration(seconds: 2));
      }
    });
```

The `catch (_) { yield const []; }` at lines 707–708 means a genuinely-unreachable device (both
local and cloud transport failed) renders identically to a device with zero channels — the UI
has no way today to distinguish "unreachable, retrying" from "confirmed empty."

**Recommended (not yet implemented) follow-up:** rather than collapsing to a bare empty list,
surface a distinct state — e.g. show the last-known channel states greyed out with a "last seen
Xm ago" label, plus an "unreachable — will retry" indicator — instead of an empty view. This is
a UI/state-representation change only; it does not change what is reachable, only how the
unreachable case is communicated. Out of scope for this document to implement — noted here as
the recommended next step.

## 7. Operator/user-facing summary (FAQ-ready)

> **"What happens if my home internet goes out?"**
> Your switches keep working. Scheduled on/off times still fire exactly on time — they run off
> a clock built into each switch, not the internet. If you're home and on the same WiFi network,
> the app still controls your switches instantly, the same as always — it talks to them directly
> over your WiFi rather than going out to the internet and back. The only case that stops
> working is controlling a switch remotely (from outside your home) while your home internet is
> down — that one genuinely needs an internet connection at the house, since there's no other
> way for a command to reach it from outside. Once your internet comes back, everything —
> including anything a schedule did while you were offline — automatically syncs back up within
> seconds.
