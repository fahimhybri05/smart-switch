'use client';

import { CalendarClock, Clock, Plus, Search, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { EmptyState, ErrorState, HouseholdSelect, PageHeader } from '@/components/common';
import { OnlineBadge } from '@/components/overview/device-card';
import { Segmented } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { defaultChannelName } from '@/lib/format';
import { useHouseholdScope, useSwitchViews } from '@/lib/queries';
import { formatIn, nextClockRun, SCHEDULE_TYPE_LABELS, SCHEDULE_TYPES, scheduleWhen } from '@/lib/schedule';
import type { Schedule, ScheduleType } from '@/lib/types';

import { LocationDialog } from './location-dialog';
import { ScheduleDialog, type ScheduleTarget } from './schedule-dialog';
import { ScheduleList } from './schedule-list';

const ALL = '__all__';
type Status = 'all' | 'enabled' | 'paused';

type DialogState = { deviceId?: string; channel?: number; existing?: Schedule } | null;

/** Every schedule across the selected household's devices, with filters. */
export function SchedulesPage() {
  const { households, selected, select, devicesQuery, devices } = useHouseholdScope();
  const { byDevice, configByDevice, configsLoading } = useSwitchViews(devices);
  const [deviceFilter, setDeviceFilter] = useState(ALL);
  const [typeFilter, setTypeFilter] = useState<ScheduleType | typeof ALL>(ALL);
  const [status, setStatus] = useState<Status>('all');
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [locationFor, setLocationFor] = useState<string | null>(null);

  const targets: ScheduleTarget[] = useMemo(
    () =>
      devices.map((device) => ({
        device,
        config: configByDevice.get(device.device_id),
        switches: byDevice.get(device.device_id) ?? [],
      })),
    [devices, byDevice, configByDevice],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      targets
        .filter((t) => deviceFilter === ALL || t.device.device_id === deviceFilter)
        .map((t) => {
          const names = new Map(t.switches.map((s) => [s.channelIdx, `${s.name} ${s.zone}`.toLowerCase()]));
          const schedules = (t.config?.schedules ?? []).filter(
            (s) =>
              (typeFilter === ALL || s.type === typeFilter) &&
              (status === 'all' || (status === 'enabled' ? s.enabled : !s.enabled)) &&
              (!q || (names.get(s.channel_idx) ?? defaultChannelName(s.channel_idx).toLowerCase()).includes(q)),
          );
          return { target: t, schedules };
        }),
    [targets, deviceFilter, typeFilter, status, q],
  );

  const all = targets.flatMap((t) => t.config?.schedules ?? []);
  const active = all.filter((s) => s.enabled).length;
  const nextUp = useMemo(() => {
    let best: { at: number; label: string } | null = null;
    for (const t of targets) {
      for (const s of t.config?.schedules ?? []) {
        const next = nextClockRun(s, t.config?.utc_offset_min ?? 0);
        if (next && (!best || next.getTime() < best.at)) {
          const name = t.switches.find((sw) => sw.channelIdx === s.channel_idx)?.name ?? defaultChannelName(s.channel_idx);
          best = { at: next.getTime(), label: `${name} → ${s.action} · ${scheduleWhen(s)}` };
        }
      }
    }
    return best;
  }, [targets]);

  const shown = filtered.filter((f) => f.schedules.length > 0);
  const filtering = deviceFilter !== ALL || typeFilter !== ALL || status !== 'all' || !!q;
  const locationTarget = targets.find((t) => t.device.device_id === locationFor);

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Per-switch timers that run in the cloud, even with every app closed."
        actions={
          <>
            <HouseholdSelect households={households.data ?? []} value={selected?.id} onChange={select} />
            <Button onClick={() => setDialog({})} disabled={targets.every((t) => t.switches.length === 0)}>
              <Plus /> Add schedule
            </Button>
          </>
        }
      />

      {devicesQuery.isLoading ? (
        <div className="grid gap-4">
          <Skeleton className="h-11 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      ) : devicesQuery.isError ? (
        <ErrorState error={devicesQuery.error} onRetry={() => devicesQuery.refetch()} />
      ) : devices.length === 0 ? (
        <EmptyState icon={Smartphone} title="No devices yet">
          Claim a device from the Smart Control mobile app, then schedule its switches here.
        </EmptyState>
      ) : (
        <div className="grid gap-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="squircle border bg-card px-4 py-3">
              <div className="text-lg font-bold leading-none">{all.length}</div>
              <div className="mt-1 text-xs text-muted-foreground">Schedules</div>
            </div>
            <div className="squircle border bg-card px-4 py-3">
              <div className="text-lg font-bold leading-none">{active}</div>
              <div className="mt-1 text-xs text-muted-foreground">Active</div>
            </div>
            <div className="squircle flex items-center gap-3 border bg-card px-4 py-3">
              <Clock className="h-5 w-5 shrink-0 text-brand-ink" />
              <div className="min-w-0">
                <div className="truncate text-sm font-bold leading-tight">
                  {nextUp ? `Next ${formatIn((nextUp.at - Date.now()) / 60_000)}` : 'Nothing timed coming up'}
                </div>
                <div className="truncate text-xs text-muted-foreground">{nextUp?.label ?? 'Clock-based schedules only'}</div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative lg:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search switches"
                aria-label="Search switches"
                className="pl-9"
              />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:flex">
              <Select value={deviceFilter} onValueChange={setDeviceFilter}>
                <SelectTrigger className="sm:w-48" aria-label="Device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All devices</SelectItem>
                  {devices.map((d) => (
                    <SelectItem key={d.device_id} value={d.device_id}>
                      {d.friendly_name || d.device_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as ScheduleType | typeof ALL)}>
                <SelectTrigger className="sm:w-44" aria-label="Type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All types</SelectItem>
                  {SCHEDULE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {SCHEDULE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Segmented
              label="Status"
              value={status}
              onChange={setStatus}
              className="self-start lg:ml-auto"
              options={[
                { value: 'all', label: 'All' },
                { value: 'enabled', label: 'Active' },
                { value: 'paused', label: 'Off' },
              ]}
            />
          </div>

          {configsLoading && all.length === 0 ? (
            <Skeleton className="h-48 rounded-xl" />
          ) : shown.length === 0 ? (
            <EmptyState icon={CalendarClock} title={filtering ? 'No schedules match' : 'No schedules yet'}>
              {filtering ? (
                <Button
                  variant="link"
                  onClick={() => {
                    setDeviceFilter(ALL);
                    setTypeFilter(ALL);
                    setStatus('all');
                    setQuery('');
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                'Use “Add schedule” to switch something on or off automatically.'
              )}
            </EmptyState>
          ) : (
            shown.map(({ target, schedules }) => (
              <Card key={target.device.device_id}>
                <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-3">
                  <CardTitle className="flex min-w-0 flex-wrap items-center gap-3 text-base">
                    <Link href={`/devices/${encodeURIComponent(target.device.device_id)}`} className="truncate hover:underline">
                      {target.device.friendly_name || target.device.device_id}
                    </Link>
                    <OnlineBadge online={target.device.is_online} lastSeen={target.device.last_seen_at} />
                  </CardTitle>
                  <Button variant="outline" size="sm" onClick={() => setDialog({ deviceId: target.device.device_id })}>
                    <Plus /> Add
                  </Button>
                </CardHeader>
                <CardContent>
                  <ScheduleList
                    target={target}
                    schedules={schedules}
                    onEdit={(existing) => setDialog({ deviceId: target.device.device_id, existing })}
                    onAdd={(channel) => setDialog({ deviceId: target.device.device_id, channel })}
                    onSetLocation={() => setLocationFor(target.device.device_id)}
                  />
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      <ScheduleDialog
        targets={dialog?.existing && dialog.deviceId ? targets.filter((t) => t.device.device_id === dialog.deviceId) : targets}
        initialDeviceId={dialog?.deviceId ?? (deviceFilter !== ALL ? deviceFilter : undefined)}
        initialChannel={dialog?.channel}
        existing={dialog?.existing ?? null}
        open={dialog != null}
        onOpenChange={(o) => !o && setDialog(null)}
      />
      {locationTarget && (
        <LocationDialog
          deviceId={locationTarget.device.device_id}
          deviceName={locationTarget.device.friendly_name || locationTarget.device.device_id}
          config={locationTarget.config}
          open={locationFor != null}
          onOpenChange={(o) => !o && setLocationFor(null)}
        />
      )}
    </>
  );
}
