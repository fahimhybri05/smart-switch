// The one board this firmware/backend pair targets today (see
// board_config.h: SS_CHANNEL_COUNT = 6). Used as a
// fallback wherever the backend needs a channel count but has no
// device_switches rows yet to count instead.
export const DEFAULT_CHANNEL_COUNT = 6;
