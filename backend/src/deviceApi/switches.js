import { pool } from '../db/pool.js';
import { pushHwConfigToDevice } from './hwConfig.js';
import { DEFAULT_CHANNEL_COUNT } from './constants.js';

const VALID_INPUT_MODES = new Set(['DISABLED', 'TOGGLE', 'EDGE']);

// Nullable per-switch safety/energy fields: [wire key, min, max]. NULL
// clears the setting (feature off); omitted keeps the stored value.
const NULLABLE_INT_FIELDS = [
  ['watts', 0, 100_000],
  ['max_on_s', 1, 604_800],
  ['min_off_s', 1, 86_400],
];

export const SWITCH_COLUMNS = `channel_idx, name, zone, type, default_boot_state, input_mode, inching_ms,
  watts, max_on_s, min_off_s, (locked_at IS NOT NULL) AS locked, locked_at`;

/**
 * Create-or-update a switch by `channel_idx` — mirrors the old firmware's
 * `handlePostSwitches`/`ConfigStore::upsertSwitch` (docs/firmware-esp8266.md
 * §5/§7). `type` is always forced to `"ON_OFF"` server-side regardless of
 * caller input, same as the old firmware ("this board is ON/OFF only").
 *
 * Also takes the safety/energy fields `watts`, `max_on_s`, `min_off_s`
 * (int, or null to clear) and `locked` (bool); each keeps its stored value
 * when omitted. Locking records `locked_at`/`locked_by` (`actorUserId`, null
 * when unknown) — re-sending `locked: true` for an already-locked switch
 * keeps the original lock time/actor; `locked: false` clears both.
 */
export async function upsertSwitch(deviceId, body, { actorUserId = null } = {}) {
  const channelIdx = Number(body?.channel_idx);
  if (!Number.isInteger(channelIdx) || channelIdx < 0 || channelIdx >= DEFAULT_CHANNEL_COUNT) {
    return { status: 400, body: { error: `channel_idx must be within [0, ${DEFAULT_CHANNEL_COUNT})` } };
  }

  const extra = {};
  for (const [field, min, max] of NULLABLE_INT_FIELDS) {
    const value = body?.[field];
    extra[`${field}Provided`] = value !== undefined;
    if (value === undefined || value === null) {
      extra[field] = null;
    } else if (Number.isInteger(value) && value >= min && value <= max) {
      extra[field] = value;
    } else {
      return { status: 400, body: { error: `${field} must be an integer within [${min}, ${max}] or null` } };
    }
  }
  const lockedProvided = body?.locked !== undefined;
  if (lockedProvided && typeof body.locked !== 'boolean') {
    return { status: 400, body: { error: 'locked must be a boolean' } };
  }
  const locked = lockedProvided ? body.locked : false;

  // Never NULL: the app parses name/zone as non-nullable strings, and the
  // old firmware always sent "" for an unset value.
  const name = body?.name ?? '';
  const zone = body?.zone ?? '';
  const type = 'ON_OFF';
  const defaultBootState = body?.default_boot_state === 'ON' ? 'ON' : 'OFF';
  const inputModeProvided = body?.input_mode !== undefined;
  const inputMode = VALID_INPUT_MODES.has(body?.input_mode) ? body.input_mode : 'DISABLED';
  const inchingMsProvided = body?.inching_ms !== undefined;
  const inchingMs = Number.isInteger(body?.inching_ms) ? body.inching_ms : 0;

  const { rows } = await pool.query(
    `INSERT INTO device_switches (device_id, channel_idx, name, zone, type, default_boot_state, input_mode, inching_ms,
                                  watts, max_on_s, min_off_s, locked_at, locked_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $11, $13, $15,
             CASE WHEN $17::boolean THEN now() END, CASE WHEN $17::boolean THEN $18::bigint END)
     ON CONFLICT (device_id, channel_idx) DO UPDATE SET
       name = EXCLUDED.name,
       zone = EXCLUDED.zone,
       type = EXCLUDED.type,
       default_boot_state = EXCLUDED.default_boot_state,
       -- Omitted hw fields keep their stored value rather than silently
       -- resetting to the defaults (which the device would never hear about).
       input_mode = CASE WHEN $9 THEN EXCLUDED.input_mode ELSE device_switches.input_mode END,
       inching_ms = CASE WHEN $10 THEN EXCLUDED.inching_ms ELSE device_switches.inching_ms END,
       -- Same preserve-when-omitted rule for the safety/energy fields.
       watts = CASE WHEN $12 THEN EXCLUDED.watts ELSE device_switches.watts END,
       max_on_s = CASE WHEN $14 THEN EXCLUDED.max_on_s ELSE device_switches.max_on_s END,
       min_off_s = CASE WHEN $16 THEN EXCLUDED.min_off_s ELSE device_switches.min_off_s END,
       locked_by = CASE
         WHEN NOT $19::boolean THEN device_switches.locked_by
         WHEN NOT $17::boolean THEN NULL
         WHEN device_switches.locked_at IS NOT NULL THEN device_switches.locked_by
         ELSE $18::bigint
       END,
       locked_at = CASE
         WHEN NOT $19::boolean THEN device_switches.locked_at
         WHEN NOT $17::boolean THEN NULL
         ELSE COALESCE(device_switches.locked_at, now())
       END
     RETURNING ${SWITCH_COLUMNS}`,
    [deviceId, channelIdx, name, zone, type, defaultBootState, inputMode, inchingMs,
      inputModeProvided, inchingMsProvided,
      extra.watts, extra.wattsProvided, extra.max_on_s, extra.max_on_sProvided,
      extra.min_off_s, extra.min_off_sProvided, locked, actorUserId, lockedProvided],
  );

  // Only re-push hw config when the request actually touched a
  // hw-relevant field — a plain name/zone rename doesn't need it. This
  // checks "did the request mention the field" rather than "did the value
  // actually change" (simpler, and a redundant fire-and-forget push is
  // harmless — the device treats it as idempotent cache state either way).
  // The safety/energy fields and the lock are backend-only (enforced on the
  // command path), so they never need a push.
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
