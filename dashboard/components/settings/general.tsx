'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Cpu,
  Home,
  LogOut,
  Monitor,
  Moon,
  Power,
  ShieldCheck,
  Sun,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageHeader } from '@/components/common';
import { DesktopAppCard } from '@/components/install-app';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { authApi, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useDefaultHousehold } from '@/lib/preferences';
import { useAutomations, useDevices, useHouseholds, useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';

const THEMES: { value: string; label: string; icon: LucideIcon; preview: string }[] = [
  { value: 'light', label: 'Light', icon: Sun, preview: 'bg-[#f5f7fa]' },
  { value: 'dark', label: 'Dark', icon: Moon, preview: 'bg-[#101827]' },
  { value: 'system', label: 'System', icon: Monitor, preview: 'bg-gradient-to-br from-[#f5f7fa] from-50% to-[#101827] to-50%' },
];

function Appearance() {
  const { theme, setTheme } = useTheme();
  // next-themes only knows the stored theme after hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Appearance</CardTitle>
        <CardDescription>Choose how the dashboard looks on this browser.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label="Theme">
          {THEMES.map(({ value, label, icon: Icon, preview }) => {
            const active = mounted && theme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTheme(value)}
                className={cn(
                  'group rounded-2xl border p-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-primary/70 ring-2 ring-primary/30' : 'hover:border-primary/40',
                )}
              >
                <span className={cn('block h-16 rounded-xl border sm:h-20', preview)} aria-hidden />
                <span className="mt-2 flex items-center gap-2 px-1 text-sm font-semibold">
                  <Icon className={cn('h-4 w-4', active ? 'text-brand-ink' : 'text-muted-foreground')} />
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function Account() {
  const { me, isLoading } = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    setBusy(true);
    try {
      await authApi.logout();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      qc.clear();
      router.replace('/login');
      router.refresh();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Account</CardTitle>
        <CardDescription>Signed in to Smart Control.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/15 text-lg font-bold text-brand-ink">
            {(me?.email ?? '?').charAt(0).toUpperCase()}
          </span>
          {isLoading ? (
            <div className="grid gap-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-32" />
            </div>
          ) : (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-bold">{me?.email ?? 'Signed in'}</span>
                {me?.isAdmin && <Badge>Admin</Badge>}
              </div>
              <div className="text-sm text-muted-foreground">
                {me?.createdAt ? `Member since ${formatDate(me.createdAt)}` : 'Smart Control account'}
                {me?.households.length
                  ? ` · ${me.households.length} household${me.households.length === 1 ? '' : 's'}`
                  : ''}
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {me?.isAdmin && (
            <Button asChild variant="outline" size="sm">
              <Link href="/admin">
                <ShieldCheck /> Admin console
              </Link>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={logout} disabled={busy} className="text-destructive hover:text-destructive">
            <LogOut /> Sign out
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const AUTO = 'auto';

function YourHome() {
  const households = useHouseholds();
  const devices = useDevices();
  const automations = useAutomations();
  const loading = households.isLoading || devices.isLoading;

  const list = devices.data ?? [];
  const online = list.filter((d) => d.is_online).length;
  const channels = list.flatMap((d) => d.channels);
  const on = channels.filter((c) => c.state?.toUpperCase() === 'ON').length;
  const autos = automations.data ?? [];
  const autosOn = autos.filter((a) => a.enabled).length;

  const stats: { icon: LucideIcon; label: string; value: string; href: string }[] = [
    { icon: Cpu, label: 'Devices online', value: `${online} / ${list.length}`, href: '/' },
    { icon: Power, label: 'Switches on now', value: `${on} / ${channels.length}`, href: '/' },
    { icon: Zap, label: 'Automations on', value: `${autosOn} / ${autos.length}`, href: '/automations' },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your home</CardTitle>
        <CardDescription>Everything your account can control, right now.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {loading ? (
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[70px] rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {stats.map(({ icon: Icon, label, value, href }) => (
              <Link
                key={label}
                href={href}
                className="squircle border bg-muted/40 px-3 py-3 transition-colors hover:border-primary/40"
              >
                <Icon className="h-4 w-4 text-brand-ink" />
                <div className="mt-2 text-lg font-bold leading-none tabular-nums">{value}</div>
                <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
              </Link>
            ))}
          </div>
        )}
        <div>
          <div className="mb-2 text-xs font-semibold text-muted-foreground">Households</div>
          {households.isLoading ? (
            <Skeleton className="h-10 rounded-lg" />
          ) : households.data?.length ? (
            <ul className="-mx-2 grid">
              {households.data.map((h) => {
                const count = list.filter((d) => d.household_id === h.id).length;
                return (
                  <li key={h.id}>
                    <Link
                      href="/settings/household"
                      className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors hover:bg-accent"
                    >
                      <Home className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
                      <Badge variant={h.role === 'owner' ? 'default' : 'secondary'} className="capitalize">
                        {h.role}
                      </Badge>
                      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                        {count} device{count === 1 ? '' : 's'}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">You&apos;re not in a household yet.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/usage">
              <BarChart3 /> Energy & usage
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/activity">
              <Activity /> Recent activity
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Preferences() {
  const households = useHouseholds();
  const [defaultId, setDefaultId] = useDefaultHousehold();
  const list = households.data ?? [];
  const current = list.some((h) => h.id === defaultId) ? String(defaultId) : AUTO;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Preferences</CardTitle>
        <CardDescription>Saved in this browser.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-2">
          <Label htmlFor="default-household">Open to household</Label>
          <Select
            value={current}
            onValueChange={(v) => {
              setDefaultId(v === AUTO ? null : Number(v));
              toast.success('Default household saved');
            }}
            disabled={list.length < 2}
          >
            <SelectTrigger id="default-household" className="w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>Automatic (the one you own)</SelectItem>
              {list.map((h) => (
                <SelectItem key={h.id} value={String(h.id)}>
                  {h.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {list.length < 2
              ? 'You have one household, so there is nothing to choose yet.'
              : 'Overview, groups, schedules and usage start on this household.'}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function GeneralSettings() {
  return (
    <>
      <PageHeader title="Settings" description="Your home, appearance and account." />
      <div className="grid gap-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <YourHome />
          <Account />
        </div>
        <div className="grid gap-6 xl:grid-cols-2">
          <Appearance />
          <Preferences />
        </div>
        <DesktopAppCard />
      </div>
    </>
  );
}
