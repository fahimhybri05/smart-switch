import { setChannelState } from '../deviceApi/channels.js';
import { pool } from '../db/pool.js';
import { isGuardError } from '../safety/guard.js';
import { localSolarMinutes } from './solar.js';

const TICK_MS = 60_000;

// Same rationale as automations/scheduler.js's identical constant: a short
// process outage (deploy, crash, restart) spanning the exact trigger
// minute would otherwise mean that occurrence is silently skipped forever.
// A short grace window lets the next tick after recovery still fire it.
const CATCH_UP_GRACE_MINUTES = 5;

// Matches automations/engine.js's RELAY_RETRY_DELAY_MS exactly, and for
// the same reason: a device schedule fire is unattended (no user to just
// retap it), and the ESP8266 cloud tunnel's baseline reconnect cadence
// (~4-9s) means one short bounded retry catches the common "device is
// mid-reconnect" case without materially delaying the action.
const RELAY_RETRY_DELAY_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// NOTE on why this isn't a util shared with automations/scheduler.js
// (judgment call, see report): device_settings.utc_offset_min is a flat
// UTC-offset-in-minutes, mirroring the old firmware's single
// `utc_offset_min` field (docs/firmware-esp8266.md §5) — NOT a DST-aware
// IANA timezone name like households.timezone, which is what
// automations/scheduler.js's localParts() resolves via Intl.DateTimeFormat.
// The two schedulers' "what is local time right now" inputs are genuinely
// different kinds of data, not just a formatting difference, so extracting
// one shared localParts() would need to paper over that. On top of that,
// docs/plan.md's own "What does not change" section lists automations/ as
// explicitly untouched by this pass, so retrofitting scheduler.js to call
// out to a new shared module was avoided even where the *shape* of the
// tick/day-match/catch-up-window logic below is deliberately copied from
// it. This file is self-contained.

/** 1=Mon..7=Sun, "YYYY-MM-DD", and minutes-since-midnight, all computed by
 * shifting `date` by a flat UTC-offset-in-minutes. */
function localPartsForOffset(utcOffsetMin, date) {
  const shifted = new Date(date.getTime() + utcOffsetMin * 60_000);
  const jsDay = shifted.getUTCDay(); // 0=Sun..6=Sat
  const yearStart = Date.UTC(shifted.getUTCFullYear(), 0, 1);
  return {
    day: jsDay === 0 ? 7 : jsDay,
    dateKey: shifted.toISOString().slice(0, 10),
    minutesSinceMidnight: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    yday: Math.floor((Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - yearStart) / 86_400_000),
  };
}

function parseHhMmToMinutes(hhmm) {
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

function maskIncludesDay(mask, day) {
  return (mask & (1 << (day - 1))) !== 0;
}

// Tracks the currently-running tick() call (including any in-flight
// fireDeviceSchedule() retry sleep), same purpose/shape as
// automations/scheduler.js's identical variable — lets graceful shutdown
// wait for it before device WS sockets are torn down.
let tickInFlight = null;

/**
 * One schedule's fire-and-bounded-retry actuation. Mirrors
 * automations/engine.js's fireAutomation retry shape, minus the loop/
 * cascade-protection machinery (a device schedule has no actions of its
 * own that could feed back into anything) and minus any on-device
 * fallback — the trimmed-down firmware holds no config to fall back to,
 * matching the user's own "hold last commanded state" offline decision
 * (docs/plan.md). If the device is offline or unreachable after the
 * retry, this is logged and otherwise silently skipped for this tick —
 * there's nowhere else for it to go.
 */
async function fireDeviceSchedule(row) {
  const doFire = () => setChannelState(row.device_id, row.channel_idx, row.action);
  // A refusal by the switch lock / min-off rules (safety/guard.js) is a
  // rule, not a transient failure: no retry, and the occurrence counts as
  // handled (last_fired_at below), so it isn't re-attempted on every tick
  // of the catch-up window.
  const logRefused = (err) =>
    console.warn(`device schedule ${row.id} (${row.device_id} ch${row.channel_idx}) refused: ${err.code}`);
  try {
    await doFire();
  } catch (firstErr) {
    if (isGuardError(firstErr)) {
      logRefused(firstErr);
    } else {
      await sleep(RELAY_RETRY_DELAY_MS);
      try {
        await doFire();
      } catch (retryErr) {
        if (!isGuardError(retryErr)) {
          console.error(
            `device schedule ${row.id} (${row.device_id} ch${row.channel_idx}) failed to fire (after 1 retry)`,
            retryErr,
          );
          return;
        }
        logRefused(retryErr);
      }
    }
  }
  // 'once' and 'countdown' are one-shot: disable after firing, same as the
  // old firmware's selfDisable().
  const oneShot = row.type === 'once' || row.type === 'countdown';
  await pool.query(
    `UPDATE device_schedules SET last_fired_at = now(), enabled = enabled AND NOT $3
     WHERE device_id = $1 AND id = $2`,
    [row.device_id, row.id, oneShot],
  );
}

/** Local minutes-since-midnight this clock/solar schedule targets today, or
 * null if it has no target today (bad time, no location, polar day/night). */
function targetMinutes(row, settings, yday) {
  if (row.type === 'sunrise' || row.type === 'sunset') {
    if (!settings.location_set) return null;
    const eventMin = localSolarMinutes(
      yday, settings.latitude, settings.longitude, settings.utc_offset_min, row.type === 'sunrise',
    );
    if (eventMin < 0) return null;
    return (((eventMin + (row.solar_offset_min ?? 0)) % 1440) + 1440) % 1440;
  }
  if (!row.time) return null;
  return parseHhMmToMinutes(row.time);
}

/**
 * One scheduler tick's worth of work. Exported directly (instead of only
 * inline in `setInterval`) so it's unit-testable without needing fake
 * timers for the interval itself — same reasoning as
 * ws/deviceServer.js's `runDeviceHeartbeatTick`.
 */
export async function runDeviceScheduleTick() {
  try {
    const { rows } = await pool.query(
      `SELECT s.device_id, s.id, s.channel_idx, s.action, s.type, s.days_mask, s.time,
              s.duration_s, s.solar_offset_min, s.countdown_started_at, s.last_fired_at,
              COALESCE(ds.utc_offset_min, 0) AS utc_offset_min,
              ds.latitude, ds.longitude, COALESCE(ds.location_set, false) AS location_set
       FROM device_schedules s
       LEFT JOIN device_settings ds ON ds.device_id = s.device_id
       WHERE s.enabled`,
    );
    if (rows.length === 0) return;

    const now = new Date();

    for (const row of rows) {
      if (row.type === 'countdown') {
        if (!row.countdown_started_at || row.duration_s == null) continue;
        const dueAt = new Date(row.countdown_started_at).getTime() + row.duration_s * 1000;
        if (now.getTime() >= dueAt) {
          await fireDeviceSchedule(row);
        }
        continue;
      }

      const { day, dateKey, minutesSinceMidnight, yday } = localPartsForOffset(row.utc_offset_min, now);
      // 'daily'/'once'/solar fire every day (the old firmware ignored
      // days_mask for them); only 'weekly' is day-filtered.
      if (row.type === 'weekly' && !maskIncludesDay(row.days_mask, day)) continue;

      const scheduledMinutes = targetMinutes(row, row, yday);
      if (scheduledMinutes == null) continue;
      const minutesLate = minutesSinceMidnight - scheduledMinutes;
      // Not reached yet today, or missed by more than the catch-up window.
      if (minutesLate < 0 || minutesLate > CATCH_UP_GRACE_MINUTES) continue;

      // Fires at most once per local day regardless of how many ticks land
      // inside the grace window.
      if (
        row.last_fired_at &&
        localPartsForOffset(row.utc_offset_min, new Date(row.last_fired_at)).dateKey === dateKey
      ) {
        continue;
      }

      await fireDeviceSchedule(row);
    }
  } catch (err) {
    console.error('device schedule scheduler tick failed', err);
  }
}

function runTick() {
  tickInFlight = runDeviceScheduleTick().finally(() => {
    tickInFlight = null;
  });
}

/** Returns a stop function — call from server.js's graceful shutdown,
 * alongside startAutomationScheduler()'s stop function. */
export function startDeviceScheduler() {
  const handle = setInterval(runTick, TICK_MS);
  return () => clearInterval(handle);
}

/**
 * Awaits whatever tick() call is currently in flight (if any) — including
 * an in-flight fireDeviceSchedule()'s retry-delay sleep — so graceful
 * shutdown can let a just-fired schedule's relay command actually reach
 * the device before its socket is torn down. Mirrors
 * automations/scheduler.js's waitForCurrentTick exactly. No-op if no tick
 * is running.
 */
export async function waitForCurrentDeviceScheduleTick() {
  if (tickInFlight) {
    await tickInFlight;
  }
}
