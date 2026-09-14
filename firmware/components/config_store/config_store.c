#include "config_store.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_littlefs.h"
#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "config_store";

#define SS_CONFIG_PATH "/storage/config.json"
#define SS_CONFIG_TMP_PATH "/storage/config.json.tmp"

static ss_config_t       s_cfg;
static SemaphoreHandle_t s_mutex;

static esp_err_t write_json_locked(const ss_config_t *cfg);
static esp_err_t read_json(ss_config_t *out);

void config_store_default(ss_config_t *out)
{
    memset(out, 0, sizeof(*out));

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(out->device_id, sizeof(out->device_id), "esp-%02x%02x%02x", mac[3], mac[4], mac[5]);

    snprintf(out->name, sizeof(out->name), "Smart Switch %s", out->device_id);
    snprintf(out->board_type, sizeof(out->board_type), "6CH_GPIO");
    snprintf(out->channel_driver, sizeof(out->channel_driver), "GPIO_DIRECT");
    out->channel_count = SS_MAX_CHANNELS;

    const esp_app_desc_t *desc = esp_app_get_description();
    snprintf(out->fw_version, sizeof(out->fw_version), "%s", desc->version);

    out->switch_count = SS_MAX_CHANNELS;
    for (uint8_t i = 0; i < SS_MAX_CHANNELS; i++) {
        ss_switch_t *sw = &out->switches[i];
        sw->channel_idx = i;
        snprintf(sw->name, sizeof(sw->name), "Channel %d", i);
        sw->zone[0] = '\0';
        snprintf(sw->type, sizeof(sw->type), "ON_OFF");
        snprintf(sw->default_boot_state, sizeof(sw->default_boot_state), "OFF");
    }

    out->schedule_count = 0;
    out->next_schedule_id = 1;
    out->auth_password_set = false;
    out->utc_offset_min = 0;

    uint8_t secret_bytes[16];
    esp_fill_random(secret_bytes, sizeof(secret_bytes));
    for (size_t i = 0; i < sizeof(secret_bytes); i++) {
        snprintf(&out->cloud_secret[i * 2], 3, "%02x", secret_bytes[i]);
    }
}

esp_err_t config_store_init(void)
{
    esp_vfs_littlefs_conf_t conf = {
        .base_path = "/storage",
        .partition_label = "storage",
        .format_if_mount_failed = true,
        .dont_mount = false,
    };

    esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "failed to mount/format littlefs storage partition (%s)", esp_err_to_name(err));
        return err;
    }

    size_t total = 0, used = 0;
    if (esp_littlefs_info(conf.partition_label, &total, &used) == ESP_OK) {
        ESP_LOGI(TAG, "storage mounted: %d/%d bytes used", (int)used, (int)total);
    }

    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }

    err = read_json(&s_cfg);
    if (err == ESP_ERR_NOT_FOUND) {
        ESP_LOGI(TAG, "%s not found, generating default config", SS_CONFIG_PATH);
        config_store_default(&s_cfg);
        err = write_json_locked(&s_cfg);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "failed to persist default config (%s)", esp_err_to_name(err));
        }
    } else if (err == ESP_OK && s_cfg.cloud_secret[0] == '\0') {
        // Existing config from before cloud_secret existed — generate one now
        // rather than requiring a factory reset to get a cloud identity.
        ESP_LOGI(TAG, "no cloud_secret in existing config, generating one");
        uint8_t secret_bytes[16];
        esp_fill_random(secret_bytes, sizeof(secret_bytes));
        for (size_t i = 0; i < sizeof(secret_bytes); i++) {
            snprintf(&s_cfg.cloud_secret[i * 2], 3, "%02x", secret_bytes[i]);
        }
        esp_err_t save_err = write_json_locked(&s_cfg);
        if (save_err != ESP_OK) {
            ESP_LOGE(TAG, "failed to persist generated cloud_secret (%s)", esp_err_to_name(save_err));
        }
    }
    return err;
}

esp_err_t config_store_get(ss_config_t *out)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    memcpy(out, &s_cfg, sizeof(*out));
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t config_store_load(ss_config_t *out)
{
    return config_store_get(out);
}

static void schedule_to_json(cJSON *arr, const ss_schedule_t *s)
{
    cJSON *item = cJSON_CreateObject();
    cJSON_AddStringToObject(item, "id", s->id);
    cJSON_AddNumberToObject(item, "channel_idx", s->channel_idx);
    cJSON_AddStringToObject(item, "action", s->action);
    cJSON_AddStringToObject(item, "type", s->type);
    if (s->time[0] != '\0') {
        cJSON_AddStringToObject(item, "time", s->time);
    }
    if (strcmp(s->type, "weekly") == 0) {
        cJSON *days = cJSON_AddArrayToObject(item, "days");
        for (int bit = 0; bit < 7; bit++) {
            if (s->days_mask & (1 << bit)) {
                cJSON_AddItemToArray(days, cJSON_CreateNumber(bit + 1));
            }
        }
    }
    if (strcmp(s->type, "countdown") == 0) {
        cJSON_AddNumberToObject(item, "duration_s", s->duration_s);
        // countdown_started_at is a disk-format/internal detail — persisted
        // here so a reboot mid-countdown can catch up correctly, but this is
        // config_store's own on-disk file, not the HTTP API's wire response
        // (http_api builds its own response JSON and omits this field).
        cJSON_AddNumberToObject(item, "_countdown_started_at", (double)s->countdown_started_at);
    }
    cJSON_AddBoolToObject(item, "enabled", s->enabled);
    cJSON_AddItemToArray(arr, item);
}

static esp_err_t write_json_locked(const ss_config_t *cfg)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "device_id", cfg->device_id);
    cJSON_AddStringToObject(root, "name", cfg->name);
    cJSON_AddStringToObject(root, "board_type", cfg->board_type);
    cJSON_AddNumberToObject(root, "channel_count", cfg->channel_count);
    cJSON_AddStringToObject(root, "channel_driver", cfg->channel_driver);
    cJSON_AddStringToObject(root, "fw_version", cfg->fw_version);

    cJSON *switches = cJSON_AddArrayToObject(root, "switches");
    for (uint8_t i = 0; i < cfg->switch_count; i++) {
        const ss_switch_t *sw = &cfg->switches[i];
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "channel_idx", sw->channel_idx);
        cJSON_AddStringToObject(item, "name", sw->name);
        cJSON_AddStringToObject(item, "zone", sw->zone);
        cJSON_AddStringToObject(item, "type", sw->type);
        cJSON_AddStringToObject(item, "default_boot_state", sw->default_boot_state);
        cJSON_AddItemToArray(switches, item);
    }

    cJSON *schedules = cJSON_AddArrayToObject(root, "schedules");
    for (uint8_t i = 0; i < cfg->schedule_count; i++) {
        schedule_to_json(schedules, &cfg->schedules[i]);
    }

    cJSON_AddNumberToObject(root, "_next_schedule_id", cfg->next_schedule_id);
    cJSON_AddNumberToObject(root, "utc_offset_min", cfg->utc_offset_min);
    cJSON_AddBoolToObject(root, "_static_ip_enabled", cfg->static_ip_enabled);
    cJSON_AddStringToObject(root, "_static_ip", cfg->static_ip);
    cJSON_AddStringToObject(root, "_static_gateway", cfg->static_gateway);
    cJSON_AddStringToObject(root, "_static_subnet", cfg->static_subnet);
    cJSON_AddStringToObject(root, "_static_dns", cfg->static_dns);
    cJSON_AddBoolToObject(root, "_auth_password_set", cfg->auth_password_set);
    if (cfg->auth_password_set) {
        char hex[65];
        for (int i = 0; i < 32; i++) {
            snprintf(&hex[i * 2], 3, "%02x", cfg->auth_password_hash[i]);
        }
        cJSON_AddStringToObject(root, "_auth_password_hash", hex);
    }
    cJSON_AddStringToObject(root, "_cloud_secret", cfg->cloud_secret);

    char *rendered = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (rendered == NULL) {
        return ESP_ERR_NO_MEM;
    }

    esp_err_t err = ESP_OK;
    FILE *f = fopen(SS_CONFIG_TMP_PATH, "w");
    if (f == NULL) {
        ESP_LOGE(TAG, "failed to open %s for write", SS_CONFIG_TMP_PATH);
        err = ESP_FAIL;
        goto done;
    }
    fputs(rendered, f);
    fclose(f);

    if (rename(SS_CONFIG_TMP_PATH, SS_CONFIG_PATH) != 0) {
        ESP_LOGE(TAG, "failed to rename %s -> %s", SS_CONFIG_TMP_PATH, SS_CONFIG_PATH);
        err = ESP_FAIL;
    }

done:
    free(rendered);
    return err;
}

esp_err_t config_store_save(const ss_config_t *cfg)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    esp_err_t err = write_json_locked(cfg);
    if (err == ESP_OK) {
        memcpy(&s_cfg, cfg, sizeof(s_cfg));
    }
    xSemaphoreGive(s_mutex);
    return err;
}

static void parse_switch(const cJSON *item, ss_switch_t *sw)
{
    memset(sw, 0, sizeof(*sw));

    const cJSON *v;
    if ((v = cJSON_GetObjectItem(item, "channel_idx")) && cJSON_IsNumber(v)) {
        sw->channel_idx = (uint8_t)v->valueint;
    }
    if ((v = cJSON_GetObjectItem(item, "name")) && cJSON_IsString(v)) {
        snprintf(sw->name, sizeof(sw->name), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(item, "zone")) && cJSON_IsString(v)) {
        snprintf(sw->zone, sizeof(sw->zone), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(item, "type")) && cJSON_IsString(v)) {
        snprintf(sw->type, sizeof(sw->type), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(item, "default_boot_state")) && cJSON_IsString(v)) {
        snprintf(sw->default_boot_state, sizeof(sw->default_boot_state), "%s", v->valuestring);
    }
}

static void parse_schedule(const cJSON *item, ss_schedule_t *s)
{
    memset(s, 0, sizeof(*s));

    const cJSON *v;
    if ((v = cJSON_GetObjectItem(item, "id")) && cJSON_IsString(v)) {
        snprintf(s->id, sizeof(s->id), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(item, "channel_idx")) && cJSON_IsNumber(v)) {
        s->channel_idx = (uint8_t)v->valueint;
    }
    if ((v = cJSON_GetObjectItem(item, "action")) && cJSON_IsString(v)) {
        snprintf(s->action, sizeof(s->action), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(item, "type")) && cJSON_IsString(v)) {
        snprintf(s->type, sizeof(s->type), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(item, "time")) && cJSON_IsString(v)) {
        snprintf(s->time, sizeof(s->time), "%s", v->valuestring);
    }
    const cJSON *days = cJSON_GetObjectItem(item, "days");
    if (cJSON_IsArray(days)) {
        const cJSON *d;
        cJSON_ArrayForEach(d, days) {
            if (cJSON_IsNumber(d) && d->valueint >= 1 && d->valueint <= 7) {
                s->days_mask |= (1 << (d->valueint - 1));
            }
        }
    }
    if ((v = cJSON_GetObjectItem(item, "duration_s")) && cJSON_IsNumber(v)) {
        s->duration_s = (uint32_t)v->valuedouble;
    }
    if ((v = cJSON_GetObjectItem(item, "_countdown_started_at")) && cJSON_IsNumber(v)) {
        s->countdown_started_at = (int64_t)v->valuedouble;
    }
    if ((v = cJSON_GetObjectItem(item, "enabled")) && cJSON_IsBool(v)) {
        s->enabled = cJSON_IsTrue(v);
    }
}

static void hex_to_bytes(const char *hex, uint8_t out[32])
{
    for (int i = 0; i < 32; i++) {
        unsigned int byte;
        sscanf(&hex[i * 2], "%2x", &byte);
        out[i] = (uint8_t)byte;
    }
}

static esp_err_t read_json(ss_config_t *out)
{
    FILE *f = fopen(SS_CONFIG_PATH, "r");
    if (f == NULL) {
        return ESP_ERR_NOT_FOUND;
    }

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0) {
        fclose(f);
        return ESP_FAIL;
    }

    char *buf = malloc(size + 1);
    if (buf == NULL) {
        fclose(f);
        return ESP_ERR_NO_MEM;
    }
    size_t read = fread(buf, 1, size, f);
    fclose(f);
    buf[read] = '\0';

    cJSON *root = cJSON_Parse(buf);
    free(buf);
    if (root == NULL) {
        ESP_LOGE(TAG, "failed to parse %s", SS_CONFIG_PATH);
        return ESP_FAIL;
    }

    memset(out, 0, sizeof(*out));

    const cJSON *v;
    if ((v = cJSON_GetObjectItem(root, "device_id")) && cJSON_IsString(v)) {
        snprintf(out->device_id, sizeof(out->device_id), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(root, "name")) && cJSON_IsString(v)) {
        snprintf(out->name, sizeof(out->name), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(root, "board_type")) && cJSON_IsString(v)) {
        snprintf(out->board_type, sizeof(out->board_type), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(root, "channel_count")) && cJSON_IsNumber(v)) {
        out->channel_count = (uint8_t)v->valueint;
    }
    if ((v = cJSON_GetObjectItem(root, "channel_driver")) && cJSON_IsString(v)) {
        snprintf(out->channel_driver, sizeof(out->channel_driver), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(root, "fw_version")) && cJSON_IsString(v)) {
        snprintf(out->fw_version, sizeof(out->fw_version), "%s", v->valuestring);
    }

    const cJSON *switches = cJSON_GetObjectItem(root, "switches");
    if (cJSON_IsArray(switches)) {
        int i = 0;
        const cJSON *item;
        cJSON_ArrayForEach(item, switches) {
            if (i >= SS_MAX_CHANNELS) {
                break;
            }
            parse_switch(item, &out->switches[i]);
            i++;
        }
        out->switch_count = (uint8_t)i;
    }

    const cJSON *schedules = cJSON_GetObjectItem(root, "schedules");
    if (cJSON_IsArray(schedules)) {
        int i = 0;
        const cJSON *item;
        cJSON_ArrayForEach(item, schedules) {
            if (i >= SS_MAX_SCHEDULES) {
                break;
            }
            parse_schedule(item, &out->schedules[i]);
            i++;
        }
        out->schedule_count = (uint8_t)i;
    }

    if ((v = cJSON_GetObjectItem(root, "_next_schedule_id")) && cJSON_IsNumber(v)) {
        out->next_schedule_id = (uint32_t)v->valuedouble;
    } else {
        out->next_schedule_id = 1;
    }
    if ((v = cJSON_GetObjectItem(root, "utc_offset_min")) && cJSON_IsNumber(v)) {
        out->utc_offset_min = (int16_t)v->valueint;
    }

    if ((v = cJSON_GetObjectItem(root, "_static_ip_enabled")) && cJSON_IsBool(v)) {
        out->static_ip_enabled = cJSON_IsTrue(v);
    }
    if ((v = cJSON_GetObjectItem(root, "_static_ip")) && cJSON_IsString(v)) {
        snprintf(out->static_ip, sizeof(out->static_ip), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(root, "_static_gateway")) && cJSON_IsString(v)) {
        snprintf(out->static_gateway, sizeof(out->static_gateway), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(root, "_static_subnet")) && cJSON_IsString(v)) {
        snprintf(out->static_subnet, sizeof(out->static_subnet), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(root, "_static_dns")) && cJSON_IsString(v)) {
        snprintf(out->static_dns, sizeof(out->static_dns), "%s", v->valuestring);
    }

    if ((v = cJSON_GetObjectItem(root, "_auth_password_set")) && cJSON_IsBool(v)) {
        out->auth_password_set = cJSON_IsTrue(v);
    }
    if ((v = cJSON_GetObjectItem(root, "_auth_password_hash")) && cJSON_IsString(v) &&
        strlen(v->valuestring) == 64) {
        hex_to_bytes(v->valuestring, out->auth_password_hash);
    }
    if ((v = cJSON_GetObjectItem(root, "_cloud_secret")) && cJSON_IsString(v) &&
        strlen(v->valuestring) == 32) {
        snprintf(out->cloud_secret, sizeof(out->cloud_secret), "%s", v->valuestring);
    }

    cJSON_Delete(root);
    return ESP_OK;
}

esp_err_t config_store_get_schedules(ss_schedule_t *out, uint8_t max, uint8_t *count)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    uint8_t n = s_cfg.schedule_count < max ? s_cfg.schedule_count : max;
    memcpy(out, s_cfg.schedules, n * sizeof(ss_schedule_t));
    *count = n;
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t config_store_set_schedule(const ss_schedule_t *in, ss_schedule_t *out_stored)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    esp_err_t err = ESP_OK;
    int slot = -1;

    if (in->id[0] == '\0') {
        if (s_cfg.schedule_count >= SS_MAX_SCHEDULES) {
            err = ESP_ERR_NO_MEM;
            goto done;
        }
        slot = s_cfg.schedule_count;
        s_cfg.schedules[slot] = *in;
        snprintf(s_cfg.schedules[slot].id, sizeof(s_cfg.schedules[slot].id), "s-%" PRIu32, s_cfg.next_schedule_id);
        s_cfg.next_schedule_id++;
        s_cfg.schedule_count++;
    } else {
        for (int i = 0; i < s_cfg.schedule_count; i++) {
            if (strcmp(s_cfg.schedules[i].id, in->id) == 0) {
                slot = i;
                break;
            }
        }
        if (slot < 0) {
            err = ESP_ERR_NOT_FOUND;
            goto done;
        }
        char keep_id[12];
        snprintf(keep_id, sizeof(keep_id), "%s", s_cfg.schedules[slot].id);
        s_cfg.schedules[slot] = *in;
        snprintf(s_cfg.schedules[slot].id, sizeof(s_cfg.schedules[slot].id), "%s", keep_id);
    }

    err = write_json_locked(&s_cfg);
    if (err == ESP_OK && out_stored != NULL) {
        *out_stored = s_cfg.schedules[slot];
    }

done:
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t config_store_delete_schedule(const char *id)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    esp_err_t err = ESP_ERR_NOT_FOUND;
    for (int i = 0; i < s_cfg.schedule_count; i++) {
        if (strcmp(s_cfg.schedules[i].id, id) == 0) {
            for (int j = i; j < s_cfg.schedule_count - 1; j++) {
                s_cfg.schedules[j] = s_cfg.schedules[j + 1];
            }
            s_cfg.schedule_count--;
            err = write_json_locked(&s_cfg);
            break;
        }
    }

    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t config_store_set_switch(const ss_switch_t *in)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    esp_err_t err = ESP_OK;
    int slot = -1;
    for (int i = 0; i < s_cfg.switch_count; i++) {
        if (s_cfg.switches[i].channel_idx == in->channel_idx) {
            slot = i;
            break;
        }
    }
    if (slot < 0) {
        if (s_cfg.switch_count >= SS_MAX_CHANNELS) {
            err = ESP_ERR_NO_MEM;
            goto done;
        }
        slot = s_cfg.switch_count;
        s_cfg.switch_count++;
    }
    s_cfg.switches[slot] = *in;
    err = write_json_locked(&s_cfg);

done:
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t config_store_delete_switch(uint8_t channel_idx)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    esp_err_t err = ESP_ERR_NOT_FOUND;
    for (int i = 0; i < s_cfg.switch_count; i++) {
        if (s_cfg.switches[i].channel_idx == channel_idx) {
            for (int j = i; j < s_cfg.switch_count - 1; j++) {
                s_cfg.switches[j] = s_cfg.switches[j + 1];
            }
            s_cfg.switch_count--;
            err = write_json_locked(&s_cfg);
            break;
        }
    }

    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t config_store_set_auth_hash(const uint8_t hash[32])
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    memcpy(s_cfg.auth_password_hash, hash, 32);
    s_cfg.auth_password_set = true;
    esp_err_t err = write_json_locked(&s_cfg);
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t config_store_get_auth_hash(uint8_t out[32], bool *is_set)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    *is_set = s_cfg.auth_password_set;
    if (*is_set) {
        memcpy(out, s_cfg.auth_password_hash, 32);
    }
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t config_store_set_utc_offset(int16_t offset_min)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    s_cfg.utc_offset_min = offset_min;
    esp_err_t err = write_json_locked(&s_cfg);
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t config_store_set_static_ip(bool enabled, const char *ip, const char *gateway,
                                      const char *subnet, const char *dns)
{
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    s_cfg.static_ip_enabled = enabled;
    if (enabled) {
        snprintf(s_cfg.static_ip, sizeof(s_cfg.static_ip), "%s", ip);
        snprintf(s_cfg.static_gateway, sizeof(s_cfg.static_gateway), "%s", gateway);
        snprintf(s_cfg.static_subnet, sizeof(s_cfg.static_subnet), "%s", subnet);
        snprintf(s_cfg.static_dns, sizeof(s_cfg.static_dns), "%s", dns ? dns : "");
    }
    esp_err_t err = write_json_locked(&s_cfg);
    xSemaphoreGive(s_mutex);
    return err;
}
