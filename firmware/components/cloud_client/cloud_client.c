#include "cloud_client.h"

#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "config_store.h"
#include "provisioning.h"
#include "relay_hal.h"

static const char *TAG = "cloud_client";

#define HTTP_RESP_BUF_SIZE 4096
#define HTTP_LOOPBACK_TIMEOUT_MS 5000

static esp_websocket_client_handle_t s_client = NULL;
static volatile bool s_connected = false;

// ------------------------------------------------------- loopback HTTP proxy

typedef struct {
    char  *buf;
    size_t cap;
    size_t len;
} http_resp_buf_t;

static esp_err_t http_event_handler(esp_http_client_event_t *evt)
{
    if (evt->event_id == HTTP_EVENT_ON_DATA) {
        http_resp_buf_t *rb = (http_resp_buf_t *)evt->user_data;
        if (rb != NULL && rb->len + evt->data_len < rb->cap) {
            memcpy(rb->buf + rb->len, evt->data, evt->data_len);
            rb->len += evt->data_len;
            rb->buf[rb->len] = '\0';
        }
    }
    return ESP_OK;
}

// Proxies one relayed {reqId, method, path, body} command to the device's
// own already-running local HTTP server (http_api_start(), main.c) and
// sends the real response back up the cloud tunnel as {reqId, status, body}.
// No handler logic is duplicated — see docs/plan.md.
static void proxy_and_reply(const char *req_id, const char *method, const char *path, const cJSON *body)
{
    char url[160];
    snprintf(url, sizeof(url), "http://127.0.0.1%s", path);

    esp_http_client_method_t http_method;
    if (strcmp(method, "GET") == 0) {
        http_method = HTTP_METHOD_GET;
    } else if (strcmp(method, "POST") == 0) {
        http_method = HTTP_METHOD_POST;
    } else if (strcmp(method, "DELETE") == 0) {
        http_method = HTTP_METHOD_DELETE;
    } else {
        ESP_LOGW(TAG, "unsupported relayed method: %s", method);
        return;
    }

    http_resp_buf_t rb = {
        .buf = malloc(HTTP_RESP_BUF_SIZE),
        .cap = HTTP_RESP_BUF_SIZE,
        .len = 0,
    };
    if (rb.buf == NULL) {
        return;
    }
    rb.buf[0] = '\0';

    esp_http_client_config_t config = {
        .url = url,
        .method = http_method,
        .timeout_ms = HTTP_LOOPBACK_TIMEOUT_MS,
        .event_handler = http_event_handler,
        .user_data = &rb,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);

    char *body_str = NULL;
    if (body != NULL && !cJSON_IsNull(body)) {
        body_str = cJSON_PrintUnformatted(body);
        if (body_str != NULL) {
            esp_http_client_set_header(client, "Content-Type", "application/json");
            esp_http_client_set_post_field(client, body_str, strlen(body_str));
        }
    }

    int status = 0;
    if (esp_http_client_perform(client) == ESP_OK) {
        status = esp_http_client_get_status_code(client);
    }
    esp_http_client_cleanup(client);
    free(body_str);

    cJSON *resp_body = rb.len > 0 ? cJSON_Parse(rb.buf) : NULL;
    free(rb.buf);

    cJSON *reply = cJSON_CreateObject();
    cJSON_AddStringToObject(reply, "reqId", req_id);
    cJSON_AddNumberToObject(reply, "status", status);
    cJSON_AddItemToObject(reply, "body", resp_body != NULL ? resp_body : cJSON_CreateNull());

    char *reply_str = cJSON_PrintUnformatted(reply);
    cJSON_Delete(reply);
    if (reply_str != NULL && s_client != NULL) {
        esp_websocket_client_send_text(s_client, reply_str, strlen(reply_str), pdMS_TO_TICKS(2000));
    }
    free(reply_str);
}

// ------------------------------------------------------------ WS lifecycle

static void send_auth_frame(void)
{
    ss_config_t cfg;
    config_store_get(&cfg);

    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "deviceId", cfg.device_id);
    cJSON_AddStringToObject(root, "cloudSecret", cfg.cloud_secret);
    char *str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (str != NULL) {
        esp_websocket_client_send_text(s_client, str, strlen(str), pdMS_TO_TICKS(2000));
        free(str);
    }
}

// On (re)connect, republish every channel's current state so the cloud's
// cached view resyncs even if changes happened while offline (spec §18 —
// physical-switch/offline-schedule state must reach the app once cloud
// connectivity returns).
static void publish_full_state(void)
{
    ss_config_t cfg;
    config_store_get(&cfg);
    for (uint8_t i = 0; i < cfg.switch_count; i++) {
        bool on = false;
        if (relay_hal_get_state(cfg.switches[i].channel_idx, &on) == ESP_OK) {
            cloud_client_notify_state_changed(cfg.switches[i].channel_idx, on);
        }
    }
}

static void handle_incoming_frame(const char *data, size_t len)
{
    cJSON *root = cJSON_ParseWithLength(data, len);
    if (root == NULL) {
        return;
    }

    const cJSON *req_id = cJSON_GetObjectItem(root, "reqId");
    const cJSON *method = cJSON_GetObjectItem(root, "method");
    const cJSON *path = cJSON_GetObjectItem(root, "path");
    if (cJSON_IsString(req_id) && cJSON_IsString(method) && cJSON_IsString(path)) {
        proxy_and_reply(req_id->valuestring, method->valuestring, path->valuestring,
                         cJSON_GetObjectItem(root, "body"));
    }

    cJSON_Delete(root);
}

static void websocket_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "connected to cloud");
        s_connected = true;
        send_auth_frame();
        publish_full_state();
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_ERROR:
        s_connected = false;
        break;
    case WEBSOCKET_EVENT_DATA:
        // Text/control frames only — ignore anything but a complete text
        // frame (fragmented-delivery reassembly isn't needed for the small
        // control-plane JSON this tunnel carries).
        if (data->op_code == 0x1 && data->payload_len == data->data_len) {
            handle_incoming_frame(data->data_ptr, data->data_len);
        }
        break;
    default:
        break;
    }
}

static void cloud_client_task(void *arg)
{
    provisioning_wait_wifi_ready(portMAX_DELAY);

    esp_websocket_client_config_t ws_cfg = {
        .uri = CONFIG_SS_CLOUD_WS_URL,
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms = 10000,
    };
    s_client = esp_websocket_client_init(&ws_cfg);
    esp_websocket_register_events(s_client, WEBSOCKET_EVENT_ANY, websocket_event_handler, NULL);
    esp_websocket_client_start(s_client);

    // The library's own background task owns the connection/reconnect loop
    // from here on (auto-reconnect enabled by default) — this task just
    // needs to stay alive as the handle's owner.
    vTaskDelete(NULL);
}

esp_err_t cloud_client_init(void)
{
    BaseType_t ok = xTaskCreate(cloud_client_task, "cloud_client", 6144, NULL, tskIDLE_PRIORITY + 3, NULL);
    return ok == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

void cloud_client_notify_state_changed(uint8_t channel_idx, bool on)
{
    if (!s_connected || s_client == NULL) {
        return;
    }
    cJSON *root = cJSON_CreateObject();
    cJSON_AddStringToObject(root, "event", "state_changed");
    cJSON_AddNumberToObject(root, "channelIdx", channel_idx);
    cJSON_AddStringToObject(root, "state", on ? "ON" : "OFF");
    char *str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (str != NULL) {
        // Non-blocking best-effort — this is called from hot paths
        // (http_api's channel-state handler, schedule_exec's fire()); a
        // slow/stalled tunnel must never stall a relay toggle.
        esp_websocket_client_send_text(s_client, str, strlen(str), 0);
        free(str);
    }
}
