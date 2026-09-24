'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { KeyRound, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import {
  ConfirmButton,
  Forbidden,
  isForbidden,
  Pagination,
  SearchBox,
  TableCard,
  Th,
  useAdminAction,
  useClampPage,
  useDebounced,
} from '@/components/admin/shared';
import { EmptyState, ErrorState, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { adminApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { formatDate, formatDateTime, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

export function AdminApiKeys() {
  const run = useAdminAction();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const q = useDebounced(search.trim());
  const keys = useQuery({
    queryKey: qk.adminApiKeys(q, page),
    queryFn: () => adminApi.apiKeys({ q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  useClampPage(keys.data?.items.length, page, setPage);

  if (isForbidden(keys.error)) return <Forbidden />;

  return (
    <>
      <PageHeader
        title="API keys"
        description="Every active key, across all accounts. Revoking a key also kills its hook URLs."
        actions={
          <SearchBox
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(0);
            }}
            placeholder="Owner email, key name or prefix"
          />
        }
      />
      {keys.isLoading ? (
        <Skeleton className="h-80 rounded-2xl" />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
      ) : !keys.data?.items.length ? (
        <EmptyState icon={KeyRound} title={q ? 'No matching keys' : 'No active API keys'}>
          {q ? 'Try a different search.' : 'Keys users create under API & Integrations appear here.'}
        </EmptyState>
      ) : (
        <div className={cn('grid gap-3 transition-opacity', keys.isPlaceholderData && 'opacity-60')}>
          <TableCard>
            <thead>
              <tr>
                <Th>Key</Th>
                <Th>Owner</Th>
                <Th>Created</Th>
                <Th>Last used</Th>
                <Th className="text-right">Hooks</Th>
                <Th className="w-28">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {keys.data.items.map((k) => (
                <tr key={k.id} className="hover:bg-muted/30">
                  <td className="max-w-[240px]">
                    <div className="truncate font-semibold">{k.name}</div>
                    <code className="font-mono text-xs text-muted-foreground">{k.prefix}…</code>
                  </td>
                  <td className="max-w-[240px]">
                    <div className="flex items-center gap-1.5">
                      <Link
                        href={`/admin/users/${k.userId}`}
                        className="truncate hover:text-brand-ink hover:underline"
                      >
                        {k.userEmail}
                      </Link>
                      {k.userDisabled && <Badge variant="destructive">Disabled</Badge>}
                    </div>
                  </td>
                  <td className="whitespace-nowrap">{formatDate(k.createdAt)}</td>
                  <td className="whitespace-nowrap" title={formatDateTime(k.lastUsedAt)}>
                    {timeAgo(k.lastUsedAt)}
                  </td>
                  <td className="text-right tabular-nums">{k.hookCount}</td>
                  <td className="text-right">
                    <ConfirmButton
                      title={`Revoke “${k.name}”?`}
                      description={
                        <>
                          <p>
                            This key belongs to <strong className="text-foreground">{k.userEmail}</strong>. Anything
                            using it stops working immediately, and they are not notified.
                          </p>
                          {k.hookCount > 0 && (
                            <p>
                              <strong className="text-foreground">
                                {k.hookCount} hook URL{k.hookCount === 1 ? '' : 's'} tied to it stop working too.
                              </strong>
                            </p>
                          )}
                        </>
                      }
                      confirmLabel="Revoke key"
                      onConfirm={() => run(() => adminApi.revokeApiKey(k.id), 'Key revoked')}
                      trigger={
                        <Button variant="outline" size="sm">
                          <Trash2 /> Revoke
                        </Button>
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableCard>
          <Pagination page={page} pageSize={PAGE_SIZE} total={keys.data.total} onChange={setPage} />
        </div>
      )}
    </>
  );
}
