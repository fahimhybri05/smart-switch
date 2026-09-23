#include "physical_input.h"

#include "board_config.h"
#include "channel_control.h"
#include "config_store.h"
#include "relay_hal.h"

static bool s_active[SS_CHANNEL_COUNT];       // has a real GPIO AND input_mode != DISABLED
static bool s_lastEngaged[SS_CHANNEL_COUNT];  // last observed raw engaged-state (pre-debounce)
static uint32_t s_stableSinceMs[SS_CHANNEL_COUNT];
static bool s_debounced[SS_CHANNEL_COUNT];    // last confirmed (debounced) engaged-state
static bool s_hasBaseline[SS_CHANNEL_COUNT];

static const SsChannelHw *channelHwForChannel(uint8_t channelIdx) {
  const SsConfig &cfg = configStore.cfg();
  for (uint8_t i = 0; i < cfg.channelHwCount; i++) {
    if (cfg.channelHw[i].channel_idx == channelIdx) {
      return &cfg.channelHw[i];
    }
  }
  return nullptr;
}

// Re-evaluated every poll, not just at boot: input modes arrive via the
// backend's hw_config_push at any time, and a fresh/reflashed device starts
// with every channel DISABLED until the first push lands.
static void refreshActive(uint8_t i, uint32_t now) {
  const SsChannelHw *hw = channelHwForChannel(i);
  bool want = SS_INPUT_GPIO[i] >= 0 && hw != nullptr && strcmp(hw->inputMode, "DISABLED") != 0;
  if (want == s_active[i]) return;
  s_active[i] = want;
  s_hasBaseline[i] = false;
  s_stableSinceMs[i] = now;
  if (want) {
    pinMode(SS_INPUT_GPIO[i], INPUT_PULLUP);
  }
}

void physicalInputInit() {
  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    s_active[i] = false;
    s_lastEngaged[i] = false;
    s_stableSinceMs[i] = 0;
    s_debounced[i] = false;
    s_hasBaseline[i] = false;
    refreshActive(i, millis());
  }
}

void physicalInputLoop() {
  static uint32_t s_lastPollMs = 0;
  uint32_t now = millis();
  if ((int32_t)(now - s_lastPollMs) < 20) {
    return;
  }
  s_lastPollMs = now;

  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    refreshActive(i, now);
    if (!s_active[i]) continue;

    bool raw = digitalRead(SS_INPUT_GPIO[i]);
    bool engaged = SS_INPUT_ACTIVE_LOW ? (raw == LOW) : (raw == HIGH);

    if (engaged != s_lastEngaged[i]) {
      s_stableSinceMs[i] = now;
    } else if ((int32_t)(now - s_stableSinceMs[i]) >= 50 && !s_hasBaseline[i]) {
      // First stable reading is the baseline, whichever position it's in —
      // otherwise an input idling un-engaged would swallow its first press.
      s_debounced[i] = engaged;
      s_hasBaseline[i] = true;
    } else if ((int32_t)(now - s_stableSinceMs[i]) >= 50 && engaged != s_debounced[i]) {
      s_debounced[i] = engaged;
      const SsChannelHw *hw = channelHwForChannel(i);
      const char *mode = (hw != nullptr) ? hw->inputMode : "DISABLED";
      if (strcmp(mode, "TOGGLE") == 0) {
        channelControlSetState(i, engaged);
      } else if (strcmp(mode, "EDGE") == 0) {
        if (engaged) {
          channelControlSetState(i, !relayHalGetState(i));
        }
      }
    }

    s_lastEngaged[i] = engaged;
  }
}
