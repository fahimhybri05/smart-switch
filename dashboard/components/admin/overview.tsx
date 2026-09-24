'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Cpu,
  Home,
  KeyRound,
  Lock,
  Mail,
  Power,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  UserPlus,
  Users,
  WifiOff,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { ACTION_LABELS, actionVariant } from '@/components/admin/audit';
import { Forbidden, isForbidden } from '@/components/admin/shared';
import { ErrorState, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DailyBars } from '@/components/usage/charts';
import { adminApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { sourceLabel, timeAgo } from '@/lib/format';
import type { AdminDeviceAttention, AdminStats } from '@/lib/types';
import { cn } from '@/lib/utils';

const nf = new Intl.NumberFormat();
const plural = (n: number, word: string) => `${nf.format(n)} ${word}${n === 1 ? '' : 's'}`;

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

/* --------------------------------- Tiles --------------------------------- */

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: ReactNode;
  href: string;
}) {
  return (
    <Link href={href} className="group rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Card className="h-full transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-primary/40">
        <CardContent className="flex h-full flex-col gap-3 p-5 sm:p-5">
          <div className="flex items-center justify-between text-sm font-semibold text-muted-foreground">
            <span>{label}</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10 text-brand-ink">
              <Icon className="h-4 w-4" />
            </span>
          </div>
          <div className="text-3xl font-extrabold tabular-nums tracking-tight">{value}</div>
          <div className="mt-auto text-xs text-muted-foreground">{sub}</div>
        </CardContent>
      </Card>
    </Link>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <div className="squircle flex items-center gap-3 border bg-card px-4 py-3">
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
          tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-primary/10 text-brand-ink',
        )}
      >
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <div className="text-lg font-bold leading-none tabular-nums">{value}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">
          {label}
          {sub ? <span className="opacity-80"> · {sub}</span> : null}
        </div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  description,
  href,
  hrefLabel = 'View all',
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  href?: string;
  hrefLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {href && (
          <Link
            href={href}
            className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-ink hover:underline"
          >
            {hrefLabel} <ArrowRight className="h-4 w-4" />
          </Link>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/* --------------------------------- Charts -------------------------------- */

/** Single-series magnitude: one hue, sorted bars, direct labels, no legend. */
function SourceBreakdown({ bySource, total }: { bySource: Record<string, number>; total: number }) {
  const rows = Object.entries(bySource).sort((a, b) => b[1] - a[1]);
  const max = rows[0]?.[1] ?? 0;
  if (!rows.length) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No switch changes in the last 24 hours.</p>;
  }
  return (
    <ul className="grid gap-2.5" aria-label="Switch changes by source, last 24 hours">
      {rows.map(([source, count]) => {
        const pct = total ? Math.round((count / total) * 100) : 0;
        return (
          <li
            key={source}
            className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm"
            title={`${sourceLabel(source)}: ${nf.format(count)} (${pct}%)`}
          >
            <span className="truncate text-muted-foreground">{sourceLabel(source)}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${max ? Math.max(2, (count / max) * 100) : 0}%` }}
              />
            </span>
            <span className="w-20 text-right font-semibold tabular-nums">
              {nf.format(count)} <span className="text-xs font-normal text-muted-foreground">{pct}%</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** 24 hourly columns, oldest → now; hover shows the exact count. */
function HourlyBars({ hours }: { hours: { hour: string; count: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...hours.map((h) => h.count));
  const peak = hours.reduce((best, h) => (h.count > best.count ? h : best), hours[0] ?? { hour: '--', count: 0 });
  return (
    <div>
      <div
        className="flex h-36 items-end gap-[3px]"
        role="img"
        aria-label={`Switch changes per hour, last 24 hours. Peak ${peak.count} at ${peak.hour}:00.`}
        onMouseLeave={() => setHover(null)}
      >
        {hours.map((h, i) => (
          <div
            key={`${h.hour}-${i}`}
            className="relative flex h-full min-w-0 flex-1 flex-col justify-end"
            onMouseEnter={() => setHover(i)}
          >
            {hover === i && (
              <div className="pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-xs shadow-soft">
                {h.hour}:00 · <span className="font-semibold tabular-nums">{nf.format(h.count)}</span>
              </div>
            )}
            <div
              className={cn(
                'min-h-[2px] rounded-t-[3px] transition-[height] duration-500',
                i === hours.length - 1 ? 'bg-primary' : 'bg-primary/55',
                hover === i && 'bg-primary',
              )}
              style={{ height: `${(h.count / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] tabular-nums text-muted-foreground">
        {hours
          .filter((_, i) => i % 6 === 0 || i === hours.length - 1)
          .map((h, i) => (
            <span key={`${h.hour}-${i}`}>{h.hour}:00</span>
          ))}
      </div>
      {peak.count > 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Busiest hour: <span className="font-semibold text-foreground">{peak.hour}:00</span> with{' '}
          {plural(peak.count, 'change')}.
        </p>
      )}
    </div>
  );
}

/* ------------------------------- Lists ----------------------------------- */

function DeviceRow({ d, right }: { d: AdminDeviceAttention; right: ReactNode }) {
  return (
    <li>
      <Link
        href={`/admin/devices?q=${encodeURIComponent(d.deviceId)}`}
        className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-accent"
      >
        <span className="min-w-0">
          <span className="block truncate font-semibold">{d.name || d.deviceId}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {d.name ? <span className="font-mono">{d.deviceId}</span> : null}
            {d.household ? `${d.name ? ' · ' : ''}${d.household}` : ''}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{right}</span>
      </Link>
    </li>
  );
}

function NeedsAttention({ s }: { s: AdminStats }) {
  const a = s.attention;
  const safety = s.automation?.safetyAutoOff24h ?? 0;
  const locked = s.switches?.locked ?? 0;
  const healthy = !a?.offlineClaimed && !a?.weakSignal.length && !safety;
  return (
    <SectionCard
      title="Needs attention"
      description={healthy ? 'Nothing needs you right now.' : 'Devices and rules worth a look.'}
      href="/admin/devices"
      hrefLabel="Devices"
    >
      {healthy ? (
        <div className="flex items-center gap-3 rounded-xl bg-primary/10 px-4 py-4 text-sm">
          <CheckCircle2 className="h-5 w-5 text-brand-ink" />
          Every claimed device is online with a healthy signal.
        </div>
      ) : (
        <div className="grid gap-4">
          {!!a?.offlineClaimed && (
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                <WifiOff className="h-3.5 w-3.5" /> Offline · {nf.format(a.offlineClaimed)}
              </div>
              <ul className="-mx-2">
                {a.offlineDevices.map((d) => (
                  <DeviceRow key={d.deviceId} d={d} right={d.lastSeenAt ? `seen ${timeAgo(d.lastSeenAt)}` : 'never seen'} />
                ))}
              </ul>
              {a.offlineClaimed > a.offlineDevices.length && (
                <p className="px-2 pt-1 text-xs text-muted-foreground">
                  +{nf.format(a.offlineClaimed - a.offlineDevices.length)} more
                </p>
              )}
            </div>
          )}
          {!!a?.weakSignal.length && (
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" /> Weak Wi-Fi signal
              </div>
              <ul className="-mx-2">
                {a.weakSignal.map((d) => (
                  <DeviceRow key={d.deviceId} d={d} right={`${d.rssi} dBm`} />
                ))}
              </ul>
            </div>
          )}
          {safety > 0 && (
            <div className="flex items-center gap-3 rounded-xl bg-warning/10 px-3 py-2.5 text-sm">
              <ShieldCheck className="h-4 w-4 text-warning" />
              Safety rules switched off {plural(safety, 'switch')} in the last 24 hours.
            </div>
          )}
        </div>
      )}
      {locked > 0 && (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Lock className="h-3.5 w-3.5" /> {plural(locked, 'switch')} locked by users.
        </p>
      )}
    </SectionCard>
  );
}

function TopDevices({ rows }: { rows: NonNullable<AdminStats['trends']>['topDevices7d'] }) {
  const max = rows[0]?.count ?? 0;
  if (!rows.length) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No switch changes in the last 7 days.</p>;
  }
  return (
    <ol className="grid gap-3">
      {rows.map((r, i) => (
        <li key={r.deviceId} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 text-sm">
          <span className="text-xs font-bold tabular-nums text-muted-foreground">{i + 1}</span>
          <Link href={`/admin/devices?q=${encodeURIComponent(r.deviceId)}`} className="min-w-0 hover:text-brand-ink">
            <span className="block truncate font-semibold">{r.name || r.deviceId}</span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${max ? Math.max(3, (r.count / max) * 100) : 0}%` }}
              />
            </span>
          </Link>
          <span className="font-semibold tabular-nums">{nf.format(r.count)}</span>
        </li>
      ))}
    </ol>
  );
}

function RecentUsers({ users }: { users: NonNullable<AdminStats['recentUsers']> }) {
  if (!users.length) return <p className="py-6 text-center text-sm text-muted-foreground">No users yet.</p>;
  return (
    <ul className="-mx-2 grid">
      {users.map((u) => (
        <li key={u.id}>
          <Link
            href={`/admin/users/${u.id}`}
            className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-accent"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-bold text-brand-ink">
              {u.email.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium">{u.email}</span>
            {u.isAdmin && <Badge>Admin</Badge>}
            <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(u.createdAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function RecentAudit() {
  const audit = useQuery({
    queryKey: [...qk.adminAudit, 'recent'],
    queryFn: () => adminApi.audit(null, 6),
    refetchInterval: 60_000,
  });
  if (audit.isLoading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 rounded-lg" />
        ))}
      </div>
    );
  }
  const entries = audit.data?.entries ?? [];
  if (!entries.length) return <p className="py-6 text-center text-sm text-muted-foreground">No admin actions yet.</p>;
  return (
    <ul className="grid gap-2.5">
      {entries.map((e) => (
        <li key={e.id} className="flex items-center justify-between gap-3 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <Badge variant={actionVariant(e.action)} className="shrink-0">
              {ACTION_LABELS[e.action] ?? e.action}
            </Badge>
            <span className="truncate text-muted-foreground">
              {typeof e.details?.email === 'string' ? e.details.email : (e.targetId ?? '')}
            </span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground" title={e.adminEmail ?? undefined}>
            {timeAgo(e.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SystemHealth({ s }: { s: AdminStats }) {
  const sys = s.system;
  if (!sys) return null;
  const items: [string, string][] = [
    ['Backend', sys.version ? `v${sys.version}` : '—'],
    ['Node.js', sys.node],
    ['Uptime', formatUptime(sys.uptimeS)],
    ['Memory (RSS)', formatBytes(sys.memoryRssBytes)],
    ['Heap used', formatBytes(sys.heapUsedBytes)],
    ['Database size', formatBytes(sys.dbBytes)],
    ['Stats query time', `${nf.format(sys.dbQueryMs)} ms`],
    ['Live connections', `${nf.format(sys.clients.sockets)} (${plural(sys.clients.users, 'user')})`],
  ];
  const firmware = s.attention?.firmware ?? [];
  const fwTotal = firmware.reduce((sum, f) => sum + f.count, 0);
  return (
    <SectionCard title="System health" description={`Server time ${new Date(sys.serverTime).toLocaleString()}`}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          {items.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 truncate font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <div>
          <div className="mb-2 text-xs text-muted-foreground">Firmware versions</div>
          {firmware.length ? (
            <ul className="grid gap-2">
              {firmware.map((f) => (
                <li key={f.version} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs">{f.version}</span>
                    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${fwTotal ? (f.count / fwTotal) * 100 : 0}%` }}
                      />
                    </span>
                  </span>
                  <span className="font-semibold tabular-nums">{nf.format(f.count)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No devices yet.</p>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

/* --------------------------------- Page ---------------------------------- */

export function AdminOverview() {
  const stats = useQuery({ queryKey: qk.adminStats, queryFn: adminApi.stats, refetchInterval: 30_000 });

  if (isForbidden(stats.error)) return <Forbidden />;

  const s = stats.data;
  const offline = s?.attention?.offlineClaimed ?? 0;

  return (
    <>
      <PageHeader
        title="Admin"
        description={
          s ? `System overview · updated ${timeAgo(new Date(stats.dataUpdatedAt).toISOString())}` : 'System overview for Smart Control.'
        }
        actions={
          <>
            {s?.attention && (
              <Badge variant={offline ? 'warning' : 'default'} className="gap-1.5 px-3 py-1">
                <span className={cn('h-2 w-2 rounded-full', offline ? 'bg-warning' : 'bg-primary')} />
                {offline ? `${plural(offline, 'device')} offline` : 'All devices online'}
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={() => stats.refetch()} disabled={stats.isFetching}>
              <RefreshCw className={cn(stats.isFetching && 'animate-spin')} /> Refresh
            </Button>
          </>
        }
      />
      {stats.isLoading ? (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-36 rounded-2xl" />
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[62px] rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      ) : stats.isError || !s ? (
        <ErrorState error={stats.error} onRetry={() => stats.refetch()} />
      ) : (
        <div className="grid gap-4 animate-in fade-in">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={Users}
              label="Users"
              value={nf.format(s.users.total)}
              sub={[
                s.growth ? `+${nf.format(s.growth.usersNew7d)} this week` : null,
                plural(s.users.admins, 'admin'),
                `${nf.format(s.users.disabled)} disabled`,
              ]
                .filter(Boolean)
                .join(' · ')}
              href="/admin/users"
            />
            <StatCard
              icon={Cpu}
              label="Devices online"
              value={`${nf.format(s.devices.online)} / ${nf.format(s.devices.total)}`}
              sub={`${nf.format(s.devices.claimed)} claimed · ${nf.format(s.devices.unclaimed)} unclaimed${
                s.growth?.devicesNew7d ? ` · +${nf.format(s.growth.devicesNew7d)} this week` : ''
              }`}
              href="/admin/devices"
            />
            <StatCard
              icon={Activity}
              label="Switch changes (24h)"
              value={nf.format(s.activity.last24h)}
              sub={s.trends ? `${nf.format(s.trends.activity7d)} in the last 7 days` : 'Across every household'}
              href="/admin/activity"
            />
            <StatCard
              icon={KeyRound}
              label="Active API keys"
              value={nf.format(s.apiKeys.active)}
              sub={`${plural(s.hooks.active, 'active hook URL')}`}
              href="/admin/api-keys"
            />
          </div>

          {s.growth && s.households && s.switches && s.automation && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MiniStat
                icon={UserCheck}
                label="Active users (24h)"
                value={nf.format(s.growth.usersActive24h)}
                sub={`${nf.format(s.growth.usersActive7d)} this week`}
              />
              <MiniStat
                icon={UserPlus}
                label="New users (30d)"
                value={nf.format(s.growth.usersNew30d)}
                sub={`${nf.format(s.growth.usersNew7d)} this week`}
              />
              <MiniStat
                icon={Home}
                label="Households"
                value={nf.format(s.households.total)}
                sub={`${nf.format(s.households.withoutDevices)} without devices`}
              />
              <MiniStat
                icon={Mail}
                label="Pending invites"
                value={nf.format(s.households.pendingInvites)}
                tone={s.households.pendingInvites ? 'warning' : 'default'}
              />
              <MiniStat
                icon={Power}
                label="Switches on now"
                value={`${nf.format(s.switches.on)} / ${nf.format(s.switches.total)}`}
                sub={`${nf.format(s.switches.metered)} with wattage`}
              />
              <MiniStat
                icon={CalendarClock}
                label="Schedules"
                value={nf.format(s.automation.schedules)}
                sub={`${nf.format(s.automation.schedulesEnabled)} enabled`}
              />
              <MiniStat
                icon={Zap}
                label="Automations"
                value={nf.format(s.automation.automations)}
                sub={`${nf.format(s.automation.automationsEnabled)} enabled · ${plural(s.automation.groups, 'group')}`}
              />
              <MiniStat
                icon={ShieldCheck}
                label="Safety rules"
                value={nf.format(s.switches.withSafetyRules)}
                sub={`${nf.format(s.automation.safetyAutoOff24h)} auto-offs today`}
                tone={s.automation.safetyAutoOff24h ? 'warning' : 'default'}
              />
            </div>
          )}

          {s.trends && (
            <div className="grid gap-4 lg:grid-cols-3">
              <SectionCard
                className="lg:col-span-2"
                title="Switch changes, last 14 days"
                description={`${nf.format(s.trends.daily.reduce((sum, d) => sum + d.activity, 0))} changes`}
                href="/admin/activity"
                hrefLabel="Feed"
              >
                <DailyBars
                  days={s.trends.daily.map((d) => d.day)}
                  series={[
                    {
                      key: 'activity',
                      label: 'Switch changes',
                      color: 'hsl(var(--primary))',
                      values: s.trends.daily.map((d) => d.activity),
                    },
                  ]}
                  format={(v) => plural(v, 'change')}
                  axisFormat={(v) => nf.format(v)}
                  height={200}
                  ariaLabel="Switch changes per day, last 14 days"
                />
              </SectionCard>
              <SectionCard
                title="New users, 14 days"
                description={`${nf.format(s.trends.daily.reduce((sum, d) => sum + d.signups, 0))} sign-ups`}
                href="/admin/users"
              >
                <DailyBars
                  days={s.trends.daily.map((d) => d.day)}
                  series={[
                    {
                      key: 'signups',
                      label: 'Sign-ups',
                      color: 'var(--series-1)',
                      values: s.trends.daily.map((d) => d.signups),
                    },
                  ]}
                  format={(v) => plural(v, 'sign-up')}
                  height={200}
                  compact
                  ariaLabel="New users per day, last 14 days"
                />
              </SectionCard>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard
              title="What changed switches, last 24 hours"
              description={`${nf.format(s.activity.last24h)} changes by source`}
              href="/admin/activity"
              hrefLabel="Feed"
            >
              <SourceBreakdown bySource={s.activity.bySource24h} total={s.activity.last24h} />
            </SectionCard>
            {s.trends && (
              <SectionCard title="By hour, last 24 hours" description="Server time">
                <HourlyBars hours={s.trends.hourly24h} />
              </SectionCard>
            )}
          </div>

          {(s.attention || s.trends) && (
            <div className="grid gap-4 lg:grid-cols-2">
              {s.attention && <NeedsAttention s={s} />}
              {s.trends && (
                <SectionCard title="Most active devices" description="Switch changes, last 7 days" href="/admin/devices">
                  <TopDevices rows={s.trends.topDevices7d} />
                </SectionCard>
              )}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {s.recentUsers && (
              <SectionCard title="Newest users" href="/admin/users">
                <RecentUsers users={s.recentUsers} />
              </SectionCard>
            )}
            <SectionCard title="Recent admin actions" href="/admin/audit" hrefLabel="Audit log">
              <RecentAudit />
            </SectionCard>
          </div>

          <SystemHealth s={s} />
        </div>
      )}
    </>
  );
}
