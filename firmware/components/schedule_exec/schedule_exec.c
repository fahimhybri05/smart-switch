#include "schedule_exec.h"

#include <ctype.h>
#include <string.h>
#include <time.h>

#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "cloud_client.h"
#include "ds3231.h"
#include "relay_hal.h"

static const char *TAG = "schedule_exec";

static volatile bool s_time_known_good = false;

typedef struct {
    char    id[12];
    int64_t last_fired_minute; // -1 = never fired this boot
} fire_guard_t;

static fire_guard_t s_fire_guard[SS_MAX_SCHEDULES];

static fire_guard_t *guard_for(const char *id)
{
    for (int i = 0; i < SS_MAX_SCHEDULES; i++) {
        if (strcmp(s_fire_guard[i].id, id) == 0) {
            return &s_fire_guard[i];
        }
    }
    for (int i = 0; i < SS_MAX_SCHEDULES; i++) {
        if (s_fire_guard[i].id[0] == '\0') {
            snprintf(s_fire_guard[i].id, sizeof(s_fire_guard[i].id), "%s", id);
            s_fire_guard[i].last_fired_minute = -1;
            return &s_fire_guard[i];
        }
    }
    return NULL; // table full — shouldn't happen, sized to SS_MAX_SCHEDULES
}

static bool parse_hhmm(const char *s, int *h, int *m)
{
    if (strlen(s) != 5 || s[2] != ':') {
        return false;
    }
    for (int i = 0; i < 5; i++) {
        if (i != 2 && !isdigit((unsigned char)s[i])) {
            return false;
        }
    }
    *h = (s[0] - '0') * 10 + (s[1] - '0');
    *m = (s[3] - '0') * 10 + (s[4] - '0');
    return (*h >= 0 && *h < 24 && *m >= 0 && *m < 60);
}

static void sntp_sync_cb(struct timeval *tv)
{
    struct tm tmv;
    localtime_r(&tv->tv_sec, &tmv); // TZ forced to UTC0 in schedule_exec_start()

    ds3231_time_t dt = {
        .year = (int16_t)(tmv.tm_year + 1900),
        .month = (uint8_t)(tmv.tm_mon + 1),
        .day = (uint8_t)tmv.tm_mday,
        .weekday = (uint8_t)(tmv.tm_wday == 0 ? 7 : tmv.tm_wday),
        .hour = (uint8_t)tmv.tm_hour,
        .minute = (uint8_t)tmv.tm_min,
        .second = (uint8_t)tmv.tm_sec,
    };

    if (ds3231_set_time(&dt) == ESP_OK) {
        ds3231_clear_osf();
        ESP_LOGI(TAG, "RTC healed from SNTP sync");
    } else {
        ESP_LOGE(TAG, "SNTP synced but failed to write time to DS3231 (I2C error?)");
    }
    // System clock (time(NULL)) is already set by lwip's SNTP implementation
    // before this callback runs, regardless of the DS3231 write outcome —
    // safe to trust system time as the fallback source from here on.
    s_time_known_good = true;
}

// Primary: DS3231. Fallback: SNTP-synced system clock, only on I2C failure.
static esp_err_t get_now(time_t *out_epoch, struct tm *out_tm)
{
    ds3231_time_t dt;
    if (ds3231_get_time(&dt) == ESP_OK) {
        struct tm tmv = {0};
        tmv.tm_year = dt.year - 1900;
        tmv.tm_mon = dt.month - 1;
        tmv.tm_mday = dt.day;
        tmv.tm_hour = dt.hour;
        tmv.tm_min = dt.minute;
        tmv.tm_sec = dt.second;
        tmv.tm_isdst = 0;
        *out_epoch = mktime(&tmv); // TZ=UTC0 forced — mktime normalizes tm_wday too
        *out_tm = tmv;
        return ESP_OK;
    }

    time_t epoch = time(NULL);
    struct tm tmv;
    localtime_r(&epoch, &tmv);
    *out_epoch = epoch;
    *out_tm = tmv;
    return ESP_OK;
}

static void fire(const ss_schedule_t *sched)
{
    bool on = (strcmp(sched->action, "ON") == 0);
    relay_hal_set_state(sched->channel_idx, on);
    cloud_client_notify_state_changed(sched->channel_idx, on);
    ESP_LOGI(TAG, "fired schedule %s: channel %d -> %s", sched->id, sched->channel_idx, sched->action);
}

static void self_disable(const ss_schedule_t *sched)
{
    ss_schedule_t updated = *sched;
    updated.enabled = false;
    config_store_set_schedule(&updated, NULL);
}

static void scheduler_tick(void)
{
    if (!s_time_known_good) {
        return;
    }

    time_t epoch;
    struct tm tmv;
    get_now(&epoch, &tmv);
    int64_t current_minute = epoch / 60;

    // Clock-type schedules (once/daily/weekly) are matched in local time;
    // countdown schedules and the fire-guard's current_minute stay in raw
    // UTC epoch since they're duration/uniqueness based, not wall-clock.
    // RTC/SNTP themselves are never touched — the offset is applied here,
    // at match time, only.
    ss_config_t cfg;
    config_store_get(&cfg);
    time_t local_epoch = epoch + (time_t)cfg.utc_offset_min * 60;
    struct tm local_tm;
    gmtime_r(&local_epoch, &local_tm);
    int iso_wday = (local_tm.tm_wday == 0) ? 7 : local_tm.tm_wday;

    ss_schedule_t scheds[SS_MAX_SCHEDULES];
    uint8_t count = 0;
    config_store_get_schedules(scheds, SS_MAX_SCHEDULES, &count);

    for (uint8_t i = 0; i < count; i++) {
        ss_schedule_t *s = &scheds[i];
        if (!s->enabled) {
            continue;
        }

        if (strcmp(s->type, "countdown") == 0) {
            if (s->countdown_started_at > 0 && epoch >= s->countdown_started_at + (time_t)s->duration_s) {
                fire(s);
                self_disable(s);
            }
            continue;
        }

        // Clock types: once / daily / weekly
        int h, m;
        if (!parse_hhmm(s->time, &h, &m)) {
            continue;
        }
        // A window, not an exact tmv.tm_sec == 0 match: the scheduler tick
        // is ~1Hz but not guaranteed to land exactly on the second boundary
        // (HTTP/WS traffic can delay a given loop iteration) — requiring an
        // exact match silently skipped the whole day's fire whenever a tick
        // missed :00. Safe to widen: the fire-guard below (keyed by
        // current_minute) already prevents firing more than once per minute
        // regardless of how many ticks land inside this window.
        bool time_match = (local_tm.tm_hour == h && local_tm.tm_min == m && tmv.tm_sec < 5);
        if (!time_match) {
            continue;
        }
        if (strcmp(s->type, "weekly") == 0 && !(s->days_mask & (1 << (iso_wday - 1)))) {
            continue;
        }

        fire_guard_t *g = guard_for(s->id);
        if (g != NULL && g->last_fired_minute == current_minute) {
            continue; // already fired this exact minute
        }
        if (g != NULL) {
            g->last_fired_minute = current_minute;
        }

        fire(s);
        if (strcmp(s->type, "once") == 0) {
            self_disable(s);
        }
    }
}

static void scheduler_task(void *arg)
{
    (void)arg;
    for (;;) {
        scheduler_tick();
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

esp_err_t schedule_exec_start(void)
{
    setenv("TZ", "UTC0", 1);
    tzset();

    bool osf = true;
    esp_err_t err = ds3231_get_osf(&osf);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "failed to read DS3231 OSF (%s) — treating time as unknown until SNTP sync", esp_err_to_name(err));
        s_time_known_good = false;
    } else if (osf) {
        ESP_LOGW(TAG, "DS3231 oscillator-stop-flag set — RTC time not trustworthy until SNTP heals it");
        s_time_known_good = false;
    } else {
        ESP_LOGI(TAG, "DS3231 time trusted (OSF clear)");
        s_time_known_good = true;
    }

    esp_sntp_config_t sntp_cfg = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    sntp_cfg.wait_for_sync = false; // must not block — may be called pre-WiFi
    sntp_cfg.sync_cb = sntp_sync_cb;
    esp_netif_sntp_init(&sntp_cfg);

    for (int i = 0; i < SS_MAX_SCHEDULES; i++) {
        s_fire_guard[i].id[0] = '\0';
        s_fire_guard[i].last_fired_minute = -1;
    }

    BaseType_t created = xTaskCreate(scheduler_task, "schedule_exec", 4096, NULL, tskIDLE_PRIORITY + 3, NULL);
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

bool schedule_exec_time_is_known_good(void)
{
    return s_time_known_good;
}

int64_t schedule_exec_now_epoch(void)
{
    time_t epoch;
    struct tm tmv;
    get_now(&epoch, &tmv);
    return (int64_t)epoch;
}

esp_err_t schedule_exec_upsert(const ss_schedule_t *in, ss_schedule_t *out)
{
    if (in->channel_idx >= relay_hal_channel_count()) {
        return ESP_ERR_INVALID_ARG;
    }
    if (strcmp(in->action, "ON") != 0 && strcmp(in->action, "OFF") != 0) {
        return ESP_ERR_INVALID_ARG;
    }

    bool is_clock = strcmp(in->type, "once") == 0 || strcmp(in->type, "daily") == 0 || strcmp(in->type, "weekly") == 0;
    bool is_countdown = strcmp(in->type, "countdown") == 0;
    if (!is_clock && !is_countdown) {
        return ESP_ERR_INVALID_ARG;
    }
    if (is_clock) {
        int h, m;
        if (!parse_hhmm(in->time, &h, &m)) {
            return ESP_ERR_INVALID_ARG;
        }
    }
    if (is_countdown && in->duration_s == 0) {
        return ESP_ERR_INVALID_ARG;
    }

    ss_schedule_t working = *in;

    if (in->id[0] == '\0') {
        if (is_countdown) {
            working.countdown_started_at = time(NULL);
        }
    } else {
        ss_schedule_t existing[SS_MAX_SCHEDULES];
        uint8_t count = 0;
        config_store_get_schedules(existing, SS_MAX_SCHEDULES, &count);

        int found = -1;
        for (int i = 0; i < count; i++) {
            if (strcmp(existing[i].id, in->id) == 0) {
                found = i;
                break;
            }
        }
        if (found < 0) {
            return ESP_ERR_NOT_FOUND;
        }

        if (is_countdown) {
            bool was_enabled = existing[found].enabled;
            if (!was_enabled && in->enabled) {
                working.countdown_started_at = time(NULL); // re-arm on disabled->enabled transition
            } else {
                working.countdown_started_at = existing[found].countdown_started_at; // plain edit: don't restart
            }
        }
    }

    return config_store_set_schedule(&working, out);
}

esp_err_t schedule_exec_delete(const char *id)
{
    return config_store_delete_schedule(id);
}
