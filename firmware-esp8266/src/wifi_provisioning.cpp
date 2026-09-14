#include "wifi_provisioning.h"

#include <ArduinoJson.h>
#include <ESP8266WiFi.h>

#include "config_store.h"
#include "http_api.h"
#include "http_auth.h"

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
    WiFi.begin();
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
      delay(250);
    }
    if (WiFi.status() == WL_CONNECTED) {
      s_state = WifiReconfigState::Connected;
      return;
    }
    // Couldn't reconnect to the stored network (moved router, changed
    // password) — fall through to opening the SoftAP so the user can fix
    // it without needing a factory reset.
  }

  WiFi.mode(WIFI_AP);
  String apName = String("SmartSwitch-") + configStore.cfg().device_id;
  // No Security1/protocomm equivalent on this chip (see docs/plan.md) — the
  // SoftAP itself is WPA2-protected using device_id as the password, the
  // same physically-visible identity already used as the pairing secret.
  WiFi.softAP(apName.c_str(), configStore.cfg().device_id);
}

void wifiProvisioningLoop() {
  if (s_deferArmed && (long)(millis() - s_deferAt) >= 0) {
    s_deferArmed = false;
    WiFi.mode(WIFI_AP_STA); // keep the AP alive in case the new creds fail
    WiFi.begin(s_pendingSsid.c_str(), s_pendingPassword.c_str());
    s_connectAttemptStart = millis();
    s_state = WifiReconfigState::Testing;
  }

  if (s_state == WifiReconfigState::Testing) {
    if (WiFi.status() == WL_CONNECTED) {
      s_state = WifiReconfigState::Connected;
      WiFi.mode(WIFI_STA); // provisioning succeeded, drop the AP
      WiFi.setSleepMode(WIFI_NONE_SLEEP); // re-assert — see wifiProvisioningBegin()
    } else if (millis() - s_connectAttemptStart > CONNECT_TIMEOUT_MS) {
      if (s_previousSsid.length() > 0) {
        WiFi.begin(s_previousSsid.c_str(), s_previousPassword.c_str());
      }
      s_state = WifiReconfigState::FailedRolledBack;
    }
  }
}

void wifiProvisioningHandlePost() {
  if (configStore.cfg().auth_password_set && !httpAuthCheck(httpServer)) {
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
    httpServer.send(400, "application/json", "{\"error\":\"invalid JSON\"}");
    return;
  }
  const char *ssid = doc["ssid"] | "";
  const char *password = doc["password"] | "";
  if (strlen(ssid) == 0) {
    httpServer.send(400, "application/json", "{\"error\":\"ssid required\"}");
    return;
  }

  s_previousSsid = WiFi.SSID();
  s_previousPassword = WiFi.psk();
  s_pendingSsid = ssid;
  s_pendingPassword = password;
  s_state = WifiReconfigState::Testing;
  s_deferArmed = true;
  s_deferAt = millis() + DEFER_MS;

  httpServer.send(202, "application/json", "{\"state\":\"TESTING\"}");
}

void wifiProvisioningHandleFormPage() {
  static const char PAGE[] PROGMEM = R"HTML(<!DOCTYPE html><html><body>
<h3>Connect your Smart Switch to WiFi</h3>
<form id="f">
  <input name="ssid" placeholder="WiFi network name"><br>
  <input name="password" type="password" placeholder="WiFi password"><br>
  <button type="submit">Connect</button>
</form>
<p id="status"></p>
<script>
document.getElementById('f').onsubmit = function(e) {
  e.preventDefault();
  fetch('/api/wifi', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ssid: this.ssid.value, password: this.password.value})
  }).then(function () {
    document.getElementById('status').innerText =
      'Connecting… check the app, or reconnect your phone to your home WiFi in a minute.';
  });
};
</script>
</body></html>)HTML";
  httpServer.send_P(200, "text/html", PAGE);
}

WifiReconfigState wifiProvisioningGetState() { return s_state; }

bool wifiProvisioningIsConnected() { return WiFi.status() == WL_CONNECTED; }
