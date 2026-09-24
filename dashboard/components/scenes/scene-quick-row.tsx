'use client';

import { ChevronRight, Loader2 } from 'lucide-react';
import Link from 'next/link';

import { useRunScene, useScenes } from '@/lib/queries';
import type { Scene, SwitchRef } from '@/lib/types';
import { cn } from '@/lib/utils';

import { SceneGlyph } from './scene-icon';

function QuickScene({ scene, labelFor }: { scene: Scene; labelFor: (m: SwitchRef) => string }) {
  const run = useRunScene();
  return (
    <button
      type="button"
      disabled={run.isPending || scene.actions.length === 0}
      onClick={() => run.mutate({ scene, labelFor })}
      aria-label={`Run scene ${scene.name}`}
      className={cn(
        'inline-flex h-11 shrink-0 items-center gap-2 rounded-full border bg-card pl-2 pr-4 text-sm font-semibold transition-all',
        'hover:border-primary/40 hover:shadow-glow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] disabled:opacity-60',
      )}
    >
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-brand-ink">
        {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SceneGlyph icon={scene.icon} className="h-4 w-4" />}
      </span>
      <span className="max-w-[160px] truncate">{scene.name}</span>
    </button>
  );
}

/** One-tap scene buttons at the top of the Overview; hidden when the household has no scenes. */
export function SceneQuickRow({
  householdId,
  ready,
  labelFor,
}: {
  householdId: number | undefined;
  ready: boolean;
  labelFor: (m: SwitchRef) => string;
}) {
  const { data } = useScenes(householdId, ready);
  const scenes = (data ?? []).filter((s) => householdId == null || s.householdId == null || s.householdId === householdId);
  if (scenes.length === 0) return null;
  return (
    <section aria-label="Scenes" className="grid gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Scenes</h2>
        <Link
          href="/scenes"
          className="inline-flex items-center gap-0.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
        >
          Manage <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
        {scenes.map((s) => (
          <QuickScene key={s.id} scene={s} labelFor={labelFor} />
        ))}
      </div>
    </section>
  );
}
