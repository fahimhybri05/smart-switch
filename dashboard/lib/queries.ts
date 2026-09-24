'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';

import { ApiError, authApi, devicesApi, errorMessage, householdsApi } from './api';
import { normalizeState, patchChannelState, qk } from './cache';
import { defaultChannelName, switchId } from './format';
import { POLL_INTERVAL_MS, useLiveStatus } from './live';
import type { ChannelState, Device, DeviceConfig, Household, SwitchView } from './types';

/* ------------------------------ Session / me ----------------------------- */

export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: authApi.session, staleTime: 60_000 });
}

/** The signed-in user (null until loaded or when /auth/me isn't available). */
export function useMe() {
  const { data, ...rest } = useSession();
  return { me: data?.user ?? null, ...rest };
}

/* -------------------------------- Devices -------------------------------- */

export function useDevices() {
  const live = useLiveStatus();
  return useQuery({
    queryKey: qk.devices,
    queryFn: devicesApi.list,
    refetchInterval: live === 'live' ? false : POLL_INTERVAL_MS,
    staleTime: 5_000,
  });
}

export function useDeviceConfig(deviceId: string | undefined) {
  return useQuery({
    queryKey: qk.deviceConfig(deviceId ?? ''),
    queryFn: () => devicesApi.config(deviceId!),
    enabled: !!deviceId,
    staleTime: 60_000,
  });
}

/**
 * Merges live channel state (GET /devices / WS) with each device's
 * canonical switch config (GET /devices/:id/config): names and zones live
 * in device_switches, not in the channel cache.
 */
export function buildSwitchViews(device: Device, config: DeviceConfig | undefined): SwitchView[] {
  const deviceName = device.friendly_name || config?.name || device.device_id;
  const channelByIdx = new Map(device.channels.map((c) => [c.channelIdx, c]));
  const configByIdx = new Map((config?.switches ?? []).map((s) => [s.channel_idx, s]));
  const indices = new Set<number>([...configByIdx.keys()]);
  if (configByIdx.size === 0) channelByIdx.forEach((_, idx) => indices.add(idx));

  return [...indices]
    .sort((a, b) => a - b)
    .map((idx) => {
      const ch = channelByIdx.get(idx);
      const cfg = configByIdx.get(idx) ?? null;
      return {
        id: switchId(device.device_id, idx),
        deviceId: device.device_id,
        deviceName,
        channelIdx: idx,
        name: cfg?.name || ch?.name || defaultChannelName(idx),
        zone: cfg?.zone || ch?.zone || '',
        state: normalizeState(ch?.state),
        online: device.is_online,
        updatedAt: ch?.updatedAt ?? null,
        config: cfg,
      };
    });
}

/** Stable `combine` for useQueries: TanStack structurally shares its result between renders. */
function combineConfigs(results: { data?: DeviceConfig; isLoading: boolean }[]) {
  return {
    configData: results.map((r) => r.data),
    configsLoading: results.some((r) => r.isLoading),
  };
}

export function useSwitchViews(devices: Device[] | undefined) {
  const list = useMemo(() => devices ?? [], [devices]);
  const { configData, configsLoading } = useQueries({
    queries: list.map((d) => ({
      queryKey: qk.deviceConfig(d.device_id),
      queryFn: () => devicesApi.config(d.device_id),
      staleTime: 60_000,
      retry: 1,
    })),
    combine: combineConfigs,
  });

  const byDevice = useMemo(() => {
    const map = new Map<string, SwitchView[]>();
    list.forEach((d, i) => map.set(d.device_id, buildSwitchViews(d, configData[i])));
    return map;
  }, [list, configData]);

  return { byDevice, configsLoading };
}

/** Optimistic channel toggle with rollback on failure (503 offline, 504 timeout, …). */
export function useSetChannelState() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { deviceId: string; channelIdx: number; state: ChannelState; label?: string }) =>
      devicesApi.setChannelState(v.deviceId, v.channelIdx, v.state),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.devices });
      const previous = qc.getQueryData<Device[]>(qk.devices);
      patchChannelState(qc, v.deviceId, v.channelIdx, v.state);
      return { previous };
    },
    onError: (err, v, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.devices, ctx.previous);
      const what = v.label ? `${v.label}: ` : '';
      toast.error(`${what}${errorMessage(err)}`);
      if (err instanceof ApiError && err.status === 503) {
        void qc.invalidateQueries({ queryKey: qk.devices });
      }
    },
  });
}

/* ------------------------------- Households ------------------------------ */

export function useHouseholds() {
  return useQuery({ queryKey: qk.households, queryFn: householdsApi.list, staleTime: 30_000 });
}

/**
 * Selected household lives in the URL (`?h=<id>`) so it survives reloads
 * and deep links without any browser storage.
 */
export function useSelectedHousehold(households: Household[] | undefined) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = Number(params.get('h'));

  const selected = useMemo(() => {
    if (!households?.length) return null;
    return (
      households.find((h) => h.id === raw) ??
      households.find((h) => h.role === 'owner') ??
      households[0]
    );
  }, [households, raw]);

  const select = useCallback(
    (id: number) => {
      const next = new URLSearchParams(params.toString());
      next.set('h', String(id));
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  return { selected, select };
}
