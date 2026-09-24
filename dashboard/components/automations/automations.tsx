'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Globe, Lock, MoreHorizontal, Pencil, Plus, Smartphone, Trash2, Zap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { Callout, ConfirmAction, EmptyState, ErrorState, HouseholdSelect, PageHeader } from '@/components/common';
import type { DeviceSwitches } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorMessage, householdsApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { formatDays, switchId, timeAgo } from '@/lib/format';
import {
  useAutomations,
  useDeleteAutomation,
  useHouseholdScope,
  useSwitchViews,
  useToggleAutomation,
} from '@/lib/queries';
import { allTimeZones, browserTimeZone, formatIn, minutesUntilZoned, zonedNow } from '@/lib/schedule';
import type { Automation, Household } from '@/lib/types';
import { cn } from '@/lib/utils';

import { AutomationDialog } from './automation-dialog';

/** Owner-only: households.timezone is what schedule triggers are evaluated in. */
function TimezoneDialog({
  household,
  open,
  onOpenChange,
}: {
  household: Household;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const zones = useMemo(() => allTimeZones(), []);
  const [value, setValue] = useState(household.timezone ?? 'UTC');
  const [error, setError] = useState<string | null>(null);
  const browser = browserTimeZone();
  useEffect(() => {
    if (open) {
      setValue(household.timezone ?? 'UTC');
      setError(null);
    }
  }, [open, household.timezone]);

  const mutation = useMutation({
    mutationFn: (tz: string) => householdsApi.setTimezone(household.id, tz),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.households });
      toast.success('Household timezone updated');
      onOpenChange(false);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const tz = value.trim();
    // The backend stores any string, but an unknown zone would break the
    // automation scheduler's Intl lookup — only accept zones the runtime knows.
    if (!zonedNow(tz)) {
      setError(`“${tz}” isn't a timezone this browser recognises. Pick one from the list, e.g. Europe/London.`);
      return;
    }
    mutation.mutate(tz);
  };

  const preview = zonedNow(value.trim());
  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Household timezone</DialogTitle>
          <DialogDescription>
            Timed automations for {household.name} run in this timezone, following daylight-saving changes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <div className="grid gap-2">
            <Label htmlFor="tz">Timezone</Label>
            <Input id="tz" list="tz-list" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
            <datalist id="tz-list">
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              {preview ? `It's ${preview.hhmm} there now.` : 'Type to search, e.g. Asia/Dhaka.'}
              {browser && browser !== value.trim() && (
                <>
                  {' '}
                  <button type="button" className="font-semibold text-brand-ink hover:underline" onClick={() => setValue(browser)}>
                    Use {browser}
                  </button>
                </>
              )}
            </p>
          </div>
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

function AutomationRow({
  automation,
  canEdit,
  timeZone,
  nameOf,
  onEdit,
}: {
  automation: Automation;
  canEdit: boolean;
  timeZone: string;
  nameOf: (deviceId: string, channelIdx: number) => string;
  onEdit: () => void;
}) {
  const toggle = useToggleAutomation();
  const remove = useDeleteAutomation();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const t = automation.trigger;
  const Icon = t.type === 'schedule' ? Clock : Zap;

  const when =
    t.type === 'schedule'
      ? `${formatDays(t.days) || 'Never'} at ${t.time}`
      : `When ${nameOf(t.deviceId, t.channelIdx)} turns ${t.state === 'ON' ? 'on' : 'off'}`;
  const on = automation.actions.filter((a) => a.state === 'ON').map((a) => nameOf(a.deviceId, a.channelIdx));
  const off = automation.actions.filter((a) => a.state === 'OFF').map((a) => nameOf(a.deviceId, a.channelIdx));
  const list = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', '));
  const until = automation.enabled && t.type === 'schedule' ? minutesUntilZoned(t.days, t.time, timeZone) : null;

  return (
    <li className={cn('flex items-center gap-3 px-4 py-3.5', !automation.enabled && 'opacity-70')}>
      <span
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
          automation.enabled ? 'bg-primary/15 text-brand-ink' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{automation.name}</div>
        <div className="truncate text-sm text-muted-foreground">{when}</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {on.length > 0 && (
            <span>
              <span className="font-bold text-brand-ink">ON</span> {list(on)}
            </span>
          )}
          {off.length > 0 && (
            <span>
              <span className="font-bold text-destructive">OFF</span> {list(off)}
            </span>
          )}
          <span className="text-muted-foreground">
            {until != null ? `Next ${formatIn(until)} · ` : ''}
            {automation.lastFiredAt ? `Last ran ${timeAgo(automation.lastFiredAt)}` : 'Never ran'}
          </span>
        </div>
      </div>
      <Switch
        checked={automation.enabled}
        disabled={!canEdit || toggle.isPending}
        onCheckedChange={(enabled) => toggle.mutate({ automation, enabled })}
        aria-label={automation.enabled ? `Disable ${automation.name}` : `Enable ${automation.name}`}
        title={canEdit ? undefined : 'Only a household owner can change automations'}
      />
      {canEdit && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${automation.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil /> Edit
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setConfirmOpen(true)} className="text-destructive focus:text-destructive">
                <Trash2 /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ConfirmAction
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Delete automation?"
            description={<>“{automation.name}” stops running for everyone in the household.</>}
            confirmLabel="Delete"
            onConfirm={async () => {
              await remove.mutateAsync(automation.id);
              toast.success('Automation deleted');
            }}
          />
        </>
      )}
    </li>
  );
}

export function AutomationsPage() {
  const { households, selected, select, devicesQuery, devices, isOwner } = useHouseholdScope();
  const { byDevice, configsLoading } = useSwitchViews(devices);
  const automationsQuery = useAutomations();
  const [dialog, setDialog] = useState<{ existing: Automation | null } | null>(null);
  const [tzOpen, setTzOpen] = useState(false);

  const timeZone = selected?.timezone || 'UTC';
  const groups: DeviceSwitches[] = useMemo(
    () => devices.map((device) => ({ device, switches: byDevice.get(device.device_id) ?? [] })),
    [devices, byDevice],
  );
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) {
      for (const s of g.switches) map.set(s.id, groups.length > 1 ? `${s.name} (${s.deviceName})` : s.name);
    }
    return (deviceId: string, channelIdx: number) => map.get(switchId(deviceId, channelIdx)) ?? `${deviceId} ch${channelIdx}`;
  }, [groups]);

  const automations = (automationsQuery.data ?? []).filter((a) => !selected || a.householdId === selected.id);
  const now = zonedNow(timeZone);
  const browser = browserTimeZone();

  return (
    <>
      <PageHeader
        title="Automations"
        description="Household rules that run on the server — at a time, or when a switch changes."
        actions={
          <>
            <HouseholdSelect households={households.data ?? []} value={selected?.id} onChange={select} />
            {isOwner && (
              <Button onClick={() => setDialog({ existing: null })} disabled={!selected || devices.length === 0}>
                <Plus /> New automation
              </Button>
            )}
          </>
        }
      />

      {selected && (
        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          <Globe className="h-4 w-4" />
          <span>
            Times are in <strong className="text-foreground">{timeZone}</strong>
            {now ? ` · it's ${now.hhmm} there now` : ''}
          </span>
          {isOwner && (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setTzOpen(true)}>
              Change
            </Button>
          )}
          {isOwner && browser && browser !== timeZone && timeZone === 'UTC' && (
            <span className="text-xs">(still the default — you may want {browser})</span>
          )}
        </div>
      )}

      {!isOwner && selected && (
        <Callout tone="info" icon={Lock} className="mb-6">
          You&apos;re a member of {selected.name}. Only household owners can create or change automations.
        </Callout>
      )}

      {automationsQuery.isLoading || devicesQuery.isLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : automationsQuery.isError ? (
        <ErrorState error={automationsQuery.error} onRetry={() => automationsQuery.refetch()} />
      ) : devices.length === 0 && automations.length === 0 ? (
        <EmptyState icon={Smartphone} title="No devices yet">
          Claim a device from the Smart Control mobile app, then automate it here.
        </EmptyState>
      ) : automations.length === 0 ? (
        <EmptyState icon={Zap} title="No automations yet">
          {isOwner
            ? 'Create a rule that runs on its own — e.g. turn the porch light on every evening, or the fan off when the light goes off.'
            : 'The household owner hasn’t created any automations yet.'}
        </EmptyState>
      ) : (
        <ul className="squircle divide-y border bg-card">
          {automations.map((a) => (
            <AutomationRow
              key={a.id}
              automation={a}
              canEdit={isOwner}
              timeZone={timeZone}
              nameOf={nameOf}
              onEdit={() => setDialog({ existing: a })}
            />
          ))}
        </ul>
      )}
      {configsLoading && automations.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Loading switch names…</p>
      )}

      {selected && (
        <AutomationDialog
          householdId={selected.id}
          timeZone={timeZone}
          groups={groups}
          existing={dialog?.existing ?? null}
          open={dialog != null}
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
      {selected && isOwner && <TimezoneDialog household={selected} open={tzOpen} onOpenChange={setTzOpen} />}
    </>
  );
}
