'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { parseSwitchKey, SwitchChecklist, type DeviceSwitches } from '@/components/pickers';
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
import { useSaveGroup } from '@/lib/queries';
import type { DeviceConfig, Group } from '@/lib/types';

const MAX_MEMBERS = 64; // routes/groups.js groupSchema .max(64)

const schema = z.object({
  name: z.string().trim().max(64, 'At most 64 characters'),
  members: z.array(z.string()).max(MAX_MEMBERS, `At most ${MAX_MEMBERS} switches`),
});
type Values = z.infer<typeof schema>;

const defaults = (g: Group | null | undefined): Values => ({
  name: g?.name ?? '',
  members: (g?.members ?? []).map((m) => switchId(m.deviceId, m.channelIdx)),
});

/** Create/edit a group: a name plus any switches across the household's devices (the app's _GroupEditorSheet). */
export function GroupDialog({
  householdId,
  groups,
  configs,
  existing,
  open,
  onOpenChange,
}: {
  householdId: number | undefined;
  groups: DeviceSwitches[];
  configs: Map<string, DeviceConfig | undefined>;
  existing?: Group | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveGroup();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(existing) });

  useEffect(() => {
    if (open) {
      form.reset(defaults(existing));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const watchedMembers = useWatch({ control: form.control, name: 'members' });
  const members = useMemo(() => watchedMembers ?? [], [watchedMembers]);
  const selected = useMemo(() => new Set(members), [members]);
  const known = useMemo(() => new Set(groups.flatMap((g) => g.switches.map((s) => s.id))), [groups]);
  const unknown = members.filter((k) => !known.has(k));
  const interlocked = groups
    .filter((g) => configs.get(g.device.device_id)?.interlock_enabled && g.switches.filter((s) => selected.has(s.id)).length > 1)
    .map((g) => g.device.friendly_name || g.device.device_id);

  const setMembers = (next: string[]) =>
    form.setValue('members', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });

  const onSubmit = form.handleSubmit(async (v) => {
    setError(null);
    try {
      await save.mutateAsync({
        id: existing?.id,
        householdId: existing ? undefined : householdId,
        // Same fallback as the app's group editor.
        name: v.name.trim() || 'Unnamed group',
        members: v.members.map((k) => parseSwitchKey(k)).filter((m): m is NonNullable<typeof m> => m != null),
      });
      toast.success(existing ? 'Group updated' : 'Group created');
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
          <DialogTitle>{existing ? 'Edit group' : 'New group'}</DialogTitle>
          <DialogDescription>Control several switches at once — they can be on different devices.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="group-name">Name</Label>
            <Input id="group-name" placeholder="e.g. Living room lights" aria-invalid={!!errors.name} {...form.register('name')} />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>Switches</Label>
              <span className="text-xs text-muted-foreground">{members.length} selected</span>
            </div>
            <SwitchChecklist
              groups={groups}
              isSelected={(sw) => selected.has(sw.id)}
              onToggle={(sw, checked) => setMembers(checked ? [...members, sw.id] : members.filter((k) => k !== sw.id))}
            />
            {errors.members && <p className="text-xs text-destructive">{errors.members.message}</p>}
            {unknown.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs">
                {unknown.length} switch{unknown.length > 1 ? 'es are' : ' is'} no longer in this household.
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setMembers(members.filter((k) => known.has(k)))}
                >
                  Remove {unknown.length > 1 ? 'them' : 'it'}
                </Button>
              </div>
            )}
            {interlocked.length > 0 && (
              <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
                Interlock is on for {interlocked.join(', ')}: paired channels can&apos;t be on together, so &ldquo;On&rdquo;
                may leave this group partially on.
              </p>
            )}
          </div>

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
              {existing ? 'Save changes' : 'Create group'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
