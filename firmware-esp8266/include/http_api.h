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

// Dispatches {method, path, bodyJson} to the same logic the ESP8266WebServer
// routes use, without touching the live WebServer request object — safe to
// call in-process from anywhere (this chip has no RTOS, so "in-process" and
// "synchronous" are the same thing; this replaces cloud_client.cpp's old
// loopback-HTTP-to-itself approach, which self-deadlocked because
// ESP8266WebServer::handleClient() can't re-enter while something else in
// the same loop() iteration blocks waiting on it). Auth is still enforced
// exactly as it is for a real HTTP request — httpAuthCheck's existing
// loopback-bypass logic (matching 127.0.0.1) should be treated as
// unconditionally authorized here too, since this call path only exists for
// already-cloud-authenticated relayed commands (same trust boundary the
// ESP32 firmware's http_auth.c documents for its own loopback bypass).
// method: "GET"|"POST"|"DELETE". path: e.g. "/api/channels/0/state" (no
// query string). bodyJson: raw JSON body string, or "" for none.
// outStatus/outBody: HTTP-shaped status code and JSON response body string.
void httpApiDispatch(const char* method, const char* path, const char* bodyJson,
                      int* outStatus, String* outBody);
