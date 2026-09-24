import { pool } from '../db/pool.js';

/**
 * The one rule check every REMOTE channel-state command passes through
 * (lock + min-off time). Enforced centrally in ws/registry.js's
 * relayCommand/relayToDevice — the funnel every backend-initiated
 * actuation uses (client WS, REST /command, /v1 + hooks via
 * switches.js#actuate, automations, device schedules, scenes) — and in
 * deviceApi/dispatch.js for LAN requests the device forwards up for
 * authorization. Physical presses on the board never reach the backend
 * as a command and are unaffected.
 *
 * Only the max-runtime auto-OFF (safety/scheduler.js) bypasses it:
 * protection wins over a lock.
 */

export const GUARD_ERROR_CODES = new Set(['switch_locked', 'min_off_time']);

const CHANNEL_STATE_PATH = /^\/api\/channels\/(\d+)\/state$/;

/** `{channelIdx, state}` when `{method, path, body}` is a channel-state
 * command, else null. */
export function channelCommandTarget({ method, path, body } = {}) {
  if (method !== 'POST' || typeof path !== 'string') return null;
  const match = path.match(CHANNEL_STATE_PATH);
  if (!match) return null;
  return { channelIdx: Number(match[1]), state: body?.state };
}

/**
 * Resolves null when the command may proceed, else
 * `{error: 'switch_locked'}` or `{error: 'min_off_time', retryAfterSeconds}`.
 * Min-off only restricts a command that turns the channel ON while it is
 * (per the cache) OFF; an unknown state or state_since never blocks.
 * Uses the database clock, the same clock state_since is written with.
 */
export async function checkChannelCommand(deviceId, channelIdx, state) {
  const { rows } = await pool.query(
    `SELECT (s.locked_at IS NOT NULL) AS locked, s.min_off_s, c.state,
            EXTRACT(EPOCH FROM (now() - c.state_since))::float8 AS state_age_s
     FROM (VALUES ($1::text, $2::int)) AS k(device_id, channel_idx)
     LEFT JOIN device_switches s ON s.device_id = k.device_id AND s.channel_idx = k.channel_idx
     LEFT JOIN cached_channel_state c ON c.device_id = k.device_id AND c.channel_idx = k.channel_idx`,
    [deviceId, channelIdx],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.locked) {
    return { error: 'switch_locked' };
  }
  if (
    state === 'ON' &&
    row.min_off_s != null &&
    row.state === 'OFF' &&
    row.state_age_s != null
  ) {
    const remaining = Number(row.min_off_s) - Number(row.state_age_s);
    if (remaining > 0) {
      return { error: 'min_off_time', retryAfterSeconds: Math.max(1, Math.ceil(remaining)) };
    }
  }
  return null;
}

/** A guard block as a `.code`-tagged Error, same convention as the
 * registry's device_offline/device_timeout rejections. */
export function guardError(block) {
  const err = new Error(block.error);
  err.code = block.error;
  if (block.retryAfterSeconds !== undefined) err.retryAfterSeconds = block.retryAfterSeconds;
  return err;
}

export function isGuardError(err) {
  return GUARD_ERROR_CODES.has(err?.code);
}

/** The internal-REST body (`{error}` / `{error, retryAfterSeconds}`) and
 * status for a guard block or guard Error. */
export function guardRestResponse(blockOrErr) {
  const code = blockOrErr.error ?? blockOrErr.code;
  if (code === 'switch_locked') {
    return { status: 423, body: { error: 'switch_locked' } };
  }
  return {
    status: 409,
    body: { error: 'min_off_time', retryAfterSeconds: blockOrErr.retryAfterSeconds },
  };
}
