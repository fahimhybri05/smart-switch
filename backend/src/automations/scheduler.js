import { pool } from '../db/pool.js';
import { fireAutomation } from './engine.js';

const TICK_MS = 60_000;
const DAY_NUMBER = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// How late a schedule is allowed to catch up and still fire — e.g. the
// process being down (deploy, crash, restart) for a couple of minutes
// across the exact trigger time used to mean that occurrence was silently
// skipped forever (no backfill). A short grace window lets the next tick
// after recovery still fire it, without firing something hours-stale after
// a longer outage.
const CATCH_UP_GRACE_MINUTES = 5;

/** 1=Mon..7=Sun, "YYYY-MM-DD", and minutes-since-midnight, all computed in
 * `timezone` for the given `date` — no moment/luxon needed. */
function localParts(timezone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    day: DAY_NUMBER[map.weekday],
    dateKey: `${map.year}-${map.month}-${map.day}`,
    minutesSinceMidnight: Number(map.hour) * 60 + Number(map.minute),
  };
}

function parseHhMmToMinutes(hhmm) {
  const [h, m] = hhmm.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

// Tracks the currently-running tick() call (including any in-flight
// fireAutomation() retry sleep) so graceful shutdown can wait for it to
// finish before tearing down device WS sockets out from under it — see
// waitForCurrentTick below.
let tickInFlight = null;

async function tick() {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.household_id, a.name, a.actions, a.schedule_days, a.schedule_time, a.last_fired_at,
              h.timezone
       FROM automations a
       JOIN households h ON h.id = a.household_id
       WHERE a.trigger_type = 'schedule' AND a.enabled`,
    );
    const now = new Date();
    for (const row of rows) {
      if (!row.schedule_days || !row.schedule_time) continue;

      const { day, dateKey, minutesSinceMidnight } = localParts(row.timezone, now);
      if (!row.schedule_days.includes(day)) continue;

      const scheduledMinutes = parseHhMmToMinutes(row.schedule_time);
      const minutesLate = minutesSinceMidnight - scheduledMinutes;
      // Not reached yet today, or missed by more than the catch-up window —
      // either way, don't fire this tick.
      if (minutesLate < 0 || minutesLate > CATCH_UP_GRACE_MINUTES) continue;

      // Per-calendar-day guard (in the household's own timezone), not a
      // rolling time-since-last-fire window — this is what makes catch-up
      // safe: a schedule fires at most once per local day regardless of how
      // many ticks land inside the grace window above, and a late
      // catch-up fire still counts as "done for today".
      if (row.last_fired_at && localParts(row.timezone, new Date(row.last_fired_at)).dateKey === dateKey) {
        continue;
      }

      await fireAutomation(row);
    }
  } catch (err) {
    console.error('automation scheduler tick failed', err);
  }
}

function runTick() {
  tickInFlight = tick().finally(() => {
    tickInFlight = null;
  });
}

/** Returns a stop function — call from server.js's graceful shutdown. */
export function startAutomationScheduler() {
  const handle = setInterval(runTick, TICK_MS);
  return () => clearInterval(handle);
}

/**
 * Awaits whatever tick() call is currently in flight (if any) — including
 * an in-flight fireAutomation()'s RELAY_RETRY_DELAY_MS sleep — so graceful
 * shutdown can let an automation's relay commands actually reach devices
 * before their sockets are torn down. No-op if no tick is running.
 */
export async function waitForCurrentTick() {
  if (tickInFlight) {
    await tickInFlight;
  }
}
