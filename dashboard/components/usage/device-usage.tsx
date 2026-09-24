'use client';

import { BarChart3 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { ErrorState } from '@/components/common';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { defaultChannelName } from '@/lib/format';
import { useDeviceUsage, type UsageRange } from '@/lib/queries';
import type { SwitchView } from '@/lib/types';
import { cn } from '@/lib/utils';

import { DailyBars, formatKwh, formatOnTime } from './charts';
import { RangePicker } from './usage-page';

const hoursFmt = (h: number) => formatOnTime(h * 3600);

/** Device page "Usage" card: one small daily-bar chart per switch, on a shared scale. */
export function DeviceUsageSection({ deviceId, switches }: { deviceId: string; switches: SwitchView[] }) {
  const [days, setDays] = useState<UsageRange>(7);
  const usage = useDeviceUsage(deviceId, days);
  const data = usage.data;
  const nameOf = (idx: number, fallback: string) =>
    switches.find((s) => s.channelIdx === idx)?.name || fallback || defaultChannelName(idx);
  const maxHours = Math.max(0, ...(data?.switches ?? []).flatMap((s) => s.dailyOnSeconds.map((v) => v / 3600)));
  const dayCount = data?.days.length || days;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div className="grid gap-1.5">
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-brand-ink" /> Usage
          </CardTitle>
          <CardDescription>
            Hours on per day{data ? ` (days in ${data.timezone})` : ''}. All switches share one scale.{' '}
            <Link href="/usage" className="font-semibold text-brand-ink hover:underline">
              Household usage
            </Link>
          </CardDescription>
        </div>
        <RangePicker value={days} onChange={setDays} />
      </CardHeader>
      <CardContent>
        {usage.isLoading && !data ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-32 rounded-xl" />
            ))}
          </div>
        ) : usage.isError && !data ? (
          <ErrorState error={usage.error} onRetry={() => usage.refetch()} />
        ) : !data || data.switches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No usage recorded for this device yet.</p>
        ) : (
          <div className={cn('grid gap-3 sm:grid-cols-2', usage.isPlaceholderData && 'opacity-60')}>
            {data.switches.map((s) => {
              const name = nameOf(s.channelIdx, s.name);
              return (
                <div key={s.channelIdx} className="rounded-xl border p-3">
                  <div className="mb-2 flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold">{name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      <span className="font-semibold text-foreground">{formatOnTime(s.totalOnSeconds)}</span>
                      {s.kwh != null && ` · ${formatKwh(s.kwh)}`}
                      {` · avg ${formatOnTime(s.totalOnSeconds / dayCount)}/day`}
                    </span>
                  </div>
                  <DailyBars
                    compact
                    height={64}
                    days={data.days}
                    max={maxHours}
                    series={[
                      {
                        key: String(s.channelIdx),
                        label: name,
                        color: 'hsl(var(--primary))',
                        values: s.dailyOnSeconds.map((v) => v / 3600),
                      },
                    ]}
                    format={hoursFmt}
                    ariaLabel={`${name}: on ${formatOnTime(s.totalOnSeconds)} over the last ${dayCount} days`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
