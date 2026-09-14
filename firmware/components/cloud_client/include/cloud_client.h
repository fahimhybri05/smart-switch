#pragma once

#include <stdbool.h>
#include "esp_err.h"

// Starts the persistent cloud-tunnel task (own task, does not self-delete —
// unlike network_services_task, this runs for the device's whole life).
// Blocks internally on provisioning_wait_wifi_ready() before first connect,
// then reconnects with backoff for as long as the device is powered.
// Call once from app_main(), after config_store_load(). Idempotent-unsafe
// (only call once).
esp_err_t cloud_client_init(void);

// Best-effort unsolicited push of a channel's new state, for a state change
// that didn't originate from a cloud-relayed command (a local LAN app call,
// or a schedule firing) — call from http_api's channel-state handler and
// from schedule_exec's schedule-firing path. No-op (silently dropped, no
// queue) if the cloud tunnel isn't currently connected — matches "device
// stays authoritative, cache is best-effort" (see docs/plan.md); the next
// reconnect republishes full current state anyway.
void cloud_client_notify_state_changed(uint8_t channel_idx, bool on);
