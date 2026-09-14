#include "http_auth.h"

#include <bearssl/bearssl.h>
#include <libb64/cdecode.h>

#include "config_store.h"

#define LOCKOUT_THRESHOLD 5
#define LOCKOUT_BASE_S 30
#define LOCKOUT_MAX_S 300

static uint32_t s_consecutiveFailures = 0;
static unsigned long s_lockoutUntilMs = 0;

static void send401(ESP8266WebServer &server) {
  server.sendHeader("WWW-Authenticate", "Basic realm=\"smart-switch\"");
  server.send(401, "text/plain", "");
}

static void send429(ESP8266WebServer &server, uint32_t retryAfterS) {
  server.sendHeader("Retry-After", String(retryAfterS));
  server.send(429, "text/plain", "");
}

static void recordFailure() {
  s_consecutiveFailures++;
  if (s_consecutiveFailures >= LOCKOUT_THRESHOLD) {
    uint32_t shift = s_consecutiveFailures - LOCKOUT_THRESHOLD;
    uint32_t backoffS = LOCKOUT_BASE_S << (shift > 4 ? 4 : shift);
    if (backoffS > LOCKOUT_MAX_S) backoffS = LOCKOUT_MAX_S;
    s_lockoutUntilMs = millis() + backoffS * 1000UL;
  }
}

static bool constantTimeEqual(const uint8_t *a, const uint8_t *b, size_t len) {
  uint8_t diff = 0;
  for (size_t i = 0; i < len; i++) diff |= a[i] ^ b[i];
  return diff == 0;
}

bool httpAuthCheck(ESP8266WebServer &server) {
  // A connection whose peer is the loopback interface can only have
  // originated from this same device (cloud_client's loopback proxy call,
  // see cloud_client.cpp) — external traffic can never carry a spoofed
  // 127.0.0.1 source. Cloud auth already happened at the WS tunnel layer.
  if (server.client().remoteIP() == IPAddress(127, 0, 0, 1)) {
    return true;
  }

  if (!configStore.cfg().auth_password_set) {
    return true; // fresh/unclaimed device — open until a password is set
  }

  unsigned long now = millis();
  if ((long)(s_lockoutUntilMs - now) > 0) {
    send429(server, (s_lockoutUntilMs - now + 999) / 1000);
    return false;
  }

  if (!server.hasHeader("Authorization")) {
    recordFailure();
    send401(server);
    return false;
  }
  String hdr = server.header("Authorization");
  if (!hdr.startsWith("Basic ")) {
    recordFailure();
    send401(server);
    return false;
  }
  String b64 = hdr.substring(6);

  char decoded[192];
  int decodedLen = base64_decode_chars(b64.c_str(), b64.length(), decoded);
  if (decodedLen <= 0 || decodedLen >= (int)sizeof(decoded)) {
    recordFailure();
    send401(server);
    return false;
  }
  decoded[decodedLen] = '\0';

  char *colon = strchr(decoded, ':');
  if (colon == nullptr) {
    recordFailure();
    send401(server);
    return false;
  }
  const char *password = colon + 1;

  br_sha256_context ctx;
  uint8_t computed[32];
  br_sha256_init(&ctx);
  br_sha256_update(&ctx, password, strlen(password));
  br_sha256_out(&ctx, computed);

  if (!constantTimeEqual(computed, configStore.cfg().auth_password_hash, 32)) {
    recordFailure();
    send401(server);
    return false;
  }

  s_consecutiveFailures = 0;
  s_lockoutUntilMs = 0;
  return true;
}
