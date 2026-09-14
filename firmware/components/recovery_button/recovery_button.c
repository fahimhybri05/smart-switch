#include "recovery_button.h"

#include "driver/gpio.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "wifi_provisioning/manager.h"

static const char *TAG = "recovery_button";

#define POLL_MS 100

static void do_network_reset(void)
{
    ESP_LOGW(TAG, "short hold: resetting WiFi provisioning only (switches/schedules kept)");
    wifi_prov_mgr_reset_provisioning(); // == esp_wifi_restore(); scoped to WiFi-only NVS state,
                                         // does not touch the separate "storage" littlefs partition
    esp_restart();
}

static void do_factory_reset(void)
{
    ESP_LOGW(TAG, "long hold: full factory reset (WiFi + switches/schedules wiped)");
    wifi_prov_mgr_reset_provisioning();
    esp_littlefs_format("storage"); // safe to call on an already-mounted partition
    esp_restart();
}

static void button_task(void *arg)
{
    (void)arg;

    gpio_config_t io_conf = {
        .pin_bit_mask = 1ULL << CONFIG_SS_BOOT_BUTTON_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&io_conf);

    uint32_t held_ms = 0;
    for (;;) {
        if (gpio_get_level(CONFIG_SS_BOOT_BUTTON_GPIO) == 0) { // active-low: pressed = GND
            held_ms += POLL_MS;
            if (held_ms >= (uint32_t)CONFIG_SS_BOOT_LONG_HOLD_MS) {
                do_factory_reset(); // never returns
            }
        } else {
            if (held_ms >= (uint32_t)CONFIG_SS_BOOT_SHORT_HOLD_MS) {
                do_network_reset(); // never returns
            }
            held_ms = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

esp_err_t recovery_button_init(void)
{
    BaseType_t created = xTaskCreate(button_task, "recovery_button", 3072, NULL, tskIDLE_PRIORITY + 1, NULL);
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
