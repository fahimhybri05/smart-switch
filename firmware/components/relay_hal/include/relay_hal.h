#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "driver/gpio.h"
#include "esp_err.h"

typedef enum {
    SS_CHANNEL_DRIVER_GPIO_DIRECT = 0,
    SS_CHANNEL_DRIVER_I2C_EXPANDER, // phase 4 — not implemented in scaffold
} ss_channel_driver_t;

typedef struct {
    ss_channel_driver_t driver;
    uint8_t             channel_count;
    const gpio_num_t   *gpio_pins; // array[channel_count], GPIO_DIRECT only
    bool                active_low;
} relay_hal_config_t;

// Initializes the relay outputs described by cfg. For SS_CHANNEL_DRIVER_GPIO_DIRECT,
// each pin is configured as a push-pull output and driven to its "off" level.
// SS_CHANNEL_DRIVER_I2C_EXPANDER returns ESP_ERR_NOT_SUPPORTED (phase 4).
esp_err_t relay_hal_init(const relay_hal_config_t *cfg);

esp_err_t relay_hal_set_state(uint8_t channel_idx, bool on);
esp_err_t relay_hal_get_state(uint8_t channel_idx, bool *on);
uint8_t   relay_hal_channel_count(void);
