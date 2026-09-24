'use client';

import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { toast } from 'sonner';

import {
  ApiError,
  authApi,
  automationsApi,
  codeMessage,
  devicesApi,
  errorMessage,
  groupsApi,
  householdsApi,
  scenesApi,
  usageApi,
} from './api';
import { isChannelLocked, normalizeState, patchCachedSchedule, patchChannelLocked, patchChannelState, qk } from './cache';
import { defaultChannelName, switchId } from './format';
import { POLL_INTERVAL_MS, useLiveStatus } from './live';
import type {
  Automation,
  AutomationInput,
  ChannelState,
  Device,
  DeviceConfig,
  Group,
  GroupInput,
  Household,
  Scene,
  SceneInput,
  Schedule,
  ScheduleInput,
  SwitchRef,
  SwitchView,
} from './types';

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
        locked: isChannelLocked(device, config, idx),
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

  const configByDevice = useMemo(() => {
    const map = new Map<string, DeviceConfig | undefined>();
    list.forEach((d, i) => map.set(d.device_id, configData[i]));
    return map;
  }, [list, configData]);

  return { byDevice, configByDevice, configsLoading };
}

/**
 * "Name" for a switch reference: its configured name, else "Device · Channel n",
 * else the raw "deviceId:channel" (e.g. a device that left the household).
 */
export function useSwitchLabeler(byDevice: Map<string, SwitchView[]>, devices: Device[] | undefined) {
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const list of byDevice.values()) for (const s of list) names.set(s.id, s.name);
    const deviceMap = new Map((devices ?? []).map((d) => [d.device_id, d]));
    return (m: SwitchRef) => {
      const name = names.get(switchId(m.deviceId, m.channelIdx));
      if (name) return name;
      const d = deviceMap.get(m.deviceId);
      return d ? `${d.friendly_name || d.device_id} · ${defaultChannelName(m.channelIdx)}` : switchId(m.deviceId, m.channelIdx);
    };
  }, [byDevice, devices]);
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
      noteLockedError(qc, err, v.deviceId, v.channelIdx);
    },
  });
}

/** A command bounced off a lock we didn't know about: show the badge now and refresh the config. */
function noteLockedError(qc: QueryClient, err: unknown, deviceId: string, channelIdx: number) {
  if (err instanceof ApiError && err.code === 'switch_locked') {
    patchChannelLocked(qc, deviceId, channelIdx, true);
    void qc.invalidateQueries({ queryKey: qk.deviceConfig(deviceId) });
  }
}

/**
 * "Reason: name, name +2 · Reason: name" — one line for a batch of failed
 * switch commands (groups, scenes).
 */
export function summarizeFailures(failed: { reason: string; label: string }[]): string {
  const byReason = new Map<string, string[]>();
  for (const f of failed) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f.label]);
  return [...byReason.entries()]
    .map(
      ([reason, names]) =>
        `${reason.replace(/\.$/, '')}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4}` : ''}`,
    )
    .join(' · ');
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

/**
 * The selected household (URL `?h=`) plus the devices that belong to it.
 * Devices carry household_id (GET /devices); if an older backend omits it,
 * every device is shown.
 */
export function useHouseholdScope() {
  const households = useHouseholds();
  const { selected, select } = useSelectedHousehold(households.data);
  const devicesQuery = useDevices();
  const devices = useMemo(() => {
    const all = devicesQuery.data ?? [];
    if (!selected || !all.some((d) => d.household_id != null)) return all;
    return all.filter((d) => d.household_id === selected.id);
  }, [devicesQuery.data, selected]);
  return {
    households,
    selected,
    select,
    devicesQuery,
    devices,
    isOwner: selected?.role === 'owner',
  };
}

/* ------------------------------- Schedules ------------------------------- */

/** Wire body for a schedule, carrying only the fields its type uses. */
export function scheduleToInput(s: Schedule | ScheduleInput): ScheduleInput {
  const input: ScheduleInput = {
    channel_idx: s.channel_idx,
    action: s.action,
    type: s.type,
    enabled: s.enabled,
  };
  if (s.id) input.id = s.id;
  if (s.type === 'once' || s.type === 'daily' || s.type === 'weekly') input.time = s.time;
  if (s.type === 'weekly') input.days = s.days;
  if (s.type === 'countdown') input.duration_s = s.duration_s;
  if (s.type === 'sunrise' || s.type === 'sunset') input.solar_offset_min = s.solar_offset_min ?? 0;
  return input;
}

export function useSaveSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { deviceId: string; input: ScheduleInput }) =>
      devicesApi.upsertSchedule(v.deviceId, scheduleToInput(v.input)),
    onSuccess: (_, v) => qc.invalidateQueries({ queryKey: qk.deviceConfig(v.deviceId) }),
  });
}

/** Optimistic enable/disable (the app's _toggleEnabled): re-posts the full schedule with `enabled` flipped. */
export function useToggleSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { deviceId: string; schedule: Schedule; enabled: boolean }) =>
      devicesApi.upsertSchedule(v.deviceId, scheduleToInput({ ...v.schedule, enabled: v.enabled })),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.deviceConfig(v.deviceId) });
      const previous = qc.getQueryData<DeviceConfig>(qk.deviceConfig(v.deviceId));
      patchCachedSchedule(qc, v.deviceId, v.schedule.id, { ...v.schedule, enabled: v.enabled });
      return { previous };
    },
    onError: (err, v, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.deviceConfig(v.deviceId), ctx.previous);
      toast.error(`Couldn't update the schedule: ${errorMessage(err)}`);
    },
    onSettled: (_, __, v) => qc.invalidateQueries({ queryKey: qk.deviceConfig(v.deviceId) }),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { deviceId: string; scheduleId: string }) => devicesApi.deleteSchedule(v.deviceId, v.scheduleId),
    onSuccess: (_, v) => {
      patchCachedSchedule(qc, v.deviceId, v.scheduleId, null);
      void qc.invalidateQueries({ queryKey: qk.deviceConfig(v.deviceId) });
    },
  });
}

/* --------------------------------- Groups -------------------------------- */

export function useGroups() {
  return useQuery({ queryKey: qk.groups, queryFn: groupsApi.list, staleTime: 30_000 });
}

export function useSaveGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GroupInput) => groupsApi.save(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.groups }),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => groupsApi.remove(id),
    onSuccess: (_, id) => {
      qc.setQueryData<Group[]>(qk.groups, (list) => list?.filter((g) => g.id !== id));
      void qc.invalidateQueries({ queryKey: qk.groups });
    },
  });
}

type MemberResult = { member: SwitchRef; ok: boolean; reason?: string; skipped?: boolean };

const LOCKED_SKIPPED = 'Locked (skipped)';

/**
 * Turns every member channel of a group ON or OFF — the app's _toggleAll:
 * all commands in parallel through the command relay (source 'dashboard'),
 * each flipped optimistically and rolled back on failure. A member on an
 * offline/unknown device is skipped (it can't be reached), and so is a
 * locked one (the backend would refuse it). Partial failures and skips are
 * summarised in one toast instead of one per switch.
 */
export function useSetGroupState() {
  const qc = useQueryClient();
  const live = useLiveStatus();
  return useMutation({
    mutationFn: async (v: {
      group: Group;
      state: ChannelState;
      labelFor?: (m: SwitchRef) => string;
    }): Promise<MemberResult[]> => {
      await qc.cancelQueries({ queryKey: qk.devices });
      const byId = new Map((qc.getQueryData<Device[]>(qk.devices) ?? []).map((d) => [d.device_id, d]));
      return Promise.all(
        v.group.members.map(async (member): Promise<MemberResult> => {
          const device = byId.get(member.deviceId);
          if (!device) return { member, ok: false, reason: 'Device not found' };
          if (!device.is_online) return { member, ok: false, reason: 'Device offline' };
          const config = qc.getQueryData<DeviceConfig>(qk.deviceConfig(member.deviceId));
          if (isChannelLocked(device, config, member.channelIdx)) {
            return { member, ok: false, reason: LOCKED_SKIPPED, skipped: true };
          }
          const previous = normalizeState(device.channels.find((c) => c.channelIdx === member.channelIdx)?.state);
          patchChannelState(qc, member.deviceId, member.channelIdx, v.state);
          try {
            await devicesApi.setChannelState(member.deviceId, member.channelIdx, v.state);
            return { member, ok: true };
          } catch (err) {
            if (previous) patchChannelState(qc, member.deviceId, member.channelIdx, previous);
            noteLockedError(qc, err, member.deviceId, member.channelIdx);
            if (err instanceof ApiError && err.code === 'switch_locked') {
              return { member, ok: false, reason: LOCKED_SKIPPED, skipped: true };
            }
            return { member, ok: false, reason: errorMessage(err) };
          }
        }),
      );
    },
    onSuccess: (results, v) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        const description = summarizeFailures(
          failed.map((f) => ({
            reason: f.reason ?? 'Failed',
            label: v.labelFor?.(f.member) ?? switchId(f.member.deviceId, f.member.channelIdx),
          })),
        );
        const ok = results.length - failed.length;
        const what = `${v.group.name}: ${ok} of ${results.length} switches turned ${v.state === 'ON' ? 'on' : 'off'}`;
        if (ok === 0) toast.error(what, { description });
        else toast.warning(what, { description });
        if (failed.some((f) => !f.skipped)) void qc.invalidateQueries({ queryKey: qk.devices });
      } else if (live !== 'live') {
        void qc.invalidateQueries({ queryKey: qk.devices });
      }
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

/* ------------------------------ Automations ------------------------------ */

export function useAutomations() {
  return useQuery({ queryKey: qk.automations, queryFn: automationsApi.list, staleTime: 30_000 });
}

export function useSaveAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AutomationInput) => automationsApi.save(input),
    onSuccess: (saved) => {
      qc.setQueryData<Automation[]>(qk.automations, (list) =>
        list ? (list.some((a) => a.id === saved.id) ? list.map((a) => (a.id === saved.id ? saved : a)) : [...list, saved]) : list,
      );
      void qc.invalidateQueries({ queryKey: qk.automations });
    },
  });
}

/** Optimistic enabled toggle — the backend has no partial update, so the whole rule is re-posted. */
export function useToggleAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { automation: Automation; enabled: boolean }) => {
      const { automation: a } = v;
      return automationsApi.save({
        id: a.id,
        householdId: a.householdId,
        name: a.name,
        enabled: v.enabled,
        trigger: a.trigger,
        actions: a.actions,
      });
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.automations });
      const previous = qc.getQueryData<Automation[]>(qk.automations);
      qc.setQueryData<Automation[]>(qk.automations, (list) =>
        list?.map((a) => (a.id === v.automation.id ? { ...a, enabled: v.enabled } : a)),
      );
      return { previous };
    },
    onError: (err, _, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.automations, ctx.previous);
      toast.error(`Couldn't update the automation: ${errorMessage(err)}`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.automations }),
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => automationsApi.remove(id),
    onSuccess: (_, id) => {
      qc.setQueryData<Automation[]>(qk.automations, (list) => list?.filter((a) => a.id !== id));
      void qc.invalidateQueries({ queryKey: qk.automations });
    },
  });
}

/* --------------------------------- Scenes -------------------------------- */

/** Pass `enabled: false` until the household selection has settled, to avoid a throwaway unscoped fetch. */
export function useScenes(householdId: number | null | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.scenes(householdId),
    queryFn: () => scenesApi.list(householdId ?? undefined),
    staleTime: 30_000,
    enabled,
  });
}

export function useSaveScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SceneInput) => scenesApi.save(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.scenesAll }),
  });
}

export function useDeleteScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => scenesApi.remove(id),
    onSuccess: (_, id) => {
      qc.setQueriesData<Scene[]>({ queryKey: qk.scenesAll }, (list) => list?.filter((s) => s.id !== id));
      void qc.invalidateQueries({ queryKey: qk.scenesAll });
    },
  });
}

/**
 * Runs a scene on the backend (every action in parallel, source 'scene';
 * lock and min-off rules apply per action) and reports "Night: 5 of 6 done"
 * with the failures grouped by reason.
 */
export function useRunScene() {
  const qc = useQueryClient();
  const live = useLiveStatus();
  return useMutation({
    mutationFn: (v: { scene: Scene; labelFor?: (m: SwitchRef) => string }) => scenesApi.run(v.scene.id),
    onSuccess: (result, v) => {
      const total = result.results.length || result.succeeded + result.failed;
      const what = `${v.scene.name}: ${result.succeeded} of ${total} done`;
      const failed = result.results.filter((r) => !r.ok);
      for (const f of failed) noteLockedError(qc, new ApiError('', 423, f.error ?? null), f.deviceId, f.channelIdx);
      const description = failed.length
        ? summarizeFailures(
            failed.map((f) => ({
              reason: codeMessage(f.error, f.retryAfterSeconds),
              label: v.labelFor?.(f) ?? switchId(f.deviceId, f.channelIdx),
            })),
          )
        : undefined;
      if (total > 0 && result.succeeded === 0 && result.failed > 0) toast.error(what, { description });
      else if (result.failed > 0) toast.warning(what, { description: description || `${result.failed} failed` });
      else toast.success(what);
      if (live !== 'live' || result.failed > 0) void qc.invalidateQueries({ queryKey: qk.devices });
    },
    onError: (err, v) => toast.error(`${v.scene.name}: ${errorMessage(err)}`),
  });
}

/* ---------------------------------- Usage -------------------------------- */

export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export function useHouseholdUsage(householdId: number | undefined, days: number) {
  return useQuery({
    queryKey: qk.usage(householdId ?? 0, days),
    queryFn: () => usageApi.household(householdId!, days),
    enabled: householdId != null,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useDeviceUsage(deviceId: string | undefined, days: number) {
  return useQuery({
    queryKey: qk.deviceUsage(deviceId ?? '', days),
    queryFn: () => devicesApi.usage(deviceId!, days),
    enabled: !!deviceId,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}
