'use client';

import { Lock, MoreHorizontal, Pencil, Play, Plus, Smartphone, Sparkles, Trash2, WifiOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ConfirmAction, EmptyState, ErrorState, HouseholdSelect, PageHeader } from '@/components/common';
import type { DeviceSwitches } from '@/components/pickers';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { switchId } from '@/lib/format';
import {
  useDeleteScene,
  useHouseholdScope,
  useRunScene,
  useScenes,
  useSwitchLabeler,
  useSwitchViews,
} from '@/lib/queries';
import type { Device, Scene, SwitchRef } from '@/lib/types';

import { SceneDialog } from './scene-dialog';
import { SceneGlyph } from './scene-icon';

const list = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', '));

function SceneCard({
  scene,
  labelFor,
  lockedIds,
  devices,
  onEdit,
}: {
  scene: Scene;
  labelFor: (m: SwitchRef) => string;
  lockedIds: Set<string>;
  devices: Map<string, Device>;
  onEdit: () => void;
}) {
  const run = useRunScene();
  const remove = useDeleteScene();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const on = scene.actions.filter((a) => a.state === 'ON').map(labelFor);
  const off = scene.actions.filter((a) => a.state === 'OFF').map(labelFor);
  const locked = scene.actions.filter((a) => lockedIds.has(switchId(a.deviceId, a.channelIdx))).length;
  const offline = scene.actions.filter((a) => devices.get(a.deviceId)?.is_online === false).length;

  return (
    <article className="squircle flex flex-col gap-4 border bg-card p-4 shadow-soft">
      <div className="flex items-start gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-brand-ink">
          <SceneGlyph icon={scene.icon} className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-bold leading-tight">{scene.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {scene.actions.length} switch{scene.actions.length === 1 ? '' : 'es'}
          </p>
          <div className="mt-1.5 grid gap-0.5 text-xs">
            {on.length > 0 && (
              <span className="truncate" title={on.join(', ')}>
                <span className="font-bold text-brand-ink">ON</span> {list(on)}
              </span>
            )}
            {off.length > 0 && (
              <span className="truncate" title={off.join(', ')}>
                <span className="font-bold text-destructive">OFF</span> {list(off)}
              </span>
            )}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${scene.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil /> Edit scene
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setConfirmOpen(true)} className="text-destructive focus:text-destructive">
              <Trash2 /> Delete scene
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {(locked > 0 || offline > 0) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold">
          {locked > 0 && (
            <span className="inline-flex items-center gap-1 text-warning">
              <Lock className="h-3 w-3" /> {locked} locked · will be skipped
            </span>
          )}
          {offline > 0 && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <WifiOff className="h-3 w-3" /> {offline} offline
            </span>
          )}
        </div>
      )}

      <Button
        size="lg"
        className="mt-auto w-full"
        loading={run.isPending}
        disabled={scene.actions.length === 0}
        onClick={() => run.mutate({ scene, labelFor })}
        aria-label={`Run ${scene.name}`}
      >
        {!run.isPending && <Play />} Run
      </Button>

      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete ${scene.name}?`}
        description="The scene is removed for everyone in the household. The switches themselves aren't changed."
        confirmLabel="Delete scene"
        onConfirm={async () => {
          await remove.mutateAsync(scene.id);
          toast.success('Scene deleted');
        }}
      />
    </article>
  );
}

export function ScenesPage() {
  const { households, selected, select, devicesQuery, devices } = useHouseholdScope();
  const { byDevice } = useSwitchViews(devices);
  const scenesQuery = useScenes(selected?.id, !households.isLoading);
  const [dialog, setDialog] = useState<{ existing: Scene | null } | null>(null);

  const labelFor = useSwitchLabeler(byDevice, devicesQuery.data);
  const deviceMap = useMemo(() => new Map((devicesQuery.data ?? []).map((d) => [d.device_id, d])), [devicesQuery.data]);
  const lockedIds = useMemo(
    () => new Set([...byDevice.values()].flat().filter((s) => s.locked).map((s) => s.id)),
    [byDevice],
  );
  const pickerGroups: DeviceSwitches[] = useMemo(
    () => devices.map((device) => ({ device, switches: byDevice.get(device.device_id) ?? [] })),
    [devices, byDevice],
  );

  // Rows carry householdId; filter in case the backend ignores ?householdId=.
  const scenes = (scenesQuery.data ?? []).filter((s) => !selected || s.householdId == null || s.householdId === selected.id);

  return (
    <>
      <PageHeader
        title="Scenes"
        description="Set many switches at once with one tap, like “Night” or “Away”."
        actions={
          <>
            <HouseholdSelect households={households.data ?? []} value={selected?.id} onChange={select} />
            <Button onClick={() => setDialog({ existing: null })} disabled={devices.length === 0}>
              <Plus /> New scene
            </Button>
          </>
        }
      />

      {scenesQuery.isLoading || devicesQuery.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[196px] rounded-xl" />
          ))}
        </div>
      ) : scenesQuery.isError ? (
        <ErrorState error={scenesQuery.error} onRetry={() => scenesQuery.refetch()} />
      ) : devices.length === 0 && scenes.length === 0 ? (
        <EmptyState icon={Smartphone} title="No devices yet">
          Claim a device from the Smart Control mobile app, then build scenes from its switches here.
        </EmptyState>
      ) : scenes.length === 0 ? (
        <EmptyState icon={Sparkles} title="No scenes yet">
          Make a scene like &ldquo;Night&rdquo; that turns the porch light on and everything else off, then run it with
          one tap from here or the Overview.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {scenes.map((s) => (
            <SceneCard
              key={s.id}
              scene={s}
              labelFor={labelFor}
              lockedIds={lockedIds}
              devices={deviceMap}
              onEdit={() => setDialog({ existing: s })}
            />
          ))}
        </div>
      )}

      <SceneDialog
        householdId={selected?.id}
        groups={pickerGroups}
        existing={dialog?.existing ?? null}
        open={dialog != null}
        onOpenChange={(o) => !o && setDialog(null)}
      />
    </>
  );
}
