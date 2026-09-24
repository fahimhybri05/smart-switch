'use client';

import { Loader2, Lock, WifiOff } from 'lucide-react';
import { toast } from 'sonner';

import { DeviceVisual } from '@/components/device-visual';
import { deviceKindFromName } from '@/lib/device-kind';

import { useSetChannelState } from '@/lib/queries';
import type { SwitchView } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * One switch as a big rounded tile. ON tiles get the brand-green glow.
 * Clicking toggles optimistically (rolled back by useSetChannelState on
 * failure). Unknown state toggles to ON, matching the public API. A locked
 * switch shows a lock badge and only explains itself when clicked — no
 * command is sent (the backend would refuse it with switch_locked).
 */
export function SwitchTile({ view, className }: { view: SwitchView; className?: string }) {
  const mutation = useSetChannelState();
  const on = view.state === 'ON';
  const pending =
    mutation.isPending &&
    mutation.variables?.deviceId === view.deviceId &&
    mutation.variables?.channelIdx === view.channelIdx;
  const disabled = !view.online;

  const locked = view.locked;

  const toggle = () => {
    if (disabled) return;
    if (locked) {
      toast.info('This switch is locked', {
        id: `locked-${view.id}`,
        description: 'Unlock it in the switch settings to control it remotely. The physical switch still works.',
      });
      return;
    }
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
      aria-label={`${view.name}: ${view.state ?? 'unknown'}${disabled ? ' (device offline)' : ''}${locked ? ' (locked)' : `. Click to turn ${on ? 'off' : 'on'}.`}`}
      className={cn(
        'squircle group relative flex min-h-[124px] flex-col justify-between gap-3 border p-4 text-left transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        on
          ? 'border-primary/50 bg-gradient-to-br from-primary/20 via-primary/10 to-transparent shadow-glow'
          : 'bg-card hover:border-primary/30 hover:bg-accent/40',
        disabled && 'cursor-not-allowed opacity-55 hover:border-border hover:bg-card',
        locked && !disabled && 'cursor-default hover:border-warning/40 hover:bg-card',
        !disabled && !locked && 'active:scale-[0.98]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Same device artwork as the mobile app, picked from the switch name */}
        <div className="relative -ml-2 -mt-1 h-[68px] w-[82px] shrink-0">
          <DeviceVisual
            kind={deviceKindFromName(view.name)}
            on={on}
            dimmed={disabled}
            className="h-full w-full"
          />
          {pending && (
            <span className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </span>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide',
              on ? 'bg-primary/20 text-brand-ink' : 'bg-muted text-muted-foreground',
            )}
          >
            {disabled && <WifiOff className="h-3 w-3" />}
            {disabled ? 'Offline' : (view.state ?? '—')}
          </span>
          {locked && <LockBadge />}
        </div>
      </div>
      <div className="min-w-0">
        <div className="truncate font-semibold leading-tight">{view.name}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{view.zone || 'No zone'}</div>
      </div>
    </button>
  );
}

/** Small "Locked" pill shown on switch and group tiles. */
export function LockBadge({ label = 'Locked', className }: { label?: string; className?: string }) {
  return (
    <span
      title="Locked: remote control is blocked. The physical switch still works."
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-warning',
        className,
      )}
    >
      <Lock className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}
