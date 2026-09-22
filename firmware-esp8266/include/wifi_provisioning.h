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
// the "SmartSwitch-<device_id>" SoftAP (WPA2, password = device_id — no
// Security1/protocomm equivalent on this chip, see docs/plan.md) and serves
// a plain HTML fallback form at http://192.168.4.1/ in addition to the
// JSON endpoint below.
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

// POST /api/wifi handler body: accepts {ssid, password}, always responds
// 202 immediately and arms the deferred connect attempt. Auth-gated only
// once the device has an auth password configured (mirrors every other
// endpoint — a fresh/unclaimed device leaves this open).
void wifiProvisioningHandlePost();

// GET / handler — a plain HTML form (spec §8's "fall back gracefully"
// path) for a phone that joined the SoftAP manually and isn't using the
// app; posts to the same JSON endpoint above via a small inline script.
void wifiProvisioningHandleFormPage();

WifiReconfigState wifiProvisioningGetState();

bool wifiProvisioningIsConnected();
