'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { parseSwitchKey, Segmented, SwitchChecklist, type DeviceSwitches } from '@/components/pickers';
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
import { useSaveScene } from '@/lib/queries';
import type { ChannelState, Scene, SceneInput } from '@/lib/types';
import { cn } from '@/lib/utils';

import { SCENE_ICONS } from './scene-icon';

const MAX_ACTIONS = 64; // scenes.actions max 64 (user-features contract)

const schema = z
  .object({
    name: z.string().trim().min(1, 'Enter a name').max(64, 'At most 64 characters'),
    icon: z.string(),
    actions: z.array(z.object({ key: z.string(), state: z.enum(['ON', 'OFF']) })),
  })
  .superRefine((v, ctx) => {
    if (v.actions.length === 0) ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Pick at least one switch' });
    if (v.actions.length > MAX_ACTIONS) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: `At most ${MAX_ACTIONS} switches` });
    }
  });
type Values = z.infer<typeof schema>;

const defaults = (s: Scene | null | undefined): Values => ({
  name: s?.name ?? '',
  icon: s?.icon ?? 'home',
  actions: (s?.actions ?? []).map((a) => ({ key: switchId(a.deviceId, a.channelIdx), state: a.state })),
});

/** Create/edit a scene: a name, an icon and any switches across the household, each set ON or OFF. */
export function SceneDialog({
  householdId,
  groups,
  existing,
  open,
  onOpenChange,
}: {
  householdId: number | undefined;
  groups: DeviceSwitches[];
  existing?: Scene | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveScene();
  const [error, setError] = useState<string | null>(null);
  const [defaultState, setDefaultState] = useState<ChannelState>('ON');
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(existing) });

  useEffect(() => {
    if (open) {
      form.reset(defaults(existing));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const watched = useWatch({ control: form.control, name: 'actions' });
  const actions = useMemo(() => watched ?? [], [watched]);
  const stateOf = useMemo(() => new Map(actions.map((a) => [a.key, a.state])), [actions]);
  const known = useMemo(() => new Set(groups.flatMap((g) => g.switches.map((s) => s.id))), [groups]);
  const unknown = actions.filter((a) => !known.has(a.key));
  const onCount = actions.filter((a) => a.state === 'ON').length;

  const setActions = (next: Values['actions']) =>
    form.setValue('actions', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    const input: SceneInput = {
      id: existing?.id,
      householdId: existing?.householdId ?? householdId,
      name: v.name.trim(),
      icon: v.icon || null,
      actions: v.actions
        .map((a) => {
          const ref = parseSwitchKey(a.key);
          return ref ? { ...ref, state: a.state } : null;
        })
        .filter((a): a is NonNullable<typeof a> => a != null),
    };
    try {
      await save.mutateAsync(input);
      toast.success(existing ? 'Scene updated' : 'Scene created');
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  const { errors } = form.formState;
  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit scene' : 'New scene'}</DialogTitle>
          <DialogDescription>
            One tap sets each switch the way you pick here, across any of the household&apos;s devices.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="scene-name">Name</Label>
            <Input
              id="scene-name"
              placeholder="e.g. Night"
              maxLength={64}
              aria-invalid={!!errors.name}
              {...form.register('name')}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid gap-2">
            <Label id="scene-icon-label">Icon</Label>
            <Controller
              control={form.control}
              name="icon"
              render={({ field }) => (
                <div role="radiogroup" aria-labelledby="scene-icon-label" className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                  {SCENE_ICONS.map(({ key, label, Icon }) => {
                    const active = field.value === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={label}
                        title={label}
                        onClick={() => field.onChange(key)}
                        className={cn(
                          'flex aspect-square items-center justify-center rounded-xl border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          active
                            ? 'border-primary/60 bg-primary/15 text-brand-ink shadow-glow-sm'
                            : 'text-muted-foreground hover:border-primary/30 hover:text-foreground',
                        )}
                      >
                        <Icon className="h-5 w-5" />
                      </button>
                    );
                  })}
                </div>
              )}
            />
          </div>

          <section className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>
                Switches{' '}
                <span className="font-normal text-muted-foreground">
                  ({actions.length} selected{actions.length ? ` · ${onCount} on, ${actions.length - onCount} off` : ''})
                </span>
              </Label>
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
                setActions(
                  checked ? [...actions, { key: sw.id, state: defaultState }] : actions.filter((a) => a.key !== sw.id),
                )
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
            {errors.actions && <p className="text-xs text-destructive">{errors.actions.message}</p>}
            {unknown.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs">
                {unknown.length} switch{unknown.length > 1 ? 'es are' : ' is'} no longer in this household.
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setActions(actions.filter((a) => known.has(a.key)))}
                >
                  Remove {unknown.length > 1 ? 'them' : 'it'}
                </Button>
              </div>
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
              {existing ? 'Save changes' : 'Create scene'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
