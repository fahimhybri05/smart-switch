import { pool } from '../db/pool.js';

const VALID_ACTIONS = new Set(['ON', 'OFF']);
const VALID_TYPES = new Set(['once', 'daily', 'weekly', 'countdown', 'sunrise', 'sunset']);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 1-7 (ISO weekday, 1=Mon) -> bitmask, bit (day-1). Mirrors the old
 * firmware's handlePostSchedules packing days[] into days_mask. */
function daysArrayToMask(days) {
  if (!Array.isArray(days)) return 0;
  return days.reduce((mask, day) => (Number.isInteger(day) && day >= 1 && day <= 7 ? mask | (1 << (day - 1)) : mask), 0);
}

/** Inverse of daysArrayToMask — used when reading a schedule back out onto the wire. */
function maskToDaysArray(mask) {
  const days = [];
  for (let day = 1; day <= 7; day += 1) {
    if (mask & (1 << (day - 1))) days.push(day);
  }
  return days;
}

/** DB row -> wire shape, matching app/lib/models/device/schedule.dart's
 * Schedule.fromJson field-for-field. Optional fields are included only
 * when meaningful for this schedule's `type`, same as the old firmware's
 * GET /api/config ("conditionally time/days/duration_s"). */
function rowToScheduleWire(row) {
  const wire = {
    id: row.id,
    channel_idx: row.channel_idx,
    action: row.action,
    type: row.type,
    enabled: row.enabled,
  };
  if (row.time != null) wire.time = row.time;
  if (row.days_mask) wire.days = maskToDaysArray(row.days_mask);
  if (row.duration_s != null) wire.duration_s = row.duration_s;
  if (row.solar_offset_min != null) wire.solar_offset_min = row.solar_offset_min;
  return wire;
}

const SCHEDULE_COLUMNS =
  'id, channel_idx, action, type, time, days_mask, duration_s, solar_offset_min, enabled';

/** All of a device's schedules, wire-shaped — used by deviceApi/info.js's getConfig. */
export async function listSchedules(deviceId) {
  const { rows } = await pool.query(
    `SELECT ${SCHEDULE_COLUMNS} FROM device_schedules WHERE device_id = $1 ORDER BY id`,
    [deviceId],
  );
  return rows.map(rowToScheduleWire);
}

/**
 * Create (empty/missing `id`) or update (non-empty `id`) a schedule —
 * mirrors the old firmware's `handlePostSchedules`/`ConfigStore::upsertSchedule`
 * contract exactly: a supplied `id` must already exist (404 otherwise,
 * this is NOT an upsert-by-caller-chosen-id), an empty/missing `id` always
 * creates a new row under a backend-generated id (see
 * migrations/006_device_config.sql's device_schedule_id_seq comment).
 */
export async function upsertSchedule(deviceId, body) {
  const channelIdx = Number(body?.channel_idx);
  if (!Number.isInteger(channelIdx) || channelIdx < 0) {
    return { status: 400, body: { error: 'channel_idx must be a non-negative integer' } };
  }
  const action = body?.action;
  if (!VALID_ACTIONS.has(action)) {
    return { status: 400, body: { error: 'action must be ON or OFF' } };
  }
  const type = body?.type;
  if (!VALID_TYPES.has(type)) {
    return { status: 400, body: { error: `type must be one of ${[...VALID_TYPES].join(', ')}` } };
  }
  if (body?.time !== undefined && body.time !== null && !TIME_RE.test(body.time)) {
    return { status: 400, body: { error: 'time must be HH:MM' } };
  }

  const isSolar = type === 'sunrise' || type === 'sunset';
  if (isSolar) {
    const { rows: settingsRows } = await pool.query(
      'SELECT location_set FROM device_settings WHERE device_id = $1',
      [deviceId],
    );
    if (!settingsRows[0]?.location_set) {
      return { status: 400, body: { error: 'device location not configured' } };
    }
  }
  if (
    body?.solar_offset_min != null &&
    (!Number.isInteger(body.solar_offset_min) || body.solar_offset_min < -180 || body.solar_offset_min > 180)
  ) {
    return { status: 400, body: { error: 'solar_offset_min out of range' } };
  }
  if (type === 'countdown' && (!Number.isInteger(body?.duration_s) || body.duration_s <= 0)) {
    return { status: 400, body: { error: 'duration_s must be a positive integer for countdown' } };
  }

  const time = body?.time ?? null;
  const daysMask = daysArrayToMask(body?.days);
  const durationS = Number.isInteger(body?.duration_s) ? body.duration_s : null;
  const solarOffsetMin = Number.isInteger(body?.solar_offset_min) ? body.solar_offset_min : null;
  const enabled = body?.enabled ?? true;

  const id = body?.id;
  if (id) {
    // Countdown re-arms only on a disabled->enabled transition, so a plain
    // edit doesn't restart it — same rule as the old firmware.
    const { rows } = await pool.query(
      `UPDATE device_schedules SET
         channel_idx = $3, action = $4, type = $5, time = $6,
         days_mask = $7, duration_s = $8, solar_offset_min = $9, enabled = $10,
         countdown_started_at = CASE
           WHEN $5 <> 'countdown' THEN NULL
           WHEN NOT device_schedules.enabled AND $10 THEN now()
           ELSE COALESCE(device_schedules.countdown_started_at, now())
         END
       WHERE device_id = $1 AND id = $2
       RETURNING ${SCHEDULE_COLUMNS}`,
      [deviceId, id, channelIdx, action, type, time, daysMask, durationS, solarOffsetMin, enabled],
    );
    if (!rows[0]) {
      return { status: 404, body: { error: 'schedule not found' } };
    }
    return { status: 200, body: rowToScheduleWire(rows[0]) };
  }

  const { rows } = await pool.query(
    `INSERT INTO device_schedules
       (id, device_id, channel_idx, action, type, time, days_mask, duration_s, solar_offset_min, enabled,
        countdown_started_at)
     VALUES ('s-' || nextval('device_schedule_id_seq'), $1, $2, $3, $4, $5, $6, $7, $8, $9,
        CASE WHEN $4 = 'countdown' THEN now() END)
     RETURNING ${SCHEDULE_COLUMNS}`,
    [deviceId, channelIdx, action, type, time, daysMask, durationS, solarOffsetMin, enabled],
  );
  return { status: 200, body: rowToScheduleWire(rows[0]) };
}

/** 404 if `id` doesn't exist for this device, else 204 — matches the old
 * firmware's `handleDeleteSchedule`. */
export async function deleteSchedule(deviceId, id) {
  const { rows } = await pool.query(
    'DELETE FROM device_schedules WHERE device_id = $1 AND id = $2 RETURNING id',
    [deviceId, id],
  );
  if (!rows[0]) {
    return { status: 404, body: { error: 'schedule not found' } };
  }
  return { status: 204, body: null };
}
