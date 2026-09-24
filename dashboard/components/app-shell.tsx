'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  BarChart3,
  Boxes,
  CalendarClock,
  ChevronDown,
  Cpu,
  Gauge,
  KeyRound,
  LayoutGrid,
  LogOut,
  Menu,
  ScrollText,
  Settings,
  Sparkles,
  UserRound,
  Users,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { Brand } from '@/components/brand';
import { InstallButton } from '@/components/install-app';
import { LiveIndicator } from '@/components/live-indicator';
import { ThemeToggle } from '@/components/theme-toggle';
import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authApi, errorMessage } from '@/lib/api';
import { LiveProvider } from '@/lib/live';
import { useMe } from '@/lib/queries';
import { SHOW_SCENES } from '@/lib/features';
import { cn } from '@/lib/utils';

type NavItem = { href: string; label: string; icon: typeof LayoutGrid; exact?: boolean };

const NAV: NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutGrid },
  ...(SHOW_SCENES ? [{ href: '/scenes', label: 'Scenes', icon: Sparkles }] : []),
  { href: '/groups', label: 'Groups', icon: Boxes },
  { href: '/schedules', label: 'Schedules', icon: CalendarClock },
  { href: '/automations', label: 'Automations', icon: Zap },
  { href: '/usage', label: 'Usage', icon: BarChart3 },
  { href: '/activity', label: 'Activity', icon: Activity },
];

/** Shown only to admins — the backend enforces is_admin on every /admin call regardless. */
const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Overview', icon: Gauge, exact: true },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/devices', label: 'Devices', icon: Cpu },
  { href: '/admin/activity', label: 'Activity', icon: Activity },
  { href: '/admin/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/admin/audit', label: 'Audit log', icon: ScrollText },
];

function isActive(pathname: string, { href, exact }: NavItem) {
  if (href === '/') return pathname === '/' || pathname.startsWith('/devices');
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <>
      {items.map((item) => {
        const { href, label, icon: Icon } = item;
        const active = isActive(pathname, item);
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors',
              active
                ? 'bg-primary/15 text-foreground ring-1 ring-primary/30 dark:bg-primary/10'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon
              className={cn('h-[18px] w-[18px]', active ? 'text-brand-ink' : 'group-hover:text-foreground')}
            />
            {label}
          </Link>
        );
      })}
    </>
  );
}

/**
 * Settings group pinned to the bottom of the sidebar. Its sections live here
 * (not on the settings pages); it opens itself on any /settings route.
 */
function SettingsGroup({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const inSettings = pathname === '/settings' || pathname.startsWith('/settings/');
  const [open, setOpen] = useState(inSettings);
  useEffect(() => {
    if (inSettings) setOpen(true);
  }, [inSettings]);

  return (
    <div className="grid gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="settings-submenu"
        className={cn(
          'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors',
          inSettings ? 'text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <Settings className={cn('h-[18px] w-[18px]', inSettings ? 'text-brand-ink' : 'group-hover:text-foreground')} />
        Settings
        <ChevronDown
          className={cn('ml-auto h-4 w-4 opacity-60 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>
      {/* grid-rows 0fr → 1fr animates the height without measuring it. */}
      <div
        id="settings-submenu"
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-200 ease-out',
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
        inert={!open}
      >
        <div className="overflow-hidden">
          <div className="ml-[21px] grid gap-0.5 border-l pl-3">
            {SETTINGS_SECTIONS.map(({ href, label, icon: Icon }) => {
              const active = href === '/settings' ? pathname === href : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
                    active
                      ? 'bg-primary/15 text-foreground ring-1 ring-primary/30 dark:bg-primary/10'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Icon className={cn('h-4 w-4', active && 'text-brand-ink')} />
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { me } = useMe();
  return (
    <>
      <nav className="-mx-1 grid min-h-0 flex-1 content-start gap-1 overflow-y-auto px-1">
        <NavList items={NAV} onNavigate={onNavigate} />
        {me?.isAdmin && (
          <>
            <div className="mt-5 px-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              Admin
            </div>
            <NavList items={ADMIN_NAV} onNavigate={onNavigate} />
          </>
        )}
      </nav>
      <nav className="border-t pt-4" aria-label="Settings">
        <SettingsGroup onNavigate={onNavigate} />
      </nav>
    </>
  );
}

function UserMenu() {
  const { me } = useMe();
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

  const initial = (me?.email ?? '?').charAt(0).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 px-2" aria-label="Account menu">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-brand-ink">
            {initial}
          </span>
          <span className="hidden max-w-[180px] truncate text-sm font-medium md:inline">{me?.email ?? 'Account'}</span>
          <ChevronDown className="hidden opacity-60 md:inline" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="truncate">{me?.email ?? 'Signed in'}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/profile">
            <UserRound /> Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={logout} disabled={busy} className="text-destructive focus:text-destructive">
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setMobileOpen(false), [pathname]);

  return (
    <LiveProvider>
      <div className="flex min-h-dvh">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col gap-6 border-r bg-card/40 px-4 py-5 lg:flex">
          <Link href="/" className="px-2">
            <Brand />
          </Link>
          <NavLinks />
        </aside>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setMobileOpen(false)} />
            <aside className="absolute inset-y-0 left-0 flex w-72 flex-col gap-6 border-r bg-background px-4 py-5 shadow-2xl animate-in slide-in-from-left">
              <div className="flex items-center justify-between px-2">
                <Brand />
                <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="Close menu">
                  <X />
                </Button>
              </div>
              <NavLinks onNavigate={() => setMobileOpen(false)} />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur-md sm:px-6">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu />
            </Button>
            <Link href="/" className="lg:hidden">
              <Brand size={30} className="[&>span:last-child]:hidden sm:[&>span:last-child]:inline" />
            </Link>
            <div className="ml-auto flex items-center gap-1 sm:gap-2">
              <InstallButton />
              <LiveIndicator />
              <ThemeToggle />
              <UserMenu />
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
            <Suspense>{children}</Suspense>
          </main>
        </div>
      </div>
    </LiveProvider>
  );
}
