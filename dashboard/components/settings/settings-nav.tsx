'use client';

import { Home, PlugZap, SlidersHorizontal, UserRound, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/utils';

export const SETTINGS_SECTIONS: { href: string; label: string; icon: LucideIcon; description: string }[] = [
  { href: '/settings', label: 'General', icon: SlidersHorizontal, description: 'Appearance, account and about' },
  { href: '/settings/profile', label: 'Profile', icon: UserRound, description: 'Email, password and account' },
  { href: '/settings/household', label: 'Household', icon: Home, description: 'Members and invites' },
  { href: '/settings/integrations', label: 'API & Integrations', icon: PlugZap, description: 'API keys and hook URLs' },
];

/** Vertical list on desktop, horizontally scrolling pills on small screens. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings sections" className="-mx-4 overflow-x-auto px-4 pb-1 lg:mx-0 lg:overflow-visible lg:px-0">
      <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground lg:px-3 lg:pb-2">
        <span className="hidden lg:inline">Settings</span>
      </div>
      <ul className="flex gap-2 lg:grid lg:gap-1">
        {SETTINGS_SECTIONS.map(({ href, label, icon: Icon }) => {
          const active = href === '/settings' ? pathname === href : pathname.startsWith(href);
          return (
            <li key={href} className="shrink-0">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors lg:rounded-xl lg:border-0 lg:px-3 lg:py-2.5',
                  active
                    ? 'border-primary/60 bg-primary/15 text-foreground lg:ring-1 lg:ring-primary/30'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon className={cn('h-4 w-4', active && 'text-brand-ink')} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
