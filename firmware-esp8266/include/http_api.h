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
