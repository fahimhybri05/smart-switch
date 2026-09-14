#include "relay_hal.h"

#include <string.h>

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "relay_hal";

// Must track config_store.h's SS_MAX_CHANNELS — independent #define since
// this component doesn't include config_store.h; nothing enforces they move
// together at compile time.
#define SS_RELAY_HAL_MAX_CHANNELS 6

static gpio_num_t s_pins[SS_RELAY_HAL_MAX_CHANNELS];
static bool       s_state[SS_RELAY_HAL_MAX_CHANNELS];
static uint8_t    s_channel_count = 0;
static bool       s_active_low = true;
static bool       s_initialized = false;
static SemaphoreHandle_t s_mutex;

esp_err_t relay_hal_init(const relay_hal_config_t *cfg)
{
    if (cfg->driver == SS_CHANNEL_DRIVER_I2C_EXPANDER) {
        ESP_LOGE(TAG, "I2C expander HAL is not implemented — this board is GPIO-direct only");
        return ESP_ERR_NOT_SUPPORTED;
    }

    if (cfg->channel_count > SS_RELAY_HAL_MAX_CHANNELS) {
        ESP_LOGE(TAG, "channel_count %d exceeds max %d", cfg->channel_count, SS_RELAY_HAL_MAX_CHANNELS);
        return ESP_ERR_INVALID_ARG;
    }

    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }

    s_channel_count = cfg->channel_count;
    s_active_low = cfg->active_low;

    for (uint8_t i = 0; i < s_channel_count; i++) {
        s_pins[i] = cfg->gpio_pins[i];

        gpio_config_t io_conf = {
            .pin_bit_mask = 1ULL << s_pins[i],
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        esp_err_t err = gpio_config(&io_conf);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "gpio_config failed for channel %d (gpio %d): %s", i, s_pins[i], esp_err_to_name(err));
            return err;
        }

        s_state[i] = false;
        gpio_set_level(s_pins[i], s_active_low ? 1 : 0); // drive to "off"
    }

    s_initialized = true;
    ESP_LOGI(TAG, "initialized %d GPIO-direct channel(s), active_%s", s_channel_count, s_active_low ? "low" : "high");
    return ESP_OK;
}

esp_err_t relay_hal_set_state(uint8_t channel_idx, bool on)
{
    if (!s_initialized || channel_idx >= s_channel_count) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    gpio_set_level(s_pins[channel_idx], s_active_low ? !on : on);
    s_state[channel_idx] = on;

    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t relay_hal_get_state(uint8_t channel_idx, bool *on)
{
    if (!s_initialized || channel_idx >= s_channel_count || on == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(50)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    *on = s_state[channel_idx];

    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

uint8_t relay_hal_channel_count(void)
{
    return s_channel_count;
}
