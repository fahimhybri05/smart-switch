'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { DayChips, parseSwitchKey, Segmented, SwitchChecklist, SwitchSelect, type DeviceSwitches } from '@/components/pickers';
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
import { errorMessage } from '@/lib/api';
import { switchId } from '@/lib/format';
import { useSaveAutomation } from '@/lib/queries';
import { ALL_DAYS, formatIn, minutesUntilZoned, zonedNow } from '@/lib/schedule';
import type { Automation, AutomationInput, AutomationTrigger, ChannelState } from '@/lib/types';

const MAX_ACTIONS = 32; // routes/automations.js actionSchema .max(32)

const schema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(64, 'At most 64 characters'),
    triggerType: z.enum(['schedule', 'state']),
    days: z.array(z.number()),
    time: z.string(),
    triggerSwitch: z.string(),
    triggerState: z.enum(['ON', 'OFF']),
    actions: z.array(z.object({ key: z.string(), state: z.enum(['ON', 'OFF']) })),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (v.triggerType === 'schedule') {
      if (v.days.length === 0) issue('days', 'Pick at least one day');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) issue('time', 'Pick a time');
    } else if (!parseSwitchKey(v.triggerSwitch)) {
      issue('triggerSwitch', 'Choose the switch that triggers this');
    }
    if (v.actions.length === 0) issue('actions', 'Pick at least one switch to control');
    if (v.actions.length > MAX_ACTIONS) issue('actions', `At most ${MAX_ACTIONS} switches`);
  });
type Values = z.infer<typeof schema>;

function defaults(existing: Automation | null | undefined): Values {
  const t = existing?.trigger;
  return {
    name: existing?.name ?? '',
    triggerType: t?.type ?? 'schedule',
    days: t?.type === 'schedule' && t.days.length ? t.days : ALL_DAYS,
    time: t?.type === 'schedule' ? t.time : '18:00',
    triggerSwitch: t?.type === 'state' ? switchId(t.deviceId, t.channelIdx) : '',
    triggerState: t?.type === 'state' ? t.state : 'ON',
    actions: (existing?.actions ?? []).map((a) => ({ key: switchId(a.deviceId, a.channelIdx), state: a.state })),
  };
}

/**
 * Create/edit an automation — the app's _AutomationEditor, except each
 * action carries its own ON/OFF (the backend stores state per action).
 * Schedule triggers run in the household's timezone.
 */
export function AutomationDialog({
  householdId,
  timeZone,
  groups,
  existing,
  open,
  onOpenChange,
}: {
  householdId: number;
  timeZone: string;
  groups: DeviceSwitches[];
  existing?: Automation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveAutomation();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(existing) });

  useEffect(() => {
    if (open) {
      form.reset(defaults(existing));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const v = useWatch({ control: form.control }) as Values;
  const actions = useMemo(() => v.actions ?? [], [v.actions]);
  const stateOf = useMemo(() => new Map(actions.map((a) => [a.key, a.state])), [actions]);
  const [defaultState, setDefaultState] = useState<ChannelState>('ON');

  // Switches an existing rule references that aren't in this household's list any more.
  const known = useMemo(() => new Set(groups.flatMap((g) => g.switches.map((s) => s.id))), [groups]);
  const unknownActions = actions.filter((a) => !known.has(a.key));

  const now = zonedNow(timeZone);
  const until = v.triggerType === 'schedule' ? minutesUntilZoned(v.days ?? [], v.time ?? '', timeZone) : null;
  const selfTrigger = v.triggerType === 'state' && actions.some((a) => a.key === v.triggerSwitch);

  const setActions = (next: Values['actions']) =>
    form.setValue('actions', next, { shouldValidate: form.formState.isSubmitted, shouldDirty: true });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    let trigger: AutomationTrigger;
    if (values.triggerType === 'schedule') {
      trigger = { type: 'schedule', days: [...values.days].sort((a, b) => a - b), time: values.time };
    } else {
      const ref = parseSwitchKey(values.triggerSwitch)!;
      trigger = { type: 'state', ...ref, state: values.triggerState };
    }
    const input: AutomationInput = {
      id: existing?.id,
      householdId: existing?.householdId ?? householdId,
      name: values.name.trim(),
      enabled: existing?.enabled ?? true,
      trigger,
      actions: values.actions.map((a) => ({ ...parseSwitchKey(a.key)!, state: a.state })),
    };
    try {
      await save.mutateAsync(input);
      toast.success(existing ? 'Automation updated' : 'Automation created');
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  const { errors } = form.formState;

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit automation' : 'New automation'}</DialogTitle>
          <DialogDescription>Runs on the server for the whole household, even with every app closed.</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="auto-name">Name</Label>
            <Input id="auto-name" placeholder="e.g. Porch lights at dusk" aria-invalid={!!errors.name} {...form.register('name')} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <section className="grid gap-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold">When</h3>
              <Controller
                control={form.control}
                name="triggerType"
                render={({ field }) => (
                  <Segmented
                    label="Trigger"
                    value={field.value}
                    onChange={field.onChange}
                    options={[
                      { value: 'schedule', label: 'At a time' },
                      { value: 'state', label: 'A switch changes' },
                    ]}
                  />
                )}
              />
            </div>

            {v.triggerType === 'schedule' ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="auto-time">Time</Label>
                  <Input id="auto-time" type="time" step={60} className="w-40" aria-invalid={!!errors.time} {...form.register('time')} />
                  {errors.time ? (
                    <p className="text-xs text-destructive">{errors.time.message}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Household time ({timeZone}{now ? `, now ${now.hhmm}` : ''})
                      {until != null ? ` · next run ${formatIn(until)}` : ''}
                    </p>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label>Days</Label>
                  <Controller
                    control={form.control}
                    name="days"
                    render={({ field }) => <DayChips value={field.value} onChange={field.onChange} invalid={!!errors.days} />}
                  />
                  {errors.days && <p className="text-xs text-destructive">{errors.days.message}</p>}
                </div>
              </>
            ) : (
              <div className="grid gap-3 sm:grid-cols-[1fr,auto] sm:items-end">
                <div className="grid gap-2">
                  <Label htmlFor="auto-trigger">Switch</Label>
                  <Controller
                    control={form.control}
                    name="triggerSwitch"
                    render={({ field }) => (
                      <SwitchSelect
                        id="auto-trigger"
                        groups={groups}
                        value={field.value}
                        onChange={field.onChange}
                        invalid={!!errors.triggerSwitch}
                        placeholder={field.value && !known.has(field.value) ? `Unknown switch (${field.value})` : 'Choose a switch'}
                      />
                    )}
                  />
                </div>
                <Controller
                  control={form.control}
                  name="triggerState"
                  render={({ field }) => (
                    <Segmented
                      label="Changes to"
                      value={field.value}
                      onChange={field.onChange}
                      className="h-10"
                      options={[
                        { value: 'ON', label: 'Turns on', tone: 'on' },
                        { value: 'OFF', label: 'Turns off', tone: 'off' },
                      ]}
                    />
                  )}
                />
                {errors.triggerSwitch && <p className="text-xs text-destructive sm:col-span-2">{errors.triggerSwitch.message}</p>}
              </div>
            )}
          </section>

          <section className="grid gap-3 rounded-xl border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold">
                Then <span className="font-normal text-muted-foreground">({actions.length} selected)</span>
              </h3>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                New picks
                <Segmented
                  size="sm"
                  label="Default action"
                  value={defaultState}
                  onChange={setDefaultState}
                  options={[
                    { value: 'ON', label: 'ON', tone: 'on' },
                    { value: 'OFF', label: 'OFF', tone: 'off' },
                  ]}
                />
                {actions.length > 1 && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setActions(actions.map((a) => ({ ...a, state: defaultState })))}
                  >
                    Apply to all
                  </Button>
                )}
              </div>
            </div>
            <SwitchChecklist
              groups={groups}
              isSelected={(sw) => stateOf.has(sw.id)}
              onToggle={(sw, checked) =>
                setActions(checked ? [...actions, { key: sw.id, state: defaultState }] : actions.filter((a) => a.key !== sw.id))
              }
              extra={(sw) => (
                <Segmented
                  size="sm"
                  label={`${sw.name} action`}
                  value={stateOf.get(sw.id) ?? 'ON'}
                  onChange={(state) => setActions(actions.map((a) => (a.key === sw.id ? { ...a, state } : a)))}
                  options={[
                    { value: 'ON', label: 'ON', tone: 'on' },
                    { value: 'OFF', label: 'OFF', tone: 'off' },
                  ]}
                />
              )}
            />
            {unknownActions.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs">
                {unknownActions.length} action{unknownActions.length > 1 ? 's point' : ' points'} at a switch that&apos;s no
                longer in this household.
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setActions(actions.filter((a) => known.has(a.key)))}
                >
                  Remove {unknownActions.length > 1 ? 'them' : 'it'}
                </Button>
              </div>
            )}
            {errors.actions && <p className="text-xs text-destructive">{errors.actions.message}</p>}
            {selfTrigger && (
              <p className="text-xs text-muted-foreground">
                This rule also controls the switch that triggers it. That&apos;s allowed — the server stops a rule from
                re-triggering itself in a loop.
              </p>
            )}
          </section>

          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {existing ? 'Save changes' : 'Create automation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
