#include <stdio.h>
#include <string.h>

#include "driver/i2c_master.h"
#include "esp_chip_info.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "channel_control.h"
#include "cloud_client.h"
#include "config_store.h"
#include "ds3231.h"
#include "http_api.h"
#include "mdns_advertise.h"
#include "ota.h"
#include "physical_input.h"
#include "provisioning.h"
#include "recovery_button.h"
#include "relay_hal.h"
#include "schedule_exec.h"
#include "wifi_reconfig.h"

static const char *TAG = "main";

// Config read once at boot and kept static — network_services_task below
// outlives app_main's own stack frame (it can block on WiFi for longer than
// app_main takes to finish and return), so this must not be a local/stack
// variable.
static ss_config_t s_cfg;

static void init_nvs(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
}

static void init_relays_from_config(const ss_config_t *cfg)
{
    static const gpio_num_t pins[SS_MAX_CHANNELS] = {
        CONFIG_SS_RELAY_CH0_GPIO,
        CONFIG_SS_RELAY_CH1_GPIO,
        CONFIG_SS_RELAY_CH2_GPIO,
        CONFIG_SS_RELAY_CH3_GPIO,
        CONFIG_SS_RELAY_CH4_GPIO,
        CONFIG_SS_RELAY_CH5_GPIO,
    };

    relay_hal_config_t hal_cfg = {
        .driver = SS_CHANNEL_DRIVER_GPIO_DIRECT,
        .channel_count = CONFIG_SS_CHANNEL_COUNT,
        .gpio_pins = pins,
        .active_low = CONFIG_SS_RELAY_ACTIVE_LOW,
    };
    ESP_ERROR_CHECK(relay_hal_init(&hal_cfg));

    for (uint8_t i = 0; i < cfg->switch_count && i < CONFIG_SS_CHANNEL_COUNT; i++) {
        const ss_switch_t *sw = &cfg->switches[i];
        // "LAST" requires persisting live channel state across reboots,
        // which isn't modeled yet — OFF/ON only at boot for now.
        bool on = (strcmp(sw->default_boot_state, "ON") == 0);
        relay_hal_set_state(sw->channel_idx, on);
    }
}

static void init_i2c_and_rtc(void)
{
    i2c_master_bus_config_t i2c_bus_cfg = {
        .i2c_port = -1,
        .sda_io_num = CONFIG_SS_I2C_SDA_GPIO,
        .scl_io_num = CONFIG_SS_I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    i2c_master_bus_handle_t i2c_bus;
    ESP_ERROR_CHECK(i2c_new_master_bus(&i2c_bus_cfg, &i2c_bus));
    ESP_ERROR_CHECK(ds3231_init(i2c_bus));
    ESP_ERROR_CHECK(schedule_exec_start());
}

// Waits for WiFi (may block for a while — SoftAP provisioning has no
// definite deadline), then starts the HTTP API + mDNS. Runs on its own task
// so it never blocks app_main's boot-complete log / ota_confirm_if_healthy.
static void network_services_task(void *arg)
{
    const ss_config_t *cfg = (const ss_config_t *)arg;

    provisioning_wait_wifi_ready(portMAX_DELAY);

    ESP_ERROR_CHECK(http_api_start());
    httpd_handle_t server = http_api_get_server_handle();
    ESP_ERROR_CHECK(wifi_reconfig_register_http_handlers(server));
    ESP_ERROR_CHECK(ota_register_http_handlers(server));

    esp_err_t err = mdns_advertise_start(cfg->device_id, cfg->name, cfg->board_type, relay_hal_channel_count());
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "mdns_advertise_start failed: %s", esp_err_to_name(err));
    }

    ESP_LOGI(TAG, "network services up: http_api + mdns advertising");
    vTaskDelete(NULL);
}

void app_main(void)
{
    esp_chip_info_t chip_info;
    esp_chip_info(&chip_info);
    ESP_LOGI(TAG, "Smart Switch firmware booting (chip model=%d revision=%d)",
             chip_info.model, chip_info.revision);

    init_nvs();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    ESP_ERROR_CHECK(ota_init());

    ESP_ERROR_CHECK(config_store_init());
    ESP_ERROR_CHECK(config_store_load(&s_cfg));

    // Printed once per boot so a fresh board's QR sticker can be generated
    // off the serial monitor right after flashing — the app's QR wizard
    // reads &chip= to pick the right WiFi-provisioning method (this chip's
    // Security1 handshake vs the ESP8266 port's plain JSON form). Serial
    // access requires physical/USB access to the board, same threat model
    // as the printed sticker itself.
    ESP_LOGI(TAG, "QR sticker: qrencode -o sticker.png "
                  "'smartapp://device/setup?id=%s&secret=%s&chip=esp32'",
             s_cfg.device_id, s_cfg.cloud_secret);

    init_relays_from_config(&s_cfg);
    ESP_ERROR_CHECK(channel_control_init());
    ESP_ERROR_CHECK(physical_input_init());
    init_i2c_and_rtc();

    ESP_ERROR_CHECK(provisioning_init(s_cfg.device_id));
    ESP_ERROR_CHECK(wifi_reconfig_init());
    ESP_ERROR_CHECK(recovery_button_init());

    xTaskCreate(network_services_task, "net_svc", 4096, &s_cfg, tskIDLE_PRIORITY + 3, NULL);

    // Persistent, outlives this function — reconnects to the cloud relay
    // for the device's whole life, unlike network_services_task above
    // (one-shot bootstrap that self-deletes once http_api/mdns are up).
    ESP_ERROR_CHECK(cloud_client_init());

    // Fast no-op on any normal boot; only blocks (up to 45s) on the first
    // boot after an OTA update, confirming or forcing a rollback.
    ota_confirm_if_healthy(pdMS_TO_TICKS(45000));

    ESP_LOGI(TAG, "boot complete: device_id=%s board_type=%s channel_count=%d fw_version=%s provisioned=%s",
             s_cfg.device_id, s_cfg.board_type, s_cfg.channel_count, s_cfg.fw_version,
             provisioning_is_provisioned() ? "true" : "false");
}
