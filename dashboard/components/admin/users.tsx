'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import {
  Forbidden,
  isForbidden,
  Pagination,
  SearchBox,
  TableCard,
  Th,
  useClampPage,
  useDebounced,
} from '@/components/admin/shared';
import { UserActions } from '@/components/admin/user-actions';
import { EmptyState, ErrorState, PageHeader } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { adminApi } from '@/lib/api';
import { qk } from '@/lib/cache';
import { formatDate, formatDateTime, timeAgo } from '@/lib/format';
import { useMe } from '@/lib/queries';
import type { AdminUser } from '@/lib/types';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

export function UserBadges({ user, isSelf }: { user: AdminUser; isSelf?: boolean }) {
  return (
    <>
      {isSelf && <Badge variant="outline">You</Badge>}
      {user.isAdmin && <Badge>Admin</Badge>}
      {user.disabledAt && <Badge variant="destructive">Disabled</Badge>}
    </>
  );
}

export function AdminUsers() {
  const { me } = useMe();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const q = useDebounced(search.trim());

  const users = useQuery({
    queryKey: qk.adminUsers(q, page),
    queryFn: () => adminApi.users({ q, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  useClampPage(users.data?.items.length, page, setPage);

  if (isForbidden(users.error)) return <Forbidden />;

  return (
    <>
      <PageHeader
        title="Users"
        description="Every account. Disable, sign out, reset passwords and manage admins."
        actions={
          <SearchBox
            value={search}
            onChange={(v) => {
              setSearch(v);
              setPage(0);
            }}
            placeholder="Search by email"
          />
        }
      />
      {users.isLoading ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => users.refetch()} />
      ) : !users.data?.items.length ? (
        <EmptyState icon={Users} title={q ? 'No matching users' : 'No users yet'}>
          {q ? `Nobody's email contains “${q}”.` : 'Accounts appear here once people sign up.'}
        </EmptyState>
      ) : (
        <div className={cn('grid gap-3 transition-opacity', users.isPlaceholderData && 'opacity-60')}>
          <TableCard>
            <thead>
              <tr>
                <Th>Email</Th>
                <Th>Created</Th>
                <Th>Last active</Th>
                <Th className="text-right">Homes</Th>
                <Th className="text-right">Devices</Th>
                <Th className="text-right">Keys</Th>
                <Th className="w-12">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {users.data.items.map((u) => (
                <tr key={u.id} className={cn('hover:bg-muted/30', u.disabledAt && 'text-muted-foreground')}>
                  <td className="max-w-[320px]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Link
                        href={`/admin/users/${u.id}`}
                        className="truncate font-semibold text-foreground hover:text-brand-ink hover:underline"
                      >
                        {u.email}
                      </Link>
                      <UserBadges user={u} isSelf={me?.id === u.id} />
                    </div>
                    <div className="text-xs text-muted-foreground">#{u.id}</div>
                  </td>
                  <td className="whitespace-nowrap">{formatDate(u.createdAt)}</td>
                  <td className="whitespace-nowrap" title={formatDateTime(u.lastActiveAt)}>
                    {timeAgo(u.lastActiveAt)}
                  </td>
                  <td className="text-right tabular-nums">{u.householdCount}</td>
                  <td className="text-right tabular-nums">{u.deviceCount}</td>
                  <td className="text-right tabular-nums">{u.apiKeyCount}</td>
                  <td className="text-right">
                    <UserActions user={u} onDeleted={() => undefined} />
                  </td>
                </tr>
              ))}
            </tbody>
          </TableCard>
          <Pagination page={page} pageSize={PAGE_SIZE} total={users.data.total} onChange={setPage} />
        </div>
      )}
    </>
  );
}
