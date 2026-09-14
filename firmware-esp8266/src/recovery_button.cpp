#include "recovery_button.h"

#include <Arduino.h>
#include <LittleFS.h>

#include "board_config.h"

#if SS_BOOT_BUTTON_GPIO >= 0

static unsigned long s_pressStartMs = 0;
static bool s_pressed = false;
static bool s_longFired = false;

static void doNetworkReset() {
  ESP.eraseConfig();
  delay(200);
  ESP.restart();
}

static void doFactoryReset() {
  LittleFS.format();
  ESP.eraseConfig();
  delay(200);
  ESP.restart();
}

void recoveryButtonBegin() { pinMode(SS_BOOT_BUTTON_GPIO, INPUT_PULLUP); }

void recoveryButtonLoop() {
  bool down = digitalRead(SS_BOOT_BUTTON_GPIO) == LOW; // active-low
  if (down && !s_pressed) {
    s_pressed = true;
    s_longFired = false;
    s_pressStartMs = millis();
  } else if (down && s_pressed) {
    unsigned long held = millis() - s_pressStartMs;
    if (!s_longFired && held >= SS_BOOT_LONG_HOLD_MS) {
      s_longFired = true;
      doFactoryReset(); // does not return
    }
  } else if (!down && s_pressed) {
    unsigned long held = millis() - s_pressStartMs;
    s_pressed = false;
    if (!s_longFired && held >= SS_BOOT_SHORT_HOLD_MS) {
      doNetworkReset(); // does not return
    }
  }
}

#else

void recoveryButtonBegin() {}
void recoveryButtonLoop() {}

#endif
