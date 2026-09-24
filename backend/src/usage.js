import { z } from 'zod';

import { pool } from './db/pool.js';
import { DEFAULT_CHANNEL_COUNT } from './deviceApi/constants.js';

/**
 * Usage stats: per-switch ON time per household-local day, from
 * activity_log (the append-only record of every confirmed state change).
 *
 * The interval math is pure and exported for unit tests; getUsage() only
 * loads rows and feeds them through it.
 */

export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

// ---------------------------------------------------------------------------
// Time zone helpers (Intl only — no tz library in this project).
// ---------------------------------------------------------------------------

/** `timeZone` when Intl knows it, else 'UTC'. */
export function resolveTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function localParts(timeZone, ms) {
  const map = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) map[p.type] = p.value;
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    h: Number(map.hour) % 24,
    mi: Number(map.minute),
    s: Number(map.second),
  };
}

/** Offset (local - UTC) in ms of `timeZone` at instant `ms`. */
function offsetMs(timeZone, ms) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = localParts(timeZone, whole);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - whole;
}

/** The instant of local midnight starting calendar day y-m-d in `timeZone`
 * (two passes so a DST change between guess and answer is accounted for). */
export function zonedMidnightMs(timeZone, y, m, d) {
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - offsetMs(timeZone, wall);
  return wall - offsetMs(timeZone, first);
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * The last `days` local calendar days (oldest first, today last) as
 * `{key: 'YYYY-MM-DD', startMs, endMs}`; endMs is the next local midnight.
 */
export function dayWindows(timeZone, days, nowMs) {
  const today = localParts(timeZone, nowMs);
  const windows = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(today.y, today.m - 1, today.d - i));
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    windows.push({
      key: `${y}-${pad(m)}-${pad(d)}`,
      startMs: zonedMidnightMs(timeZone, y, m, d),
      endMs: zonedMidnightMs(timeZone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
    });
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Interval math.
// ---------------------------------------------------------------------------

/**
 * ON intervals `[[startMs, endMs], ...]` within `[startMs, endMs]`.
 * - `events`: `[{state, at}]` (at = ms), ascending; consecutive duplicate
 *   states are collapsed (an echo replay of ON doesn't restart anything);
 *   events outside the window are ignored.
 * - `initialState`: the last known state before the window — ON means the
 *   switch counts from the window start.
 * - A switch still ON at the end counts until `endMs` (pass "now").
 */
export function onIntervals(events, { initialState = null, startMs, endMs }) {
  const intervals = [];
  let current = initialState;
  let onSince = current === 'ON' ? startMs : null;
  for (const { state, at } of events) {
    if (at < startMs || at > endMs) continue;
    if (state === current) continue;
    if (state === 'ON') {
      onSince = at;
    } else if (onSince !== null) {
      if (at > onSince) intervals.push([onSince, at]);
      onSince = null;
    }
    current = state;
  }
  if (onSince !== null && endMs > onSince) {
    intervals.push([onSince, endMs]);
  }
  return intervals;
}

/** Whole seconds of `intervals` falling in each window. */
export function bucketSeconds(intervals, windows) {
  return windows.map(({ startMs, endMs }) => {
    let ms = 0;
    for (const [a, b] of intervals) {
      const lo = Math.max(a, startMs);
      const hi = Math.min(b, endMs);
      if (hi > lo) ms += hi - lo;
    }
    return Math.round(ms / 1000);
  });
}

export function kwhFor(onSeconds, watts) {
  return watts == null ? null : (onSeconds * watts) / 3.6e6;
}

/** Everything one switch contributes to a usage response. */
export function summarizeSwitch({ events, initialState, windows, nowMs, watts }) {
  if (windows.length === 0) {
    return { dailyOnSeconds: [], totalOnSeconds: 0, kwh: kwhFor(0, watts) };
  }
  const intervals = onIntervals(events, {
    initialState,
    startMs: windows[0].startMs,
    endMs: Math.min(nowMs, windows[windows.length - 1].endMs),
  });
  const dailyOnSeconds = bucketSeconds(intervals, windows);
  const totalOnSeconds = dailyOnSeconds.reduce((a, b) => a + b, 0);
  return { dailyOnSeconds, totalOnSeconds, kwh: kwhFor(totalOnSeconds, watts) };
}

// ---------------------------------------------------------------------------
// Loader.
// ---------------------------------------------------------------------------

const SWITCH_FILTER = `d.household_id = $1 AND ($2::text IS NULL OR s.device_id = $2) AND s.channel_idx < $3`;

/**
 * Usage for every configured switch (device_switches) of `householdId`'s
 * devices — or of one device when `deviceId` is given (caller has already
 * checked it belongs to the household). Only this household's activity
 * rows count, so a reclaimed device never shows a previous owner's history.
 */
export async function getUsage({ householdId, deviceId = null, days, now = new Date() }) {
  const nowMs = now.getTime();
  const { rows: householdRows } = await pool.query('SELECT timezone FROM households WHERE id = $1', [
    householdId,
  ]);
  const timezone = resolveTimeZone(householdRows[0]?.timezone);
  const windows = dayWindows(timezone, days, nowMs);
  const windowStart = new Date(windows[0].startMs);
  const params = [householdId, deviceId, DEFAULT_CHANNEL_COUNT, windowStart];

  const [{ rows: switchRows }, { rows: initialRows }, { rows: eventRows }] = await Promise.all([
    pool.query(
      `SELECT s.device_id, d.friendly_name, s.channel_idx, s.name, s.watts
       FROM device_switches s
       JOIN devices d ON d.device_id = s.device_id
       WHERE ${SWITCH_FILTER}
       ORDER BY s.device_id, s.channel_idx`,
      params.slice(0, 3),
    ),
    pool.query(
      `SELECT s.device_id, s.channel_idx, last.state
       FROM device_switches s
       JOIN devices d ON d.device_id = s.device_id
       CROSS JOIN LATERAL (
         SELECT a.state FROM activity_log a
         WHERE a.household_id = $1 AND a.device_id = s.device_id AND a.channel_idx = s.channel_idx
           AND a.created_at < $4
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 1
       ) last
       WHERE ${SWITCH_FILTER}`,
      params,
    ),
    pool.query(
      `SELECT a.device_id, a.channel_idx, a.state, a.created_at
       FROM activity_log a
       WHERE a.household_id = $1 AND ($2::text IS NULL OR a.device_id = $2) AND a.channel_idx < $3
         AND a.created_at >= $4
       ORDER BY a.created_at, a.id`,
      params,
    ),
  ]);

  const keyOf = (dev, idx) => `${dev}:${Number(idx)}`;
  const initialByKey = new Map(initialRows.map((r) => [keyOf(r.device_id, r.channel_idx), r.state]));
  const eventsByKey = new Map();
  for (const r of eventRows) {
    const k = keyOf(r.device_id, r.channel_idx);
    if (!eventsByKey.has(k)) eventsByKey.set(k, []);
    eventsByKey.get(k).push({ state: r.state, at: new Date(r.created_at).getTime() });
  }

  const switches = switchRows.map((r) => {
    const channelIdx = Number(r.channel_idx);
    const k = keyOf(r.device_id, channelIdx);
    const watts = r.watts == null ? null : Number(r.watts);
    return {
      deviceId: r.device_id,
      deviceName: r.friendly_name ?? r.device_id,
      channelIdx,
      name: r.name && r.name.trim() !== '' ? r.name : `Channel ${channelIdx}`,
      watts,
      ...summarizeSwitch({
        events: eventsByKey.get(k) ?? [],
        initialState: initialByKey.get(k) ?? null,
        windows,
        nowMs,
        watts,
      }),
    };
  });

  const withKwh = switches.filter((s) => s.kwh !== null);
  return {
    timezone,
    days: windows.map((w) => w.key),
    switches,
    totals: {
      onSeconds: switches.reduce((a, s) => a + s.totalOnSeconds, 0),
      kwh: withKwh.length ? withKwh.reduce((a, s) => a + s.kwh, 0) : null,
    },
  };
}
