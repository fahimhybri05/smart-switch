import type { QueryClient } from '@tanstack/react-query';

import type { ChannelState, Device, DeviceConfig, Schedule } from './types';

export const qk = {
  session: ['session'] as const,
  devices: ['devices'] as const,
  deviceConfig: (deviceId: string) => ['device-config', deviceId] as const,
  households: ['households'] as const,
  groups: ['groups'] as const,
  automations: ['automations'] as const,
  /** Prefix for every scenes list — invalidate this after a scene mutation. */
  scenesAll: ['scenes'] as const,
  scenes: (householdId: number | null | undefined) => ['scenes', householdId ?? 'all'] as const,
  usage: (householdId: number, days: number) => ['usage', householdId, days] as const,
  deviceUsage: (deviceId: string, days: number) => ['device-usage', deviceId, days] as const,
  incomingInvites: ['invites', 'incoming'] as const,
  outgoingInvites: (householdId: number) => ['invites', 'outgoing', householdId] as const,
  activity: (householdId: number) => ['activity', householdId] as const,
  apiKeys: ['api-keys'] as const,
  hooks: ['hooks'] as const,
  /** Everything under /admin — invalidate this prefix after any admin mutation. */
  admin: ['admin'] as const,
  adminStats: ['admin', 'stats'] as const,
  adminUsers: (q: string, page: number) => ['admin', 'users', q, page] as const,
  adminUser: (id: number) => ['admin', 'user', id] as const,
  adminDevices: (q: string, status: string, page: number) => ['admin', 'devices', q, status, page] as const,
  adminHouseholds: (q: string) => ['admin', 'households', q] as const,
  adminActivity: ['admin', 'activity'] as const,
  adminApiKeys: (q: string, page: number) => ['admin', 'api-keys', q, page] as const,
  adminAudit: ['admin', 'audit'] as const,
};

export function normalizeState(state: string | null | undefined): ChannelState | null {
  if (!state) return null;
  const s = state.toUpperCase();
  return s === 'ON' ? 'ON' : s === 'OFF' ? 'OFF' : null;
}

/** Sets one channel's state in the cached GET /devices list (adds the channel if unseen). */
export function patchChannelState(
  qc: QueryClient,
  deviceId: string,
  channelIdx: number,
  state: ChannelState,
) {
  qc.setQueryData<Device[]>(qk.devices, (devices) =>
    devices?.map((d) => {
      if (d.device_id !== deviceId) return d;
      const now = new Date().toISOString();
      const exists = d.channels.some((c) => c.channelIdx === channelIdx);
      const channels = exists
        ? d.channels.map((c) => (c.channelIdx === channelIdx ? { ...c, state, updatedAt: now } : c))
        : [...d.channels, { channelIdx, name: null, zone: null, state, updatedAt: now }].sort(
            (a, b) => a.channelIdx - b.channelIdx,
          );
      return { ...d, channels };
    }),
  );
}

/**
 * Whether a channel is locked: the live /devices channel flag when the
 * backend sends it, else the switch config's.
 */
export function isChannelLocked(
  device: Device | undefined,
  config: DeviceConfig | undefined,
  channelIdx: number,
): boolean {
  const ch = device?.channels.find((c) => c.channelIdx === channelIdx);
  if (ch?.locked != null) return ch.locked;
  return config?.switches.find((s) => s.channel_idx === channelIdx)?.locked === true;
}

/** Sets a channel's lock flag in both the device list and the device's config cache. */
export function patchChannelLocked(qc: QueryClient, deviceId: string, channelIdx: number, locked: boolean) {
  qc.setQueryData<Device[]>(qk.devices, (devices) =>
    devices?.map((d) =>
      d.device_id === deviceId
        ? { ...d, channels: d.channels.map((c) => (c.channelIdx === channelIdx ? { ...c, locked } : c)) }
        : d,
    ),
  );
  qc.setQueryData<DeviceConfig>(qk.deviceConfig(deviceId), (cfg) =>
    cfg
      ? {
          ...cfg,
          switches: cfg.switches.map((s) => (s.channel_idx === channelIdx ? { ...s, locked } : s)),
        }
      : cfg,
  );
}

export function patchDeviceOnline(qc: QueryClient, deviceId: string, online: boolean) {
  qc.setQueryData<Device[]>(qk.devices, (devices) =>
    devices?.map((d) =>
      d.device_id === deviceId
        ? { ...d, is_online: online, last_seen_at: online ? new Date().toISOString() : d.last_seen_at }
        : d,
    ),
  );
}

/** Replaces the device list from a WS snapshot, keeping fields the snapshot may lack. */
export function applySnapshot(qc: QueryClient, next: Device[]) {
  qc.setQueryData<Device[]>(qk.devices, (prev) => {
    if (!prev) return next;
    const byId = new Map(prev.map((d) => [d.device_id, d]));
    return next.map((d) => ({ ...byId.get(d.device_id), ...d, household_id: d.household_id ?? byId.get(d.device_id)?.household_id }));
  });
}

/** Replaces (or, with `remove`, drops) one schedule inside a cached device config. */
export function patchCachedSchedule(
  qc: QueryClient,
  deviceId: string,
  scheduleId: string,
  next: Schedule | null,
) {
  qc.setQueryData<DeviceConfig>(qk.deviceConfig(deviceId), (cfg) =>
    cfg
      ? {
          ...cfg,
          schedules: next
            ? cfg.schedules.map((s) => (s.id === scheduleId ? next : s))
            : cfg.schedules.filter((s) => s.id !== scheduleId),
        }
      : cfg,
  );
}
