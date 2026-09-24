import { pool } from './db/pool.js';
import { setChannelState } from './deviceApi/channels.js';
import { DEFAULT_CHANNEL_COUNT } from './deviceApi/constants.js';
import { noteExpectedStateChange } from './ws/attribution.js';
import { isDeviceOnline } from './ws/registry.js';

/**
 * Shared switch service for the public API (`/v1`) and hook URLs: one
 * canonical "switch" view (name/zone from device_switches, live state from
 * cached_channel_state, online from the in-memory registry) and one
 * actuation path, so both surfaces behave identically.
 */

export class SwitchError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    // e.g. `retryAfterSeconds` for min_off_time — included in the /v1 error body.
    this.extra = extra;
  }
}

export function formatSwitchId(deviceId, channelIdx) {
  return `${deviceId}:${channelIdx}`;
}

/** `"esp8266-3d87ce:0"` -> `{deviceId, channelIdx}`, or null. Splits on the
 * LAST `:` so a device id containing colons still round-trips. */
export function parseSwitchId(id) {
  if (typeof id !== 'string') return null;
  const i = id.lastIndexOf(':');
  if (i <= 0) return null;
  const deviceId = id.slice(0, i);
  const channel = id.slice(i + 1);
  if (!/^\d{1,3}$/.test(channel)) return null;
  const channelIdx = Number(channel);
  if (channelIdx >= DEFAULT_CHANNEL_COUNT) return null;
  return { deviceId, channelIdx };
}

function toApiState(cached) {
  if (cached === 'ON') return 'on';
  if (cached === 'OFF') return 'off';
  return 'unknown';
}

function rowToSwitch(row) {
  const name = row.name && row.name.trim() !== '' ? row.name : `Channel ${row.channel_idx}`;
  return {
    id: formatSwitchId(row.device_id, row.channel_idx),
    deviceId: row.device_id,
    deviceName: row.friendly_name ?? row.device_id,
    channel: row.channel_idx,
    name,
    zone: row.zone ?? '',
    state: toApiState(row.state),
    online: isDeviceOnline(row.device_id),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

const SWITCH_SELECT = `
  SELECT d.device_id, d.friendly_name, gs.idx AS channel_idx,
         s.name, s.zone, c.state, c.updated_at
  FROM devices d
  CROSS JOIN generate_series(0, $2::int - 1) AS gs(idx)
  LEFT JOIN device_switches s ON s.device_id = d.device_id AND s.channel_idx = gs.idx
  LEFT JOIN cached_channel_state c ON c.device_id = d.device_id AND c.channel_idx = gs.idx
  WHERE d.household_id = ANY($1::bigint[])`;

/** Every physical channel of every device in `householdIds` (optionally
 * one device only), ordered by device then channel. */
export async function listSwitchesForHouseholds(householdIds, { deviceId } = {}) {
  if (householdIds.length === 0) return [];
  const { rows } = await pool.query(
    `${SWITCH_SELECT} AND ($3::text IS NULL OR d.device_id = $3)
     ORDER BY d.device_id, gs.idx`,
    [householdIds, DEFAULT_CHANNEL_COUNT, deviceId ?? null],
  );
  return rows.map(rowToSwitch);
}

/** One switch, or null when it doesn't exist or isn't in `householdIds`. */
export async function getSwitch(householdIds, deviceId, channelIdx) {
  if (householdIds.length === 0) return null;
  const { rows } = await pool.query(
    `${SWITCH_SELECT} AND d.device_id = $3 AND gs.idx = $4`,
    [householdIds, DEFAULT_CHANNEL_COUNT, deviceId, channelIdx],
  );
  return rows[0] ? rowToSwitch(rows[0]) : null;
}

/** Toggle target from a switch's current (cached) state — unknown turns ON. */
export function toggleTarget(currentState) {
  return currentState === 'on' ? 'off' : 'on';
}

/**
 * Actuates one channel. `state` is 'on'|'off'. Notes attribution first (so
 * the device's confirming `state_changed` echo is logged with `source`),
 * then relays via setChannelState. Resolves with the confirmed state
 * ('on'|'off'); throws SwitchError 503 device_offline / 504 device_timeout
 * / 502 device_error, or — from the safety guard enforced inside the relay
 * (safety/guard.js) — 423 switch_locked / 409 min_off_time (with
 * `extra.retryAfterSeconds`).
 */
export async function actuate({ deviceId, channelIdx, state, source, actorUserId = null }) {
  const wire = state === 'on' ? 'ON' : 'OFF';
  if (!isDeviceOnline(deviceId)) {
    throw new SwitchError(503, 'device_offline', 'The device is offline.');
  }
  noteExpectedStateChange(deviceId, channelIdx, wire, { source, actorUserId });
  let result;
  try {
    result = await setChannelState(deviceId, channelIdx, wire);
  } catch (err) {
    if (err.code === 'device_offline') {
      throw new SwitchError(503, 'device_offline', 'The device is offline.');
    }
    if (err.code === 'device_timeout') {
      throw new SwitchError(504, 'device_timeout', 'The device did not respond in time.');
    }
    if (err.code === 'switch_locked') {
      throw new SwitchError(423, 'switch_locked', 'This switch is locked.');
    }
    if (err.code === 'min_off_time') {
      throw new SwitchError(
        409,
        'min_off_time',
        `This switch must stay off for another ${err.retryAfterSeconds}s before it can be turned on.`,
        { retryAfterSeconds: err.retryAfterSeconds },
      );
    }
    throw err;
  }
  if (!result || result.status < 200 || result.status >= 300) {
    throw new SwitchError(502, 'device_error', 'The device rejected the command.');
  }
  const confirmed = result.body?.state;
  return confirmed === 'ON' || confirmed === 'OFF' ? toApiState(confirmed) : state;
}

/** Actuates and returns the switch view with the new state applied (the
 * device's own `state_changed` echo updates the cache moments later). */
export async function actuateSwitch(sw, state, { source, actorUserId }) {
  const newState = await actuate({
    deviceId: sw.deviceId,
    channelIdx: sw.channel,
    state,
    source,
    actorUserId,
  });
  return { ...sw, state: newState, online: true, updatedAt: new Date().toISOString() };
}
