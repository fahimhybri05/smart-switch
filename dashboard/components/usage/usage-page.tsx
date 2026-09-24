'use client';

import { ArrowDown, ArrowUp, ArrowUpDown, BarChart3, Clock, Gauge, Power, Smartphone, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';

import { EmptyState, ErrorState, HouseholdSelect, PageHeader } from '@/components/common';
import { Segmented } from '@/components/pickers';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { switchId } from '@/lib/format';
import { USAGE_RANGES, useHouseholdScope, useHouseholdUsage, type UsageRange } from '@/lib/queries';
import type { HouseholdSwitchUsage } from '@/lib/types';
import { cn } from '@/lib/utils';

import { DailyBars, formatKwh, formatOnTime, Legend, type Series } from './charts';

const MAX_SERIES = 8;
const trim = (n: number) => String(Math.round(n * 10) / 10);
const hoursAxis = (h: number) => `${trim(h)}h`;
const hoursFmt = (h: number) => formatOnTime(h * 3600);
const kwhAxis = (v: number) => (v >= 10 ? String(Math.round(v)) : trim(v));

type Metric = 'time' | 'energy';
type SortKey = 'time' | 'kwh';

const dailyKwh = (s: HouseholdSwitchUsage) =>
  s.watts != null ? s.dailyOnSeconds.map((sec) => (sec * s.watts!) / 3.6e6) : s.dailyOnSeconds.map(() => 0);

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Clock;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="squircle flex items-start gap-3 border bg-card px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-brand-ink">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <div className="truncate text-lg font-bold leading-tight tabular-nums">{value}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

export function RangePicker({ value, onChange }: { value: UsageRange; onChange: (v: UsageRange) => void }) {
  return (
    <Segmented
      label="Range"
      value={String(value)}
      onChange={(v) => onChange(Number(v) as UsageRange)}
      options={USAGE_RANGES.map((d) => ({ value: String(d), label: `${d} days` }))}
    />
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  className,
}: {
  label: string;
  active: boolean;
  dir: 'asc' | 'desc';
  onClick: () => void;
  className?: string;
}) {
  const Icon = !active ? ArrowUpDown : dir === 'desc' ? ArrowDown : ArrowUp;
  return (
    <th className={cn('px-3 py-2 text-right font-semibold', className)} aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active && 'text-foreground',
        )}
      >
        {label}
        <Icon className="h-3.5 w-3.5" />
      </button>
    </th>
  );
}

export function UsagePage() {
  const { households, selected, select } = useHouseholdScope();
  const [days, setDays] = useState<UsageRange>(7);
  const [metric, setMetric] = useState<Metric>('time');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'time', dir: 'desc' });
  const usage = useHouseholdUsage(selected?.id, days);
  const data = usage.data;

  const hasEnergy = data?.totals.kwh != null || (data?.switches ?? []).some((s) => s.kwh != null);
  const effectiveMetric: Metric = hasEnergy ? metric : 'time';

  // Colour follows the switch: the top switches (by the shown metric) get the
  // fixed palette slots in their stable response order; the rest fold into "Other".
  const { series, colorOf } = useMemo(() => {
    const rows = data?.switches ?? [];
    const valuesOf = (s: HouseholdSwitchUsage) =>
      effectiveMetric === 'time' ? s.dailyOnSeconds.map((sec) => sec / 3600) : dailyKwh(s);
    const weight = (s: HouseholdSwitchUsage) => (effectiveMetric === 'time' ? s.totalOnSeconds : (s.kwh ?? 0));
    const ranked = rows.map((s, i) => ({ s, i })).filter(({ s }) => weight(s) > 0);
    ranked.sort((a, b) => weight(b.s) - weight(a.s));
    const overflow = ranked.length > MAX_SERIES;
    const chosen = ranked.slice(0, overflow ? MAX_SERIES - 1 : MAX_SERIES).sort((a, b) => a.i - b.i);
    const colors = new Map<string, string>();
    const out: Series[] = chosen.map(({ s }, slot) => {
      const key = switchId(s.deviceId, s.channelIdx);
      const color = `var(--series-${slot + 1})`;
      colors.set(key, color);
      return { key, label: s.name || `Channel ${s.channelIdx}`, color, values: valuesOf(s) };
    });
    if (overflow) {
      const rest = ranked.slice(MAX_SERIES - 1);
      out.push({
        key: '__other__',
        label: `Other (${rest.length})`,
        color: 'var(--series-other)',
        values: (data?.days ?? []).map((_, d) => rest.reduce((sum, { s }) => sum + (valuesOf(s)[d] ?? 0), 0)),
      });
    }
    return { series: out, colorOf: colors };
  }, [data, effectiveMetric]);

  const rows = useMemo(() => {
    const list = [...(data?.switches ?? [])];
    const val = (s: HouseholdSwitchUsage) => (sort.key === 'time' ? s.totalOnSeconds : s.kwh);
    list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      // Switches without watts (kWh unknown) always sink to the bottom.
      if (va == null || vb == null) return va == null ? (vb == null ? b.totalOnSeconds - a.totalOnSeconds : 1) : -1;
      return sort.dir === 'desc' ? vb - va : va - vb;
    });
    return list;
  }, [data, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));

  const dayCount = data?.days.length || days;
  const maxOn = Math.max(1, ...(data?.switches ?? []).map((s) => s.totalOnSeconds));
  const withWatts = (data?.switches ?? []).filter((s) => s.watts != null).length;
  const activeSwitches = (data?.switches ?? []).filter((s) => s.totalOnSeconds > 0).length;

  return (
    <>
      <PageHeader
        title="Usage"
        description="How long each switch was on, and the energy it used where its wattage is set."
        actions={
          <>
            <HouseholdSelect households={households.data ?? []} value={selected?.id} onChange={select} />
            <RangePicker value={days} onChange={setDays} />
          </>
        }
      />

      {households.isLoading || (usage.isLoading && !data) ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[76px] rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : !selected ? (
        <EmptyState icon={Smartphone} title="No household yet">
          Claim a device from the Smart Control mobile app to start tracking usage.
        </EmptyState>
      ) : usage.isError && !data ? (
        <ErrorState error={usage.error} onRetry={() => usage.refetch()} />
      ) : !data || data.switches.length === 0 ? (
        <EmptyState icon={BarChart3} title="No usage yet">
          Once switches in this household are turned on and off, their on-time shows up here.
        </EmptyState>
      ) : (
        <div className={cn('grid gap-6 transition-opacity', usage.isPlaceholderData && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat icon={Clock} label={`Total on-time · ${dayCount} days`} value={formatOnTime(data.totals.onSeconds)} />
            <Stat
              icon={Zap}
              label="Energy"
              value={formatKwh(data.totals.kwh)}
              hint={withWatts === 0 ? 'Set watts in switch settings' : withWatts < data.switches.length ? `${withWatts} of ${data.switches.length} switches have watts` : undefined}
            />
            <Stat
              icon={Gauge}
              label="Average per day"
              value={
                effectiveMetric === 'energy' && data.totals.kwh != null
                  ? formatKwh(data.totals.kwh / dayCount)
                  : formatOnTime(data.totals.onSeconds / dayCount)
              }
            />
            <Stat icon={Power} label="Switches used" value={`${activeSwitches}/${data.switches.length}`} />
          </div>

          <Card>
            <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
              <div className="grid gap-1.5">
                <CardTitle>{effectiveMetric === 'time' ? 'On-time per day' : 'Energy per day (kWh)'}</CardTitle>
                <CardDescription>Days in {data.timezone}. Hover a day for its breakdown.</CardDescription>
              </div>
              {hasEnergy && (
                <Segmented
                  size="sm"
                  label="Metric"
                  value={effectiveMetric}
                  onChange={setMetric}
                  options={[
                    { value: 'time', label: 'On-time' },
                    { value: 'energy', label: 'Energy' },
                  ]}
                />
              )}
            </CardHeader>
            <CardContent className="grid gap-4">
              {series.length > 1 && <Legend series={series} />}
              {series.length === 0 ? (
                <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  {effectiveMetric === 'energy' ? 'No energy recorded in this range.' : 'Nothing was on in this range.'}
                </p>
              ) : (
                <DailyBars
                  days={data.days}
                  series={series}
                  format={effectiveMetric === 'time' ? hoursFmt : (v) => formatKwh(v)}
                  axisFormat={effectiveMetric === 'time' ? hoursAxis : kwhAxis}
                  ariaLabel={`${effectiveMetric === 'time' ? 'On-time' : 'Energy'} per day for the last ${dayCount} days, stacked by switch. The table below lists the totals.`}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Per switch</CardTitle>
              <CardDescription>Totals for the last {dayCount} days. Click a column to sort.</CardDescription>
            </CardHeader>
            <CardContent className="px-0 sm:px-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="border-y bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 text-left font-semibold sm:px-6">Switch</th>
                      <SortHeader label="On-time" active={sort.key === 'time'} dir={sort.dir} onClick={() => toggleSort('time')} />
                      <th className="px-3 py-2 text-right font-semibold">Avg / day</th>
                      <th className="px-3 py-2 text-right font-semibold">Watts</th>
                      <SortHeader
                        label="kWh"
                        active={sort.key === 'kwh'}
                        dir={sort.dir}
                        onClick={() => toggleSort('kwh')}
                        className="pr-4 sm:pr-6"
                      />
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((s) => {
                      const key = switchId(s.deviceId, s.channelIdx);
                      const color = colorOf.get(key) ?? (s.totalOnSeconds > 0 ? 'var(--series-other)' : 'transparent');
                      return (
                        <tr key={key} className="hover:bg-accent/30">
                          <td className="px-4 py-2.5 sm:px-6">
                            <div className="flex items-center gap-2.5">
                              <span
                                className={cn('h-2.5 w-2.5 shrink-0 rounded-[3px]', color === 'transparent' && 'border')}
                                style={{ background: color }}
                                aria-hidden
                              />
                              <div className="min-w-0">
                                <div className="truncate font-medium">{s.name || `Channel ${s.channelIdx}`}</div>
                                <div className="truncate text-xs text-muted-foreground">{s.deviceName || s.deviceId}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            <div>{formatOnTime(s.totalOnSeconds)}</div>
                            <div className="ml-auto mt-1 h-1 w-20 overflow-hidden rounded-full bg-muted" aria-hidden>
                              <div className="h-full rounded-full bg-primary" style={{ width: `${(s.totalOnSeconds / maxOn) * 100}%` }} />
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                            {formatOnTime(s.totalOnSeconds / dayCount)}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                            {s.watts != null ? `${s.watts.toLocaleString()} W` : '—'}
                          </td>
                          <td className="px-3 py-2.5 pr-4 text-right tabular-nums sm:pr-6">{formatKwh(s.kwh, false)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="border-t bg-muted/20 font-semibold">
                    <tr>
                      <td className="px-4 py-2.5 sm:px-6">Total</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatOnTime(data.totals.onSeconds)}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{formatOnTime(data.totals.onSeconds / dayCount)}</td>
                      <td className="px-3 py-2.5" />
                      <td className="px-3 py-2.5 pr-4 text-right tabular-nums sm:pr-6">{formatKwh(data.totals.kwh, false)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {withWatts < data.switches.length && (
                <p className="px-4 pt-3 text-xs text-muted-foreground sm:px-6">
                  kWh is estimated from on-time × the switch&apos;s power draw. Set it with the gear on a device&apos;s switch.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
