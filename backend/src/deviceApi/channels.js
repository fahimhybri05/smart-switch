import { pool } from '../db/pool.js';
import { relayCommand } from '../ws/registry.js';

/**
 * Served straight from `cached_channel_state` — no device round-trip, per
 * docs/plan.md ("GET /api/channels is answered from cached_channel_state").
 * A channel with no cached row yet (never reported a state) simply doesn't
 * appear, same as `db/devices.js`'s existing use of this table elsewhere.
 */
export async function getChannels(deviceId) {
  const { rows } = await pool.query(
    'SELECT channel_idx, state FROM cached_channel_state WHERE device_id = $1 ORDER BY channel_idx',
    [deviceId],
  );
  return { status: 200, body: rows };
}

/**
 * Backend-initiated actuation: relays `POST /api/channels/{idx}/state` to
 * the device and resolves with its `{status, body}` response — the same
 * `relayCommand` primitive every other actuation path (automations/engine.js,
 * routes/devices.js, ws/clientServer.js) already uses. Used by
 * deviceSchedules/scheduler.js to fire a schedule.
 *
 * Deliberately does NOT call `noteExpectedStateChange` itself — same as
 * `relayCommand` itself, attribution-noting is left to the caller, who
 * knows the real source (app/widget/automation/...). A caller that doesn't
 * note anything (e.g. the schedule scheduler) gets the existing
 * `source: 'device'` fallback attribution once the device's confirming
 * `state_changed` event arrives (ws/attribution.js / ws/deviceServer.js) —
 * see deviceSchedules/scheduler.js's own comment for why that's an
 * acceptable, documented choice here.
 */
export function setChannelState(deviceId, channelIdx, state) {
  return relayCommand(deviceId, {
    method: 'POST',
    path: `/api/channels/${channelIdx}/state`,
    body: { state },
  });
}
