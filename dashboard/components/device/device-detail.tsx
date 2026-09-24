'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CalendarClock, Cpu, MapPin, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';

import { Callout, ConfirmAction, EmptyState, ErrorState, PageHeader } from '@/components/common';
import { OnlineBadge } from '@/components/overview/device-card';
import { SwitchTile } from '@/components/overview/switch-tile';
import { LocationDialog } from '@/components/schedules/location-dialog';
import { ScheduleDialog, type ScheduleTarget } from '@/components/schedules/schedule-dialog';
import { ScheduleList } from '@/components/schedules/schedule-list';
import { DeviceUsageSection } from '@/components/usage/device-usage';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Skeleton } from '@/components/ui/skeleton';
import { devicesApi, errorMessage } from '@/lib/api';
import { qk } from '@/lib/cache';
import { timeAgo } from '@/lib/format';
import { buildSwitchViews, useDeviceConfig, useDevices, useHouseholds } from '@/lib/queries';
import { formatUtcOffset } from '@/lib/schedule';
import type { Device, Schedule, SwitchView } from '@/lib/types';

import { SwitchConfigDialog } from './switch-config-dialog';

const renameSchema = z.object({
  friendlyName: z.string().trim().min(1, 'Enter a name').max(64, 'At most 64 characters'),
});

function RenameDialog({
  device,
  open,
  onOpenChange,
}: {
  device: Device;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const form = useForm<z.infer<typeof renameSchema>>({
    resolver: zodResolver(renameSchema),
    values: { friendlyName: device.friendly_name ?? '' },
  });
  const mutation = useMutation({
    mutationFn: (name: string) => devicesApi.rename(device.device_id, name),
    onSuccess: (_, name) => {
      qc.setQueryData<Device[]>(qk.devices, (list) =>
        list?.map((d) => (d.device_id === device.device_id ? { ...d, friendly_name: name } : d)),
      );
      void qc.invalidateQueries({ queryKey: qk.deviceConfig(device.device_id) });
      toast.success('Device renamed');
      onOpenChange(false);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename device</DialogTitle>
          <DialogDescription>The new name shows up in the app for everyone in the household.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={form.handleSubmit((v) => mutation.mutate(v.friendlyName))}
          className="grid gap-4"
          noValidate
        >
          <div className="grid gap-2">
            <Label htmlFor="friendlyName">Name</Label>
            <Input id="friendlyName" autoFocus {...form.register('friendlyName')} />
            {form.formState.errors.friendlyName && (
              <p className="text-xs text-destructive">{form.formState.errors.friendlyName.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
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

export function DeviceDetail({ deviceId }: { deviceId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const devicesQuery = useDevices();
  const configQuery = useDeviceConfig(deviceId);
  const households = useHouseholds();
  const [renameOpen, setRenameOpen] = useState(false);
  const [editing, setEditing] = useState<SwitchView | null>(null);
  const [scheduleDialog, setScheduleDialog] = useState<{ existing?: Schedule; channel?: number } | null>(null);
  const [locationOpen, setLocationOpen] = useState(false);

  const device = devicesQuery.data?.find((d) => d.device_id === deviceId);
  const switches = useMemo(
    () => (device ? buildSwitchViews(device, configQuery.data) : []),
    [device, configQuery.data],
  );
  const zones = useMemo(
    () => [...new Set(switches.map((s) => s.zone).filter(Boolean))].sort(),
    [switches],
  );

  // Device → household isn't in GET /devices today; fall back to "owner of any household".
  const isOwner = useMemo(() => {
    const list = households.data ?? [];
    if (device?.household_id != null) return list.find((h) => h.id === device.household_id)?.role === 'owner';
    return list.some((h) => h.role === 'owner');
  }, [households.data, device?.household_id]);

  if (devicesQuery.isLoading) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }
  if (devicesQuery.isError) return <ErrorState error={devicesQuery.error} onRetry={() => devicesQuery.refetch()} />;
  if (!device) {
    return (
      <EmptyState icon={Cpu} title="Device not found">
        It may have been removed from your household.{' '}
        <Link href="/" className="font-semibold text-brand-ink hover:underline">
          Back to overview
        </Link>
      </EmptyState>
    );
  }

  const name = device.friendly_name || device.device_id;
  const config = configQuery.data;
  const target: ScheduleTarget = { device, config, switches };

  const remove = async () => {
    await devicesApi.remove(device.device_id);
    qc.setQueryData<Device[]>(qk.devices, (list) => list?.filter((d) => d.device_id !== device.device_id));
    qc.removeQueries({ queryKey: qk.deviceConfig(device.device_id) });
    toast.success(`${name} removed from the household`);
    router.replace('/');
  };

  return (
    <>
      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Overview
      </Link>
      <PageHeader
        title={name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <OnlineBadge online={device.is_online} lastSeen={device.last_seen_at} />
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{device.device_id}</code>
          </span>
        }
        actions={
          <Button variant="outline" onClick={() => setRenameOpen(true)}>
            <Pencil /> Rename
          </Button>
        }
      />

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Switches</CardTitle>
            <CardDescription>Tap a tile to toggle. Use the gear for name, zone, boot state, power, safety limits and the lock.</CardDescription>
          </CardHeader>
          <CardContent>
            {configQuery.isLoading && switches.length === 0 ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-[124px] rounded-xl" />
                ))}
              </div>
            ) : switches.length === 0 ? (
              <p className="text-sm text-muted-foreground">This device has no switches configured yet.</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {switches.map((s) => (
                  <div key={s.id} className="relative">
                    <SwitchTile view={s} className="w-full pr-12" />
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      className="absolute bottom-3 right-3"
                      onClick={() => setEditing(s)}
                      aria-label={`Configure ${s.name}`}
                      disabled={!s.config && !configQuery.data}
                    >
                      <Settings2 />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {configQuery.isError && (
              <Callout tone="warning" className="mt-4">
                Couldn&apos;t load this device&apos;s configuration: {errorMessage(configQuery.error)}
              </Callout>
            )}
          </CardContent>
        </Card>

        <DeviceUsageSection deviceId={device.device_id} switches={switches} />

        <Card>
          <CardHeader className="flex-row flex-wrap items-start justify-between gap-3 space-y-0">
            <div className="grid gap-1.5">
              <CardTitle className="flex items-center gap-2">
                <CalendarClock className="h-5 w-5 text-brand-ink" /> Schedules
              </CardTitle>
              <CardDescription>
                Turn switches on or off at set times, on a countdown, or at sunrise/sunset
                {config ? ` · device time ${formatUtcOffset(config.utc_offset_min)}` : ''}.
              </CardDescription>
            </div>
            <Button onClick={() => setScheduleDialog({})} disabled={!config || switches.length === 0}>
              <Plus /> Add schedule
            </Button>
          </CardHeader>
          <CardContent>
            {!config ? (
              <Skeleton className="h-16 rounded-lg" />
            ) : config.schedules.length === 0 ? (
              <EmptyState icon={CalendarClock} title="No schedules yet" className="py-8">
                Add one to switch something automatically — it runs in the cloud, even with every app closed.
              </EmptyState>
            ) : (
              <ScheduleList
                target={target}
                onEdit={(existing) => setScheduleDialog({ existing })}
                onAdd={(channel) => setScheduleDialog({ channel })}
                onSetLocation={() => setLocationOpen(true)}
              />
            )}
          </CardContent>
        </Card>

        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Cpu className="h-5 w-5 text-brand-ink" /> Device
              </CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto,1fr] gap-x-6 gap-y-2 text-sm md:grid-cols-[auto,1fr,auto,1fr]">
                <dt className="text-muted-foreground">Board</dt>
                <dd>{config?.board_type ?? '—'}</dd>
                <dt className="text-muted-foreground">Channels</dt>
                <dd>{config?.channel_count ?? switches.length}</dd>
                <dt className="text-muted-foreground">Interlock</dt>
                <dd>{config ? (config.interlock_enabled ? 'Enabled' : 'Disabled') : '—'}</dd>
                <dt className="text-muted-foreground">Last seen</dt>
                <dd>{device.is_online ? 'Now' : timeAgo(device.last_seen_at)}</dd>
                <dt className="text-muted-foreground">Clock</dt>
                <dd>{config ? formatUtcOffset(config.utc_offset_min) : '—'}</dd>
                <dt className="text-muted-foreground">Location</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  {config?.location_set && config.latitude != null && config.longitude != null
                    ? `${config.latitude.toFixed(3)}, ${config.longitude.toFixed(3)}`
                    : config
                      ? 'Not set'
                      : '—'}
                  {config && (
                    <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setLocationOpen(true)}>
                      <MapPin /> {config.location_set ? 'Change' : 'Set location'}
                    </Button>
                  )}
                </dd>
              </dl>
            </CardContent>
          </Card>
        </div>

        {isOwner && (
          <Card className="border-destructive/30">
            <CardHeader>
              <CardTitle className="text-destructive">Remove device</CardTitle>
              <CardDescription>
                Unclaims the device from the household. It stops appearing for every member and has to be
                claimed again from the mobile app to be used.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ConfirmAction
                title={`Remove ${name}?`}
                description="Everyone in the household loses access to this device until it is claimed again."
                confirmLabel="Remove device"
                onConfirm={remove}
                trigger={
                  <Button variant="destructive">
                    <Trash2 /> Remove device
                  </Button>
                }
              />
            </CardContent>
          </Card>
        )}
      </div>

      <RenameDialog device={device} open={renameOpen} onOpenChange={setRenameOpen} />
      <ScheduleDialog
        targets={[target]}
        initialDeviceId={device.device_id}
        initialChannel={scheduleDialog?.channel}
        existing={scheduleDialog?.existing ?? null}
        open={scheduleDialog != null}
        onOpenChange={(o) => !o && setScheduleDialog(null)}
      />
      <LocationDialog
        deviceId={device.device_id}
        deviceName={name}
        config={config}
        open={locationOpen}
        onOpenChange={setLocationOpen}
      />
      {editing && (
        <SwitchConfigDialog
          view={switches.find((s) => s.id === editing.id) ?? editing}
          zones={zones}
          open
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </>
  );
}
