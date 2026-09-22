#pragma once

// NodeMCU/Wemos D1 mini (ESP-12E/F) pin map — 6 relay channels + I2C for
// the DS3231 RTC, all direct GPIO (no I2C relay expander on this board).
//
// GPIO0 is this board's physical BOOT/FLASH button — previously double-
// booked as a 7th (MOSFET) relay channel, now dedicated to the recovery
// button instead (mirrors the ESP32 firmware's GPIO0 recovery-button
// convention) since this chip's ~9 usable GPIOs leave no other spare pin.
// If your build needs the 7th channel back, you'll need to give up the
// physical-button recovery feature (set SS_BOOT_BUTTON_GPIO back to -1)
// or the DS3231/I2C pins instead — there simply isn't a free GPIO to have
// all three.
//
// This chip only breaks out ~9 usable GPIOs total, so every "spare" pin is
// double-booked with a boot-strapping role. These are DEFAULTS matching the
// common wiring convention for this exact pin-budget problem — verify
// against your actual PCB before flashing if your board differs:
//
//   GPIO0  (D3): recovery button + boot-strap (must read HIGH at boot) —
//                INPUT_PULLUP idles HIGH when not pressed, satisfying the
//                boot-strap requirement the same way relay 7 used to.
//   GPIO2  (D4): I2C SDA + boot-strap (must read HIGH at boot) + onboard
//                LED on most boards — I2C SDA idles HIGH (pulled up)
//                between transactions, compatible with the boot
//                requirement; the LED will flicker faintly during RTC
//                reads, cosmetic only.
//   GPIO15 (D8): I2C SCL + boot-strap (must read LOW at boot) — NodeMCU
//                boards already have an onboard pulldown holding this LOW
//                at boot, satisfying the requirement before I2C init runs.
//   GPIO1/GPIO3 (TX/RX): left free for UART — flashing + the boot-time
//                identity log line (device_id/cloud_secret for the QR
//                sticker), same as the ESP32 firmware. Never repurposed.

#define SS_CHANNEL_COUNT 6 // 6 relays, all binary on/off

static const uint8_t SS_RELAY_ACTIVE_LOW = true;

static const int8_t SS_RELAY_GPIO[SS_CHANNEL_COUNT] = {
    5,  // D1 — relay 1
    4,  // D2 — relay 2
    14, // D5 — relay 3
    12, // D6 — relay 4
    13, // D7 — relay 5
    16, // D0 — relay 6
};

#define SS_I2C_SDA_GPIO 2  // D4
#define SS_I2C_SCL_GPIO 15 // D8

// BOOT-equivalent recovery button: short hold = WiFi-only reset, long hold
// = full factory reset — mirrors the ESP32 firmware's recovery_button
// component. GPIO0 is this board's physical BOOT/FLASH button (see the pin
// map note above) — active-low + internal-pullup, same convention the
// ESP32 board uses.
#define SS_BOOT_BUTTON_GPIO 0
#define SS_BOOT_SHORT_HOLD_MS 5000
#define SS_BOOT_LONG_HOLD_MS 12000

// Physical wall-switch/button input per channel — mirrors SS_RELAY_GPIO
// above but for reading, not driving. -1 = not wired (default for every
// channel — this board's GPIO budget is already fully committed to relays +
// I2C + boot-strap constraints documented at the top of this file; a real
// build must free up pins deliberately before using this feature, exactly
// like SS_BOOT_BUTTON_GPIO above).
static const uint8_t SS_INPUT_ACTIVE_LOW = true;
static const int8_t SS_INPUT_GPIO[SS_CHANNEL_COUNT] = {
    -1, -1, -1, -1, -1, -1,
};

#define SS_STATUS_LED_GPIO 2 // shared with I2C SDA — see note above

// Single self-hosted backend, no runtime configurability needed (same
// reasoning as the ESP32 firmware's Kconfig-hardcoded CONFIG_SS_CLOUD_WS_URL)
// — edit these to point at your backend before flashing.
//
// IMPORTANT: an unreachable/wrong host here is not a harmless no-op — the
// underlying library's TCP connect blocks the whole device (single
// cooperative loop(), including the HTTP server) for up to
// WEBSOCKETS_TCP_TIMEOUT on every failed reconnect attempt (every
// s_ws.setReconnectInterval(), see cloud_client.cpp). Reproduced live: this
// placeholder value caused every local LAN request to randomly stall for
// seconds, which read as "the app is slow" — it wasn't the app, or even
// really "the firmware", it was this pointed at nothing reachable.
#define SS_CLOUD_WS_HOST "api.smart-switch.shop"
#define SS_CLOUD_WS_PORT 443
#define SS_CLOUD_WS_PATH "/device"
#define SS_CLOUD_WS_USE_TLS true
