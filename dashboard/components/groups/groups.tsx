'use client';

import { Boxes, Loader2, MoreHorizontal, Pencil, Plus, Power, PowerOff, Smartphone, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmAction, EmptyState, ErrorState, HouseholdSelect, PageHeader } from '@/components/common';
import { DeviceVisual } from '@/components/device-visual';
import { LockBadge } from '@/components/overview/switch-tile';
import type { DeviceSwitches } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { normalizeState } from '@/lib/cache';
import { deviceKindFromName } from '@/lib/device-kind';
import { defaultChannelName, switchId } from '@/lib/format';
import { useDeleteGroup, useGroups, useHouseholdScope, useSetGroupState, useSwitchViews } from '@/lib/queries';
import type { Device, Group, SwitchRef } from '@/lib/types';
import { cn } from '@/lib/utils';

import { GroupDialog } from './group-dialog';

interface GroupStatus {
  total: number;
  on: number;
  reachable: number;
  offline: number;
  /** Reachable members that are locked (group ON/OFF skips them). */
  locked: number;
  label: string;
  tone: 'on' | 'partial' | 'off' | 'offline' | 'empty';
}

/** "All on / Partially on / All off" from live channel state — the app's _GroupTile logic. */
function groupStatus(group: Group, devices: Map<string, Device>, lockedIds: Set<string>): GroupStatus {
  let on = 0;
  let offline = 0;
  let locked = 0;
  for (const m of group.members) {
    const d = devices.get(m.deviceId);
    if (!d || !d.is_online) {
      offline += 1;
      continue;
    }
    if (lockedIds.has(switchId(m.deviceId, m.channelIdx))) locked += 1;
    if (normalizeState(d.channels.find((c) => c.channelIdx === m.channelIdx)?.state) === 'ON') on += 1;
  }
  const total = group.members.length;
  const reachable = total - offline;
  const suffix = offline > 0 && reachable > 0 ? ` · ${offline} offline` : '';
  if (total === 0) return { total, on, reachable, offline, locked, label: 'No switches', tone: 'empty' };
  if (reachable === 0) return { total, on, reachable, offline, locked, label: 'Offline', tone: 'offline' };
  if (on === reachable) return { total, on, reachable, offline, locked, label: `All on${suffix}`, tone: 'on' };
  if (on > 0) return { total, on, reachable, offline, locked, label: `Partially on · ${on} of ${reachable}${suffix}`, tone: 'partial' };
  return { total, on, reachable, offline, locked, label: `All off${suffix}`, tone: 'off' };
}

function GroupTile({
  group,
  devices,
  labelFor,
  lockedIds,
  onEdit,
}: {
  group: Group;
  devices: Map<string, Device>;
  lockedIds: Set<string>;
  labelFor: (m: SwitchRef) => string;
  onEdit: () => void;
}) {
  const setState = useSetGroupState();
  const remove = useDeleteGroup();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const status = groupStatus(group, devices, lockedIds);
  const pendingState = setState.isPending ? setState.variables?.state : null;
  const allLocked = status.reachable > 0 && status.locked === status.reachable;
  const canControl = status.reachable > status.locked && !setState.isPending;
  const kind = deviceKindFromName(group.name);
  const run = (state: 'ON' | 'OFF') => setState.mutate({ group, state, labelFor });
  const names = group.members.map(labelFor);

  return (
    <article
      className={cn(
        'squircle flex flex-col gap-4 border p-4 transition-all duration-300',
        status.tone === 'on' || status.tone === 'partial'
          ? 'border-primary/40 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent'
          : 'bg-card',
        status.tone === 'on' && 'shadow-glow',
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          disabled={!canControl}
          onClick={() => run(status.tone === 'on' ? 'OFF' : 'ON')}
          aria-label={`${group.name}: ${status.label}. Click to turn ${status.tone === 'on' ? 'off' : 'on'}.`}
          className="relative -ml-2 -mt-1 h-[76px] w-[92px] shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
        >
          <DeviceVisual
            kind={kind === 'appliance' ? 'switch' : kind}
            on={status.on > 0}
            dimmed={status.tone === 'offline' || status.tone === 'empty'}
            className="h-full w-full"
          />
          {setState.isPending && (
            <span className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </span>
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-base font-bold leading-tight">{group.name}</h3>
            {status.locked > 0 && <LockBadge className="shrink-0" label={allLocked ? 'Locked' : `${status.locked} locked`} />}
          </div>
          <div
            className={cn(
              'mt-1 flex items-center gap-1.5 text-xs font-semibold',
              status.tone === 'on' && 'text-brand-ink',
              status.tone === 'partial' && 'text-warning',
              status.tone === 'offline' && 'text-destructive',
              (status.tone === 'off' || status.tone === 'empty') && 'text-muted-foreground',
            )}
          >
            <span
              className={cn(
                'h-2 w-2 shrink-0 rounded-full bg-current',
                status.tone === 'on' && 'shadow-[0_0_6px_hsl(var(--brand))]',
              )}
            />
            <span className="truncate">{status.label}</span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={names.join(', ')}>
            {allLocked && 'Every reachable switch is locked · '}
            {status.total} switch{status.total === 1 ? '' : 'es'}
            {names.length > 0 && ` · ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4}` : ''}`}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${group.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil /> Edit group
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfirmOpen(true)} className="text-destructive focus:text-destructive">
              <Trash2 /> Delete group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-auto grid grid-cols-2 gap-2">
        <Button
          size="lg"
          disabled={!canControl}
          loading={pendingState === 'ON'}
          onClick={() => run('ON')}
          className="bg-primary text-primary-foreground"
          aria-label={`Turn ${group.name} on`}
        >
          {pendingState !== 'ON' && <Power />} On
        </Button>
        <Button
          size="lg"
          variant="destructive"
          disabled={!canControl}
          loading={pendingState === 'OFF'}
          onClick={() => run('OFF')}
          aria-label={`Turn ${group.name} off`}
        >
          {pendingState !== 'OFF' && <PowerOff />} Off
        </Button>
      </div>

      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${group.name}?`}
        description="The group is removed for everyone in the household. The switches themselves aren't changed."
        confirmLabel="Delete group"
        onConfirm={async () => {
          await remove.mutateAsync(group.id);
          toast.success('Group deleted');
        }}
      />
    </article>
  );
}

export function GroupsPage() {
  const { households, selected, select, devicesQuery, devices } = useHouseholdScope();
  const { byDevice, configByDevice } = useSwitchViews(devices);
  const groupsQuery = useGroups();
  const [dialog, setDialog] = useState<{ existing: Group | null } | null>(null);

  const deviceMap = useMemo(() => new Map((devicesQuery.data ?? []).map((d) => [d.device_id, d])), [devicesQuery.data]);
  const pickerGroups: DeviceSwitches[] = useMemo(
    () => devices.map((device) => ({ device, switches: byDevice.get(device.device_id) ?? [] })),
    [devices, byDevice],
  );
  const lockedIds = useMemo(
    () => new Set([...byDevice.values()].flat().filter((s) => s.locked).map((s) => s.id)),
    [byDevice],
  );
  const labelFor = useMemo(() => {
    const names = new Map<string, string>();
    for (const list of byDevice.values()) for (const s of list) names.set(s.id, s.name);
    return (m: SwitchRef) => {
      const name = names.get(switchId(m.deviceId, m.channelIdx));
      if (name) return name;
      const d = deviceMap.get(m.deviceId);
      return d ? `${d.friendly_name || d.device_id} · ${defaultChannelName(m.channelIdx)}` : `${m.deviceId}:${m.channelIdx}`;
    };
  }, [byDevice, deviceMap]);

  // Older backends don't return householdId — then every group is shown.
  const groups = (groupsQuery.data ?? []).filter((g) => !selected || g.householdId == null || g.householdId === selected.id);

  return (
    <>
      <PageHeader
        title="Groups"
        description="Switch several things on or off together, across devices."
        actions={
          <>
            <HouseholdSelect households={households.data ?? []} value={selected?.id} onChange={select} />
            <Button onClick={() => setDialog({ existing: null })} disabled={devices.length === 0}>
              <Plus /> New group
            </Button>
          </>
        }
      />

      {groupsQuery.isLoading || devicesQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[196px] rounded-xl" />
          ))}
        </div>
      ) : groupsQuery.isError ? (
        <ErrorState error={groupsQuery.error} onRetry={() => groupsQuery.refetch()} />
      ) : devices.length === 0 && groups.length === 0 ? (
        <EmptyState icon={Smartphone} title="No devices yet">
          Claim a device from the Smart Control mobile app, then group its switches here.
        </EmptyState>
      ) : groups.length === 0 ? (
        <EmptyState icon={Boxes} title="No groups yet">
          Make a group like &ldquo;Living room lights&rdquo; to switch several things with one tap.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => (
            <GroupTile key={g.id} group={g} devices={deviceMap} labelFor={labelFor} lockedIds={lockedIds} onEdit={() => setDialog({ existing: g })} />
          ))}
        </div>
      )}

      <GroupDialog
        householdId={selected?.id}
        groups={pickerGroups}
        configs={configByDevice}
        existing={dialog?.existing ?? null}
        open={dialog != null}
        onOpenChange={(o) => !o && setDialog(null)}
      />
    </>
  );
}
