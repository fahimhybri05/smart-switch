'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRightLeft, Cpu, Info, KeyRound, MoreHorizontal, Unlink } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

import {
  ConfirmDialog,
  Forbidden,
  isForbidden,
  OnlineDot,
  Pagination,
  SearchBox,
  TableCard,
  Th,
  useAdminAction,
  useClampPage,
  useDebounced,
} from '@/components/admin/shared';
import { Callout, EmptyState, ErrorState, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { adminApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { formatDateTime, timeAgo } from '@/lib/format';
import type { AdminDevice, AdminDeviceStatus, DeviceDiagnostics } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;
const ALL = 'all';

/* ------------------------------ Diagnostics ------------------------------ */

function formatUptime(raw: unknown): string {
  const s = Number(raw);
  if (!Number.isFinite(s) || s < 0) return raw == null ? '—' : String(raw);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(s % 60)}s`;
}

function formatHeap(raw: unknown): string {
  const n = Number(raw);
  return Number.isFinite(n) ? `${(n / 1024).toFixed(1)} KB` : raw == null ? '—' : String(raw);
}

function rssiLabel(raw: unknown): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw == null ? '—' : String(raw);
  const quality = n >= -60 ? 'strong' : n >= -70 ? 'good' : n >= -80 ? 'weak' : 'very weak';
  return `${n} dBm (${quality})`;
}

function DiagnosticsMenu({ diag, deviceId }: { diag: DeviceDiagnostics | null; deviceId: string }) {
  if (!diag) return <span className="text-xs text-muted-foreground">—</span>;
  const rows: [string, string][] = [
    ['Firmware', diag.fw == null ? '—' : String(diag.fw)],
    ['Reset reason', diag.resetReason == null ? '—' : String(diag.resetReason)],
    ['Wi-Fi signal', rssiLabel(diag.rssi)],
    ['Free heap', formatHeap(diag.freeHeap)],
    ['Uptime at connect', formatUptime(diag.uptimeS)],
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 font-mono text-xs" aria-label={`Diagnostics for ${deviceId}`}>
          <Info className="text-muted-foreground" />
          {diag.fw != null ? String(diag.fw) : 'diag'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-3">
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">Last connect</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="truncate text-right font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        {diag.at && (
          <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">Reported {formatDateTime(diag.at)}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------- Reassign ------------------------------- */

function ReassignDialog({
  device,
  open,
  onOpenChange,
}: {
  device: AdminDevice;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const run = useAdminAction();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useDebounced(search.trim());
  const households = useQuery({
    queryKey: qk.adminHouseholds(q),
    queryFn: () => adminApi.households(q),
    enabled: open,
  });

  const close = (o: boolean) => {
    if (busy) return;
    onOpenChange(o);
    if (!o) {
      setTimeout(() => {
        setSearch('');
        setSelected(null);
      }, 200);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Reassign {device.friendlyName || device.deviceId}</DialogTitle>
          <DialogDescription>
            Moves the device to another household. Its owner becomes that household&apos;s owner, and its existing
            schedules are paused so they don&apos;t fire in someone else&apos;s home.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="household-search">Household</Label>
          <Input
            id="household-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, member email or #id"
            autoFocus
          />
          <div className="max-h-64 overflow-y-auto rounded-xl border">
            {households.isLoading ? (
              <div className="grid gap-1 p-2">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : households.isError ? (
              <p className="p-4 text-sm text-destructive">Couldn&apos;t load households.</p>
            ) : !households.data?.length ? (
              <p className="p-4 text-center text-sm text-muted-foreground">No matching households.</p>
            ) : (
              <ul className="divide-y" role="listbox" aria-label="Households">
                {households.data.map((h) => {
                  const current = h.id === device.householdId;
                  return (
                    <li key={h.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={selected === h.id}
                        disabled={current}
                        onClick={() => setSelected(h.id)}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
                          selected === h.id && 'bg-primary/10 ring-1 ring-inset ring-primary/40',
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {h.name} <span className="text-xs text-muted-foreground">#{h.id}</span>
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {h.ownerEmail ?? 'no owner'} · {h.memberCount} member{h.memberCount === 1 ? '' : 's'}
                          </span>
                        </span>
                        {current && <Badge variant="secondary">Current</Badge>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={selected === null}
            loading={busy}
            onClick={async () => {
              if (selected === null) return;
              setBusy(true);
              try {
                await run(() => adminApi.reassignDevice(device.deviceId, selected), 'Device reassigned');
                setBusy(false);
                close(false);
              } catch {
                setBusy(false);
              }
            }}
          >
            <ArrowRightLeft /> Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* --------------------------------- Actions ------------------------------- */

function DeviceActions({ device }: { device: AdminDevice }) {
  const run = useAdminAction();
  const [dialog, setDialog] = useState<'unclaim' | 'reassign' | 'reset' | null>(null);
  const setOpen = (k: typeof dialog) => (o: boolean) => setDialog(o ? k : null);
  const label = device.friendlyName || device.deviceId;

  return (
    <>
      {/* Non-modal: the menu opens dialogs, and a modal menu closing into a modal
          dialog can leave pointer-events stuck on <body> (Radix). */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="max-w-[220px] truncate">{label}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setDialog('reassign')}>
            <ArrowRightLeft /> Reassign…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDialog('reset')}>
            <KeyRound /> Reset secret…
          </DropdownMenuItem>
          {device.householdId != null && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDialog('unclaim')} className="text-destructive focus:text-destructive">
                <Unlink /> Unclaim…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={dialog === 'unclaim'}
        onOpenChange={setOpen('unclaim')}
        title={`Unclaim ${label}?`}
        description={
          <>
            <p>
              Removes it from <strong className="text-foreground">{device.householdName ?? 'its household'}</strong>.
              Its members lose access and its schedules are paused. Hook URLs pointing at it stop working.
            </p>
            <p>The device keeps its secret — whoever claims it next needs it (from the device&apos;s setup page).</p>
          </>
        }
        confirmLabel="Unclaim device"
        onConfirm={() => run(() => adminApi.unclaimDevice(device.deviceId), `${label} unclaimed`)}
      />
      <ConfirmDialog
        open={dialog === 'reset'}
        onOpenChange={setOpen('reset')}
        title={`Reset the secret of ${label}?`}
        description={
          <>
            <p>
              The stored secret is cleared and the device&apos;s live connection is dropped.{' '}
              <strong className="text-foreground">
                The device will re-pair with its current secret on next connect
              </strong>{' '}
              (it reconnects within seconds). Household and owner stay the same.
            </p>
            <p>
              Use this when a device was factory-reset and generated a new secret, so it&apos;s being rejected.
              Until it reconnects, the first connection presenting this device id is trusted.
            </p>
          </>
        }
        confirmLabel="Reset secret"
        onConfirm={() =>
          run(
            () => adminApi.resetDeviceSecret(device.deviceId),
            `Secret reset — ${label} re-pairs on its next connect`,
          )
        }
      />
      <ReassignDialog device={device} open={dialog === 'reassign'} onOpenChange={setOpen('reassign')} />
    </>
  );
}

/* ---------------------------------- Page --------------------------------- */

export function AdminDevices() {
  const params = useSearchParams();
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const [status, setStatus] = useState<AdminDeviceStatus | typeof ALL>(ALL);
  const [page, setPage] = useState(0);
  const q = useDebounced(search.trim());

  const devices = useQuery({
    queryKey: qk.adminDevices(q, status, page),
    queryFn: () =>
      adminApi.devices({
        q,
        status: status === ALL ? undefined : status,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  useClampPage(devices.data?.items.length, page, setPage);

  if (isForbidden(devices.error)) return <Forbidden />;

  return (
    <>
      <PageHeader
        title="Devices"
        description="Every device that has ever connected or been claimed."
        actions={
          <>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as AdminDeviceStatus | typeof ALL);
                setPage(0);
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All devices</SelectItem>
                <SelectItem value="online">Online</SelectItem>
                <SelectItem value="offline">Offline</SelectItem>
                <SelectItem value="unclaimed">Unclaimed</SelectItem>
              </SelectContent>
            </Select>
            <SearchBox
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(0);
              }}
              placeholder="Device, household or owner"
            />
          </>
        }
      />
      {devices.isLoading ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : devices.isError ? (
        <ErrorState error={devices.error} onRetry={() => devices.refetch()} />
      ) : !devices.data?.items.length ? (
        <EmptyState icon={Cpu} title={q || status !== ALL ? 'No matching devices' : 'No devices yet'}>
          {q || status !== ALL ? 'Try a different search or filter.' : 'Devices appear here after their first connect.'}
        </EmptyState>
      ) : (
        <div className={cn('grid gap-3 transition-opacity', devices.isPlaceholderData && 'opacity-60')}>
          <TableCard>
            <thead>
              <tr>
                <Th>Device</Th>
                <Th>Household</Th>
                <Th>Owner</Th>
                <Th>Last seen</Th>
                <Th>Firmware</Th>
                <Th className="w-12">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {devices.data.items.map((d) => (
                <tr key={d.deviceId} className="hover:bg-muted/30">
                  <td className="max-w-[280px]">
                    <div className="flex items-center gap-2.5">
                      <OnlineDot online={d.online} />
                      <div className="min-w-0">
                        <div className="truncate font-semibold">{d.friendlyName || d.deviceId}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {d.deviceId} · {d.switchCount} switch{d.switchCount === 1 ? '' : 'es'}
                        </div>
                      </div>
                    </div>
                    <span className="sr-only">{d.online ? 'Online' : 'Offline'}</span>
                  </td>
                  <td className="max-w-[200px]">
                    {d.householdId == null ? (
                      <Badge variant="warning">Unclaimed</Badge>
                    ) : (
                      <span className="block truncate">
                        {d.householdName} <span className="text-xs text-muted-foreground">#{d.householdId}</span>
                      </span>
                    )}
                  </td>
                  <td className="max-w-[220px] truncate">
                    {d.ownerEmail ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="whitespace-nowrap">
                    {d.online ? (
                      <span className="font-semibold text-brand-ink">Online now</span>
                    ) : (
                      <span title={formatDateTime(d.lastSeenAt)}>{timeAgo(d.lastSeenAt)}</span>
                    )}
                    {d.lastConnectedAt && (
                      <div className="text-xs text-muted-foreground" title={formatDateTime(d.lastConnectedAt)}>
                        connected {timeAgo(d.lastConnectedAt)}
                      </div>
                    )}
                  </td>
                  <td>
                    <DiagnosticsMenu diag={d.diagnostics} deviceId={d.deviceId} />
                  </td>
                  <td className="text-right">
                    <DeviceActions device={d} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableCard>
          <Pagination page={page} pageSize={PAGE_SIZE} total={devices.data.total} onChange={setPage} />
          <Callout tone="info" className="mt-2">
            <p>
              The dot and &ldquo;Online now&rdquo; reflect the live connection right now; firmware details come
              from the device&apos;s last connect.
            </p>
          </Callout>
        </div>
      )}
    </>
  );
}
