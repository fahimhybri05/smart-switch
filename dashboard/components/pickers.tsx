'use client';

import { WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ALL_DAYS, DAY_LABELS } from '@/lib/schedule';
import type { Device, SwitchView } from '@/lib/types';
import { cn } from '@/lib/utils';

/** "deviceId:channel" → parts (device ids may themselves contain ':'). */
export function parseSwitchKey(key: string): { deviceId: string; channelIdx: number } | null {
  const cut = key.lastIndexOf(':');
  if (cut <= 0) return null;
  const channelIdx = Number(key.slice(cut + 1));
  return Number.isInteger(channelIdx) ? { deviceId: key.slice(0, cut), channelIdx } : null;
}

/** Mon..Sun toggle chips, 1=Mon..7=Sun (same convention as the app and the backend). */
export function DayChips({
  value,
  onChange,
  disabled,
  invalid,
}: {
  value: number[];
  onChange: (days: number[]) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const set = new Set(value);
  const presets = [
    { label: 'Every day', days: ALL_DAYS },
    { label: 'Weekdays', days: [1, 2, 3, 4, 5] },
    { label: 'Weekends', days: [6, 7] },
  ];
  const same = (a: number[]) => a.length === set.size && a.every((d) => set.has(d));
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
        {DAY_LABELS.map((label, i) => {
          const day = i + 1;
          const on = set.has(day);
          return (
            <button
              key={label}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => {
                const next = new Set(set);
                if (on) next.delete(day);
                else next.add(day);
                onChange([...next].sort((a, b) => a - b));
              }}
              className={cn(
                'h-9 min-w-[3rem] rounded-full border px-3 text-sm font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                on
                  ? 'border-primary/60 bg-primary/15 text-foreground shadow-glow-sm'
                  : 'text-muted-foreground hover:border-primary/30 hover:text-foreground',
                invalid && !on && 'border-destructive/50',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            disabled={disabled}
            onClick={() => onChange(p.days)}
            className={cn(
              'font-semibold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline',
              same(p.days) && 'text-brand-ink',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Compact two-or-more-way toggle (ON/OFF, trigger kind…). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  size = 'default',
  className,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; tone?: 'on' | 'off' }[];
  disabled?: boolean;
  size?: 'default' | 'sm';
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex rounded-lg bg-muted p-1', size === 'sm' && 'p-0.5', className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex-1 whitespace-nowrap rounded-md font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
              active
                ? cn(
                    'bg-card shadow-sm',
                    o.tone === 'on' && 'bg-primary text-primary-foreground',
                    o.tone === 'off' && 'bg-destructive text-destructive-foreground',
                  )
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export interface DeviceSwitches {
  device: Device;
  switches: SwitchView[];
}

/**
 * Multi-select of switches across devices, grouped by device — the app's
 * _DeviceSwitchPicker / _ActionDeviceChoices. `extra` renders beside a
 * checked row (e.g. an automation action's ON/OFF).
 */
export function SwitchChecklist({
  groups,
  isSelected,
  onToggle,
  extra,
  loading,
}: {
  groups: DeviceSwitches[];
  isSelected: (view: SwitchView) => boolean;
  onToggle: (view: SwitchView, checked: boolean) => void;
  extra?: (view: SwitchView) => ReactNode;
  loading?: boolean;
}) {
  if (groups.length === 0) {
    return <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">No devices in this household.</p>;
  }
  return (
    <div className="grid gap-3">
      {groups.map(({ device, switches }) => (
        <fieldset key={device.device_id} className="rounded-xl border">
          <legend className="ml-3 flex items-center gap-1.5 px-1 text-xs font-bold uppercase tracking-wide text-muted-foreground">
            {device.friendly_name || device.device_id}
            {!device.is_online && <WifiOff className="h-3 w-3" aria-label="offline" />}
          </legend>
          {switches.length === 0 ? (
            <p className="px-3 pb-3 pt-1 text-xs text-muted-foreground">{loading ? 'Loading switches…' : 'No switches.'}</p>
          ) : (
            <ul className="divide-y">
              {switches.map((sw) => {
                const checked = isSelected(sw);
                const id = `pick-${sw.id}`;
                return (
                  <li key={sw.id} className="flex min-h-11 items-center gap-3 px-3 py-1.5">
                    <Checkbox id={id} checked={checked} onCheckedChange={(c) => onToggle(sw, c === true)} />
                    <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm">
                      <span className="block truncate font-medium">{sw.name}</span>
                      {sw.zone && <span className="block truncate text-xs text-muted-foreground">{sw.zone}</span>}
                    </label>
                    {checked && extra?.(sw)}
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      ))}
    </div>
  );
}

/** Single switch picker (Select with one group per device). Value is a "deviceId:channel" key. */
export function SwitchSelect({
  groups,
  value,
  onChange,
  placeholder = 'Choose a switch',
  disabled,
  invalid,
  id,
}: {
  groups: DeviceSwitches[];
  value: string | undefined;
  onChange: (key: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-invalid={invalid} className={cn(invalid && 'border-destructive')}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {groups.map(({ device, switches }) =>
          switches.length === 0 ? null : (
            <SelectGroup key={device.device_id}>
              {groups.length > 1 && <SelectLabel>{device.friendly_name || device.device_id}</SelectLabel>}
              {switches.map((sw) => (
                <SelectItem key={sw.id} value={sw.id}>
                  {sw.name}
                  {groups.length > 1 ? '' : sw.zone ? ` · ${sw.zone}` : ''}
                </SelectItem>
              ))}
            </SelectGroup>
          ),
        )}
      </SelectContent>
    </Select>
  );
}
