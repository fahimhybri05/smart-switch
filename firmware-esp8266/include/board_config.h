#pragma once

// NodeMCU/Wemos D1 mini (ESP-12E/F) pin map — 6 relay channels + 1
// MOSFET-driven channel (kept plain on/off for this pass, no PWM — see
// docs/plan.md) + I2C for the DS3231 RTC, all direct GPIO (no I2C relay
// expander on this board).
//
// This chip only breaks out ~9 usable GPIOs total, so every "spare" pin is
// double-booked with a boot-strapping role. These are DEFAULTS matching the
// common wiring convention for this exact pin-budget problem — verify
// against your actual PCB before flashing if your board differs:
//
//   GPIO0  (D3): relay 7 (MOSFET) + boot-strap (must read HIGH at boot) —
//                active-low relay convention means "off" = HIGH, which is
//                also GPIO0's required boot level, so this is safe as long
//                as the relay driver holds it HIGH before boot-mode latch.
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

#define SS_CHANNEL_COUNT 7 // 6 relays + 1 MOSFET channel, all binary on/off

static const uint8_t SS_RELAY_ACTIVE_LOW = true;

static const int8_t SS_RELAY_GPIO[SS_CHANNEL_COUNT] = {
    5,  // D1 — relay 1
    4,  // D2 — relay 2
    14, // D5 — relay 3
    12, // D6 — relay 4
    13, // D7 — relay 5
    16, // D0 — relay 6
    0,  // D3 — relay 7 (MOSFET channel, plain on/off — see note above)
};

#define SS_I2C_SDA_GPIO 2  // D4
#define SS_I2C_SCL_GPIO 15 // D8

// BOOT-equivalent recovery button: short hold = WiFi-only reset, long hold
// = full factory reset — mirrors the ESP32 firmware's recovery_button
// component. NodeMCU/D1 mini have no dedicated user button wired to a free
// GPIO by default; this assumes an external button added to GPIO0 is NOT
// used (GPIO0 is a relay output here) — wire a momentary button between
// this GPIO and GND instead, using the ESP32 board's same active-low +
// internal-pullup convention.
#define SS_BOOT_BUTTON_GPIO -1 // -1 = not wired; recovery button disabled
                               // until a free GPIO is assigned for your build
#define SS_BOOT_SHORT_HOLD_MS 5000
#define SS_BOOT_LONG_HOLD_MS 12000

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
