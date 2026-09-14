#include "mdns_advertise.h"

#include <stdio.h>

#include "esp_log.h"
#include "mdns.h"

static const char *TAG = "mdns_advertise";
static bool s_started = false;

esp_err_t mdns_advertise_start(const char *device_id, const char *name,
                                const char *board_type, uint8_t channel_count)
{
    esp_err_t err = mdns_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "mdns_init failed: %s", esp_err_to_name(err));
        return err;
    }

    ESP_ERROR_CHECK(mdns_hostname_set(device_id));
    ESP_ERROR_CHECK(mdns_instance_name_set(name));

    char ch_count_str[4];
    snprintf(ch_count_str, sizeof(ch_count_str), "%u", channel_count);

    mdns_txt_item_t txt[] = {
        {"device_id", device_id},
        {"board_type", board_type},
        {"channel_count", ch_count_str},
    };

    err = mdns_service_add(name, "_esp-switch", "_tcp", 80, txt, 3);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "mdns_service_add failed: %s", esp_err_to_name(err));
        return err;
    }

    s_started = true;
    ESP_LOGI(TAG, "advertising _esp-switch._tcp as %s (%s)", device_id, name);
    return ESP_OK;
}

esp_err_t mdns_advertise_stop(void)
{
    if (!s_started) {
        return ESP_OK;
    }
    mdns_free();
    s_started = false;
    return ESP_OK;
}
