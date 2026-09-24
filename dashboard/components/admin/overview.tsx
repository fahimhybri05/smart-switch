'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, Cpu, KeyRound, Users, type LucideIcon } from 'lucide-react';
import Link from 'next/link';

import { Forbidden, isForbidden } from '@/components/admin/shared';
import { ErrorState, PageHeader } from '@/components/common';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { adminApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { sourceLabel } from '@/lib/format';

const nf = new Intl.NumberFormat();

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
  sub: React.ReactNode;
  href: string;
}) {
  return (
    <Link href={href} className="group rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Card className="h-full transition-colors group-hover:border-primary/40">
        <CardContent className="flex h-full flex-col gap-3 p-5 sm:p-5">
          <div className="flex items-center justify-between text-sm font-semibold text-muted-foreground">
            <span>{label}</span>
            <Icon className="h-4 w-4 text-brand-ink" />
          </div>
          <div className="text-3xl font-extrabold tabular-nums tracking-tight">{value}</div>
          <div className="mt-auto text-xs text-muted-foreground">{sub}</div>
        </CardContent>
      </Card>
    </Link>
  );
}

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
                className="block h-full rounded-full bg-primary"
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

export function AdminOverview() {
  const stats = useQuery({ queryKey: qk.adminStats, queryFn: adminApi.stats, refetchInterval: 30_000 });

  if (isForbidden(stats.error)) return <Forbidden />;

  return (
    <>
      <PageHeader title="Admin" description="System overview for Smart Control." />
      {stats.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      ) : stats.isError || !stats.data ? (
        <ErrorState error={stats.error} onRetry={() => stats.refetch()} />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={Users}
              label="Users"
              value={nf.format(stats.data.users.total)}
              sub={`${stats.data.users.admins} admin${stats.data.users.admins === 1 ? '' : 's'} · ${stats.data.users.disabled} disabled`}
              href="/admin/users"
            />
            <StatCard
              icon={Cpu}
              label="Devices online"
              value={`${nf.format(stats.data.devices.online)} / ${nf.format(stats.data.devices.total)}`}
              sub={`${stats.data.devices.claimed} claimed · ${stats.data.devices.unclaimed} unclaimed`}
              href="/admin/devices"
            />
            <StatCard
              icon={Activity}
              label="Switch changes (24h)"
              value={nf.format(stats.data.activity.last24h)}
              sub="Across every household"
              href="/admin/activity"
            />
            <StatCard
              icon={KeyRound}
              label="Active API keys"
              value={nf.format(stats.data.apiKeys.active)}
              sub={`${stats.data.hooks.active} active hook URL${stats.data.hooks.active === 1 ? '' : 's'}`}
              href="/admin/api-keys"
            />
          </div>
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div className="space-y-1.5">
                <CardTitle className="text-base">What changed switches, last 24 hours</CardTitle>
                <CardDescription>{nf.format(stats.data.activity.last24h)} changes by source</CardDescription>
              </div>
              <Link
                href="/admin/activity"
                className="inline-flex items-center gap-1 text-sm font-semibold text-brand-ink hover:underline"
              >
                Feed <ArrowRight className="h-4 w-4" />
              </Link>
            </CardHeader>
            <CardContent>
              <SourceBreakdown bySource={stats.data.activity.bySource24h} total={stats.data.activity.last24h} />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
