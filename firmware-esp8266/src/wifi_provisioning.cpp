#include "wifi_provisioning.h"

#include <ArduinoJson.h>
#include <ESP8266WiFi.h>

#include "board_config.h"
#include "config_store.h"
#include "http_api.h"

static WifiReconfigState s_state = WifiReconfigState::Idle;

static bool s_deferArmed = false;
static unsigned long s_deferAt = 0;
static unsigned long s_connectAttemptStart = 0;

static String s_pendingSsid;
static String s_pendingPassword;
static String s_previousSsid;
static String s_previousPassword;

static const unsigned long CONNECT_TIMEOUT_MS = 15000;
static const unsigned long DEFER_MS = 700;

// Fix 2 support: while boot-time fallback leaves the device parked in
// AP-only mode with previously-stored credentials that just haven't been
// reachable *yet* (e.g. router still rebooting after a shared power
// outage), periodically retry them in the background instead of waiting
// forever for a human to join the SoftAP and re-enter creds that already
// work. Deliberately separate from the WifiReconfigState machine above
// (which is the manual /api/wifi reconfigure flow's app-facing state) —
// this is purely internal and never surfaced to the app beyond the
// eventual Connected transition both paths share.
enum class ApRetryState { Idle, Testing };
static ApRetryState s_apRetryState = ApRetryState::Idle;
static unsigned long s_lastApRetryMs = 0;
static unsigned long s_apRetryConnectStart = 0;
static const unsigned long AP_RETRY_INTERVAL_MS = 5UL * 60UL * 1000UL; // 5 minutes

// Nearby-network scan for the app's WiFi picker (GET /api/wifi/scan) and the
// offline web page. Async (WiFi.scanNetworks(true)) so neither the HTTP
// server nor the cloud WS stalls for the ~2-3s a scan takes; results are
// cached and served until stale. Scanning needs the STA interface, so in
// AP-only mode the SDK flips to AP_STA — s_scanFlippedMode records that so
// the mode is put back once the scan finishes.
struct ScanEntry {
  char ssid[33];
  int8_t rssi;
  bool secure;
  uint8_t channel;
};
static const uint8_t SCAN_MAX = 20;
static const unsigned long SCAN_CACHE_MS = 30000;
static ScanEntry s_scan[SCAN_MAX];
static uint8_t s_scanCount = 0;
static bool s_scanHaveResult = false;
static unsigned long s_scanAtMs = 0;
static bool s_scanRunning = false;
static bool s_scanFlippedMode = false;

static void startScan() {
  if (s_scanRunning || s_state == WifiReconfigState::Testing) {
    return; // a reconfig test owns the STA radio right now
  }
  s_scanFlippedMode = WiFi.getMode() == WIFI_AP;
  WiFi.scanNetworks(true /* async */, false /* skip hidden */);
  s_scanRunning = true;
}

static void collectScanIfDone() {
  if (!s_scanRunning) return;
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return;
  s_scanRunning = false;
  s_scanCount = 0;
  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);
    if (ssid.length() == 0 || ssid.length() > 32) continue;
    int8_t rssi = (int8_t)WiFi.RSSI(i);
    // Dedupe by SSID (mesh/extenders), keeping the strongest.
    int existing = -1;
    for (uint8_t j = 0; j < s_scanCount; j++) {
      if (ssid.equals(s_scan[j].ssid)) { existing = j; break; }
    }
    if (existing >= 0) {
      if (rssi > s_scan[existing].rssi) {
        s_scan[existing].rssi = rssi;
        s_scan[existing].channel = (uint8_t)WiFi.channel(i);
      }
      continue;
    }
    // Keep the strongest SCAN_MAX: insert sorted, dropping the weakest.
    uint8_t pos = s_scanCount;
    while (pos > 0 && s_scan[pos - 1].rssi < rssi) pos--;
    if (pos >= SCAN_MAX) continue;
    uint8_t last = s_scanCount < SCAN_MAX ? s_scanCount : SCAN_MAX - 1;
    for (uint8_t j = last; j > pos; j--) s_scan[j] = s_scan[j - 1];
    strlcpy(s_scan[pos].ssid, ssid.c_str(), sizeof(s_scan[pos].ssid));
    s_scan[pos].rssi = rssi;
    s_scan[pos].secure = WiFi.encryptionType(i) != ENC_TYPE_NONE;
    s_scan[pos].channel = (uint8_t)WiFi.channel(i);
    if (s_scanCount < SCAN_MAX) s_scanCount++;
  }
  WiFi.scanDelete();
  s_scanHaveResult = n >= 0;
  s_scanAtMs = millis();

  if (s_scanFlippedMode) {
    s_scanFlippedMode = false;
    if (WiFi.status() == WL_CONNECTED) {
      // Enabling STA for the scan let the SDK auto-join the stored network
      // (router came back) — keep it, same outcome as the AP retry below.
      s_state = WifiReconfigState::Connected;
      WiFi.mode(WIFI_STA);
      WiFi.setSleepMode(WIFI_NONE_SLEEP);
      Serial.printf("wifi: connected to \"%s\" during scan (hotspot off)\n", WiFi.SSID().c_str());
    } else if (s_state != WifiReconfigState::Testing && s_apRetryState == ApRetryState::Idle) {
      WiFi.mode(WIFI_AP); // STA channel-hopping would keep disturbing hotspot clients
    }
  }
}

String wifiProvisioningScanJson(bool refresh) {
  bool stale = !s_scanHaveResult || millis() - s_scanAtMs > SCAN_CACHE_MS;
  if ((refresh || stale) && !s_scanRunning) {
    startScan();
  }
  JsonDocument doc;
  doc["scanning"] = s_scanRunning;
  JsonArray nets = doc["networks"].to<JsonArray>();
  for (uint8_t i = 0; i < s_scanCount; i++) {
    JsonObject o = nets.add<JsonObject>();
    o["ssid"] = s_scan[i].ssid;
    o["rssi"] = s_scan[i].rssi;
    o["secure"] = s_scan[i].secure;
    o["channel"] = s_scan[i].channel;
  }
  String out;
  serializeJson(doc, out);
  return out;
}

void wifiProvisioningHandleScan() {
  httpServer.send(200, "application/json", wifiProvisioningScanJson(httpServer.arg("refresh") == "1"));
}

bool wifiProvisioningIsLocalMode() {
  return (WiFi.getMode() & WIFI_AP) && WiFi.status() != WL_CONNECTED;
}

const char *wifiReconfigStateStr(WifiReconfigState state) {
  switch (state) {
    case WifiReconfigState::Idle:
      return "IDLE";
    case WifiReconfigState::Testing:
      return "TESTING";
    case WifiReconfigState::Connected:
      return "CONNECTED";
    case WifiReconfigState::FailedRolledBack:
      return "FAILED_ROLLED_BACK";
  }
  return "IDLE";
}

// Set via POST /api/network (http_api.cpp) + persisted by config_store —
// applied here, at boot, before WiFi.begin(). See docs/plan.md; mirrors the
// ESP32 firmware's equivalent in provisioning.c.
static void applyStaticIpIfConfigured() {
  const SsConfig &cfg = configStore.cfg();
  if (!cfg.staticIpEnabled) {
    return;
  }
  IPAddress ip, gateway, subnet, dns;
  if (!ip.fromString(cfg.staticIp) || !gateway.fromString(cfg.staticGateway) ||
      !subnet.fromString(cfg.staticSubnet)) {
    return; // invalid stored config — fall back to DHCP rather than fail closed
  }
  if (cfg.staticDns[0] == '\0' || !dns.fromString(cfg.staticDns)) {
    dns = gateway;
  }
  WiFi.config(ip, gateway, subnet, dns);
}

void wifiProvisioningBegin() {
  WiFi.persistent(true);
  WiFi.setAutoReconnect(true);
  // This is a mains-powered relay, not a battery device — there's no
  // reason to trade latency for the radio power savings modem sleep is
  // for. Left enabled (the ESP8266 Arduino core's default), every request
  // after even a few seconds of idle pays a multi-second wake-from-sleep
  // tax before the first response — reproduced live: /api/config took
  // 3.8s cold, 2.7s on a second attempt a moment later, then 0.2s once
  // the radio was fully awake. That "first tap after a while" delay is
  // exactly what real usage (tapping a switch) hits every time.
  WiFi.setSleepMode(WIFI_NONE_SLEEP);

  if (WiFi.SSID().length() > 0) {
    WiFi.mode(WIFI_STA);
    applyStaticIpIfConfigured();
    Serial.printf("wifi: connecting to \"%s\"...\n", WiFi.SSID().c_str());
    WiFi.begin();
    // Intentionally blocking: this runs before any other subsystem starts
    // (httpApiBegin/cloudClientBegin/recoveryButtonBegin are all still
    // ahead in setup()), so nothing already running is frozen
    // by it — the device just isn't reachable on any interface for up to
    // 20s at boot. Not shortened here: it's an existing, presumably-tuned
    // value, and a shorter timeout risks more frequent unnecessary SoftAP
    // fallbacks on a normal, slightly-slow router. If 20s genuinely isn't
    // enough (router still rebooting, etc.), the periodic AP-mode retry
    // below (see ApRetryState / wifiProvisioningLoop()) is what recovers
    // afterwards, without needing a human to intervene.
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
      delay(250);
    }
    if (WiFi.status() == WL_CONNECTED) {
      s_state = WifiReconfigState::Connected;
      Serial.printf("wifi: connected to \"%s\" ip=%s rssi=%ddBm\n", WiFi.SSID().c_str(),
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
      return;
    }
    Serial.printf("wifi: could not connect to \"%s\" within 20s (status=%d)\n",
                  WiFi.SSID().c_str(), (int)WiFi.status());
    // Couldn't reconnect to the stored network (moved router, changed
    // password) — fall through to opening the SoftAP so the user can fix
    // it without needing a factory reset.
  }

  WiFi.mode(WIFI_AP);
  String apName = String("SmartSwitch-") + configStore.cfg().device_id;
  // No Security1/protocomm equivalent on this chip (see docs/plan.md) — the
  // SoftAP itself is WPA2-protected with the fixed SS_AP_PASSWORD
  // (board_config.h), the same on every device. It also serves the offline
  // control page (local_web.cpp) while it's up.
  WiFi.softAP(apName.c_str(), SS_AP_PASSWORD);
  Serial.printf("wifi: setup hotspot \"%s\" up at %s (password: %s)\n", apName.c_str(),
                WiFi.softAPIP().toString().c_str(), SS_AP_PASSWORD);
  // Start the periodic auto-retry clock now (Fix 2) — if stored credentials
  // exist, wifiProvisioningLoop() will start trying them again in the
  // background after AP_RETRY_INTERVAL_MS. Harmless to set even when no
  // credentials are stored (fresh device): the retry is separately gated on
  // WiFi.SSID().length() > 0 below, so it just never fires in that case.
  s_lastApRetryMs = millis();
}

void wifiProvisioningLoop() {
  collectScanIfDone();

  if (s_deferArmed && !s_scanRunning && (long)(millis() - s_deferAt) >= 0) {
    s_deferArmed = false;
    WiFi.mode(WIFI_AP_STA); // keep the AP alive in case the new creds fail
    WiFi.begin(s_pendingSsid.c_str(), s_pendingPassword.c_str());
    Serial.printf("wifi: testing new network \"%s\"...\n", s_pendingSsid.c_str());
    s_connectAttemptStart = millis();
    s_state = WifiReconfigState::Testing;
  }

  if (s_state == WifiReconfigState::Testing) {
    if (WiFi.status() == WL_CONNECTED) {
      s_state = WifiReconfigState::Connected;
      Serial.printf("wifi: connected to \"%s\" ip=%s rssi=%ddBm (hotspot off)\n",
                    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
      WiFi.mode(WIFI_STA); // provisioning succeeded, drop the AP
      WiFi.setSleepMode(WIFI_NONE_SLEEP); // re-assert — see wifiProvisioningBegin()
    } else if (millis() - s_connectAttemptStart > CONNECT_TIMEOUT_MS) {
      Serial.printf("wifi: new network \"%s\" failed, rolling back\n", s_pendingSsid.c_str());
      if (s_previousSsid.length() > 0) {
        WiFi.begin(s_previousSsid.c_str(), s_previousPassword.c_str());
      }
      s_state = WifiReconfigState::FailedRolledBack;
    }
  }

  // Rolled back onto the previous network: once it's up again, drop the
  // hotspot that was kept alive for the test (otherwise it'd stay on until
  // the next reboot).
  if (s_state == WifiReconfigState::FailedRolledBack && s_previousSsid.length() > 0 &&
      WiFi.getMode() == WIFI_AP_STA && WiFi.status() == WL_CONNECTED) {
    Serial.printf("wifi: back on \"%s\" (hotspot off)\n", WiFi.SSID().c_str());
    WiFi.mode(WIFI_STA);
    WiFi.setSleepMode(WIFI_NONE_SLEEP); // re-assert — see wifiProvisioningBegin()
  }

  // Fix 2: automatic background retry of the already-stored credentials
  // while stuck in AP-only fallback since boot. Only starts when nothing
  // else is already driving a WiFi transition (mode is exactly WIFI_AP —
  // not AP_STA, which is what the manual-reconfigure machine above uses
  // while it's mid-test/mid-rollback — and s_state isn't Testing), so the
  // two mechanisms never fight over WiFi.begin()/WiFi.mode() at once.
  if (s_apRetryState == ApRetryState::Idle && s_state != WifiReconfigState::Testing &&
      !s_scanRunning && WiFi.getMode() == WIFI_AP && WiFi.SSID().length() > 0 &&
      (long)(millis() - s_lastApRetryMs) >= (long)AP_RETRY_INTERVAL_MS) {
    s_lastApRetryMs = millis();
    WiFi.mode(WIFI_AP_STA); // keep the AP alive in case the stored creds still don't work
    WiFi.begin(); // reuse the SDK-persisted STA credentials, same ones tried at boot
    Serial.printf("wifi: retrying \"%s\" in background...\n", WiFi.SSID().c_str());
    s_apRetryConnectStart = millis();
    s_apRetryState = ApRetryState::Testing;
  } else if (s_apRetryState == ApRetryState::Testing) {
    if (WiFi.status() == WL_CONNECTED) {
      s_apRetryState = ApRetryState::Idle;
      s_state = WifiReconfigState::Connected;
      Serial.printf("wifi: connected to \"%s\" ip=%s rssi=%ddBm (hotspot off)\n",
                    WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
      WiFi.mode(WIFI_STA); // router's back — drop the AP
      WiFi.setSleepMode(WIFI_NONE_SLEEP); // re-assert — see wifiProvisioningBegin()
    } else if (millis() - s_apRetryConnectStart > CONNECT_TIMEOUT_MS) {
      s_apRetryState = ApRetryState::Idle;
      s_lastApRetryMs = millis(); // next attempt is a full interval from now
      // If a manual reconfigure test started while our retry was in
      // flight, leave WiFi.mode() alone — that state machine now owns the
      // AP/STA transitions and will resolve it (Connected or
      // FailedRolledBack) on its own.
      if (s_state != WifiReconfigState::Testing) {
        WiFi.mode(WIFI_AP); // still unreachable — back to pure AP, try again next interval
      }
    }
  }
  // Log link drops/recoveries after the initial connect (auto-reconnect is
  // handled by the SDK, this just makes it visible on serial).
  static bool s_wasConnected = false;
  bool connected = WiFi.status() == WL_CONNECTED;
  if (connected != s_wasConnected) {
    s_wasConnected = connected;
    if (connected) {
      Serial.printf("wifi: link up ip=%s\n", WiFi.localIP().toString().c_str());
    } else {
      Serial.println("wifi: link down");
    }
  }
}

void wifiProvisioningRequestReconfig(const String &bodyJson, int *outStatus, String *outBody) {
  // No local password/auth check anymore (see docs/plan.md) — the trust
  // boundary for every LAN endpoint, this one included, is now "this
  // request came from a device that already holds a valid, backend-issued
  // cloud_secret", not a locally-set password this device no longer stores.
  // The cloud-relayed path (cloud_client.cpp) is gated by the backend's
  // household-membership check instead.
  JsonDocument doc;
  if (deserializeJson(doc, bodyJson) != DeserializationError::Ok) {
    *outStatus = 400;
    *outBody = "{\"error\":\"invalid JSON\"}";
    return;
  }
  const char *ssid = doc["ssid"] | "";
  const char *password = doc["password"] | "";
  size_t ssidLen = strlen(ssid);
  size_t passLen = strlen(password);
  if (ssidLen == 0 || ssidLen > 32) {
    *outStatus = 400;
    *outBody = "{\"error\":\"ssid required (max 32 chars)\"}";
    return;
  }
  if (passLen != 0 && (passLen < 8 || passLen > 64)) {
    *outStatus = 400;
    *outBody = "{\"error\":\"password must be empty (open network) or 8-64 chars\"}";
    return;
  }
  // A second request mid-test would capture the *candidate* network as the
  // rollback target — refuse until the current attempt resolves.
  if (s_state == WifiReconfigState::Testing) {
    *outStatus = 409;
    *outBody = "{\"error\":\"wifi change already in progress\"}";
    return;
  }

  s_previousSsid = WiFi.SSID();
  s_previousPassword = WiFi.psk();
  s_pendingSsid = ssid;
  s_pendingPassword = password;
  s_state = WifiReconfigState::Testing;
  s_deferArmed = true;
  s_deferAt = millis() + DEFER_MS;

  *outStatus = 202;
  *outBody = "{\"state\":\"TESTING\"}";
}

String wifiProvisioningBuildStatus() {
  JsonDocument doc;
  doc["state"] = wifiReconfigStateStr(s_state);
  doc["connected"] = WiFi.status() == WL_CONNECTED;
  doc["ssid"] = WiFi.SSID();
  if (WiFi.status() == WL_CONNECTED) {
    doc["rssi"] = WiFi.RSSI();
    doc["ip"] = WiFi.localIP().toString();
  }
  String out;
  serializeJson(doc, out);
  return out;
}

void wifiProvisioningHandleGet() {
  httpServer.send(200, "application/json", wifiProvisioningBuildStatus());
}

void wifiProvisioningHandlePost() {
  int status;
  String body;
  wifiProvisioningRequestReconfig(httpServer.arg("plain"), &status, &body);
  httpServer.send(status, "application/json", body);
}

WifiReconfigState wifiProvisioningGetState() { return s_state; }

bool wifiProvisioningIsConnected() { return WiFi.status() == WL_CONNECTED; }
