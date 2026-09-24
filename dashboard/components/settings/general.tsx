'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ExternalLink, LogOut, Monitor, Moon, ShieldCheck, Smartphone, Sun, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CopyField, PageHeader } from '@/components/common';
import { SETTINGS_SECTIONS } from '@/components/settings/settings-nav';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { authApi, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useLiveStatus } from '@/lib/live';
import { useMe } from '@/lib/queries';
import { cn } from '@/lib/utils';

const THEMES: { value: string; label: string; icon: LucideIcon; preview: string }[] = [
  { value: 'light', label: 'Light', icon: Sun, preview: 'bg-[#f5f7fa]' },
  { value: 'dark', label: 'Dark', icon: Moon, preview: 'bg-[#101827]' },
  { value: 'system', label: 'System', icon: Monitor, preview: 'bg-gradient-to-br from-[#f5f7fa] from-50% to-[#101827] to-50%' },
];

const LIVE_TEXT = {
  live: 'Connected — switch changes appear instantly.',
  connecting: 'Connecting to live updates…',
  offline: 'Live connection lost — refreshing every 10 seconds while reconnecting.',
} as const;

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

function About({ apiUrl, version }: { apiUrl: string; version: string }) {
  const status = useLiveStatus();
  // Read after mount — the server has no idea of the browser's timezone.
  const [timeZone, setTimeZone] = useState('—');
  useEffect(() => setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone), []);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connection & about</CardTitle>
        <CardDescription>Where this dashboard talks to, and what it runs.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="flex items-start gap-3 text-sm">
          <span
            className={cn(
              'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full',
              status === 'live' && 'bg-primary shadow-[0_0_8px_hsl(var(--brand))]',
              status === 'connecting' && 'animate-pulse-dot bg-warning',
              status === 'offline' && 'bg-muted-foreground',
            )}
          />
          <span>
            <span className="font-semibold">Live updates</span>
            <span className="block text-muted-foreground">{LIVE_TEXT[status]}</span>
          </span>
        </div>
        <div className="grid gap-1.5">
          <div className="text-xs font-semibold text-muted-foreground">API base URL</div>
          <CopyField value={apiUrl} label="Copy API URL" />
          <a
            href={`${apiUrl}/v1/openapi.json`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-1 text-xs font-semibold text-brand-ink hover:underline"
          >
            OpenAPI spec <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Dashboard version</dt>
            <dd className="font-semibold tabular-nums">v{version}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Timezone (this browser)</dt>
            <dd className="truncate font-semibold">{timeZone}</dd>
          </div>
        </dl>
        <div className="flex items-center gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm text-muted-foreground">
          <Smartphone className="h-4 w-4 shrink-0" />
          New devices are paired and claimed from the Smart Control mobile app.
        </div>
      </CardContent>
    </Card>
  );
}

export function GeneralSettings({ apiUrl, version }: { apiUrl: string; version: string }) {
  return (
    <>
      <PageHeader title="Settings" description="Appearance, account and everything else in one place." />
      <div className="grid gap-6">
        <div className="grid gap-3 sm:grid-cols-3">
          {SETTINGS_SECTIONS.slice(1).map(({ href, label, icon: Icon, description }) => (
            <Link
              key={href}
              href={href}
              className="squircle group flex items-center gap-3 border bg-card px-4 py-3 transition-all hover:-translate-y-0.5 hover:border-primary/40"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-brand-ink">
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{label}</span>
                <span className="block truncate text-xs text-muted-foreground">{description}</span>
              </span>
              <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </Link>
          ))}
        </div>
        <Appearance />
        <div className="grid gap-6 xl:grid-cols-2">
          <Account />
          <About apiUrl={apiUrl} version={version} />
        </div>
      </div>
    </>
  );
}
