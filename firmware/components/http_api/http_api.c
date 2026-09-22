#include "http_api.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"

#include "channel_control.h"
#include "config_store.h"
#include "relay_hal.h"
#include "schedule_exec.h"
#include "wifi_reconfig.h"

#include "http_auth.h"
#include "http_uri_parse.h"

static const char *TAG = "http_api";
static httpd_handle_t s_server = NULL;

// ---------------------------------------------------------------- helpers

// ESP_OK: buf/buf[received]='\0' holds the body. ESP_ERR_INVALID_SIZE: body
// too large for buf (caller should reply 400, connection still usable).
// ESP_FAIL: socket error mid-read — caller must NOT attempt to send a
// response, just return ESP_FAIL so httpd closes the connection.
static esp_err_t read_body(httpd_req_t *req, char *buf, size_t buf_size)
{
    if ((size_t)req->content_len >= buf_size) {
        return ESP_ERR_INVALID_SIZE;
    }
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int ret = httpd_req_recv(req, buf + received, req->content_len - received);
        if (ret <= 0) {
            return ESP_FAIL;
        }
        received += (size_t)ret;
    }
    buf[received] = '\0';
    return ESP_OK;
}

static esp_err_t reply_json(httpd_req_t *req, cJSON *root)
{
    char *rendered = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (rendered == NULL) {
        return ESP_FAIL;
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_sendstr(req, rendered);
    free(rendered);
    return err;
}

static esp_err_t reply_error(httpd_req_t *req, const char *status, const char *msg)
{
    httpd_resp_set_status(req, status);
    httpd_resp_set_type(req, "application/json");
    char body[160];
    snprintf(body, sizeof(body), "{\"error\":\"%s\"}", msg);
    httpd_resp_sendstr(req, body);
    return ESP_OK; // a valid response was sent — don't also signal a socket error
}

static cJSON *switch_to_json(const ss_switch_t *sw)
{
    cJSON *item = cJSON_CreateObject();
    cJSON_AddNumberToObject(item, "channel_idx", sw->channel_idx);
    cJSON_AddStringToObject(item, "name", sw->name);
    cJSON_AddStringToObject(item, "zone", sw->zone);
    cJSON_AddStringToObject(item, "type", sw->type);
    cJSON_AddStringToObject(item, "default_boot_state", sw->default_boot_state);
    cJSON_AddStringToObject(item, "input_mode", sw->input_mode);
    cJSON_AddNumberToObject(item, "inching_ms", sw->inching_ms);
    return item;
}

static cJSON *schedule_to_json(const ss_schedule_t *s)
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
    }
    if (strcmp(s->type, "sunrise") == 0 || strcmp(s->type, "sunset") == 0) {
        cJSON_AddNumberToObject(item, "solar_offset_min", s->solar_offset_min);
    }
    // countdown_started_at is deliberately omitted — internal/disk-format
    // only, not part of the spec §2 wire schema.
    cJSON_AddBoolToObject(item, "enabled", s->enabled);
    return item;
}

// ------------------------------------------------------------ GET /api/info

static esp_err_t handle_get_info(httpd_req_t *req)
{
    ss_config_t cfg;
    config_store_get(&cfg);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "device_id", cfg.device_id);
    cJSON_AddStringToObject(root, "board_type", cfg.board_type);
    cJSON_AddNumberToObject(root, "channel_count", relay_hal_channel_count());
    cJSON_AddStringToObject(root, "fw_version", cfg.fw_version);
    // Non-spec extension: lets the app learn the outcome of an async WiFi
    // reconfig (POST /api/wifi always responds 202 — see wifi_reconfig.h)
    // by polling this discovery-confirm endpoint once reconnected.
    cJSON_AddStringToObject(root, "wifi_reconfig_state", wifi_reconfig_state_str(wifi_reconfig_get_state()));
    // Local-LAN-only (this endpoint is unauthenticated by design, same
    // reachability boundary as the rest of /api/info) — read once by the
    // app's advanced/manual-claim fallback; the QR-based add-device flow
    // gets both values off the sticker instead. See docs/plan.md.
    cJSON_AddStringToObject(root, "cloud_secret", cfg.cloud_secret);
    // Diagnostic — lets the app (or a curl) confirm the scheduler actually
    // has a trustworthy clock without guessing. See docs/plan.md.
    cJSON_AddBoolToObject(root, "time_known_good", schedule_exec_time_is_known_good());
    cJSON_AddNumberToObject(root, "now_epoch", (double)schedule_exec_now_epoch());
    // Forward-compatible capability list — hardcoded for now, relay_hal is
    // strictly binary on/off; a future dimmer/fan/power-meter product adds
    // to this array without a breaking schema change. See docs/plan.md.
    cJSON *capabilities = cJSON_AddArrayToObject(root, "capabilities");
    cJSON_AddItemToArray(capabilities, cJSON_CreateString("switch"));
    return reply_json(req, root);
}

// ---------------------------------------------------------- GET /api/config

static esp_err_t handle_get_config(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    ss_config_t cfg;
    config_store_get(&cfg);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "device_id", cfg.device_id);
    cJSON_AddStringToObject(root, "name", cfg.name);
    cJSON_AddStringToObject(root, "board_type", cfg.board_type);
    cJSON_AddNumberToObject(root, "channel_count", cfg.channel_count);
    cJSON_AddStringToObject(root, "channel_driver", cfg.channel_driver);
    cJSON_AddStringToObject(root, "fw_version", cfg.fw_version);
    cJSON_AddNumberToObject(root, "utc_offset_min", cfg.utc_offset_min);
    cJSON_AddBoolToObject(root, "interlock_enabled", cfg.interlock_enabled);
    cJSON_AddNumberToObject(root, "latitude", cfg.latitude);
    cJSON_AddNumberToObject(root, "longitude", cfg.longitude);
    cJSON_AddBoolToObject(root, "location_set", cfg.location_set);

    cJSON *network = cJSON_AddObjectToObject(root, "network");
    cJSON_AddStringToObject(network, "mode", cfg.static_ip_enabled ? "static" : "dhcp");
    if (cfg.static_ip_enabled) {
        cJSON_AddStringToObject(network, "ip", cfg.static_ip);
        cJSON_AddStringToObject(network, "gateway", cfg.static_gateway);
        cJSON_AddStringToObject(network, "subnet", cfg.static_subnet);
        cJSON_AddStringToObject(network, "dns", cfg.static_dns);
    }

    cJSON *switches = cJSON_AddArrayToObject(root, "switches");
    for (uint8_t i = 0; i < cfg.switch_count; i++) {
        cJSON_AddItemToArray(switches, switch_to_json(&cfg.switches[i]));
    }

    cJSON *schedules = cJSON_AddArrayToObject(root, "schedules");
    for (uint8_t i = 0; i < cfg.schedule_count; i++) {
        cJSON_AddItemToArray(schedules, schedule_to_json(&cfg.schedules[i]));
    }

    return reply_json(req, root);
}

// -------------------------------------------------------- POST /api/switches

static bool parse_switch_body(const cJSON *root, ss_switch_t *out)
{
    memset(out, 0, sizeof(*out));

    const cJSON *v = cJSON_GetObjectItem(root, "channel_idx");
    if (!cJSON_IsNumber(v)) {
        return false;
    }
    out->channel_idx = (uint8_t)v->valueint;

    if ((v = cJSON_GetObjectItem(root, "name")) && cJSON_IsString(v)) {
        snprintf(out->name, sizeof(out->name), "%s", v->valuestring);
    }
    if ((v = cJSON_GetObjectItem(root, "zone")) && cJSON_IsString(v)) {
        snprintf(out->zone, sizeof(out->zone), "%s", v->valuestring);
    }
    snprintf(out->type, sizeof(out->type), "ON_OFF"); // only type supported today (spec §2 fwd-compat note)
    snprintf(out->default_boot_state, sizeof(out->default_boot_state), "OFF");
    if ((v = cJSON_GetObjectItem(root, "default_boot_state")) && cJSON_IsString(v)) {
        if (strcmp(v->valuestring, "ON") == 0 || strcmp(v->valuestring, "LAST") == 0 || strcmp(v->valuestring, "OFF") == 0) {
            snprintf(out->default_boot_state, sizeof(out->default_boot_state), "%s", v->valuestring);
        }
    }

    snprintf(out->input_mode, sizeof(out->input_mode), "DISABLED");
    out->inching_ms = 0;
    if ((v = cJSON_GetObjectItem(root, "input_mode")) && cJSON_IsString(v)) {
        if (strcmp(v->valuestring, "TOGGLE") == 0 || strcmp(v->valuestring, "EDGE") == 0 ||
            strcmp(v->valuestring, "DISABLED") == 0) {
            snprintf(out->input_mode, sizeof(out->input_mode), "%s", v->valuestring);
        }
    }
    if ((v = cJSON_GetObjectItem(root, "inching_ms")) && cJSON_IsNumber(v)) {
        double ms = v->valuedouble;
        if (ms < 0) {
            ms = 0;
        }
        if (ms > 600000) {
            ms = 600000;
        }
        out->inching_ms = (uint32_t)ms;
    }
    return true;
}

static esp_err_t handle_post_switches(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    char buf[512];
    esp_err_t rerr = read_body(req, buf, sizeof(buf));
    if (rerr == ESP_FAIL) {
        return ESP_FAIL;
    }
    if (rerr != ESP_OK) {
        return reply_error(req, "400 Bad Request", "body too large");
    }

    cJSON *root = cJSON_Parse(buf);
    if (root == NULL) {
        return reply_error(req, "400 Bad Request", "invalid JSON");
    }

    ss_switch_t sw;
    if (!parse_switch_body(root, &sw)) {
        cJSON_Delete(root);
        return reply_error(req, "400 Bad Request", "missing/invalid channel_idx");
    }
    cJSON_Delete(root);

    if (sw.channel_idx >= relay_hal_channel_count()) {
        return reply_error(req, "400 Bad Request", "channel_idx out of range");
    }

    esp_err_t err = config_store_set_switch(&sw);
    if (err != ESP_OK) {
        return reply_error(req, "500 Internal Server Error", "failed to persist switch");
    }

    return reply_json(req, switch_to_json(&sw));
}

// ----------------------------------------------------- DELETE /api/switches/*

static esp_err_t handle_delete_switch(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    long idx;
    if (!http_uri_parse_uint(req->uri, "/api/switches/", NULL, &idx)) {
        return reply_error(req, "400 Bad Request", "invalid channel index in path");
    }

    esp_err_t err = config_store_delete_switch((uint8_t)idx);
    if (err == ESP_ERR_NOT_FOUND) {
        return reply_error(req, "404 Not Found", "no switch labeled at that channel");
    }
    if (err != ESP_OK) {
        return reply_error(req, "500 Internal Server Error", "failed to delete switch");
    }

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "status", "deleted");
    return reply_json(req, root);
}

// --------------------------------------------------------- GET /api/channels

static esp_err_t handle_get_channels(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    cJSON *root = cJSON_CreateArray();
    uint8_t n = relay_hal_channel_count();
    for (uint8_t i = 0; i < n; i++) {
        bool on = false;
        relay_hal_get_state(i, &on);
        cJSON *item = cJSON_CreateObject();
        cJSON_AddNumberToObject(item, "channel_idx", i);
        cJSON_AddStringToObject(item, "state", on ? "ON" : "OFF");
        cJSON_AddItemToArray(root, item);
    }
    return reply_json(req, root);
}

// ------------------------------------------------- POST /api/channels/:idx/state
// Hot path — kept deliberately trivial/synchronous. Touches nothing but
// relay_hal (no config_store, no flash) per the latency priority.

static esp_err_t handle_post_channel_state(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    long idx;
    if (!http_uri_parse_uint(req->uri, "/api/channels/", "/state", &idx)) {
        return reply_error(req, "400 Bad Request", "expected /api/channels/:idx/state");
    }
    if (idx >= relay_hal_channel_count()) {
        return reply_error(req, "400 Bad Request", "channel_idx out of range");
    }

    char buf[128];
    esp_err_t rerr = read_body(req, buf, sizeof(buf));
    if (rerr == ESP_FAIL) {
        return ESP_FAIL;
    }
    if (rerr != ESP_OK) {
        return reply_error(req, "400 Bad Request", "body too large");
    }

    cJSON *root = cJSON_Parse(buf);
    const cJSON *state = root ? cJSON_GetObjectItem(root, "state") : NULL;
    if (!cJSON_IsString(state) || (strcmp(state->valuestring, "ON") != 0 && strcmp(state->valuestring, "OFF") != 0)) {
        if (root) {
            cJSON_Delete(root);
        }
        return reply_error(req, "400 Bad Request", "expected {\"state\":\"ON\"|\"OFF\"}");
    }

    bool on = (strcmp(state->valuestring, "ON") == 0);
    cJSON_Delete(root);

    channel_control_set_state((uint8_t)idx, on);

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddNumberToObject(resp, "channel_idx", idx);
    cJSON_AddStringToObject(resp, "state", on ? "ON" : "OFF");
    return reply_json(req, resp);
}

// ------------------------------------------------------- POST /api/schedules

static bool parse_schedule_body(const cJSON *root, ss_schedule_t *out)
{
    memset(out, 0, sizeof(*out));

    const cJSON *v;
    if ((v = cJSON_GetObjectItem(root, "id")) && cJSON_IsString(v)) {
        snprintf(out->id, sizeof(out->id), "%s", v->valuestring);
    }

    if (!(v = cJSON_GetObjectItem(root, "channel_idx")) || !cJSON_IsNumber(v)) {
        return false;
    }
    out->channel_idx = (uint8_t)v->valueint;

    if (!(v = cJSON_GetObjectItem(root, "action")) || !cJSON_IsString(v)) {
        return false;
    }
    snprintf(out->action, sizeof(out->action), "%s", v->valuestring);

    if (!(v = cJSON_GetObjectItem(root, "type")) || !cJSON_IsString(v)) {
        return false;
    }
    snprintf(out->type, sizeof(out->type), "%s", v->valuestring);

    if ((v = cJSON_GetObjectItem(root, "time")) && cJSON_IsString(v)) {
        snprintf(out->time, sizeof(out->time), "%s", v->valuestring);
    }

    const cJSON *days = cJSON_GetObjectItem(root, "days");
    if (cJSON_IsArray(days)) {
        const cJSON *d;
        cJSON_ArrayForEach(d, days) {
            if (cJSON_IsNumber(d) && d->valueint >= 1 && d->valueint <= 7) {
                out->days_mask |= (1 << (d->valueint - 1));
            }
        }
    }

    if ((v = cJSON_GetObjectItem(root, "duration_s")) && cJSON_IsNumber(v)) {
        out->duration_s = (uint32_t)v->valuedouble;
    }

    if ((v = cJSON_GetObjectItem(root, "solar_offset_min")) && cJSON_IsNumber(v)) {
        if (v->valueint < -180 || v->valueint > 180) {
            return false;
        }
        out->solar_offset_min = (int16_t)v->valueint;
    }

    out->enabled = true;
    if ((v = cJSON_GetObjectItem(root, "enabled")) && cJSON_IsBool(v)) {
        out->enabled = cJSON_IsTrue(v);
    }

    return true;
}

static esp_err_t handle_post_schedules(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    char buf[512];
    esp_err_t rerr = read_body(req, buf, sizeof(buf));
    if (rerr == ESP_FAIL) {
        return ESP_FAIL;
    }
    if (rerr != ESP_OK) {
        return reply_error(req, "400 Bad Request", "body too large");
    }

    cJSON *root = cJSON_Parse(buf);
    if (root == NULL) {
        return reply_error(req, "400 Bad Request", "invalid JSON");
    }

    ss_schedule_t in;
    if (!parse_schedule_body(root, &in)) {
        cJSON_Delete(root);
        return reply_error(req, "400 Bad Request", "missing required fields");
    }
    cJSON_Delete(root);

    if (strcmp(in.type, "sunrise") == 0 || strcmp(in.type, "sunset") == 0) {
        ss_config_t cfg;
        config_store_get(&cfg);
        if (!cfg.location_set) {
            return reply_error(req, "400 Bad Request", "device location not configured");
        }
    }

    ss_schedule_t stored;
    esp_err_t err = schedule_exec_upsert(&in, &stored);
    if (err == ESP_ERR_INVALID_ARG) {
        return reply_error(req, "400 Bad Request", "invalid schedule fields");
    }
    if (err == ESP_ERR_NOT_FOUND) {
        return reply_error(req, "404 Not Found", "no schedule with that id");
    }
    if (err == ESP_ERR_NO_MEM) {
        return reply_error(req, "400 Bad Request", "schedule limit reached");
    }
    if (err != ESP_OK) {
        return reply_error(req, "500 Internal Server Error", "failed to persist schedule");
    }

    return reply_json(req, schedule_to_json(&stored));
}

// --------------------------------------------------- DELETE /api/schedules/*

static esp_err_t handle_delete_schedule(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    char id[12];
    if (!http_uri_parse_str(req->uri, "/api/schedules/", id, sizeof(id))) {
        return reply_error(req, "400 Bad Request", "invalid schedule id in path");
    }

    esp_err_t err = schedule_exec_delete(id);
    if (err == ESP_ERR_NOT_FOUND) {
        return reply_error(req, "404 Not Found", "no schedule with that id");
    }
    if (err != ESP_OK) {
        return reply_error(req, "500 Internal Server Error", "failed to delete schedule");
    }

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "status", "deleted");
    return reply_json(req, root);
}

// --------------------------------------------------- POST /api/auth/password

static esp_err_t handle_post_auth_password(httpd_req_t *req)
{
    bool is_set = false;
    uint8_t stored[32];
    config_store_get_auth_hash(stored, &is_set);
    if (is_set && !http_auth_check(req)) {
        return ESP_OK; // http_auth_check already sent 401
    }

    char buf[192];
    esp_err_t rerr = read_body(req, buf, sizeof(buf));
    if (rerr == ESP_FAIL) {
        return ESP_FAIL;
    }
    if (rerr != ESP_OK) {
        return reply_error(req, "400 Bad Request", "body too large");
    }

    cJSON *root = cJSON_Parse(buf);
    const cJSON *pw = root ? cJSON_GetObjectItem(root, "password") : NULL;
    if (!cJSON_IsString(pw) || strlen(pw->valuestring) == 0 || strlen(pw->valuestring) > 128) {
        if (root) {
            cJSON_Delete(root);
        }
        return reply_error(req, "400 Bad Request", "expected {\"password\":\"...\"} (1-128 chars)");
    }

    unsigned char hash[32];
    mbedtls_sha256((const unsigned char *)pw->valuestring, strlen(pw->valuestring), hash, 0);
    cJSON_Delete(root);

    esp_err_t err = config_store_set_auth_hash(hash);
    if (err != ESP_OK) {
        return reply_error(req, "500 Internal Server Error", "failed to persist password");
    }

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddStringToObject(resp, "status", "ok");
    return reply_json(req, resp);
}

// ----------------------------------------------------------- POST /api/timezone

static esp_err_t handle_post_timezone(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    char buf[64];
    esp_err_t rerr = read_body(req, buf, sizeof(buf));
    if (rerr == ESP_FAIL) {
        return ESP_FAIL;
    }
    if (rerr != ESP_OK) {
        return reply_error(req, "400 Bad Request", "body too large");
    }

    cJSON *root = cJSON_Parse(buf);
    const cJSON *v = root ? cJSON_GetObjectItem(root, "utc_offset_min") : NULL;
    if (!cJSON_IsNumber(v) || v->valueint < -720 || v->valueint > 840) {
        if (root) {
            cJSON_Delete(root);
        }
        return reply_error(req, "400 Bad Request", "expected {\"utc_offset_min\": -720..840}");
    }
    int16_t offset_min = (int16_t)v->valueint;
    cJSON_Delete(root);

    esp_err_t err = config_store_set_utc_offset(offset_min);
    if (err != ESP_OK) {
        return reply_error(req, "500 Internal Server Error", "failed to persist timezone offset");
    }

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddNumberToObject(resp, "utc_offset_min", offset_min);
    return reply_json(req, resp);
}

// ---------------------------------------------------------------- POST /api/network

// {"mode":"static", "ip":..., "gateway":..., "subnet":..., "dns":...} or
// {"mode":"dhcp"}. Persists via config_store, then reboots (like OTA) so
// provisioning.c applies it cleanly at the next connect — see docs/plan.md.
// Solves the "device is hard to rediscover via mDNS" flakiness by letting
// the app remember a fixed address instead of relying on rediscovery at all.
static esp_err_t handle_post_network(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    char buf[192];
    esp_err_t rerr = read_body(req, buf, sizeof(buf));
    if (rerr == ESP_FAIL) {
        return ESP_FAIL;
    }
    if (rerr != ESP_OK) {
        return reply_error(req, "400 Bad Request", "body too large");
    }

    cJSON *root = cJSON_Parse(buf);
    const cJSON *mode = root ? cJSON_GetObjectItem(root, "mode") : NULL;
    if (!cJSON_IsString(mode) ||
        (strcmp(mode->valuestring, "static") != 0 && strcmp(mode->valuestring, "dhcp") != 0)) {
        if (root) {
            cJSON_Delete(root);
        }
        return reply_error(req, "400 Bad Request", "expected {\"mode\":\"static\"|\"dhcp\", ...}");
    }

    esp_err_t err;
    if (strcmp(mode->valuestring, "dhcp") == 0) {
        err = config_store_set_static_ip(false, NULL, NULL, NULL, NULL);
    } else {
        const cJSON *ip = cJSON_GetObjectItem(root, "ip");
        const cJSON *gateway = cJSON_GetObjectItem(root, "gateway");
        const cJSON *subnet = cJSON_GetObjectItem(root, "subnet");
        const cJSON *dns = cJSON_GetObjectItem(root, "dns");
        if (!cJSON_IsString(ip) || !cJSON_IsString(gateway) || !cJSON_IsString(subnet)) {
            cJSON_Delete(root);
            return reply_error(req, "400 Bad Request",
                                "static mode requires \"ip\", \"gateway\", \"subnet\"");
        }
        err = config_store_set_static_ip(true, ip->valuestring, gateway->valuestring,
                                          subnet->valuestring, cJSON_IsString(dns) ? dns->valuestring : NULL);
    }
    cJSON_Delete(root);

    if (err != ESP_OK) {
        return reply_error(req, "500 Internal Server Error", "failed to persist network config");
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":true,\"rebooting\":true}");

    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK; // unreachable
}

// ----------------------------------------------------------- POST /api/settings

// POST /api/settings — {"interlock_enabled"?: bool, "latitude"?: number, "longitude"?: number}
static esp_err_t handle_post_settings(httpd_req_t *req)
{
    if (!http_auth_check(req)) { return ESP_OK; }
    char buf[192];
    esp_err_t rerr = read_body(req, buf, sizeof(buf));
    if (rerr == ESP_FAIL) { return ESP_FAIL; }
    if (rerr != ESP_OK) { return reply_error(req, "400 Bad Request", "body too large"); }

    cJSON *root = cJSON_Parse(buf);
    if (root == NULL) { return reply_error(req, "400 Bad Request", "invalid JSON"); }

    const cJSON *interlock = cJSON_GetObjectItem(root, "interlock_enabled");
    const cJSON *lat = cJSON_GetObjectItem(root, "latitude");
    const cJSON *lon = cJSON_GetObjectItem(root, "longitude");

    bool have_lat = cJSON_IsNumber(lat), have_lon = cJSON_IsNumber(lon);
    if (have_lat != have_lon) {
        cJSON_Delete(root);
        return reply_error(req, "400 Bad Request", "latitude and longitude must be set together");
    }
    if (have_lat && (lat->valuedouble < -90.0 || lat->valuedouble > 90.0 ||
                      lon->valuedouble < -180.0 || lon->valuedouble > 180.0)) {
        cJSON_Delete(root);
        return reply_error(req, "400 Bad Request", "latitude/longitude out of range");
    }
    if (!cJSON_IsBool(interlock) && !have_lat) {
        cJSON_Delete(root);
        return reply_error(req, "400 Bad Request", "no recognized fields");
    }

    if (cJSON_IsBool(interlock)) {
        esp_err_t err = config_store_set_interlock(cJSON_IsTrue(interlock));
        if (err != ESP_OK) { cJSON_Delete(root); return reply_error(req, "500 Internal Server Error", "failed to persist interlock setting"); }
    }
    if (have_lat) {
        esp_err_t err = config_store_set_location(lat->valuedouble, lon->valuedouble);
        if (err != ESP_OK) { cJSON_Delete(root); return reply_error(req, "500 Internal Server Error", "failed to persist location"); }
    }
    cJSON_Delete(root);

    ss_config_t cfg;
    config_store_get(&cfg);
    cJSON *resp = cJSON_CreateObject();
    cJSON_AddBoolToObject(resp, "interlock_enabled", cfg.interlock_enabled);
    cJSON_AddNumberToObject(resp, "latitude", cfg.latitude);
    cJSON_AddNumberToObject(resp, "longitude", cfg.longitude);
    cJSON_AddBoolToObject(resp, "location_set", cfg.location_set);
    return reply_json(req, resp);
}

// ------------------------------------------------------------------ startup

esp_err_t http_api_start(void)
{
    if (s_server != NULL) {
        return ESP_OK;
    }

    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 15; // 12 here + /api/wifi, /api/ota (wifi_reconfig/ota components) + headroom
    config.stack_size = 8192;     // cJSON + mbedtls (base64/sha256) stack frames on the auth path
    config.uri_match_fn = httpd_uri_match_wildcard;
    // Without this, a handful of slow/idle LAN clients can occupy every
    // worker/socket slot indefinitely and the server refuses all new
    // connections — including cloud_client's own 127.0.0.1 loopback calls,
    // which implement every cloud-relayed command. Evict the
    // least-recently-used connection instead of refusing a new one.
    config.lru_purge_enable = true;
    // config.recv_wait_timeout defaults to 5s (HTTPD_DEFAULT_CONFIG) already
    // tight enough — left unchanged.

    esp_err_t err = httpd_start(&s_server, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed: %s", esp_err_to_name(err));
        return err;
    }

    static const httpd_uri_t handlers[] = {
        {.uri = "/api/info", .method = HTTP_GET, .handler = handle_get_info},
        {.uri = "/api/config", .method = HTTP_GET, .handler = handle_get_config},
        {.uri = "/api/switches", .method = HTTP_POST, .handler = handle_post_switches},
        {.uri = "/api/switches/*", .method = HTTP_DELETE, .handler = handle_delete_switch},
        {.uri = "/api/channels", .method = HTTP_GET, .handler = handle_get_channels},
        {.uri = "/api/channels/*", .method = HTTP_POST, .handler = handle_post_channel_state},
        {.uri = "/api/schedules", .method = HTTP_POST, .handler = handle_post_schedules},
        {.uri = "/api/schedules/*", .method = HTTP_DELETE, .handler = handle_delete_schedule},
        {.uri = "/api/auth/password", .method = HTTP_POST, .handler = handle_post_auth_password},
        {.uri = "/api/timezone", .method = HTTP_POST, .handler = handle_post_timezone},
        {.uri = "/api/network", .method = HTTP_POST, .handler = handle_post_network},
        {.uri = "/api/settings", .method = HTTP_POST, .handler = handle_post_settings},
    };

    for (size_t i = 0; i < sizeof(handlers) / sizeof(handlers[0]); i++) {
        ESP_ERROR_CHECK(httpd_register_uri_handler(s_server, &handlers[i]));
    }

    ESP_LOGI(TAG, "http_api started, %d handlers registered", (int)(sizeof(handlers) / sizeof(handlers[0])));
    return ESP_OK;
}

esp_err_t http_api_stop(void)
{
    if (s_server == NULL) {
        return ESP_OK;
    }
    esp_err_t err = httpd_stop(s_server);
    s_server = NULL;
    return err;
}

httpd_handle_t http_api_get_server_handle(void)
{
    return s_server;
}
