#include "ota.h"

#include <string.h>

#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "mbedtls/sha256.h"

#include "http_auth.h"
#include "provisioning.h"

static const char *TAG = "ota";

extern const uint8_t ota_pubkey_pem_start[] asm("_binary_ota_pubkey_pem_start");
extern const uint8_t ota_pubkey_pem_end[] asm("_binary_ota_pubkey_pem_end");

static bool s_pending_verify = false;

struct ota_session_s {
    const esp_partition_t *partition;
    esp_ota_handle_t handle;
    mbedtls_sha256_context sha_ctx;
    bool active;
};

static struct ota_session_s s_session;
static bool s_session_active = false;

esp_err_t ota_init(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
        s_pending_verify = true;
        ESP_LOGW(TAG, "running image is pending verification (post-OTA first boot)");
    }
    return ESP_OK;
}

void ota_confirm_if_healthy(TickType_t timeout_ticks)
{
    if (!s_pending_verify) {
        return; // fast no-op — the overwhelming common case, every normal boot
    }

    ESP_LOGI(TAG, "waiting for WiFi to confirm this post-OTA boot is healthy");
    if (provisioning_wait_wifi_ready(timeout_ticks)) {
        esp_ota_mark_app_valid_cancel_rollback();
        s_pending_verify = false;
        ESP_LOGI(TAG, "post-OTA boot confirmed healthy");
    } else {
        ESP_LOGE(TAG, "post-OTA boot could not reach WiFi in time — forcing rollback to previous slot");
        esp_ota_mark_app_invalid_rollback_and_reboot(); // does not return
    }
}

esp_err_t ota_apply_update_begin(size_t image_size_hint, ota_session_handle_t *out_handle)
{
    if (s_session_active) {
        return ESP_ERR_INVALID_STATE;
    }

    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t running_state;
    if (esp_ota_get_state_partition(running, &running_state) == ESP_OK &&
        running_state == ESP_OTA_IMG_PENDING_VERIFY) {
        // esp_ota_begin() would refuse this anyway — surfaced early with a
        // clearer error for the caller to map to HTTP 409.
        return ESP_ERR_OTA_ROLLBACK_INVALID_STATE;
    }

    const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
    if (update_partition == NULL) {
        return ESP_FAIL;
    }

    if (image_size_hint != 0 && image_size_hint != OTA_SIZE_UNKNOWN && image_size_hint > update_partition->size) {
        return ESP_ERR_INVALID_SIZE;
    }

    esp_ota_handle_t handle;
    esp_err_t err = esp_ota_begin(update_partition, OTA_WITH_SEQUENTIAL_WRITES, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin failed: %s", esp_err_to_name(err));
        return err;
    }

    s_session.partition = update_partition;
    s_session.handle = handle;
    mbedtls_sha256_init(&s_session.sha_ctx);
    mbedtls_sha256_starts(&s_session.sha_ctx, 0);
    s_session.active = true;
    s_session_active = true;

    *out_handle = &s_session;
    ESP_LOGI(TAG, "OTA update started, target partition '%s'", update_partition->label);
    return ESP_OK;
}

esp_err_t ota_apply_update_write(ota_session_handle_t handle, const void *data, size_t len)
{
    if (handle != &s_session || !s_session.active) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = esp_ota_write(s_session.handle, data, len);
    if (err != ESP_OK) {
        return err;
    }
    mbedtls_sha256_update(&s_session.sha_ctx, data, len);
    return ESP_OK;
}

esp_err_t ota_apply_update_finish(ota_session_handle_t handle, const char *base64_signature)
{
    if (handle != &s_session || !s_session.active) {
        return ESP_ERR_INVALID_STATE;
    }

    unsigned char digest[32];
    mbedtls_sha256_finish(&s_session.sha_ctx, digest);
    mbedtls_sha256_free(&s_session.sha_ctx);

    esp_err_t err = esp_ota_end(s_session.handle);
    s_session.active = false;
    s_session_active = false;
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end failed (image invalid): %s", esp_err_to_name(err));
        return err;
    }

    unsigned char sig[128];
    size_t sig_len = 0;
    if (mbedtls_base64_decode(sig, sizeof(sig), &sig_len,
                               (const unsigned char *)base64_signature, strlen(base64_signature)) != 0) {
        ESP_LOGE(TAG, "OTA signature header failed to base64-decode");
        return ESP_ERR_INVALID_CRC;
    }

    mbedtls_pk_context pk;
    mbedtls_pk_init(&pk);
    int rc = mbedtls_pk_parse_public_key(&pk, ota_pubkey_pem_start,
                                          (size_t)(ota_pubkey_pem_end - ota_pubkey_pem_start));
    if (rc != 0) {
        ESP_LOGE(TAG, "failed to parse embedded OTA public key (rc=-0x%04x)", -rc);
        mbedtls_pk_free(&pk);
        return ESP_FAIL;
    }

    rc = mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, sizeof(digest), sig, sig_len);
    mbedtls_pk_free(&pk);
    if (rc != 0) {
        ESP_LOGE(TAG, "OTA signature verification FAILED (rc=-0x%04x) — partition not marked bootable", -rc);
        return ESP_ERR_INVALID_CRC;
    }

    err = esp_ota_set_boot_partition(s_session.partition);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_set_boot_partition failed: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "OTA update verified and set as next boot partition");
    return ESP_OK;
}

esp_err_t ota_apply_update_abort(ota_session_handle_t handle)
{
    if (handle != &s_session || !s_session.active) {
        return ESP_ERR_INVALID_STATE;
    }
    mbedtls_sha256_free(&s_session.sha_ctx);
    esp_ota_abort(s_session.handle);
    s_session.active = false;
    s_session_active = false;
    return ESP_OK;
}

// ------------------------------------------------------------ HTTP handler

static esp_err_t handle_post_ota(httpd_req_t *req)
{
    if (!http_auth_check(req)) {
        return ESP_OK;
    }

    size_t sig_hdr_len = httpd_req_get_hdr_value_len(req, "X-Firmware-Signature");
    if (sig_hdr_len == 0 || sig_hdr_len > 200) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"missing/invalid X-Firmware-Signature header\"}");
        return ESP_OK;
    }
    char sig[201];
    if (httpd_req_get_hdr_value_str(req, "X-Firmware-Signature", sig, sizeof(sig)) != ESP_OK) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"failed to read signature header\"}");
        return ESP_OK;
    }

    ota_session_handle_t session;
    esp_err_t err = ota_apply_update_begin((size_t)req->content_len, &session);
    if (err == ESP_ERR_OTA_ROLLBACK_INVALID_STATE) {
        httpd_resp_set_status(req, "409 Conflict");
        httpd_resp_sendstr(req, "{\"error\":\"device has not confirmed its current firmware yet\"}");
        return ESP_OK;
    }
    if (err == ESP_ERR_INVALID_SIZE) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"image too large for update partition\"}");
        return ESP_OK;
    }
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        httpd_resp_sendstr(req, "{\"error\":\"failed to begin OTA update\"}");
        return ESP_OK;
    }

    static uint8_t chunk[4096];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        size_t want = (size_t)req->content_len - received;
        if (want > sizeof(chunk)) {
            want = sizeof(chunk);
        }
        int ret = httpd_req_recv(req, (char *)chunk, want);
        if (ret <= 0) {
            ota_apply_update_abort(session);
            return ESP_FAIL;
        }
        err = ota_apply_update_write(session, chunk, (size_t)ret);
        if (err != ESP_OK) {
            ota_apply_update_abort(session);
            httpd_resp_set_status(req, "500 Internal Server Error");
            httpd_resp_sendstr(req, "{\"error\":\"flash write failed\"}");
            return ESP_OK;
        }
        received += (size_t)ret;
    }

    err = ota_apply_update_finish(session, sig);
    if (err == ESP_ERR_INVALID_CRC) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "{\"error\":\"signature verification failed\"}");
        return ESP_OK;
    }
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        httpd_resp_sendstr(req, "{\"error\":\"failed to finalize OTA update\"}");
        return ESP_OK;
    }

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"status\":\"ok\",\"rebooting\":true}");
    vTaskDelay(pdMS_TO_TICKS(500)); // let the response flush before rebooting
    esp_restart();
    return ESP_OK; // unreachable
}

esp_err_t ota_register_http_handlers(httpd_handle_t server)
{
    static const httpd_uri_t handler = {
        .uri = "/api/ota",
        .method = HTTP_POST,
        .handler = handle_post_ota,
    };
    return httpd_register_uri_handler(server, &handler);
}
