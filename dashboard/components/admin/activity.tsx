'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Activity as ActivityIcon, Power, PowerOff } from 'lucide-react';

import { Forbidden, isForbidden } from '@/components/admin/shared';
import { EmptyState, ErrorState, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { adminApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { defaultChannelName, formatDateTime, sourceLabel, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

/** Read-only feed of switch changes across every household. */
export function AdminActivity() {
  const query = useInfiniteQuery({
    queryKey: qk.adminActivity,
    queryFn: ({ pageParam }) => adminApi.activity(pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 30_000,
  });
  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];

  if (isForbidden(query.error)) return <Forbidden />;

  return (
    <>
      <PageHeader title="Activity" description="Switch changes across every household, newest first." />
      {query.isLoading ? (
        <div className="grid gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState icon={ActivityIcon} title="No activity yet">
          Switch changes from every household appear here.
        </EmptyState>
      ) : (
        <Card className="overflow-hidden p-0">
          <ul className="divide-y">
            {entries.map((e) => {
              const on = e.state?.toUpperCase() === 'ON';
              return (
                <li key={e.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <span
                    className={cn(
                      'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl',
                      on ? 'bg-primary/15 text-brand-ink' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {on ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      <span className="font-semibold">{defaultChannelName(e.channelIdx)}</span>{' '}
                      <span className="text-muted-foreground">on {e.deviceFriendlyName || e.deviceId} turned</span>{' '}
                      <span className={cn('font-semibold', on && 'text-brand-ink')}>{on ? 'on' : 'off'}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {e.householdName ?? `Household #${e.householdId}`}
                      {' · '}
                      <code className="font-mono">{e.deviceId}</code>
                      {e.actorEmail ? ` · ${e.actorEmail}` : ''}
                      {' · '}
                      <span title={formatDateTime(e.createdAt)}>{timeAgo(e.createdAt)}</span>
                    </div>
                  </div>
                  <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
                    {sourceLabel(e.source)}
                  </Badge>
                </li>
              );
            })}
          </ul>
          {query.hasNextPage && (
            <div className="border-t p-3 text-center">
              <Button variant="ghost" onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
