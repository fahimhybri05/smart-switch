#pragma once

#include "esp_err.h"
#include "esp_http_server.h"

// Blocks (on its own internal task, not the caller) until WiFi is ready,
// then starts esp_http_server and registers all REST handlers. Call from a
// dedicated task, not directly from app_main() — see provisioning.h's
// provisioning_wait_wifi_ready(). Idempotent.
esp_err_t http_api_start(void);

esp_err_t http_api_stop(void);

// Integration point: components/wifi_reconfig and components/ota register
// their own handlers (POST /api/wifi, POST /api/ota) onto this same server
// instance rather than starting a second httpd_handle_t.
httpd_handle_t http_api_get_server_handle(void);
