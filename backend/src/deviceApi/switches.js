import { pool } from '../db/pool.js';
import { pushHwConfigToDevice } from './hwConfig.js';
import { DEFAULT_CHANNEL_COUNT } from './constants.js';

const VALID_INPUT_MODES = new Set(['DISABLED', 'TOGGLE', 'EDGE']);

/**
 * Create-or-update a switch by `channel_idx` — mirrors the old firmware's
 * `handlePostSwitches`/`ConfigStore::upsertSwitch` (docs/firmware-esp8266.md
 * §5/§7). `type` is always forced to `"ON_OFF"` server-side regardless of
 * caller input, same as the old firmware ("this board is ON/OFF only").
 */
export async function upsertSwitch(deviceId, body) {
  const channelIdx = Number(body?.channel_idx);
  if (!Number.isInteger(channelIdx) || channelIdx < 0 || channelIdx >= DEFAULT_CHANNEL_COUNT) {
    return { status: 400, body: { error: `channel_idx must be within [0, ${DEFAULT_CHANNEL_COUNT})` } };
  }

  const name = body?.name ?? null;
  const zone = body?.zone ?? null;
  const type = 'ON_OFF';
  const defaultBootState = body?.default_boot_state === 'ON' ? 'ON' : 'OFF';
  const inputModeProvided = body?.input_mode !== undefined;
  const inputMode = VALID_INPUT_MODES.has(body?.input_mode) ? body.input_mode : 'DISABLED';
  const inchingMsProvided = body?.inching_ms !== undefined;
  const inchingMs = Number.isInteger(body?.inching_ms) ? body.inching_ms : 0;

  const { rows } = await pool.query(
    `INSERT INTO device_switches (device_id, channel_idx, name, zone, type, default_boot_state, input_mode, inching_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (device_id, channel_idx) DO UPDATE SET
       name = EXCLUDED.name,
       zone = EXCLUDED.zone,
       type = EXCLUDED.type,
       default_boot_state = EXCLUDED.default_boot_state,
       -- Omitted hw fields keep their stored value rather than silently
       -- resetting to the defaults (which the device would never hear about).
       input_mode = CASE WHEN $9 THEN EXCLUDED.input_mode ELSE device_switches.input_mode END,
       inching_ms = CASE WHEN $10 THEN EXCLUDED.inching_ms ELSE device_switches.inching_ms END
     RETURNING channel_idx, name, zone, type, default_boot_state, input_mode, inching_ms`,
    [deviceId, channelIdx, name, zone, type, defaultBootState, inputMode, inchingMs,
      inputModeProvided, inchingMsProvided],
  );

  // Only re-push hw config when the request actually touched a
  // hw-relevant field — a plain name/zone rename doesn't need it. This
  // checks "did the request mention the field" rather than "did the value
  // actually change" (simpler, and a redundant fire-and-forget push is
  // harmless — the device treats it as idempotent cache state either way).
  if (inputModeProvided || inchingMsProvided) {
    await pushHwConfigToDevice(deviceId);
  }

  return { status: 200, body: rows[0] };
}

/** 204 regardless of whether `channelIdx` existed — matches the old
 * firmware's `handleDeleteSwitch` (silent no-op on an unknown idx). */
export async function deleteSwitch(deviceId, channelIdx) {
  await pool.query('DELETE FROM device_switches WHERE device_id = $1 AND channel_idx = $2', [
    deviceId,
    channelIdx,
  ]);
  // The deleted switch may have carried hw-relevant fields — push the
  // updated (now-shorter) channel list so the device's cache doesn't keep
  // stale settings for a channel that no longer has a switch record.
  await pushHwConfigToDevice(deviceId);
  return { status: 204, body: null };
}
