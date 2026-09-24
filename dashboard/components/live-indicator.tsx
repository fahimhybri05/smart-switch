'use client';

import { useLiveStatus } from '@/lib/live';
import { cn } from '@/lib/utils';

const LABELS = {
  live: { text: 'Live', title: 'Receiving live updates' },
  connecting: { text: 'Connecting', title: 'Connecting to live updates…' },
  offline: { text: 'Polling', title: 'Live connection lost — refreshing every 10 s while reconnecting' },
} as const;

export function LiveIndicator() {
  const status = useLiveStatus();
  const { text, title } = LABELS[status];
  return (
    <span
      title={title}
      className="hidden items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold text-muted-foreground sm:inline-flex"
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          status === 'live' && 'bg-primary shadow-[0_0_8px_hsl(var(--brand))]',
          status === 'connecting' && 'animate-pulse-dot bg-warning',
          status === 'offline' && 'bg-muted-foreground',
        )}
      />
      {text}
    </span>
  );
}
