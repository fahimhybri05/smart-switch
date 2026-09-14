#pragma once

#include <stddef.h>
#include "esp_err.h"
#include "esp_http_server.h"
#include "freertos/FreeRTOS.h"

typedef struct ota_session_s *ota_session_handle_t;

// Cheap, non-blocking: inspects the running partition's OTA state. Call
// once, early in app_main() (right after esp_event_loop_create_default()).
esp_err_t ota_init(void);

// FAST PATH: if the running image was not PENDING_VERIFY (the overwhelming
// common case — every normal boot), returns immediately, no wait, no
// blocking. SLOW PATH (only on the first boot of a freshly-OTA'd image):
// blocks up to timeout_ticks waiting for WiFi (provisioning_wait_wifi_ready)
// then confirms (esp_ota_mark_app_valid_cancel_rollback), or — if the
// timeout elapses first — forces a rollback+reboot to the previous slot
// (esp_ota_mark_app_invalid_rollback_and_reboot, does not return) so a bad
// OTA push self-heals without needing physical access (spec §10).
void ota_confirm_if_healthy(TickType_t timeout_ticks);

// http_api's POST /api/ota handler calls this once, before reading the
// body. Pass req->content_len as image_size_hint (0 if unavailable).
// Returns ESP_ERR_OTA_ROLLBACK_INVALID_STATE if the currently RUNNING app
// itself is still unconfirmed (map to HTTP 409) — esp_ota_begin() enforces
// this by design, a device must confirm its current firmware works before
// accepting another update.
esp_err_t ota_apply_update_begin(size_t image_size_hint, ota_session_handle_t *out_handle);

// Call once per httpd_req_recv() chunk — streams straight to flash and
// accumulates SHA-256 over the same bytes, no second flash read-back pass.
esp_err_t ota_apply_update_write(ota_session_handle_t handle, const void *data, size_t len);

// Call once after the full body has been streamed. base64_signature is the
// raw value of the X-Firmware-Signature request header. Verifies a detached
// ECDSA-P256 signature over the accumulated SHA-256 against the embedded
// pubkey BEFORE marking the partition bootable — a bad signature never
// becomes bootable (returns ESP_ERR_INVALID_CRC, map to HTTP 400). On
// ESP_OK the caller should respond 200 and THEN call esp_restart() itself
// (left to the caller so the HTTP response can flush first).
esp_err_t ota_apply_update_finish(ota_session_handle_t handle, const char *base64_signature);

// For client disconnects / truncated uploads mid-stream.
esp_err_t ota_apply_update_abort(ota_session_handle_t handle);

// Registers POST /api/ota onto an already-started http_api server instance
// (see http_api_get_server_handle()). Call once from main.c after both
// ota_init() and http_api_start() have succeeded.
esp_err_t ota_register_http_handlers(httpd_handle_t server);
