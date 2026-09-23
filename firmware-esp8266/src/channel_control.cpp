#include "channel_control.h"

#include "board_config.h"
#include "cloud_client.h"
#include "config_store.h"
#include "relay_hal.h"

// 0 = no pending inching auto-reverse deadline for that channel.
static uint32_t s_inchingDeadlineMs[SS_CHANNEL_COUNT];

void channelControlInit() {
  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    s_inchingDeadlineMs[i] = 0;
  }
}

void channelControlSetState(uint8_t channelIdx, bool on) {
  if (channelIdx >= SS_CHANNEL_COUNT) {
    return;
  }

  s_inchingDeadlineMs[channelIdx] = 0; // cancel any pending inching for this channel

  const SsConfig &cfg = configStore.cfg();

  if (on && cfg.interlockEnabled) {
    for (uint8_t i = 0; i < relayHalChannelCount(); i++) {
      if (i == channelIdx) continue;
      if (relayHalGetState(i)) {
        s_inchingDeadlineMs[i] = 0;
        relayHalSetState(i, false);
        configStore.setLastState(i, false);
        cloudClientNotifyStateChanged(i, false);
      }
    }
  }

  relayHalSetState(channelIdx, on);
  configStore.setLastState(channelIdx, on);
  cloudClientNotifyStateChanged(channelIdx, on);

  if (on) {
    for (uint8_t i = 0; i < cfg.channelHwCount; i++) {
      const SsChannelHw &hw = cfg.channelHw[i];
      if (hw.channel_idx == channelIdx) {
        if (hw.inchingMs > 0) {
          uint32_t deadline = millis() + hw.inchingMs;
          if (deadline == 0) deadline = 1; // avoid colliding with the 0 sentinel
          s_inchingDeadlineMs[channelIdx] = deadline;
        }
        break;
      }
    }
  }
}

void channelControlLoop() {
  for (uint8_t i = 0; i < SS_CHANNEL_COUNT; i++) {
    if (s_inchingDeadlineMs[i] != 0 &&
        (int32_t)(millis() - s_inchingDeadlineMs[i]) >= 0) {
      s_inchingDeadlineMs[i] = 0;
      channelControlSetState(i, false);
    }
  }
}
