#include "physical_input.h"

#include <string.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "channel_control.h"
#include "config_store.h"
#include "relay_hal.h"

static const char *TAG = "physical_input";

#define POLL_MS      20
#define DEBOUNCE_MS  50

typedef struct {
    gpio_num_t pin;
    bool       active;         // pin wired AND input_mode != DISABLED (and a matching switch exists)
    char       input_mode[10]; // "TOGGLE" | "EDGE"

    bool     last_raw_level;  // last raw "engaged" reading (pre-debounce)
    uint32_t stable_ms;       // how long last_raw_level has held steady
    bool     debounced_level; // accepted/debounced "engaged" state
    bool     has_baseline;    // false until the first debounced reading is captured
} input_channel_t;

static input_channel_t s_channels[SS_MAX_CHANNELS];

static bool read_engaged(gpio_num_t pin)
{
    int level = gpio_get_level(pin);
    return CONFIG_SS_INPUT_ACTIVE_LOW ? (level == 0) : (level == 1);
}

static void input_task(void *arg)
{
    (void)arg;

    for (;;) {
        for (uint8_t i = 0; i < SS_MAX_CHANNELS; i++) {
            input_channel_t *ch = &s_channels[i];
            if (!ch->active) {
                continue;
            }

            bool engaged = read_engaged(ch->pin);

            if (engaged != ch->last_raw_level) {
                ch->last_raw_level = engaged;
                ch->stable_ms = 0;
                continue;
            }

            if (ch->stable_ms < DEBOUNCE_MS) {
                ch->stable_ms += POLL_MS;
            }

            if (ch->stable_ms >= DEBOUNCE_MS && engaged != ch->debounced_level) {
                ch->debounced_level = engaged;

                if (!ch->has_baseline) {
                    // First stable reading after boot — just capture it, don't
                    // act (avoids a spurious toggle when the physical switch
                    // position differs from the relay's boot-restored state).
                    ch->has_baseline = true;
                    continue;
                }

                if (strcmp(ch->input_mode, "TOGGLE") == 0) {
                    channel_control_set_state(i, ch->debounced_level);
                } else if (strcmp(ch->input_mode, "EDGE") == 0) {
                    if (ch->debounced_level) { // not-engaged -> engaged (press edge) only
                        bool cur = false;
                        relay_hal_get_state(i, &cur);
                        channel_control_set_state(i, !cur);
                    }
                }
            }
        }

        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

esp_err_t physical_input_init(void)
{
    static const gpio_num_t pins[SS_MAX_CHANNELS] = {
        CONFIG_SS_INPUT_CH0_GPIO, CONFIG_SS_INPUT_CH1_GPIO, CONFIG_SS_INPUT_CH2_GPIO,
        CONFIG_SS_INPUT_CH3_GPIO, CONFIG_SS_INPUT_CH4_GPIO, CONFIG_SS_INPUT_CH5_GPIO,
    };

    ss_config_t cfg;
    config_store_get(&cfg);

    memset(s_channels, 0, sizeof(s_channels));

    uint64_t pin_bit_mask = 0;
    for (uint8_t i = 0; i < SS_MAX_CHANNELS; i++) {
        s_channels[i].pin = pins[i];
        if (pins[i] < 0) {
            continue;
        }

        const ss_switch_t *sw = NULL;
        for (uint8_t j = 0; j < cfg.switch_count; j++) {
            if (cfg.switches[j].channel_idx == i) {
                sw = &cfg.switches[j];
                break;
            }
        }
        if (sw == NULL || strcmp(sw->input_mode, "DISABLED") == 0) {
            continue;
        }

        s_channels[i].active = true;
        snprintf(s_channels[i].input_mode, sizeof(s_channels[i].input_mode), "%s", sw->input_mode);
        pin_bit_mask |= (1ULL << pins[i]);
    }

    if (pin_bit_mask != 0) {
        gpio_config_t io_conf = {
            .pin_bit_mask = pin_bit_mask,
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = GPIO_PULLUP_ENABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        gpio_config(&io_conf);
    }

    // Seed last_raw_level from the current pin state so the first poll tick
    // doesn't spuriously look like a level change and reset the debounce
    // timer for no reason.
    for (uint8_t i = 0; i < SS_MAX_CHANNELS; i++) {
        if (s_channels[i].active) {
            s_channels[i].last_raw_level = read_engaged(s_channels[i].pin);
        }
    }

    BaseType_t created = xTaskCreate(input_task, "physical_input", 3072, NULL, tskIDLE_PRIORITY + 2, NULL);
    if (created != pdPASS) {
        ESP_LOGE(TAG, "failed to create physical_input task");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}
