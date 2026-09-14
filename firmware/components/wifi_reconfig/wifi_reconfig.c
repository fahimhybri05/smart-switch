#include "wifi_reconfig.h"

#include <string.h>

#include "cJSON.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

#include "http_auth.h"
#include "provisioning.h"

static const char *TAG = "wifi_reconfig";

#define TEST_CONNECTED_BIT BIT0
#define TEST_DISCONNECTED_BIT BIT1
#define TEST_TIMEOUT_MS 20000
#define DEFER_MS 700 // gives the HTTP 202 ack time to round-trip before the radio drops

static wifi_config_t s_cached_sta_config;
static wifi_config_t s_candidate_sta_config;
static wifi_reconfig_state_t s_state = WIFI_RECONFIG_STATE_IDLE;
static EventGroupHandle_t s_test_event_group;
static esp_timer_handle_t s_defer_timer;
static TaskHandle_t s_worker_task;
static volatile bool s_test_armed = false;

// Own, independent handler instance (separate from provisioning.c's) — both
// are registered on the same default event loop, IDF dispatches to both.
// Only reacts while s_test_armed, so the pre-test esp_wifi_disconnect()
// call's own DISCONNECTED event isn't mistaken for "candidate connect failed".
static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (!s_test_armed) {
        return;
    }
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupSetBits(s_test_event_group, TEST_DISCONNECTED_BIT);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_test_event_group, TEST_CONNECTED_BIT);
    }
}

static void worker_task(void *arg)
{
    (void)arg;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

        provisioning_set_auto_reconnect_suspended(true);
        esp_wifi_set_storage(WIFI_STORAGE_RAM);
        esp_wifi_disconnect();
        esp_wifi_set_config(WIFI_IF_STA, &s_candidate_sta_config);

        xEventGroupClearBits(s_test_event_group, TEST_CONNECTED_BIT | TEST_DISCONNECTED_BIT);
        s_test_armed = true;
        esp_wifi_connect();

        EventBits_t bits = xEventGroupWaitBits(s_test_event_group, TEST_CONNECTED_BIT | TEST_DISCONNECTED_BIT,
                                                pdTRUE, pdFALSE, pdMS_TO_TICKS(TEST_TIMEOUT_MS));
        s_test_armed = false;

        if (bits & TEST_CONNECTED_BIT) {
            esp_wifi_set_storage(WIFI_STORAGE_FLASH);
            esp_wifi_set_config(WIFI_IF_STA, &s_candidate_sta_config); // re-set now that storage=FLASH, to persist
            s_state = WIFI_RECONFIG_STATE_CONNECTED;
            ESP_LOGI(TAG, "reconfig test succeeded, new credentials persisted");
        } else {
            esp_wifi_disconnect();
            esp_wifi_set_storage(WIFI_STORAGE_FLASH);
            esp_wifi_set_config(WIFI_IF_STA, &s_cached_sta_config);
            esp_wifi_connect();
            s_state = WIFI_RECONFIG_STATE_FAILED_ROLLED_BACK;
            ESP_LOGW(TAG, "reconfig test failed/timed out, rolled back to previous credentials");
        }

        provisioning_set_auto_reconnect_suspended(false);
    }
}

static void defer_timer_cb(void *arg)
{
    (void)arg;
    xTaskNotifyGive(s_worker_task); // callback runs on IDF's shared esp_timer task — must stay
                                     // trivial; the actual up-to-20s wait happens on our own task
                                     // so it never stalls other timers (e.g. schedule_exec's).
}

esp_err_t wifi_reconfig_init(void)
{
    s_test_event_group = xEventGroupCreate();
    if (s_test_event_group == NULL) {
        return ESP_ERR_NO_MEM;
    }

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &on_wifi_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &on_wifi_event, NULL));

    BaseType_t created = xTaskCreate(worker_task, "wifi_reconfig_wrk", 4096, NULL, tskIDLE_PRIORITY + 2, &s_worker_task);
    if (created != pdPASS) {
        return ESP_ERR_NO_MEM;
    }

    esp_timer_create_args_t timer_args = {
        .callback = defer_timer_cb,
        .name = "wifi_reconfig_defer",
    };
    return esp_timer_create(&timer_args, &s_defer_timer);
}

esp_err_t wifi_reconfig_request(const char *ssid, const char *password)
{
    size_t ssid_len = strlen(ssid);
    if (ssid_len < 1 || ssid_len > 32) {
        return ESP_ERR_INVALID_ARG;
    }
    size_t pw_len = strlen(password);
    if (pw_len != 0 && (pw_len < 8 || pw_len > 63)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (s_state == WIFI_RECONFIG_STATE_TESTING) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_wifi_get_config(WIFI_IF_STA, &s_cached_sta_config);

    memset(&s_candidate_sta_config, 0, sizeof(s_candidate_sta_config));
    snprintf((char *)s_candidate_sta_config.sta.ssid, sizeof(s_candidate_sta_config.sta.ssid), "%s", ssid);
    snprintf((char *)s_candidate_sta_config.sta.password, sizeof(s_candidate_sta_config.sta.password), "%s", password);

    s_state = WIFI_RECONFIG_STATE_TESTING;
    return esp_timer_start_once(s_defer_timer, DEFER_MS * 1000ULL);
}

wifi_reconfig_state_t wifi_reconfig_get_state(void)
{
    return s_state;
}

// ------------------------------------------------------------ HTTP handler

static esp_err_t handle_post_wifi(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    if ((size_t)req->content_len >= 192) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"body too large\"}");
        return ESP_OK;
    }

    char buf[192];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int ret = httpd_req_recv(req, buf + received, req->content_len - received);
        if (ret <= 0) {
            return ESP_FAIL;
        }
        received += (size_t)ret;
    }
    buf[received] = '\0';

    cJSON *root = cJSON_Parse(buf);
    const cJSON *ssid = root ? cJSON_GetObjectItem(root, "ssid") : NULL;
    const cJSON *password = root ? cJSON_GetObjectItem(root, "password") : NULL;
    if (!cJSON_IsString(ssid) || (password != NULL && !cJSON_IsString(password))) {
        if (root) {
            cJSON_Delete(root);
        }
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"expected {\\\"ssid\\\":\\\"...\\\",\\\"password\\\":\\\"...\\\"}\"}");
        return ESP_OK;
    }

    esp_err_t err = wifi_reconfig_request(ssid->valuestring, password ? password->valuestring : "");
    cJSON_Delete(root);

    if (err == ESP_ERR_INVALID_ARG) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"invalid ssid/password length\"}");
        return ESP_OK;
    }
    if (err == ESP_ERR_INVALID_STATE) {
        httpd_resp_set_status(req, "409 Conflict");
        httpd_resp_sendstr(req, "{\"error\":\"a reconfig test is already in progress\"}");
        return ESP_OK;
    }
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        httpd_resp_sendstr(req, "{\"error\":\"failed to start reconfig test\"}");
        return ESP_OK;
    }

    // 202: the test/rollback runs async — see DEVIATION #1, a synchronous
    // CONNECTED/FAILED_ROLLED_BACK response is not deliverable on a
    // single-radio ESP32. App learns the outcome via GET /api/info polling.
    httpd_resp_set_status(req, "202 Accepted");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"state\":\"TESTING\"}");
    return ESP_OK;
}

esp_err_t wifi_reconfig_register_http_handlers(httpd_handle_t server)
{
    static const httpd_uri_t handler = {
        .uri = "/api/wifi",
        .method = HTTP_POST,
        .handler = handle_post_wifi,
    };
    return httpd_register_uri_handler(server, &handler);
}
