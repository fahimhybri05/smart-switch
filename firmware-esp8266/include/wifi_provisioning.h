#pragma once

#include <Arduino.h>

// Same 4 states/strings as the ESP32 firmware's wifi_reconfig component
// (IDLE/TESTING/CONNECTED/FAILED_ROLLED_BACK) — the app's existing
// GET /api/info poll (after POST /api/wifi) works unmodified against this
// chip too. One state machine/endpoint serves both first-time provisioning
// (fresh device, currently AP-only — "rolled back" means AP mode is
// restored, not that a previous STA connection is restored, since there
// isn't one yet) and later reconfiguration of an already-connected device.
enum class WifiReconfigState { Idle, Testing, Connected, FailedRolledBack };

const char *wifiReconfigStateStr(WifiReconfigState state);

// Called once at boot: if WiFi credentials are already stored (ESP8266
// SDK's own persistent STA config), connects using them; otherwise starts
// the "SmartSwitch-<device_id>" SoftAP (WPA2, password = SS_AP_PASSWORD — no
// Security1/protocomm equivalent on this chip, see docs/plan.md). While the
// hotspot is up, local_web.cpp serves the offline control + WiFi setup page
// at http://192.168.4.1/ alongside the JSON endpoints below.
void wifiProvisioningBegin();

// Must be called every loop() iteration — drives the deferred
// connect-and-possibly-roll-back state machine (can't act on a new
// SSID/password synchronously inside the HTTP handler that received it,
// same reasoning as the ESP32 firmware's 700ms defer). Also drives a
// separate, automatic background retry of the already-stored credentials
// while the device is stuck in AP-only fallback since boot (self-heals
// once a temporarily-unreachable router comes back, without needing a
// human to join the SoftAP and re-enter credentials that already work).
void wifiProvisioningLoop();

// POST /api/wifi body: accepts {ssid, password}, validates, and on success
// responds 202 and arms the deferred connect-or-roll-back attempt (409 if
// one is already in flight). Shared by the local HTTP route and the
// backend-relayed path (cloud_client.cpp) so the app can change WiFi
// remotely too.
void wifiProvisioningRequestReconfig(const String &bodyJson, int *outStatus, String *outBody);

// Local POST /api/wifi route — thin wrapper around the above.
void wifiProvisioningHandlePost();

// GET /api/wifi body: {state, connected, ssid, rssi?, ip?} — the real, on-device
// reconfig outcome. The backend's own GET /api/info only has a placeholder
// wifi_reconfig_state, so remote callers poll this (relayed) instead.
String wifiProvisioningBuildStatus();

// Local GET /api/wifi route.
void wifiProvisioningHandleGet();

// GET /api/wifi/scan body: {scanning, networks:[{ssid, rssi, secure,
// channel}]} — strongest first, deduped by SSID, hidden SSIDs skipped, max
// 20. Starts an async scan when [refresh] or the cache is >30s old; while
// `scanning` is true, callers poll again (networks may be the old cache).
String wifiProvisioningScanJson(bool refresh);

// Local GET /api/wifi/scan route (?refresh=1 forces a new scan).
void wifiProvisioningHandleScan();

// True while the setup hotspot is up and the device is NOT on a WiFi
// network — the only time the offline control page (local_web.cpp) is
// served.
bool wifiProvisioningIsLocalMode();

WifiReconfigState wifiProvisioningGetState();

bool wifiProvisioningIsConnected();
