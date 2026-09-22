#include "channel_control.h"

#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"

#include "cloud_client.h"
#include "config_store.h"
#include "relay_hal.h"

static const char *TAG = "channel_control";

static esp_timer_handle_t s_inching_timer[SS_MAX_CHANNELS];
static uint8_t            s_channel_idx_ctx[SS_MAX_CHANNELS];

static void inching_timer_cb(void *arg)
{
    uint8_t idx = *(uint8_t *)arg;
    ESP_LOGI(TAG, "inching timer fired for channel %d, auto-reversing to OFF", idx);
    channel_control_set_state(idx, false);
}

esp_err_t channel_control_init(void)
{
    for (uint8_t i = 0; i < SS_MAX_CHANNELS; i++) {
        s_channel_idx_ctx[i] = i;
        esp_timer_create_args_t args = {
            .callback = inching_timer_cb,
            .arg = &s_channel_idx_ctx[i],
            .dispatch_method = ESP_TIMER_TASK,
            .name = "inching",
        };
        esp_err_t err = esp_timer_create(&args, &s_inching_timer[i]);
        if (err != ESP_OK) {
            return err;
        }
    }
    return ESP_OK;
}

esp_err_t channel_control_set_state(uint8_t channel_idx, bool on)
{
    if (channel_idx >= SS_MAX_CHANNELS) {
        // Every current caller stays in range today, but schedule_exec's
        // fire() passes a persisted schedule's channel_idx, which was only
        // validated once at schedule-creation time against the
        // Kconfig-selected (1-6) channel count. A reflash to a smaller
        // channel count, or a config restore across differently-configured
        // boards, is a plausible path to a stale out-of-range value reaching
        // this function later — guard the fixed-size array accesses below.
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t err = esp_timer_stop(s_inching_timer[channel_idx]);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "esp_timer_stop(channel %d) failed: %s", channel_idx, esp_err_to_name(err));
    }

    ss_config_t cfg;
    config_store_get(&cfg);

    if (on && cfg.interlock_enabled) {
        uint8_t count = relay_hal_channel_count();
        for (uint8_t i = 0; i < count; i++) {
            if (i == channel_idx) {
                continue;
            }
            bool other_on = false;
            relay_hal_get_state(i, &other_on);
            if (other_on) {
                esp_err_t stop_err = esp_timer_stop(s_inching_timer[i]);
                if (stop_err != ESP_OK && stop_err != ESP_ERR_INVALID_STATE) {
                    ESP_LOGW(TAG, "esp_timer_stop(channel %d) failed: %s", i, esp_err_to_name(stop_err));
                }
                // Under mutex contention relay_hal_set_state() can time out
                // (its own 50ms xSemaphoreTake) — e.g. several inching
                // auto-reverse timers, an interlock mass-off, and a fresh
                // HTTP toggle landing close together. Don't report a channel
                // as OFF over cloud when its relay write actually failed;
                // keep going so the other channels that DID succeed still
                // get turned off and notified.
                esp_err_t off_err = relay_hal_set_state(i, false);
                if (off_err != ESP_OK) {
                    ESP_LOGE(TAG, "interlock: relay_hal_set_state(channel %d, OFF) failed: %s",
                             i, esp_err_to_name(off_err));
                } else {
                    cloud_client_notify_state_changed(i, false);
                }
            }
        }
    }

    esp_err_t set_err = relay_hal_set_state(channel_idx, on);
    if (set_err != ESP_OK) {
        ESP_LOGE(TAG, "relay_hal_set_state(channel %d, %s) failed: %s",
                 channel_idx, on ? "ON" : "OFF", esp_err_to_name(set_err));
        return set_err;
    }
    cloud_client_notify_state_changed(channel_idx, on);

    if (on) {
        for (uint8_t i = 0; i < cfg.switch_count; i++) {
            if (cfg.switches[i].channel_idx == channel_idx) {
                if (cfg.switches[i].inching_ms > 0) {
                    esp_timer_start_once(s_inching_timer[channel_idx],
                                          (uint64_t)cfg.switches[i].inching_ms * 1000);
                }
                break;
            }
        }
    }

    return ESP_OK;
}
