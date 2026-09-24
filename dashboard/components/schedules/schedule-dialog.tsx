'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { MapPin } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Callout } from '@/components/common';
import { DayChips, Segmented } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { errorMessage } from '@/lib/api';
import { useSaveSchedule } from '@/lib/queries';
import {
  ALL_DAYS,
  formatDuration,
  formatIn,
  formatUtcOffset,
  isClockType,
  isSolarType,
  nextClockRun,
  SCHEDULE_TYPE_LABELS,
  SCHEDULE_TYPES,
  splitDuration,
} from '@/lib/schedule';
import type { Device, DeviceConfig, Schedule, ScheduleInput, ScheduleType, SwitchView } from '@/lib/types';

import { LocationDialog } from './location-dialog';

/** One device the dialog can create schedules on. */
export interface ScheduleTarget {
  device: Device;
  config: DeviceConfig | undefined;
  switches: SwitchView[];
}

const intIn = (v: string, min: number, max: number) => /^-?\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max;

const schema = z
  .object({
    deviceId: z.string().min(1, 'Choose a device'),
    channel: z.string().min(1, 'Choose a switch'),
    action: z.enum(['ON', 'OFF']),
    type: z.enum(['once', 'daily', 'weekly', 'countdown', 'sunrise', 'sunset']),
    time: z.string(),
    days: z.array(z.number()),
    hours: z.string(),
    minutes: z.string(),
    seconds: z.string(),
    offset: z.string(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (isClockType(v.type) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) issue('time', 'Pick a time');
    if (v.type === 'weekly' && v.days.length === 0) issue('days', 'Pick at least one day');
    if (v.type === 'countdown') {
      const bad =
        !intIn(v.hours || '0', 0, 999) || !intIn(v.minutes || '0', 0, 59) || !intIn(v.seconds || '0', 0, 59);
      if (bad) issue('hours', 'Use whole numbers: hours, minutes 0–59, seconds 0–59');
      else if (Number(v.hours || 0) * 3600 + Number(v.minutes || 0) * 60 + Number(v.seconds || 0) <= 0)
        issue('hours', 'The countdown must be longer than 0 seconds');
    }
    if (isSolarType(v.type) && !intIn(v.offset || '0', -180, 180)) {
      issue('offset', 'Offset must be a whole number of minutes between −180 and 180');
    }
  });
type Values = z.infer<typeof schema>;

function defaultsFor(targets: ScheduleTarget[], deviceId?: string, channel?: number, existing?: Schedule): Values {
  const target = targets.find((t) => t.device.device_id === deviceId) ?? (targets.length === 1 ? targets[0] : undefined);
  const firstSwitch = target?.switches[0]?.channelIdx;
  const d = splitDuration(existing?.duration_s ?? 300);
  return {
    deviceId: target?.device.device_id ?? '',
    channel: String(existing?.channel_idx ?? channel ?? firstSwitch ?? ''),
    action: existing?.action ?? 'ON',
    type: existing?.type ?? 'daily',
    time: existing?.time ?? '18:00',
    days: existing?.days?.length ? existing.days : ALL_DAYS,
    hours: String(d.h),
    minutes: String(d.m),
    seconds: String(d.s),
    offset: String(existing?.solar_offset_min ?? 0),
  };
}

/**
 * Create/edit a device schedule — the app's _ScheduleEditorSheet, same
 * fields and the same "only send what the type uses" body. Editing keeps
 * the schedule's enabled flag; new schedules start enabled.
 */
export function ScheduleDialog({
  targets,
  initialDeviceId,
  initialChannel,
  existing,
  open,
  onOpenChange,
}: {
  targets: ScheduleTarget[];
  initialDeviceId?: string;
  initialChannel?: number;
  /** Set when editing; the device is then fixed. */
  existing?: Schedule | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveSchedule();
  const [error, setError] = useState<string | null>(null);
  const [locationOpen, setLocationOpen] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: defaultsFor(targets, initialDeviceId, initialChannel, existing ?? undefined),
  });

  useEffect(() => {
    if (open) {
      form.reset(defaultsFor(targets, initialDeviceId, initialChannel, existing ?? undefined));
      setError(null);
    }
    // Reset only when (re)opened — targets refresh with live data while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const values = useWatch({ control: form.control }) as Values;
  const target = targets.find((t) => t.device.device_id === values.deviceId);
  const config = target?.config;
  const type = values.type as ScheduleType;
  const offsetMin = config?.utc_offset_min ?? 0;
  const browserOffset = -new Date().getTimezoneOffset();
  const needsLocation = isSolarType(type) && config != null && !config.location_set;

  const preview = useMemo(() => {
    if (!isClockType(type) || !/^\d\d:\d\d$/.test(values.time ?? '')) return null;
    const next = nextClockRun(
      { id: '', channel_idx: 0, action: 'ON', type, enabled: true, time: values.time, days: values.days },
      offsetMin,
    );
    return next ? formatIn((next.getTime() - Date.now()) / 60_000) : null;
  }, [type, values.time, values.days, offsetMin]);

  const onSubmit = form.handleSubmit(async (v) => {
    if (needsLocation) {
      setError('Set the device location first — sunrise and sunset need it.');
      return;
    }
    setError(null);
    const input: ScheduleInput = {
      id: existing?.id,
      channel_idx: Number(v.channel),
      action: v.action,
      type: v.type,
      enabled: existing?.enabled ?? true,
      time: v.time,
      days: v.days,
      duration_s: Number(v.hours || 0) * 3600 + Number(v.minutes || 0) * 60 + Number(v.seconds || 0),
      solar_offset_min: Number(v.offset || 0),
    };
    try {
      await save.mutateAsync({ deviceId: v.deviceId, input });
      toast.success(existing ? 'Schedule updated' : 'Schedule created');
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  const { errors } = form.formState;
  const editing = !!existing;
  const switches = target?.switches ?? [];

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit schedule' : 'New schedule'}</DialogTitle>
            <DialogDescription>
              Runs in the cloud on the device&apos;s clock
              {config ? ` (${formatUtcOffset(offsetMin)})` : ''} — it keeps working with every app closed.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              {targets.length > 1 && (
                <div className="grid gap-2 sm:col-span-2">
                  <Label>Device</Label>
                  <Controller
                    control={form.control}
                    name="deviceId"
                    render={({ field }) => (
                      <Select
                        value={field.value || undefined}
                        disabled={editing}
                        onValueChange={(id) => {
                          field.onChange(id);
                          const first = targets.find((t) => t.device.device_id === id)?.switches[0];
                          form.setValue('channel', first ? String(first.channelIdx) : '');
                        }}
                      >
                        <SelectTrigger aria-invalid={!!errors.deviceId}>
                          <SelectValue placeholder="Choose a device" />
                        </SelectTrigger>
                        <SelectContent>
                          {targets.map((t) => (
                            <SelectItem key={t.device.device_id} value={t.device.device_id}>
                              {t.device.friendly_name || t.device.device_id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  {errors.deviceId && <p className="text-xs text-destructive">{errors.deviceId.message}</p>}
                </div>
              )}

              <div className="grid gap-2">
                <Label>Switch</Label>
                <Controller
                  control={form.control}
                  name="channel"
                  render={({ field }) => (
                    <Select value={field.value || undefined} onValueChange={field.onChange} disabled={!target}>
                      <SelectTrigger aria-invalid={!!errors.channel}>
                        <SelectValue placeholder={target ? 'Choose a switch' : 'Choose a device first'} />
                      </SelectTrigger>
                      <SelectContent>
                        {switches.map((sw) => (
                          <SelectItem key={sw.id} value={String(sw.channelIdx)}>
                            {sw.name}
                            {sw.zone ? ` · ${sw.zone}` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.channel && <p className="text-xs text-destructive">{errors.channel.message}</p>}
              </div>

              <div className="grid gap-2">
                <Label>Action</Label>
                <Controller
                  control={form.control}
                  name="action"
                  render={({ field }) => (
                    <Segmented
                      label="Action"
                      value={field.value}
                      onChange={field.onChange}
                      className="h-10 w-full"
                      options={[
                        { value: 'ON', label: 'Turn ON', tone: 'on' },
                        { value: 'OFF', label: 'Turn OFF', tone: 'off' },
                      ]}
                    />
                  )}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Type</Label>
              <Controller
                control={form.control}
                name="type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SCHEDULE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {SCHEDULE_TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <p className="text-xs text-muted-foreground">
                {type === 'once' && 'Fires the next time the clock reaches this time, then turns itself off.'}
                {type === 'daily' && 'Fires every day at this time.'}
                {type === 'weekly' && 'Fires at this time on the days you pick.'}
                {type === 'countdown' &&
                  (editing
                    ? 'Editing keeps a running countdown going; switch it off and on again to restart it.'
                    : 'Starts counting as soon as you save, fires once, then turns itself off.')}
                {isSolarType(type) && `Fires every day at ${type}, shifted by the offset.`}
              </p>
            </div>

            {isClockType(type) && (
              <div className="grid gap-2">
                <Label htmlFor="sch-time">Time</Label>
                <Input
                  id="sch-time"
                  type="time"
                  step={60}
                  className="w-40"
                  aria-invalid={!!errors.time}
                  {...form.register('time')}
                />
                {errors.time ? (
                  <p className="text-xs text-destructive">{errors.time.message}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Device time{config ? ` (${formatUtcOffset(offsetMin)})` : ''}
                    {config && browserOffset !== offsetMin ? ` · your browser is ${formatUtcOffset(browserOffset)}` : ''}
                    {preview ? ` · next run ${preview}` : ''}
                  </p>
                )}
              </div>
            )}

            {type === 'weekly' && (
              <div className="grid gap-2">
                <Label>Days</Label>
                <Controller
                  control={form.control}
                  name="days"
                  render={({ field }) => (
                    <DayChips value={field.value} onChange={field.onChange} invalid={!!errors.days} />
                  )}
                />
                {errors.days && <p className="text-xs text-destructive">{errors.days.message}</p>}
              </div>
            )}

            {type === 'countdown' && (
              <div className="grid gap-2">
                <Label>Duration</Label>
                <div className="flex items-center gap-2">
                  {(
                    [
                      ['hours', 'h', 999],
                      ['minutes', 'm', 59],
                      ['seconds', 's', 59],
                    ] as const
                  ).map(([name, unit, max]) => (
                    <label key={name} className="relative">
                      <span className="sr-only">{name}</span>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={max}
                        className="w-24 pr-8"
                        aria-invalid={!!errors.hours}
                        {...form.register(name)}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                        {unit}
                      </span>
                    </label>
                  ))}
                </div>
                {errors.hours ? (
                  <p className="text-xs text-destructive">{errors.hours.message}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Total{' '}
                    {formatDuration(
                      Number(values.hours || 0) * 3600 + Number(values.minutes || 0) * 60 + Number(values.seconds || 0),
                    )}
                  </p>
                )}
              </div>
            )}

            {isSolarType(type) && (
              <>
                {needsLocation && target && (
                  <Callout tone="warning" icon={MapPin}>
                    <p>
                      <strong>{target.device.friendly_name || target.device.device_id}</strong> has no location set,
                      so its sunrise and sunset can&apos;t be worked out.
                    </p>
                    <Button type="button" size="sm" variant="outline" onClick={() => setLocationOpen(true)}>
                      <MapPin /> Set device location
                    </Button>
                  </Callout>
                )}
                <div className="grid gap-2">
                  <Label htmlFor="sch-offset">Offset (minutes)</Label>
                  <Input
                    id="sch-offset"
                    type="number"
                    inputMode="numeric"
                    min={-180}
                    max={180}
                    className="w-32"
                    aria-invalid={!!errors.offset}
                    {...form.register('offset')}
                  />
                  {errors.offset ? (
                    <p className="text-xs text-destructive">{errors.offset.message}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Negative = before, positive = after — e.g. −30 for &ldquo;30 minutes before {type}&rdquo;.
                    </p>
                  )}
                </div>
              </>
            )}

            {target && !target.device.is_online && (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                The device is offline. The schedule is saved now; it can only switch the relay while the device is
                connected.
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
                Cancel
              </Button>
              <Button type="submit" loading={save.isPending} disabled={needsLocation}>
                {editing ? 'Save changes' : 'Create schedule'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {target && (
        <LocationDialog
          deviceId={target.device.device_id}
          deviceName={target.device.friendly_name || target.device.device_id}
          config={config}
          open={locationOpen}
          onOpenChange={setLocationOpen}
        />
      )}
    </>
  );
}
