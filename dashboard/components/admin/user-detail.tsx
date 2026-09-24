'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Cpu, Home, KeyRound, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { ConfirmButton, Forbidden, isForbidden, OnlineDot, useAdminAction } from '@/components/admin/shared';
import { UserActions } from '@/components/admin/user-actions';
import { UserBadges } from '@/components/admin/users';
import { ErrorState, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, adminApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { formatDate, formatDateTime, timeAgo } from '@/lib/format';
import { useMe } from '@/lib/queries';

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export function AdminUserDetail({ userId }: { userId: number }) {
  const { me } = useMe();
  const run = useAdminAction();
  const user = useQuery({
    queryKey: qk.adminUser(userId),
    queryFn: () => adminApi.user(userId),
    enabled: Number.isInteger(userId) && userId > 0,
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
  });

  if (isForbidden(user.error)) return <Forbidden />;

  const back = (
    <Button variant="ghost" size="sm" asChild className="-ml-2 mb-3">
      <Link href="/admin/users">
        <ArrowLeft /> All users
      </Link>
    </Button>
  );

  if (user.isLoading) {
    return (
      <>
        {back}
        <Skeleton className="mb-6 h-10 w-80 rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-48 rounded-2xl" />
          <Skeleton className="h-48 rounded-2xl" />
        </div>
      </>
    );
  }
  if (user.isError || !user.data) {
    return (
      <>
        {back}
        <ErrorState error={user.error ?? new Error('User not found.')} onRetry={() => user.refetch()} />
      </>
    );
  }

  const u = user.data;
  return (
    <>
      {back}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate">{u.email}</span>
            <UserBadges user={u} isSelf={me?.id === u.id} />
          </span>
        }
        description={`User #${u.id} · joined ${formatDate(u.createdAt)} · last active ${timeAgo(u.lastActiveAt)}${
          u.disabledAt ? ` · disabled ${formatDateTime(u.disabledAt)}` : ''
        }`}
      />
      <div className="mb-6">
        <UserActions user={u} variant="buttons" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Home className="h-4 w-4 text-brand-ink" /> Households ({u.households.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {u.households.length === 0 ? (
              <Empty>Not a member of any household.</Empty>
            ) : (
              <ul className="divide-y rounded-xl border">
                {u.households.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0 truncate font-medium">
                      {h.name} <span className="text-xs text-muted-foreground">#{h.id}</span>
                    </span>
                    <Badge variant={h.role === 'owner' ? 'default' : 'secondary'}>{h.role}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cpu className="h-4 w-4 text-brand-ink" /> Devices ({u.devices.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {u.devices.length === 0 ? (
              <Empty>No devices in their households.</Empty>
            ) : (
              <ul className="divide-y rounded-xl border">
                {u.devices.map((d) => (
                  <li key={d.deviceId} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <OnlineDot online={d.online} />
                    <Link
                      href={`/admin/devices?q=${encodeURIComponent(d.deviceId)}`}
                      className="min-w-0 flex-1 truncate font-medium hover:text-brand-ink hover:underline"
                    >
                      {d.friendlyName || d.deviceId}
                    </Link>
                    <code className="hidden font-mono text-xs text-muted-foreground sm:inline">{d.deviceId}</code>
                    <span className="sr-only">{d.online ? 'online' : 'offline'}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4 text-brand-ink" /> Active API keys ({u.apiKeys.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {u.apiKeys.length === 0 ? (
              <Empty>No active API keys.</Empty>
            ) : (
              <ul className="divide-y rounded-xl border">
                {u.apiKeys.map((k) => (
                  <li
                    key={k.id}
                    className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-semibold">{k.name}</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{k.prefix}…</code>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Created {formatDate(k.createdAt)} · last used {timeAgo(k.lastUsedAt)} · {k.hookCount} hook
                        URL{k.hookCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    <ConfirmButton
                      title={`Revoke “${k.name}”?`}
                      description={`Anything using this key stops working immediately${
                        k.hookCount ? `, and its ${k.hookCount} hook URL${k.hookCount === 1 ? '' : 's'} too` : ''
                      }. The owner is not notified.`}
                      confirmLabel="Revoke key"
                      onConfirm={() => run(() => adminApi.revokeApiKey(k.id), 'Key revoked')}
                      trigger={
                        <Button variant="outline" size="sm" className="w-fit">
                          <Trash2 /> Revoke
                        </Button>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
