#pragma once

#include <ESP8266WebServer.h>

extern ESP8266WebServer httpServer;

// Registers every /api/* handler (mirrors the ESP32 firmware's http_api.c
// endpoint list exactly — same paths/methods/JSON shapes) plus the WiFi
// provisioning form/endpoint, and starts the server. Call once WiFi is up
// (STA connected or AP mode active — this server serves both the SoftAP
// clients during first-time setup and normal LAN clients afterward).
void httpApiBegin();

// Must be called every loop() iteration.
void httpApiLoop();

// The device is a thin IO+networking client now — the backend is
// authoritative for every /api/* decision except device-local network
// reconfiguration (see httpApiHandleNetworkConfig below). Every registered
// route (other than GET / and /api/wifi, which provisioning can't depend on
// a cloud link to serve) forwards straight through this function: fails
// fast with 503 if !cloudClientIsConnected(); otherwise sends
// {reqId, method, path, body} over the WS tunnel via cloudClientForward(),
// blocking this call only (pumping cloudClientLoop() internally) for a
// short bounded timeout, replying 504 on timeout. If the path matches
// POST /api/channels/{idx}/state and the backend's response is 2xx, applies
// it locally via channelControlSetState() before returning — the device
// still owns its own relay hardware; the backend's job here is authorize +
// attribute, not touch GPIOs directly.
bool httpApiForward(const char *method, const char *path, const char *bodyJson,
                     int *outStatus, String *outBody);

// POST /api/network (static IP / DHCP) is the one endpoint that stays fully
// device-local and is never forwarded to the backend — a device can't
// depend on the cloud connection it hasn't established yet to configure its
// own network. Shared between the local LAN route (http_api.cpp) and
// cloud_client.cpp's handling of a backend-relayed POST /api/network
// (reachable when the app uses the cloud-WS/cloud-REST transport instead of
// LAN) so this one path's device-local logic isn't duplicated. Does NOT
// reboot on success — callers do that themselves after handing the response
// back to whichever transport is in play, same "respond, then reboot"
// ordering as before.
void httpApiHandleNetworkConfig(const String &bodyJson, int *outStatus, String *outBody);

// GET /api/info's JSON body — device identity/runtime facts, answered
// on-device for both the local route and backend-relayed requests.
String httpApiBuildInfo();
