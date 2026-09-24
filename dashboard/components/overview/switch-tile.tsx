'use client';

import { Loader2, Power, WifiOff } from 'lucide-react';

import { useSetChannelState } from '@/lib/queries';
import type { SwitchView } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * One switch as a big rounded tile. ON tiles get the brand-green glow.
 * Clicking toggles optimistically (rolled back by useSetChannelState on
 * failure). Unknown state toggles to ON, matching the public API.
 */
export function SwitchTile({ view, className }: { view: SwitchView; className?: string }) {
  const mutation = useSetChannelState();
  const on = view.state === 'ON';
  const pending =
    mutation.isPending &&
    mutation.variables?.deviceId === view.deviceId &&
    mutation.variables?.channelIdx === view.channelIdx;
  const disabled = !view.online;

  const toggle = () => {
    if (disabled) return;
    mutation.mutate({
      deviceId: view.deviceId,
      channelIdx: view.channelIdx,
      state: on ? 'OFF' : 'ON',
      label: view.name,
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      aria-pressed={on}
      aria-label={`${view.name}: ${view.state ?? 'unknown'}${disabled ? ' (device offline)' : ''}. Click to turn ${on ? 'off' : 'on'}.`}
      className={cn(
        'squircle group relative flex min-h-[124px] flex-col justify-between gap-3 border p-4 text-left transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        on
          ? 'border-primary/50 bg-gradient-to-br from-primary/20 via-primary/10 to-transparent shadow-glow'
          : 'bg-card hover:border-primary/30 hover:bg-accent/40',
        disabled && 'cursor-not-allowed opacity-55 hover:border-border hover:bg-card',
        !disabled && 'active:scale-[0.98]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-2xl transition-all duration-300',
            on
              ? 'bg-primary text-primary-foreground shadow-[0_0_18px_hsl(var(--brand)/0.7)]'
              : 'bg-muted text-muted-foreground group-hover:text-foreground',
          )}
        >
          {pending ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : disabled ? (
            <WifiOff className="h-5 w-5" />
          ) : (
            <Power className="h-5 w-5" strokeWidth={2.5} />
          )}
        </span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide',
            on ? 'bg-primary/20 text-brand-ink' : 'bg-muted text-muted-foreground',
          )}
        >
          {disabled ? 'Offline' : (view.state ?? '—')}
        </span>
      </div>
      <div className="min-w-0">
        <div className="truncate font-semibold leading-tight">{view.name}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{view.zone || 'No zone'}</div>
      </div>
    </button>
  );
}
