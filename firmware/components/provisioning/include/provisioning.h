#pragma once

#include <stdbool.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

// Set once, on the first IP_EVENT_STA_GOT_IP, and never cleared — a
// one-shot "safe to start the HTTP server / mDNS" boot gate, not a live
// connectivity flag. Transient drops (normal WiFi flakiness, or a
// wifi_reconfig test window) do not clear it.
#define PROVISIONING_WIFI_READY_BIT BIT0

// If not provisioned: starts real wifi_prov_mgr SoftAP provisioning
// (security1, POP=device_id). If already provisioned: connects STA using
// stored credentials. device_id is used to derive the SoftAP service name
// and POP — caller (main.c) owns its lifetime for the duration of this call
// (copied internally, safe to free/reuse after return).
esp_err_t provisioning_init(const char *device_id);

bool provisioning_is_provisioned(void);

EventGroupHandle_t provisioning_get_event_group(void);

// Convenience wrapper: xEventGroupWaitBits() on PROVISIONING_WIFI_READY_BIT.
bool provisioning_wait_wifi_ready(TickType_t ticks_to_wait);

// Used by wifi_reconfig to prevent provisioning's own auto-reconnect handler
// from racing a test-connect attempt for the STA radio.
void provisioning_set_auto_reconnect_suspended(bool suspended);
