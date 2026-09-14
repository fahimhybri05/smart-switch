import { pool } from '../db/pool.js';
import { fireAutomation } from './engine.js';

const TICK_MS = 60_000;
const DAY_NUMBER = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** 1=Mon..7=Sun + 'HH:MM', computed in `timezone` — no moment/luxon needed. */
function localDayAndTime(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { day: DAY_NUMBER[map.weekday], hhmm: `${map.hour}:${map.minute}` };
}

async function tick() {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.household_id, a.name, a.actions, a.schedule_days, a.schedule_time, a.last_fired_at,
              h.timezone
       FROM automations a
       JOIN households h ON h.id = a.household_id
       WHERE a.trigger_type = 'schedule' AND a.enabled`,
    );
    const now = Date.now();
    for (const row of rows) {
      if (!row.schedule_days || !row.schedule_time) continue;
      const { day, hhmm } = localDayAndTime(row.timezone);
      if (!row.schedule_days.includes(day)) continue;
      if (row.schedule_time.slice(0, 5) !== hhmm) continue;
      // Double-fire guard: 60s tick granularity means a schedule normally
      // matches on exactly one tick; skip if we already fired very recently.
      if (row.last_fired_at && now - new Date(row.last_fired_at).getTime() < 55_000) continue;
      await fireAutomation(row);
    }
  } catch (err) {
    console.error('automation scheduler tick failed', err);
  }
}

/** Returns a stop function — call from server.js's graceful shutdown. */
export function startAutomationScheduler() {
  const handle = setInterval(tick, TICK_MS);
  return () => clearInterval(handle);
}
