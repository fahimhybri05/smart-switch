'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Activity as ActivityIcon, Power, PowerOff } from 'lucide-react';
import { useMemo } from 'react';

import { EmptyState, ErrorState, HouseholdSelect, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { activityApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { defaultChannelName, formatDateTime, sourceLabel, timeAgo } from '@/lib/format';
import { useDevices, useHouseholds, useSelectedHousehold, useSwitchViews } from '@/lib/queries';
import { cn } from '@/lib/utils';

export function ActivityPage() {
  const households = useHouseholds();
  const { selected, select } = useSelectedHousehold(households.data);
  const devices = useDevices();
  const { byDevice } = useSwitchViews(devices.data);
  const nameOf = useMemo(() => {
    const map = new Map<string, string>();
    byDevice.forEach((list) => list.forEach((s) => map.set(s.id, s.name)));
    return map;
  }, [byDevice]);

  const query = useInfiniteQuery({
    queryKey: qk.activity(selected?.id ?? 0),
    queryFn: ({ pageParam }) => activityApi.page(selected!.id, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!selected,
    refetchInterval: 30_000,
  });

  const entries = query.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <>
      <PageHeader
        title="Activity"
        description="Every switch change, and what caused it."
        actions={
          <HouseholdSelect households={households.data ?? []} value={selected?.id} onChange={select} />
        }
      />
      {households.isLoading || (selected && query.isLoading) ? (
        <div className="grid gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-xl" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : entries.length === 0 ? (
        <EmptyState icon={ActivityIcon} title="No activity yet">
          Switch changes from the app, widgets, schedules, the API and this dashboard appear here.
        </EmptyState>
      ) : (
        <Card className="overflow-hidden p-0">
          <ul className="divide-y">
            {entries.map((e) => {
              const on = e.state?.toUpperCase() === 'ON';
              const sw =
                nameOf.get(`${e.deviceId}:${e.channelIdx}`) ?? defaultChannelName(e.channelIdx);
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
                      <span className="font-semibold">{sw}</span>{' '}
                      <span className="text-muted-foreground">
                        on {e.deviceFriendlyName || e.deviceId} turned
                      </span>{' '}
                      <span className={cn('font-semibold', on && 'text-brand-ink')}>{on ? 'on' : 'off'}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {e.actorEmail ? `${e.actorEmail} · ` : ''}
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
