'use client';

import { Cpu, Power, Smartphone, Wifi } from 'lucide-react';
import { useMemo, useState } from 'react';

import { EmptyState, ErrorState, HouseholdSelect, PageHeader } from '@/components/common';
import { SceneQuickRow } from '@/components/scenes/scene-quick-row';
import { Skeleton } from '@/components/ui/skeleton';
import { useDevices, useHouseholds, useSelectedHousehold, useSwitchLabeler, useSwitchViews } from '@/lib/queries';
import { cn } from '@/lib/utils';

import { DeviceCard } from './device-card';

const ALL = '__all__';
const NO_ZONE = '__none__';

function Stat({ icon: Icon, label, value }: { icon: typeof Cpu; label: string; value: string }) {
  return (
    <div className="squircle flex items-center gap-3 border bg-card px-4 py-3">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-brand-ink">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div>
        <div className="text-lg font-bold leading-none">{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

export function Overview() {
  const households = useHouseholds();
  const { selected, select } = useSelectedHousehold(households.data);
  const devicesQuery = useDevices();
  const [zone, setZone] = useState<string>(ALL);

  // GET /devices doesn't carry household_id today; filter only when it's present.
  const devices = useMemo(() => {
    const all = devicesQuery.data ?? [];
    if (!selected || !all.some((d) => d.household_id != null)) return all;
    return all.filter((d) => d.household_id === selected.id);
  }, [devicesQuery.data, selected]);

  const { byDevice, configsLoading } = useSwitchViews(devices);

  const labelFor = useSwitchLabeler(byDevice, devicesQuery.data);
  const allSwitches = useMemo(() => [...byDevice.values()].flat(), [byDevice]);
  const zones = useMemo(() => {
    const set = new Set(allSwitches.map((s) => s.zone).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [allSwitches]);
  const hasUnzoned = allSwitches.some((s) => !s.zone);

  const matchesZone = (z: string) => zone === ALL || (zone === NO_ZONE ? !z : z === zone);

  const online = devices.filter((d) => d.is_online).length;
  const onCount = allSwitches.filter((s) => s.state === 'ON').length;

  return (
    <>
      <PageHeader
        title="Overview"
        description={selected ? selected.name : 'Your devices and switches, live.'}
        actions={
          <HouseholdSelect
            households={households.data ?? []}
            value={selected?.id}
            onChange={(id) => {
              setZone(ALL);
              select(id);
            }}
          />
        }
      />

      {devicesQuery.isLoading ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[66px] rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : devicesQuery.isError ? (
        <ErrorState error={devicesQuery.error} onRetry={() => devicesQuery.refetch()} />
      ) : devices.length === 0 ? (
        <EmptyState icon={Smartphone} title="No devices yet">
          Devices are paired and claimed from the Smart Control mobile app on the same Wi-Fi network.
          Once claimed, they show up here automatically.
        </EmptyState>
      ) : (
        <div className="grid gap-6">
          <SceneQuickRow householdId={selected?.id} ready={!households.isLoading} labelFor={labelFor} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat icon={Wifi} label="Devices online" value={`${online}/${devices.length}`} />
            <Stat icon={Power} label="Switches on" value={`${onCount}/${allSwitches.length}`} />
            <Stat icon={Cpu} label="Zones" value={String(zones.length)} />
          </div>

          {(zones.length > 0 || hasUnzoned) && (
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="tablist" aria-label="Filter by zone">
              {[
                { key: ALL, label: 'All zones' },
                ...zones.map((z) => ({ key: z, label: z })),
                ...(hasUnzoned && zones.length > 0 ? [{ key: NO_ZONE, label: 'No zone' }] : []),
              ].map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={zone === key}
                  onClick={() => setZone(key)}
                  className={cn(
                    'shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-all',
                    zone === key
                      ? 'border-primary/60 bg-primary/15 text-foreground shadow-glow-sm'
                      : 'text-muted-foreground hover:border-primary/30 hover:text-foreground',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {devices.map((d) => {
            const switches = (byDevice.get(d.device_id) ?? []).filter((s) => matchesZone(s.zone));
            if (zone !== ALL && switches.length === 0) return null;
            return (
              <DeviceCard key={d.device_id} device={d} switches={switches} loadingConfig={configsLoading} />
            );
          })}
        </div>
      )}
    </>
  );
}
