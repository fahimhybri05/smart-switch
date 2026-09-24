import { Clapperboard, Droplet, House, Leaf, Moon, Plane, Power, Sparkles, Sun, type LucideIcon } from 'lucide-react';

import type { SceneIcon } from '@/lib/types';
import { cn } from '@/lib/utils';

/** The icon set the app and the dashboard agree on (stored as free text on the scene). */
export const SCENE_ICONS: { key: SceneIcon; label: string; Icon: LucideIcon }[] = [
  { key: 'moon', label: 'Night', Icon: Moon },
  { key: 'sun', label: 'Morning', Icon: Sun },
  { key: 'home', label: 'Home', Icon: House },
  { key: 'away', label: 'Away', Icon: Plane },
  { key: 'movie', label: 'Movie', Icon: Clapperboard },
  { key: 'power', label: 'Power', Icon: Power },
  { key: 'leaf', label: 'Eco', Icon: Leaf },
  { key: 'droplet', label: 'Water', Icon: Droplet },
];

const BY_KEY = new Map(SCENE_ICONS.map((i) => [i.key as string, i.Icon]));

/** Unknown or missing icons (e.g. from a newer app) fall back to a neutral glyph. */
export function sceneIconFor(icon: string | null | undefined): LucideIcon {
  return (icon && BY_KEY.get(icon)) || Sparkles;
}

export function SceneGlyph({ icon, className }: { icon: string | null | undefined; className?: string }) {
  const Icon = sceneIconFor(icon);
  return <Icon className={cn('shrink-0', className)} aria-hidden />;
}
