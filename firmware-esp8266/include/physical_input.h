#pragma once
#include <Arduino.h>

// Call once from setup(), after channelControlInit() and after
// configStore.begin(). Reads which channels have a real GPIO assigned
// (SS_INPUT_GPIO[i] >= 0) and whose configured switch input_mode isn't
// "DISABLED", and pinMode()s those pins as INPUT_PULLUP.
void physicalInputInit();

// Call once per loop() iteration. Internally throttles its own real work to
// ~20ms via millis() so it doesn't add meaningful overhead to the
// cooperative loop.
void physicalInputLoop();
