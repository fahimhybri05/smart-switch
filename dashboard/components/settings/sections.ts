import { Home, PlugZap, SlidersHorizontal, UserRound, type LucideIcon } from 'lucide-react';

/** Settings sections — rendered as the Settings sub-menu in the sidebar (app-shell.tsx). */
export const SETTINGS_SECTIONS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/settings', label: 'General', icon: SlidersHorizontal },
  { href: '/settings/profile', label: 'Profile', icon: UserRound },
  { href: '/settings/household', label: 'Household', icon: Home },
  { href: '/settings/integrations', label: 'API & Integrations', icon: PlugZap },
];
