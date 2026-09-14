#include "http_auth.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "esp_timer.h"
#include "lwip/sockets.h"
#include "mbedtls/base64.h"
#include "mbedtls/constant_time.h"
#include "mbedtls/sha256.h"

#include "config_store.h"

// Global (not per-source-IP) and RAM-only (resets on reboot) — deliberate,
// see docs/plan.md §9. esp_http_server's default config runs a single
// worker task (http_api.c uses HTTPD_DEFAULT_CONFIG() unmodified), so
// handler dispatch is serialized and these statics are never touched
// concurrently.
#define LOCKOUT_THRESHOLD    5
#define LOCKOUT_BASE_S       30
#define LOCKOUT_MAX_S        300

static uint32_t s_consecutive_failures = 0;
static int64_t  s_lockout_until_us = 0;

static void send_401(httpd_req_t *req)
{
    httpd_resp_set_status(req, "401 Unauthorized");
    httpd_resp_set_hdr(req, "WWW-Authenticate", "Basic realm=\"smart-switch\"");
    httpd_resp_send(req, NULL, 0);
}

static void send_429(httpd_req_t *req, uint32_t retry_after_s)
{
    httpd_resp_set_status(req, "429 Too Many Requests");
    char hdr[16];
    snprintf(hdr, sizeof(hdr), "%" PRIu32, retry_after_s);
    httpd_resp_set_hdr(req, "Retry-After", hdr);
    httpd_resp_send(req, NULL, 0);
}

// Records one failed attempt, arming/escalating the lockout window once
// LOCKOUT_THRESHOLD consecutive failures have accumulated.
static void record_failure(void)
{
    s_consecutive_failures++;
    if (s_consecutive_failures >= LOCKOUT_THRESHOLD) {
        uint32_t shift = s_consecutive_failures - LOCKOUT_THRESHOLD;
        uint32_t backoff_s = LOCKOUT_BASE_S << (shift > 4 ? 4 : shift); // 30,60,120,240,480->cap
        if (backoff_s > LOCKOUT_MAX_S) {
            backoff_s = LOCKOUT_MAX_S;
        }
        s_lockout_until_us = esp_timer_get_time() + (int64_t)backoff_s * 1000000;
    }
}

// A request whose peer address is the loopback interface can only have
// originated from a process on this same device — external LAN traffic
// can never carry a spoofed 127.0.0.1 source and reach it (lwIP routes
// loopback-destined traffic only for genuinely local sockets). This is
// how cloud_client's relayed-command loopback proxy (http://127.0.0.1/...,
// see docs/plan.md) reaches password-protected endpoints without ever
// knowing the plaintext local password — cloud auth already happened at
// the WS tunnel layer (device_id + cloud_secret) before the loopback call
// is ever made.
static bool is_loopback_peer(httpd_req_t *req)
{
    int sockfd = httpd_req_to_sockfd(req);
    if (sockfd < 0) {
        return false;
    }
    struct sockaddr_storage addr;
    socklen_t addr_len = sizeof(addr);
    if (getpeername(sockfd, (struct sockaddr *)&addr, &addr_len) != 0) {
        return false;
    }
    if (addr.ss_family == AF_INET) {
        struct sockaddr_in *v4 = (struct sockaddr_in *)&addr;
        return v4->sin_addr.s_addr == PP_HTONL(INADDR_LOOPBACK);
    }
    if (addr.ss_family == AF_INET6) {
        struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)&addr;
        if (IN6_IS_ADDR_LOOPBACK(&v6->sin6_addr)) {
            return true;
        }
        // IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) — lwIP can present
        // an IPv4 connection this way depending on netconn config.
        if (IN6_IS_ADDR_V4MAPPED(&v6->sin6_addr)) {
            uint32_t v4 = v6->sin6_addr.un.u32_addr[3];
            return v4 == PP_HTONL(INADDR_LOOPBACK);
        }
    }
    return false;
}

bool http_auth_check(httpd_req_t *req)
{
    if (is_loopback_peer(req)) {
        return true;
    }

    bool is_set = false;
    uint8_t stored[32];
    config_store_get_auth_hash(stored, &is_set);
    if (!is_set) {
        return true; // fresh/unclaimed device — open until a password is configured
    }

    int64_t now = esp_timer_get_time();
    if (now < s_lockout_until_us) {
        uint32_t retry_after_s = (uint32_t)((s_lockout_until_us - now + 999999) / 1000000);
        send_429(req, retry_after_s);
        return false;
    }

    size_t hdr_len = httpd_req_get_hdr_value_len(req, "Authorization");
    if (hdr_len == 0 || hdr_len > 256) {
        record_failure();
        send_401(req);
        return false;
    }

    char hdr[257];
    if (httpd_req_get_hdr_value_str(req, "Authorization", hdr, sizeof(hdr)) != ESP_OK) {
        record_failure();
        send_401(req);
        return false;
    }

    static const char PREFIX[] = "Basic ";
    if (strncmp(hdr, PREFIX, sizeof(PREFIX) - 1) != 0) {
        record_failure();
        send_401(req);
        return false;
    }

    const char *b64 = hdr + sizeof(PREFIX) - 1;
    unsigned char decoded[192];
    size_t decoded_len = 0;
    if (mbedtls_base64_decode(decoded, sizeof(decoded) - 1, &decoded_len,
                               (const unsigned char *)b64, strlen(b64)) != 0) {
        record_failure();
        send_401(req);
        return false;
    }
    decoded[decoded_len] = '\0';

    char *colon = strchr((char *)decoded, ':');
    if (colon == NULL) {
        record_failure();
        send_401(req);
        return false;
    }
    const char *password = colon + 1;

    unsigned char computed[32];
    mbedtls_sha256((const unsigned char *)password, strlen(password), computed, 0);

    if (mbedtls_ct_memcmp(computed, stored, 32) != 0) {
        record_failure();
        send_401(req);
        return false;
    }

    s_consecutive_failures = 0;
    s_lockout_until_us = 0;
    return true;
}
