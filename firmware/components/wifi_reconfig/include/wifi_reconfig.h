#pragma once

#include "esp_err.h"
#include "esp_http_server.h"

typedef enum {
    WIFI_RECONFIG_STATE_IDLE = 0,
    WIFI_RECONFIG_STATE_TESTING,
    WIFI_RECONFIG_STATE_CONNECTED,
    WIFI_RECONFIG_STATE_FAILED_ROLLED_BACK,
} wifi_reconfig_state_t;

// Call once from main.c, after provisioning_init().
esp_err_t wifi_reconfig_init(void);

// Fast/non-blocking — validates and arms a background test, does not touch
// the radio itself. http_api's POST /api/wifi handler calls this, then
// responds immediately based on the return value:
//   ESP_ERR_INVALID_ARG   -> 400
//   ESP_ERR_INVALID_STATE -> 409 (a test is already in progress)
//   ESP_OK                -> 202 {"state":"TESTING"}
// The actual up-to-~20.7s test/rollback runs later on a dedicated worker
// task. See DEVIATION #1 in the plan: this can never be synchronous on a
// single-radio ESP32 — the app learns the outcome via GET /api/info polling
// (wifi_reconfig_get_state()) once reconnected.
esp_err_t wifi_reconfig_request(const char *ssid, const char *password);

wifi_reconfig_state_t wifi_reconfig_get_state(void);

static inline const char *wifi_reconfig_state_str(wifi_reconfig_state_t s)
{
    switch (s) {
    case WIFI_RECONFIG_STATE_TESTING: return "TESTING";
    case WIFI_RECONFIG_STATE_CONNECTED: return "CONNECTED";
    case WIFI_RECONFIG_STATE_FAILED_ROLLED_BACK: return "FAILED_ROLLED_BACK";
    default: return "IDLE";
    }
}

// Registers POST /api/wifi onto an already-started http_api server instance
// (see http_api_get_server_handle()). Call once from main.c after both
// wifi_reconfig_init() and http_api_start() have succeeded.
esp_err_t wifi_reconfig_register_http_handlers(httpd_handle_t server);
