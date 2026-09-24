'use client';

import {
  CalendarCheck,
  CalendarRange,
  Hourglass,
  MapPin,
  Pencil,
  Plus,
  Repeat,
  Sunrise,
  Sunset,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { ConfirmAction } from '@/components/common';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { defaultChannelName } from '@/lib/format';
import { useDeleteSchedule, useToggleSchedule } from '@/lib/queries';
import { formatIn, isSolarType, nextClockRun, scheduleWhen } from '@/lib/schedule';
import type { Schedule, ScheduleType } from '@/lib/types';
import { cn } from '@/lib/utils';

import type { ScheduleTarget } from './schedule-dialog';

const TYPE_ICONS: Record<ScheduleType, LucideIcon> = {
  once: CalendarCheck,
  daily: Repeat,
  weekly: CalendarRange,
  countdown: Hourglass,
  sunrise: Sunrise,
  sunset: Sunset,
};

function ScheduleRow({
  target,
  schedule,
  switchName,
  onEdit,
  onSetLocation,
}: {
  target: ScheduleTarget;
  schedule: Schedule;
  switchName: string;
  onEdit: () => void;
  onSetLocation?: () => void;
}) {
  const deviceId = target.device.device_id;
  const toggle = useToggleSchedule();
  const remove = useDeleteSchedule();
  const Icon = TYPE_ICONS[schedule.type];
  const pending = toggle.isPending;
  const locationMissing = isSolarType(schedule.type) && target.config != null && !target.config.location_set;
  const next = nextClockRun(schedule, target.config?.utc_offset_min ?? 0);
  const on = schedule.action === 'ON';

  let hint: string | null = null;
  if (!schedule.enabled) {
    hint = schedule.type === 'once' || schedule.type === 'countdown' ? 'Off — one-shot schedules turn off after firing' : 'Paused';
  } else if (next) {
    hint = `Next run ${formatIn((next.getTime() - Date.now()) / 60_000)}`;
  } else if (schedule.type === 'countdown') {
    hint = 'Counting down';
  }

  return (
    <li className={cn('flex items-center gap-3 px-4 py-3 transition-opacity', !schedule.enabled && 'opacity-70')}>
      <span
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
          schedule.enabled ? 'bg-primary/15 text-brand-ink' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <button type="button" onClick={onEdit} className="min-w-0 flex-1 text-left" aria-label={`Edit schedule: ${switchName} ${schedule.action}, ${scheduleWhen(schedule)}`}>
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          <span
            className={cn(
              'rounded-md px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide',
              on ? 'bg-primary/20 text-brand-ink' : 'bg-destructive/15 text-destructive',
            )}
          >
            {on ? 'On' : 'Off'}
          </span>
          <span className="truncate">{scheduleWhen(schedule)}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {locationMissing ? (
            <span className="inline-flex items-center gap-1 text-warning">
              <MapPin className="h-3 w-3" /> Device location not set — this won&apos;t fire
            </span>
          ) : (
            hint && <span>{hint}</span>
          )}
        </div>
      </button>
      {locationMissing && onSetLocation && (
        <Button variant="outline" size="sm" onClick={onSetLocation} className="hidden sm:inline-flex">
          Set location
        </Button>
      )}
      <Switch
        checked={schedule.enabled}
        disabled={pending}
        onCheckedChange={(enabled) => toggle.mutate({ deviceId, schedule, enabled })}
        aria-label={schedule.enabled ? 'Disable schedule' : 'Enable schedule'}
      />
      <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Edit schedule" className="hidden sm:inline-flex">
        <Pencil />
      </Button>
      <ConfirmAction
        title="Delete schedule?"
        description={
          <>
            <strong>{switchName}</strong> will no longer turn {on ? 'on' : 'off'} ({scheduleWhen(schedule).toLowerCase()}).
          </>
        }
        confirmLabel="Delete"
        onConfirm={() => remove.mutateAsync({ deviceId, scheduleId: schedule.id })}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label="Delete schedule" className="text-destructive hover:text-destructive">
            <Trash2 />
          </Button>
        }
      />
    </li>
  );
}

/**
 * One device's schedules, grouped by switch (only switches that have
 * schedules, unless `showEmptySwitches`). Dialog state lives in the parent.
 */
export function ScheduleList({
  target,
  schedules,
  onEdit,
  onAdd,
  onSetLocation,
  showEmptySwitches = false,
}: {
  target: ScheduleTarget;
  /** Defaults to every schedule in the device config (pass a filtered list for the global page). */
  schedules?: Schedule[];
  onEdit: (schedule: Schedule) => void;
  onAdd?: (channelIdx: number) => void;
  onSetLocation?: () => void;
  showEmptySwitches?: boolean;
}) {
  const list = schedules ?? target.config?.schedules ?? [];
  const byChannel = new Map<number, Schedule[]>();
  for (const s of list) byChannel.set(s.channel_idx, [...(byChannel.get(s.channel_idx) ?? []), s]);
  const channels = new Set<number>(byChannel.keys());
  if (showEmptySwitches) target.switches.forEach((s) => channels.add(s.channelIdx));
  const nameOf = new Map(target.switches.map((s) => [s.channelIdx, s]));

  return (
    <div className="grid gap-4">
      {[...channels]
        .sort((a, b) => a - b)
        .map((idx) => {
          const sw = nameOf.get(idx);
          const name = sw?.name ?? defaultChannelName(idx);
          const rows = byChannel.get(idx) ?? [];
          return (
            <section key={idx} aria-label={`${name} schedules`}>
              <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                <h4 className="min-w-0 truncate text-sm font-bold">
                  {name}
                  {sw?.zone && <span className="ml-2 font-normal text-muted-foreground">{sw.zone}</span>}
                </h4>
                {onAdd && (
                  <Button variant="ghost" size="sm" onClick={() => onAdd(idx)} aria-label={`Add schedule for ${name}`}>
                    <Plus /> Add
                  </Button>
                )}
              </div>
              {rows.length === 0 ? (
                <p className="rounded-xl border border-dashed px-4 py-3 text-xs text-muted-foreground">No schedules.</p>
              ) : (
                <ul className="divide-y rounded-xl border bg-card">
                  {rows.map((s) => (
                    <ScheduleRow
                      key={s.id}
                      target={target}
                      schedule={s}
                      switchName={name}
                      onEdit={() => onEdit(s)}
                      onSetLocation={onSetLocation}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
    </div>
  );
}
