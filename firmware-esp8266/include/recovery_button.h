#pragma once

// Mirrors the ESP32 firmware's recovery_button component: short hold =
// WiFi-only reset, long hold = full factory reset. A no-op if
// SS_BOOT_BUTTON_GPIO is -1 (board_config.h) — this pin-scarce board has
// no free GPIO for a button in the default wiring; until one is freed up,
// factory reset means re-flashing over USB (erase_flash), which the bench
// setup already has access to.
void recoveryButtonBegin();

void recoveryButtonLoop();
