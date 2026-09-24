/**
 * Pure helpers for device schedules and automation triggers: labels,
 * summaries and cheap "next run" hints. Device schedules run on the
 * device's flat UTC offset (DeviceConfig.utc_offset_min, pushed by the app —
 * see backend/src/deviceSchedules/scheduler.js); automation schedule
 * triggers run in the household's IANA timezone (automations/scheduler.js).
 */
import { formatDays } from './format';
import type { Schedule, ScheduleType } from './types';

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

export const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  once: 'Once',
  daily: 'Daily',
  weekly: 'Weekly',
  countdown: 'Countdown timer',
  sunrise: 'Sunrise',
  sunset: 'Sunset',
};

export const SCHEDULE_TYPES = Object.keys(SCHEDULE_TYPE_LABELS) as ScheduleType[];

export const isClockType = (t: ScheduleType) => t === 'once' || t === 'daily' || t === 'weekly';
export const isSolarType = (t: ScheduleType) => t === 'sunrise' || t === 'sunset';

/** 3725 → "1h 2m 5s" (zero parts dropped). */
export function formatDuration(totalS: number | undefined): string {
  const t = Math.max(0, Math.round(totalS ?? 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const parts = [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean);
  return parts.length ? parts.join(' ') : '0s';
}

export function splitDuration(totalS: number): { h: number; m: number; s: number } {
  const t = Math.max(0, Math.round(totalS));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
}

/** 330 → "UTC+05:30". */
export function formatUtcOffset(offsetMin: number): string {
  const sign = offsetMin < 0 ? '−' : '+';
  const abs = Math.abs(offsetMin);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function solarOffsetText(offsetMin: number | undefined): string {
  if (!offsetMin) return '';
  return offsetMin > 0 ? ` +${offsetMin} min` : ` −${Math.abs(offsetMin)} min`;
}

/** Human description of when a schedule fires ("Weekly at 07:30 · Mon, Tue"). */
export function scheduleWhen(s: Schedule): string {
  switch (s.type) {
    case 'once':
      return `Once at ${s.time ?? '—'}`;
    case 'daily':
      return `Every day at ${s.time ?? '—'}`;
    case 'weekly':
      return `${formatDays(s.days) || 'Weekly'} at ${s.time ?? '—'}`;
    case 'countdown':
      return `Countdown ${formatDuration(s.duration_s)}`;
    case 'sunrise':
      return `Sunrise${solarOffsetText(s.solar_offset_min)}`;
    case 'sunset':
      return `Sunset${solarOffsetText(s.solar_offset_min)}`;
  }
}

function parseHhMm(hhmm: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * Next firing time (as a real Date) of an enabled clock schedule, evaluated
 * in the device's flat UTC offset like the backend scheduler does. Null for
 * countdown/solar (the countdown's start time isn't on the wire; solar would
 * need the solar model) or disabled schedules.
 */
export function nextClockRun(s: Schedule, utcOffsetMin: number, now = new Date()): Date | null {
  if (!s.enabled || !isClockType(s.type)) return null;
  const target = parseHhMm(s.time);
  if (target == null) return null;
  const offsetMs = utcOffsetMin * 60_000;
  const localNow = new Date(now.getTime() + offsetMs); // read with getUTC*
  const midnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  for (let k = 0; k <= 7; k += 1) {
    const candidate = midnight + k * 86_400_000 + target * 60_000;
    if (candidate <= localNow.getTime()) continue;
    if (s.type === 'weekly') {
      const jsDay = new Date(candidate).getUTCDay();
      const day = jsDay === 0 ? 7 : jsDay;
      if (!s.days?.includes(day)) continue;
    }
    return new Date(candidate - offsetMs);
  }
  return null;
}

/** Minutes from now → "in 3h 20m" / "in 2d 4h" / "in <1m". */
export function formatIn(minutes: number): string {
  if (minutes < 1) return 'in <1m';
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = Math.floor(minutes % 60);
  if (d > 0) return `in ${d}d${h ? ` ${h}h` : ''}`;
  if (h > 0) return `in ${h}h${m ? ` ${m}m` : ''}`;
  return `in ${m}m`;
}

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Weekday (1=Mon..7=Sun), minutes since midnight and "HH:MM" in an IANA zone. */
export function zonedNow(timeZone: string, now = new Date()): { day: number; minutes: number; hhmm: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    const h = Number(map.hour);
    const m = Number(map.minute);
    return {
      day: WEEKDAY[map.weekday] ?? 1,
      minutes: h * 60 + m,
      hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    };
  } catch {
    return null;
  }
}

/**
 * Minutes until an automation schedule trigger next fires in `timeZone`
 * (ignores a DST jump in between — it's only a hint). Null if it never does.
 */
export function minutesUntilZoned(days: number[], time: string, timeZone: string, now = new Date()): number | null {
  const target = parseHhMm(time);
  const z = zonedNow(timeZone, now);
  if (target == null || !z || days.length === 0) return null;
  for (let k = 0; k <= 7; k += 1) {
    const day = ((z.day - 1 + k) % 7) + 1;
    if (!days.includes(day)) continue;
    const delta = k * 1440 + target - z.minutes;
    if (delta > 0) return delta;
  }
  return null;
}

/** The browser's IANA timezone, if the runtime exposes it. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Every IANA zone the runtime knows (falls back to a short list). */
export function allTimeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    const list = intl.supportedValuesOf?.('timeZone');
    if (list?.length) return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    /* fall through */
  }
  return ['UTC', 'Europe/London', 'Europe/Berlin', 'Asia/Dhaka', 'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles'];
}
