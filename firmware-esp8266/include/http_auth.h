#pragma once

#include <ESP8266WebServer.h>

// Returns true if the request is authorized. On false, has already sent a
// 401 (bad/missing credentials) or 429 (lockout window) response — caller
// should just return without sending anything else. Always true if no
// password is configured yet (fresh/unclaimed device), or if the request
// came from the loopback interface (cloud_client's own relayed-command
// proxy — see cloud_client.cpp; unspoofable from off-device, same
// rationale as the ESP32 firmware's http_auth.c).
bool httpAuthCheck(ESP8266WebServer &server);
