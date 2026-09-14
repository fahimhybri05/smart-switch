#pragma once

#include <stdbool.h>
#include "esp_http_server.h"

// Returns true if the request is authorized. On false, has already sent a
// response — either 401 + WWW-Authenticate (bad/missing credentials), or
// 429 + Retry-After if too many consecutive failures triggered a lockout
// window (escalating backoff, global + RAM-only — see http_auth.c) —
// caller should just `return ESP_OK` either way. Always returns true if no
// password has been configured yet (fresh/unclaimed device) — see spec §9,
// device-set password configured during provisioning.
bool http_auth_check(httpd_req_t *req);
