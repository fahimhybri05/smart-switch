#include "relay_hal.h"

#include "board_config.h"

static bool s_state[SS_CHANNEL_COUNT] = {false};

void relayHalInit() {
  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    // Write the "off" level to the output register BEFORE switching the pin
    // to OUTPUT mode, not after — digitalWrite() sets the register
    // regardless of current pin mode, so the pin drives "off" from the
    // instant it becomes an output, with no intermediate glitch window at
    // the direction switch itself (the previous off-level-after-pinMode
    // order left the pin's output level briefly undefined/whatever the
    // register defaulted to during that switch).
    int offLevel = SS_RELAY_ACTIVE_LOW ? HIGH : LOW;
    digitalWrite(SS_RELAY_GPIO[i], offLevel);
    pinMode(SS_RELAY_GPIO[i], OUTPUT);
    s_state[i] = false;
  }
}

void relayHalSetState(uint8_t channelIdx, bool on) {
  if (channelIdx >= SS_CHANNEL_COUNT) {
    return;
  }
  int level = on != SS_RELAY_ACTIVE_LOW ? HIGH : LOW;
  digitalWrite(SS_RELAY_GPIO[channelIdx], level);
  s_state[channelIdx] = on;
}

bool relayHalGetState(uint8_t channelIdx) {
  if (channelIdx >= SS_CHANNEL_COUNT) {
    return false;
  }
  return s_state[channelIdx];
}

uint8_t relayHalChannelCount() { return SS_CHANNEL_COUNT; }
