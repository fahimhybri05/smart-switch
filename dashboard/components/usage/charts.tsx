'use client';

import { useState } from 'react';

import { cn } from '@/lib/utils';

/* ------------------------------- Formatting ------------------------------ */

/** 12_000 → "3h 20m", 900 → "15m", 20 → "<1m", 0 → "0m". */
export function formatOnTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return '0m';
  if (s < 60) return '<1m';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (h >= 100) return `${h.toLocaleString()}h`;
  return m === 60 ? `${h + 1}h` : m ? `${h}h ${m}m` : `${h}h`;
}

/** kWh with sensible precision; null → "—". */
export function formatKwh(kwh: number | null | undefined, unit = true): string {
  if (kwh == null || !Number.isFinite(kwh)) return '—';
  const v =
    kwh === 0 ? '0' : kwh < 0.01 ? '<0.01' : kwh < 10 ? kwh.toFixed(2) : kwh < 100 ? kwh.toFixed(1) : Math.round(kwh).toLocaleString();
  return unit ? `${v} kWh` : v;
}

function parseDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** Axis label: weekday for a week, "Sep 3" otherwise. */
export function dayLabel(day: string, short: boolean): string {
  const d = parseDay(day);
  if (!d) return day;
  return short
    ? d.toLocaleDateString(undefined, { weekday: 'short' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function dayLong(day: string): string {
  const d = parseDay(day);
  return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : day;
}

/** A "nice" axis maximum (1/2/2.5/5 × 10^n) at or above `v`. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * exp >= v) return f * exp;
  return 10 * exp;
}

/* -------------------------------- Legend -------------------------------- */

export interface Series {
  key: string;
  label: string;
  /** CSS color (e.g. "var(--series-1)"). */
  color: string;
  /** One value per day, in the chart's unit. */
  values: number[];
}

export function Legend({ series, className }: { series: Pick<Series, 'key' | 'label' | 'color'>[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground', className)}>
      {series.map((s) => (
        <li key={s.key} className="flex min-w-0 items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} aria-hidden />
          <span className="max-w-[180px] truncate">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------- Bar chart ------------------------------- */

/**
 * Daily bars, stacked when there's more than one series. Plain divs: each
 * day is a full-height hover target with its bar anchored to the baseline;
 * segments are separated by a 2px surface gap and the stack gets 4px
 * rounded tops. Hovering a day shows its breakdown.
 */
export function DailyBars({
  days,
  series,
  format,
  axisFormat,
  height = 220,
  compact = false,
  max,
  ariaLabel,
}: {
  days: string[];
  series: Series[];
  /** Value → tooltip text. */
  format: (v: number) => string;
  /** Value → axis tick text (defaults to `format`). */
  axisFormat?: (v: number) => string;
  height?: number;
  /** Small-multiple mode: no y-axis, sparse x labels. */
  compact?: boolean;
  /** Shared y maximum (small multiples use one scale). */
  max?: number;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = days.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const top = niceMax(max ?? Math.max(0, ...totals));
  const n = days.length;
  const short = n <= 7;
  const labelEvery = n <= 7 ? 1 : n <= 14 ? 2 : n <= 31 ? 5 : 15;
  const ticks = compact ? [] : [top, top / 2];
  const colGap = n > 45 ? 'gap-px' : n > 14 ? 'gap-[3px]' : 'gap-2';
  const fmtAxis = axisFormat ?? format;

  const tip = hover != null ? { day: days[hover], total: totals[hover], idx: hover } : null;
  const tipAlign = tip ? (tip.idx / n < 0.2 ? 'left' : tip.idx / n > 0.8 ? 'right' : 'center') : 'center';

  return (
    <div className="relative select-none" role="img" aria-label={ariaLabel}>
      <div className="flex">
        {!compact && (
          <div className="relative w-12 shrink-0 text-[11px] tabular-nums text-muted-foreground" style={{ height }} aria-hidden>
            {ticks.map((t) => (
              <span key={t} className="absolute right-2 -translate-y-1/2" style={{ top: `${(1 - t / top) * 100}%` }}>
                {fmtAxis(t)}
              </span>
            ))}
            <span className="absolute bottom-0 right-2 translate-y-1/2">0</span>
          </div>
        )}
        <div className="relative min-w-0 flex-1" style={{ height }} onMouseLeave={() => setHover(null)}>
          {/* Recessive grid */}
          {!compact &&
            ticks.map((t) => (
              <div
                key={t}
                className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border"
                style={{ top: `${(1 - t / top) * 100}%` }}
                aria-hidden
              />
            ))}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-border" aria-hidden />

          <div className={cn('absolute inset-0 flex items-stretch', colGap)}>
            {days.map((day, i) => {
              const total = totals[i];
              const segs = series.filter((s) => (s.values[i] ?? 0) > 0);
              return (
                <div
                  key={day}
                  className="relative flex min-w-0 flex-1 flex-col justify-end"
                  onMouseEnter={() => setHover(i)}
                  aria-hidden
                >
                  {hover === i && <div className="pointer-events-none absolute inset-0 rounded-md bg-accent/60" />}
                  {total > 0 && (
                    <div
                      className="relative flex min-h-[2px] flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]"
                      style={{ height: `${(total / top) * 100}%` }}
                    >
                      {segs.map((s) => (
                        <div
                          key={s.key}
                          className="min-h-px"
                          style={{ background: s.color, flexGrow: s.values[i], flexBasis: 0 }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {tip && (
            <div
              className={cn(
                'pointer-events-none absolute top-0 z-10 min-w-[160px] max-w-[260px] rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-soft',
                tipAlign === 'center' && '-translate-x-1/2',
                tipAlign === 'right' && '-translate-x-full',
              )}
              style={{ left: `${((tip.idx + 0.5) / n) * 100}%` }}
            >
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="font-semibold">{dayLong(tip.day)}</span>
                {series.length > 1 && <span className="font-semibold tabular-nums">{format(tip.total)}</span>}
              </div>
              {series.length === 1 ? (
                <div className="tabular-nums">{format(tip.total)}</div>
              ) : (
                <ul className="grid gap-0.5">
                  {series
                    .filter((s) => (s.values[tip.idx] ?? 0) > 0)
                    .sort((a, b) => (b.values[tip.idx] ?? 0) - (a.values[tip.idx] ?? 0))
                    .slice(0, 8)
                    .map((s) => (
                      <li key={s.key} className="flex items-center gap-1.5">
                        <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: s.color }} />
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{s.label}</span>
                        <span className="tabular-nums">{format(s.values[tip.idx] ?? 0)}</span>
                      </li>
                    ))}
                  {tip.total === 0 && <li className="text-muted-foreground">Nothing was on</li>}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {/* x axis */}
      <div className={cn('mt-1.5 flex text-[11px] text-muted-foreground', !compact && 'pl-12')} aria-hidden>
        <div className={cn('flex min-w-0 flex-1', colGap)}>
          {days.map((day, i) => {
            const show = compact ? i === 0 || i === n - 1 : (n - 1 - i) % labelEvery === 0;
            return (
              <div key={day} className="relative min-w-0 flex-1 text-center">
                {show && (
                  <span
                    className={cn(
                      'absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap',
                      compact && i === 0 && 'left-0 translate-x-0',
                      compact && i === n - 1 && 'left-auto right-0 translate-x-0',
                    )}
                  >
                    {dayLabel(day, short)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="h-4" aria-hidden />
    </div>
  );
}
