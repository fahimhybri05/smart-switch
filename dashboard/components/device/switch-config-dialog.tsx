'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
import { devicesApi, errorMessage } from '@/lib/api';
import { qk } from '@/lib/cache';
import type { SwitchPatch, SwitchView } from '@/lib/types';

const schema = z.object({
  name: z.string().trim().max(64, 'At most 64 characters'),
  zone: z.string().trim().max(64, 'At most 64 characters'),
  defaultBootState: z.enum(['ON', 'OFF']),
  inputMode: z.enum(['DISABLED', 'TOGGLE', 'EDGE']),
  inchingSeconds: z
    .number({ message: 'Enter a number' })
    .min(0, 'Must be 0 or more')
    .max(600, 'At most 600 seconds'),
});
type Values = z.infer<typeof schema>;

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
    onSuccess: async () => {
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
      <DialogContent>
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

          {!view.online && (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              The device is offline. Changes are saved now; input mode and inching are applied when it
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
