#include "recovery_button.h"

#include <Arduino.h>
#include <ESP8266WiFi.h>

#include "board_config.h"
#include "config_store.h"

// Deferred so the HTTP/cloud reply that requested the action can actually
// leave the device before it restarts.
enum class PendingAction { None, Reboot, FactoryReset };
static PendingAction s_pending = PendingAction::None;
static unsigned long s_pendingAtMs = 0;

static void doFactoryReset() {
  Serial.println("recovery: factory reset — erasing WiFi + config, rebooting");
  configStore.factoryReset();
  WiFi.disconnect(true); // clears the SDK-persisted STA credentials
  ESP.eraseConfig();
  delay(200);
  ESP.restart();
}

void recoveryRequestReboot(uint32_t delayMs) {
  if (s_pending == PendingAction::FactoryReset) return; // never downgrade a reset
  s_pending = PendingAction::Reboot;
  s_pendingAtMs = millis() + delayMs;
}

void recoveryRequestFactoryReset(uint32_t delayMs) {
  s_pending = PendingAction::FactoryReset;
  s_pendingAtMs = millis() + delayMs;
}

static void servicePendingAction() {
  if (s_pending == PendingAction::None || (long)(millis() - s_pendingAtMs) < 0) return;
  if (s_pending == PendingAction::FactoryReset) {
    doFactoryReset(); // does not return
  }
  Serial.println("recovery: reboot requested");
  delay(100);
  ESP.restart();
}

#if SS_BOOT_BUTTON_GPIO >= 0

static unsigned long s_pressStartMs = 0;
static bool s_pressed = false;
static bool s_holdLogged = false;
static int s_lastLevel = -1;

void recoveryButtonBegin() {
  pinMode(SS_BOOT_BUTTON_GPIO, INPUT_PULLUP);
  s_lastLevel = digitalRead(SS_BOOT_BUTTON_GPIO);
  Serial.printf("recovery: button on GPIO%d, level=%d (1 = released)\n", SS_BOOT_BUTTON_GPIO,
                s_lastLevel);
}

void recoveryButtonLoop() {
  servicePendingAction();

  int level = digitalRead(SS_BOOT_BUTTON_GPIO);
  if (level != s_lastLevel) {
    s_lastLevel = level;
    Serial.printf("recovery: GPIO%d -> %s\n", SS_BOOT_BUTTON_GPIO, level == LOW ? "pressed" : "released");
  }
  bool down = level == LOW; // active-low
  if (down && !s_pressed) {
    s_pressed = true;
    s_holdLogged = false;
    s_pressStartMs = millis();
  } else if (down && s_pressed) {
    unsigned long held = millis() - s_pressStartMs;
    if (!s_holdLogged && held >= 1000) {
      s_holdLogged = true;
      Serial.printf("recovery: button held — keep holding %lus for factory reset\n",
                    (unsigned long)(SS_BOOT_FACTORY_RESET_HOLD_MS / 1000));
    }
    if (held >= SS_BOOT_FACTORY_RESET_HOLD_MS) {
      doFactoryReset(); // does not return
    }
  } else if (!down && s_pressed) {
    s_pressed = false;
    if (s_holdLogged) {
      Serial.println("recovery: released early — no reset");
    }
  }
}

#else

void recoveryButtonBegin() {}
void recoveryButtonLoop() { servicePendingAction(); }

#endif
