#pragma once

#include "esp_err.h"

// Starts a polling task watching CONFIG_SS_BOOT_BUTTON_GPIO (active-low).
// Short hold (CONFIG_SS_BOOT_SHORT_HOLD_MS, released before the long
// threshold) re-enters SoftAP provisioning without touching switches/
// schedules. Long hold (CONFIG_SS_BOOT_LONG_HOLD_MS, fires while still held)
// does a true factory reset (WiFi creds + switches/schedules wiped). Both
// paths end in esp_restart() and do not return to the caller.
//
// Call once from main.c, after provisioning_init() (needs esp_wifi_init()
// already done — wifi_prov_mgr_reset_provisioning() wraps esp_wifi_restore()).
esp_err_t recovery_button_init(void);
