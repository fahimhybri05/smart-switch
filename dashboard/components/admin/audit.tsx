'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import Link from 'next/link';

import { Forbidden, isForbidden, TableCard, Th } from '@/components/admin/shared';
import { EmptyState, ErrorState, PageHeader } from '@/components/common';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { adminApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { formatDateTime, timeAgo } from '@/lib/format';
import type { AuditEntry } from '@/lib/types';

export const ACTION_LABELS: Record<string, string> = {
  'user.disable': 'Disabled user',
  'user.enable': 'Enabled user',
  'user.logout': 'Forced sign-out',
  'user.reset_password': 'Reset password',
  'user.promote': 'Made admin',
  'user.demote': 'Removed admin',
  'user.delete': 'Deleted user',
  'device.unclaim': 'Unclaimed device',
  'device.reassign': 'Reassigned device',
  'device.reset_secret': 'Reset device secret',
  'api_key.revoke': 'Revoked API key',
};

const DESTRUCTIVE = new Set(['user.delete', 'user.disable', 'api_key.revoke', 'device.unclaim']);

export function actionVariant(action: string): BadgeProps['variant'] {
  if (DESTRUCTIVE.has(action)) return 'destructive';
  if (action.startsWith('device.')) return 'warning';
  return 'secondary';
}

function Target({ entry }: { entry: AuditEntry }) {
  const email = typeof entry.details?.email === 'string' ? entry.details.email : null;
  if (entry.targetType === 'user' && entry.targetId) {
    const label = email ?? `User #${entry.targetId}`;
    return entry.action === 'user.delete' ? (
      <span>{label}</span>
    ) : (
      <Link href={`/admin/users/${entry.targetId}`} className="hover:text-brand-ink hover:underline">
        {label}
      </Link>
    );
  }
  if (entry.targetType === 'device' && entry.targetId) {
    return (
      <Link
        href={`/admin/devices?q=${encodeURIComponent(entry.targetId)}`}
        className="font-mono text-xs hover:text-brand-ink hover:underline"
      >
        {entry.targetId}
      </Link>
    );
  }
  if (entry.targetType && entry.targetId) {
    return (
      <span>
        {entry.targetType.replace('_', ' ')} #{entry.targetId}
      </span>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

function Details({ details }: { details: AuditEntry['details'] }) {
  const pairs = Object.entries(details ?? {}).filter(([k]) => k !== 'email');
  if (!pairs.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="text-xs text-muted-foreground">
      {pairs.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && ' · '}
          {k}: <span className="font-medium text-foreground">{v === null ? '—' : String(v)}</span>
        </span>
      ))}
    </span>
  );
}

export function AdminAudit() {
  const query = useInfiniteQuery({
    queryKey: qk.adminAudit,
    queryFn: ({ pageParam }) => adminApi.audit(pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];

  if (isForbidden(query.error)) return <Forbidden />;

  return (
    <>
      <PageHeader title="Audit log" description="Every admin action, newest first. Entries can't be edited or removed." />
      {query.isLoading ? (
        <Skeleton className="h-80 rounded-2xl" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState icon={ScrollText} title="No admin actions yet">
          Disabling users, resetting device secrets, revoking keys and other admin actions are recorded here.
        </EmptyState>
      ) : (
        <div className="grid gap-3">
          <TableCard>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Admin</Th>
                <Th>Action</Th>
                <Th>Target</Th>
                <Th>Details</Th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries.map((e) => (
                <tr key={e.id} className="align-top hover:bg-muted/30">
                  <td className="whitespace-nowrap" title={formatDateTime(e.createdAt)}>
                    {timeAgo(e.createdAt)}
                    <div className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</div>
                  </td>
                  <td className="max-w-[200px] truncate">
                    {e.adminEmail === 'cli' ? (
                      <Badge variant="outline">Server CLI</Badge>
                    ) : (
                      (e.adminEmail ?? <span className="text-muted-foreground">deleted admin</span>)
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    <Badge variant={actionVariant(e.action)}>{ACTION_LABELS[e.action] ?? e.action}</Badge>
                  </td>
                  <td className="max-w-[220px] truncate">
                    <Target entry={e} />
                  </td>
                  <td className="max-w-[280px]">
                    <Details details={e.details} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableCard>
          {query.hasNextPage && (
            <div className="text-center">
              <Button variant="ghost" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
