#pragma once

#include <Arduino.h>

void relayHalInit();
void relayHalSetState(uint8_t channelIdx, bool on);
bool relayHalGetState(uint8_t channelIdx);
uint8_t relayHalChannelCount();
