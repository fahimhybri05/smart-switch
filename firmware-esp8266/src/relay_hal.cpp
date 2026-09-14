#include "relay_hal.h"

#include "board_config.h"

static bool s_state[SS_CHANNEL_COUNT] = {false};

void relayHalInit() {
  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    pinMode(SS_RELAY_GPIO[i], OUTPUT);
    relayHalSetState(i, false);
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
