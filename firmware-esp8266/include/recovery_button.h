#pragma once

// BOOT/FLASH button (SS_BOOT_BUTTON_GPIO, board_config.h): hold for
// SS_BOOT_FACTORY_RESET_HOLD_MS (7s) = factory reset — erases WiFi
// credentials and all local config, keeps device identity, then reboots
// into SoftAP setup mode. Shorter presses do nothing. A no-op if
// SS_BOOT_BUTTON_GPIO is -1.
void recoveryButtonBegin();

void recoveryButtonLoop();
