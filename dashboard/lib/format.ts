import type { ActivitySource } from './types';

/** Display fallback for a switch with no configured name (channels are 0-based on the wire). */
export function defaultChannelName(channelIdx: number): string {
  return `Channel ${channelIdx}`;
}

export function switchId(deviceId: string, channelIdx: number): string {
  return `${deviceId}:${channelIdx}`;
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diffS = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(diffS);
  if (!rtf) return new Date(iso).toLocaleString();
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diffS / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffS / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diffS / 86400), 'day');
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const SOURCE_LABELS: Record<string, string> = {
  app: 'Mobile app',
  widget: 'Home-screen widget',
  group: 'Group',
  scene: 'Scene',
  automation: 'Automation',
  device: 'Device / schedule',
  api: 'API',
  hook: 'Hook URL',
  dashboard: 'Web dashboard',
};

export function sourceLabel(source: ActivitySource): string {
  return SOURCE_LABELS[source] ?? source;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatDays(days: number[] | undefined): string {
  if (!days?.length) return '';
  if (days.length === 7) return 'Every day';
  return days
    .filter((d) => d >= 1 && d <= 7)
    .map((d) => DAY_NAMES[d - 1])
    .join(', ');
}
