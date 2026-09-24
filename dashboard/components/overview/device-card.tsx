'use client';

import { ChevronRight, Cpu } from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { timeAgo } from '@/lib/format';
import type { Device, SwitchView } from '@/lib/types';

import { SwitchTile } from './switch-tile';

export function OnlineBadge({ online, lastSeen }: { online: boolean; lastSeen?: string | null }) {
  return online ? (
    <Badge>
      <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--brand))]" />
      Online
    </Badge>
  ) : (
    <Badge variant="secondary" title={lastSeen ? `Last seen ${timeAgo(lastSeen)}` : undefined}>
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
      Offline{lastSeen ? ` · ${timeAgo(lastSeen)}` : ''}
    </Badge>
  );
}

export function DeviceCard({
  device,
  switches,
  loadingConfig,
}: {
  device: Device;
  switches: SwitchView[];
  loadingConfig: boolean;
}) {
  const name = device.friendly_name || device.device_id;
  const onCount = switches.filter((s) => s.state === 'ON').length;

  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
          <Cpu className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-bold">{name}</h2>
            <OnlineBadge online={device.is_online} lastSeen={device.last_seen_at} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {switches.length} switch{switches.length === 1 ? '' : 'es'} · {onCount} on
          </p>
        </div>
        <Link
          href={`/devices/${encodeURIComponent(device.device_id)}`}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Manage <ChevronRight className="h-4 w-4" />
        </Link>
      </div>

      {switches.length === 0 && loadingConfig ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[124px] rounded-xl" />
          ))}
        </div>
      ) : switches.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No switches match the current filter.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {switches.map((s) => (
            <SwitchTile key={s.id} view={s} />
          ))}
        </div>
      )}
    </Card>
  );
}
