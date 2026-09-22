#pragma once
#include "esp_err.h"
// Starts one polling task that services every channel whose Kconfig input
// GPIO is >= 0 and whose configured ss_switch_t.input_mode isn't "DISABLED".
// Call after relay_hal_init()/channel_control_init() and after
// config_store_load() (main.c does this at boot).
esp_err_t physical_input_init(void);
