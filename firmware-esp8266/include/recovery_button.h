#pragma once

#include <Arduino.h>

// BOOT/FLASH button (SS_BOOT_BUTTON_GPIO, board_config.h): hold for
// SS_BOOT_FACTORY_RESET_HOLD_MS (7s) = factory reset — erases WiFi
// credentials and all local config, keeps device identity, then reboots
// into SoftAP setup mode. Shorter presses do nothing. Button handling is a
// no-op if SS_BOOT_BUTTON_GPIO is -1; the requests below always work.
void recoveryButtonBegin();

// Also services pending recoveryRequest*() actions — call every loop().
void recoveryButtonLoop();

// Reboot / factory reset (same as the 7s hold) after [delayMs], so the
// reply to whoever asked (POST /api/reboot, /api/factory-reset — local or
// cloud-relayed) gets out first.
void recoveryRequestReboot(uint32_t delayMs);
void recoveryRequestFactoryReset(uint32_t delayMs);
