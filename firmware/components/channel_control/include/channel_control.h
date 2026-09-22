#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

// Central entry point for every user/schedule/physical-input-triggered
// channel state change. Applies interlock (if config's interlock_enabled and
// on==true, forces every other channel off first), then relay_hal_set_state,
// then cloud_client_notify_state_changed, then arms/cancels that channel's
// inching auto-reverse timer per its switch's inching_ms. This is the ONLY
// function that should be called to change channel state outside of
// boot-time default-state restore (main.c's init_relays_from_config, which
// intentionally bypasses interlock/inching during boot).
esp_err_t channel_control_set_state(uint8_t channel_idx, bool on);

// Call once at boot, after relay_hal_init() and after config_store_load().
esp_err_t channel_control_init(void);
