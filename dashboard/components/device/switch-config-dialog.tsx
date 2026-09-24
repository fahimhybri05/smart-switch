'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, ShieldCheck, Zap } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

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
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { devicesApi, errorMessage } from '@/lib/api';
import { patchChannelLocked, qk } from '@/lib/cache';
import type { SwitchPatch, SwitchView } from '@/lib/types';
import { cn } from '@/lib/utils';

// Backend bounds (migration 010): watts 0..100000, max_on_s 1..604800, min_off_s 1..86400.
const MAX_WATTS = 100_000;
const MAX_ON_S = 604_800;
const MAX_MIN_OFF_S = 86_400;

/** Blank → null, otherwise a finite number (NaN when unparsable). */
const parseOpt = (v: string): number | null => (v.trim() === '' ? null : Number(v.trim()));

const schema = z
  .object({
    name: z.string().trim().max(64, 'At most 64 characters'),
    zone: z.string().trim().max(64, 'At most 64 characters'),
    defaultBootState: z.enum(['ON', 'OFF']),
    inputMode: z.enum(['DISABLED', 'TOGGLE', 'EDGE']),
    inchingSeconds: z
      .number({ message: 'Enter a number' })
      .min(0, 'Must be 0 or more')
      .max(600, 'At most 600 seconds'),
    watts: z.string(),
    maxOnHours: z.string(),
    maxOnMinutes: z.string(),
    minOffMinutes: z.string(),
    locked: z.boolean(),
  })
  .superRefine((v, ctx) => {
    const watts = parseOpt(v.watts);
    if (watts != null && (!Number.isInteger(watts) || watts < 0 || watts > MAX_WATTS)) {
      ctx.addIssue({ code: 'custom', path: ['watts'], message: `Whole watts from 0 to ${MAX_WATTS.toLocaleString()}` });
    }
    const h = parseOpt(v.maxOnHours);
    const m = parseOpt(v.maxOnMinutes);
    if (h != null && (!Number.isInteger(h) || h < 0 || h > 168)) {
      ctx.addIssue({ code: 'custom', path: ['maxOnHours'], message: 'Hours from 0 to 168' });
    } else if (m != null && (!Number.isFinite(m) || m < 0 || m >= 60)) {
      ctx.addIssue({ code: 'custom', path: ['maxOnHours'], message: 'Minutes from 0 to 59' });
    } else if (maxOnSeconds(v) != null && maxOnSeconds(v)! > MAX_ON_S) {
      ctx.addIssue({ code: 'custom', path: ['maxOnHours'], message: 'At most 7 days (168 h)' });
    }
    const off = parseOpt(v.minOffMinutes);
    if (off != null && (!Number.isFinite(off) || off < 0 || off * 60 > MAX_MIN_OFF_S)) {
      ctx.addIssue({ code: 'custom', path: ['minOffMinutes'], message: 'Minutes from 0 to 1440 (24 h)' });
    }
  });
type Values = z.infer<typeof schema>;

/** h + m inputs → seconds, null when blank or zero (no max run time). */
function maxOnSeconds(v: Pick<Values, 'maxOnHours' | 'maxOnMinutes'>): number | null {
  const s = Math.round(((parseOpt(v.maxOnHours) ?? 0) * 60 + (parseOpt(v.maxOnMinutes) ?? 0)) * 60);
  return s > 0 ? s : null;
}

/** Minutes input → seconds, null when blank or zero (no min off time). */
function minOffSeconds(v: Pick<Values, 'minOffMinutes'>): number | null {
  const s = Math.round((parseOpt(v.minOffMinutes) ?? 0) * 60);
  return s > 0 ? s : null;
}

/** Up to 2 decimals, no trailing zeros ("1.5", "20"). */
const trimNum = (n: number) => String(Math.round(n * 100) / 100);

function Section({ icon: Icon, title, children }: { icon: typeof Zap; title: string; children: ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="flex items-center gap-2 text-sm font-bold">
        <Icon className="h-4 w-4 text-brand-ink" /> {title}
      </h3>
      {children}
    </section>
  );
}

// Wall switch input is hidden for now; the stored mode is kept as-is on save.
const SHOW_WALL_SWITCH_INPUT = false;

const INPUT_MODES = [
  { value: 'DISABLED', label: 'Disabled', hint: 'Wall switch input is ignored' },
  { value: 'TOGGLE', label: 'Toggle (push button)', hint: 'Each press flips the relay' },
  { value: 'EDGE', label: 'Edge (rocker switch)', hint: 'Every flip of the wall switch toggles' },
] as const;

export function SwitchConfigDialog({
  view,
  zones,
  open,
  onOpenChange,
}: {
  view: SwitchView;
  zones: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const cfg = view.config;
  const defaults: Values = {
    name: cfg?.name ?? '',
    zone: cfg?.zone ?? view.zone ?? '',
    defaultBootState: cfg?.default_boot_state ?? 'OFF',
    inputMode: cfg?.input_mode ?? 'DISABLED',
    inchingSeconds: (cfg?.inching_ms ?? 0) / 1000,
    watts: cfg?.watts != null ? String(cfg.watts) : '',
    maxOnHours: cfg?.max_on_s ? String(Math.floor(cfg.max_on_s / 3600)) : '',
    maxOnMinutes: cfg?.max_on_s ? trimNum((cfg.max_on_s % 3600) / 60) : '',
    minOffMinutes: cfg?.min_off_s ? trimNum(cfg.min_off_s / 60) : '',
    locked: cfg?.locked ?? view.locked,
  };
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });

  useEffect(() => {
    if (open) {
      form.reset(defaults);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const mutation = useMutation({
    mutationFn: (patch: SwitchPatch) => devicesApi.patchSwitch(view.deviceId, view.channelIdx, patch),
    onSuccess: async (row, patch) => {
      if (patch.locked !== undefined) patchChannelLocked(qc, view.deviceId, view.channelIdx, row?.locked ?? patch.locked);
      await qc.invalidateQueries({ queryKey: qk.deviceConfig(view.deviceId) });
      toast.success('Switch updated');
      onOpenChange(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const onSubmit = form.handleSubmit((v) => {
    // Send only what changed: a name/zone-only edit must not push hw config.
    const patch: SwitchPatch = {};
    if (v.name !== defaults.name) patch.name = v.name;
    if (v.zone !== defaults.zone) patch.zone = v.zone;
    if (v.defaultBootState !== defaults.defaultBootState) patch.defaultBootState = v.defaultBootState;
    if (v.inputMode !== defaults.inputMode) patch.inputMode = v.inputMode;
    const inchingMs = Math.round(v.inchingSeconds * 1000);
    if (inchingMs !== Math.round(defaults.inchingSeconds * 1000)) patch.inchingMs = inchingMs;
    const watts = parseOpt(v.watts);
    if (watts !== (cfg?.watts ?? null)) patch.watts = watts;
    const maxOn = maxOnSeconds(v);
    if (maxOn !== (cfg?.max_on_s ?? null)) patch.maxOnSeconds = maxOn;
    const minOff = minOffSeconds(v);
    if (minOff !== (cfg?.min_off_s ?? null)) patch.minOffSeconds = minOff;
    if (v.locked !== defaults.locked) patch.locked = v.locked;
    if (Object.keys(patch).length === 0) {
      onOpenChange(false);
      return;
    }
    mutation.mutate(patch);
  });

  const { errors } = form.formState;
  const zoneListId = `zones-${view.deviceId}-${view.channelIdx}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Configure switch</DialogTitle>
          <DialogDescription>
            {view.deviceName} · channel {view.channelIdx}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="sw-name">Name</Label>
              <Input id="sw-name" placeholder={`Channel ${view.channelIdx + 1}`} {...form.register('name')} />
              {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sw-zone">Zone</Label>
              <Input id="sw-zone" list={zoneListId} placeholder="e.g. Living room" {...form.register('zone')} />
              <datalist id={zoneListId}>
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              {errors.zone && <p className="text-xs text-destructive">{errors.zone.message}</p>}
            </div>
          </div>

          <div className="grid gap-2">
            <Label>State after power loss</Label>
            <Controller
              control={form.control}
              name="defaultBootState"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="OFF">Off</SelectItem>
                    <SelectItem value="ON">On</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {SHOW_WALL_SWITCH_INPUT && (
          <div className="grid gap-2">
            <Label>Wall switch input</Label>
            <Controller
              control={form.control}
              name="inputMode"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INPUT_MODES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">
              {INPUT_MODES.find((m) => m.value === form.watch('inputMode'))?.hint}
            </p>
          </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="sw-inching">Inching (auto-off) in seconds</Label>
            <Input
              id="sw-inching"
              type="number"
              inputMode="decimal"
              min={0}
              max={600}
              step={0.1}
              {...form.register('inchingSeconds', { valueAsNumber: true })}
            />
            <p className="text-xs text-muted-foreground">
              0 disables inching. When set, the relay turns itself off after this long.
            </p>
            {errors.inchingSeconds && (
              <p className="text-xs text-destructive">{errors.inchingSeconds.message}</p>
            )}
          </div>

          <Separator />
          <Section icon={Zap} title="Power">
            <div className="grid gap-2">
              <Label htmlFor="sw-watts">Power draw (watts)</Label>
              <div className="relative sm:max-w-[220px]">
                <Input
                  id="sw-watts"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_WATTS}
                  step={1}
                  placeholder="Unknown"
                  className="pr-10"
                  aria-invalid={!!errors.watts}
                  {...form.register('watts')}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                  W
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Used to estimate energy (kWh) on the Usage page. Leave blank if you don&apos;t know it.
              </p>
              {errors.watts && <p className="text-xs text-destructive">{errors.watts.message}</p>}
            </div>
          </Section>

          <Separator />
          <Section icon={ShieldCheck} title="Safety">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid content-start gap-2">
                <Label htmlFor="sw-maxon-h">Max run time</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="sw-maxon-h"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={168}
                    step={1}
                    placeholder="0"
                    aria-label="Max run time hours"
                    aria-invalid={!!errors.maxOnHours}
                    {...form.register('maxOnHours')}
                  />
                  <span className="text-sm text-muted-foreground">h</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={59}
                    step={1}
                    placeholder="0"
                    aria-label="Max run time minutes"
                    aria-invalid={!!errors.maxOnHours}
                    {...form.register('maxOnMinutes')}
                  />
                  <span className="text-sm text-muted-foreground">m</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Auto-off after it has been on this long. Blank = off.
                </p>
                {errors.maxOnHours && <p className="text-xs text-destructive">{errors.maxOnHours.message}</p>}
              </div>
              <div className="grid content-start gap-2">
                <Label htmlFor="sw-minoff">Min off time</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="sw-minoff"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={1440}
                    step="any"
                    placeholder="Off"
                    aria-invalid={!!errors.minOffMinutes}
                    {...form.register('minOffMinutes')}
                  />
                  <span className="text-sm text-muted-foreground">min</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Must stay off this long before it can turn on again (protects pumps and compressors). Blank = off.
                </p>
                {errors.minOffMinutes && <p className="text-xs text-destructive">{errors.minOffMinutes.message}</p>}
              </div>
            </div>
          </Section>

          <Separator />
          <Controller
            control={form.control}
            name="locked"
            render={({ field }) => (
              <label
                htmlFor="sw-locked"
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
                  field.value ? 'border-warning/50 bg-warning/10' : 'hover:bg-accent/40',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                    field.value ? 'bg-warning/20 text-warning' : 'bg-muted text-muted-foreground',
                  )}
                >
                  <Lock className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold">Lock this switch</span>
                  <span className="block text-xs text-muted-foreground">
                    Blocks app, schedules, automations, scenes, API and groups; physical switch still works. Safety
                    auto-off still applies.
                  </span>
                </span>
                <Switch id="sw-locked" checked={field.value} onCheckedChange={field.onChange} />
              </label>
            )}
          />

          {!view.online && (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              The device is offline. Changes are saved now; inching is applied when it
              reconnects.
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
