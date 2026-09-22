#include <Arduino.h>
#include <ESP8266mDNS.h>

#include "channel_control.h"
#include "cloud_client.h"
#include "config_store.h"
#include "http_api.h"
#include "physical_input.h"
#include "recovery_button.h"
#include "relay_hal.h"
#include "schedule_exec.h"
#include "wifi_provisioning.h"

static bool s_mdnsStarted = false;

// Advertises _esp-switch._tcp (same service type/TXT keys as the ESP32
// firmware's mdns_advertise component) so the app's existing mDNS
// discovery — used right after WiFi provisioning to learn the device's LAN
// IP — finds ESP8266 boards too, with no app-side change needed.
static void startMdnsIfNeeded() {
  if (s_mdnsStarted || !wifiProvisioningIsConnected()) {
    return;
  }
  const SsConfig &cfg = configStore.cfg();
  if (!MDNS.begin(cfg.device_id)) {
    return;
  }
  MDNS.addService("esp-switch", "tcp", 80);
  MDNS.addServiceTxt("esp-switch", "tcp", "device_id", cfg.device_id);
  MDNS.addServiceTxt("esp-switch", "tcp", "board_type", cfg.board_type);
  char chCount[4];
  snprintf(chCount, sizeof(chCount), "%u", relayHalChannelCount());
  MDNS.addServiceTxt("esp-switch", "tcp", "channel_count", chCount);
  s_mdnsStarted = true;
}

static void applyBootStates() {
  const SsConfig &cfg = configStore.cfg();
  for (uint8_t i = 0; i < cfg.switch_count; i++) {
    const SsSwitch &sw = cfg.switches[i];
    // "LAST" isn't implemented (matches the ESP32 firmware's scaffold —
    // relay_hal has no persisted last-state read-back) — treated as OFF.
    bool on = strcmp(sw.default_boot_state, "ON") == 0;
    relayHalSetState(sw.channel_idx, on);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);

  configStore.begin();
  relayHalInit();
  applyBootStates();
  channelControlInit();
  physicalInputInit();

  // Printed once per boot so a fresh board's QR sticker can be generated
  // right after flashing — the app's QR wizard reads &chip= to pick the
  // right WiFi-provisioning method (this chip's plain JSON form vs the
  // ESP32's Security1 handshake). Serial access requires physical/USB
  // access to the board, same threat model as the printed sticker itself.
  Serial.printf("QR sticker: qrencode -o sticker.png "
                "'smartapp://device/setup?id=%s&secret=%s&chip=esp8266'\n",
                configStore.cfg().device_id, configStore.cfg().cloud_secret);

  wifiProvisioningBegin();
  httpApiBegin();
  scheduleExecBegin();
  cloudClientBegin();
  recoveryButtonBegin();

  Serial.printf("boot complete: device_id=%s board_type=%s channel_count=%d fw_version=%s\n",
                configStore.cfg().device_id, configStore.cfg().board_type,
                relayHalChannelCount(), configStore.cfg().fw_version);
}

void loop() {
  wifiProvisioningLoop();
  startMdnsIfNeeded();
  if (s_mdnsStarted) {
    MDNS.update();
  }
  httpApiLoop();
  configStore.loop();
  scheduleExecLoop();
  channelControlLoop();
  physicalInputLoop();
  cloudClientLoop();
  recoveryButtonLoop();
}
