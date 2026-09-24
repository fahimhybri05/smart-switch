/**
 * Browser-side API client. Every backend call goes through the BFF
 * (/api/bff/* or /api/auth/*); this file is the single place that knows URL
 * paths, request bodies and how raw responses map onto lib/types.ts.
 */
import type {
  ActivityPage,
  AdminActivityEntry,
  AdminApiKey,
  AdminDevice,
  AdminDeviceStatus,
  AdminHousehold,
  AdminStats,
  AdminUser,
  AdminUserDetail,
  AuditEntry,
  Automation,
  AutomationAction,
  AutomationInput,
  AutomationTrigger,
  CursorPage,
  Paged,
  ApiKey,
  ChannelState,
  CommandResult,
  CreatedApiKey,
  CreatedHook,
  Device,
  DeviceChannel,
  DeviceConfig,
  DeviceSettings,
  DeviceUsage,
  Group,
  GroupInput,
  Hook,
  Household,
  HouseholdSwitchUsage,
  HouseholdUsage,
  IncomingInvite,
  Me,
  OutgoingInvite,
  Role,
  Scene,
  SceneAction,
  SceneInput,
  SceneRunResult,
  Schedule,
  ScheduleInput,
  ScheduleType,
  SwitchConfig,
  SwitchPatch,
  SwitchRef,
  SwitchUsage,
} from './types';

/* --------------------------------------------------------------------- */
/* Transport                                                             */
/* --------------------------------------------------------------------- */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Human-readable messages for machine codes the backend returns. */
const CODE_MESSAGES: Record<string, string> = {
  device_offline: 'The device is offline.',
  device_timeout: "The device didn't respond in time.",
  session_expired: 'Your session has expired. Please sign in again.',
  backend_unavailable: "Can't reach the Smart Control server right now.",
  'bad origin': 'Request blocked (bad origin).',
  'missing request header': 'Request blocked.',
  switch_locked: 'This switch is locked',
  min_off_time: 'Protection: wait before turning it on again',
};

/** "Protection: wait N min before turning it on again" (N rounded up, at least 1). */
export function minOffMessage(retryAfterSeconds: unknown): string {
  const s = Number(retryAfterSeconds);
  if (!Number.isFinite(s) || s <= 0) return CODE_MESSAGES.min_off_time;
  return `Protection: wait ${Math.max(1, Math.ceil(s / 60))} min before turning it on again`;
}

/**
 * Human text for a backend machine code — also used for per-item codes that
 * come back inside a 200 (e.g. POST /scenes/:id/run results).
 */
export function codeMessage(code: string | null | undefined, retryAfterSeconds?: unknown): string {
  if (!code) return 'Failed';
  if (code === 'min_off_time') return minOffMessage(retryAfterSeconds);
  return CODE_MESSAGES[code] ?? code.charAt(0).toUpperCase() + code.slice(1).replace(/_/g, ' ');
}

function extractError(status: number, body: unknown): ApiError {
  const raw = (body as { error?: unknown } | null)?.error;
  let code: string | null = null;
  let message: string;
  // retryAfterSeconds sits beside `error` on REST, inside it on /v1-style bodies.
  const retryAfter =
    (body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds ??
    (raw && typeof raw === 'object' ? (raw as { retryAfterSeconds?: unknown }).retryAfterSeconds : undefined);
  if (typeof raw === 'string') {
    code = raw;
    message = CODE_MESSAGES[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
  } else if (raw && typeof raw === 'object') {
    code = (raw as { code?: string }).code ?? null;
    message = (raw as { message?: string }).message ?? (code ? (CODE_MESSAGES[code] ?? code) : '');
  } else {
    message = '';
  }
  if (!message) {
    message =
      status === 429
        ? 'Too many attempts. Please wait a few minutes and try again.'
        : status >= 500
          ? 'Something went wrong on the server.'
          : `Request failed (${status}).`;
  }
  // Our own wording wins for the safety codes, whatever the backend's message says.
  if (code === 'switch_locked') message = CODE_MESSAGES.switch_locked;
  if (code === 'min_off_time') message = minOffMessage(retryAfter);
  if (status === 429 && !code) code = 'rate_limited';
  return new ApiError(message, status, code, body);
}

let redirecting = false;

function redirectToLogin() {
  if (typeof window === 'undefined' || redirecting) return;
  redirecting = true;
  const next = window.location.pathname + window.location.search;
  const qs = next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  window.location.assign(`/login${qs}`);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Redirect to /login when the BFF reports the session is gone (default true). */
  authRedirect?: boolean;
}

export async function request<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, authRedirect = true } = opts;
  const headers: Record<string, string> = { Accept: 'application/json', 'X-SC-Request': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError('Network error — check your connection.', 0, 'network_error');
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 200) };
    }
  }

  if (!res.ok) {
    if (res.status === 401 && res.headers.get('x-sc-session') === 'expired' && authRedirect) {
      redirectToLogin();
    }
    throw extractError(res.status, data);
  }
  return data as T;
}

const bff = (path: string) => `/api/bff/${path}`;
const enc = encodeURIComponent;

/* --------------------------------------------------------------------- */
/* Normalisers (adjust here if backend shapes differ)                     */
/* --------------------------------------------------------------------- */

type Loose = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v));
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));

function normalizeMe(raw: unknown): Me {
  const o = ((raw as Loose)?.user ?? raw ?? {}) as Loose;
  const households = Array.isArray(o.households) ? (o.households as Loose[]) : [];
  return {
    id: num(o.id ?? o.userId),
    email: str(o.email) ?? '',
    createdAt: str(o.createdAt ?? o.created_at),
    isAdmin: o.isAdmin === true || o.is_admin === true,
    households: households.map((h) => ({
      id: num(h.id ?? h.householdId),
      name: str(h.name) ?? '',
      role: (str(h.role) ?? 'member') as Role,
    })),
  };
}

function normalizeSwitchConfig(raw: Loose): SwitchConfig {
  return {
    channel_idx: num(raw.channel_idx ?? raw.channelIdx),
    name: str(raw.name) ?? '',
    zone: str(raw.zone) ?? '',
    type: str(raw.type) ?? 'ON_OFF',
    default_boot_state: (raw.default_boot_state ?? raw.defaultBootState) === 'ON' ? 'ON' : 'OFF',
    input_mode: ((raw.input_mode ?? raw.inputMode) as SwitchConfig['input_mode']) ?? 'DISABLED',
    inching_ms: num(raw.inching_ms ?? raw.inchingMs ?? 0) || 0,
    watts: optNum(raw.watts),
    max_on_s: optNum(raw.max_on_s ?? raw.maxOnSeconds),
    min_off_s: optNum(raw.min_off_s ?? raw.minOffSeconds),
    locked: raw.locked === true || (raw.locked == null && (raw.locked_at ?? raw.lockedAt) != null),
    locked_at: str(raw.locked_at ?? raw.lockedAt),
  };
}

/** Positive-or-zero number, or null for null/undefined/garbage. */
function optNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const SCHEDULE_TYPES: ScheduleType[] = ['once', 'daily', 'weekly', 'countdown', 'sunrise', 'sunset'];

function normalizeSchedule(raw: Loose): Schedule {
  const type = SCHEDULE_TYPES.includes(raw.type as ScheduleType) ? (raw.type as ScheduleType) : 'once';
  const s: Schedule = {
    id: str(raw.id) ?? '',
    channel_idx: num(raw.channel_idx ?? raw.channelIdx),
    action: raw.action === 'ON' ? 'ON' : 'OFF',
    type,
    enabled: raw.enabled !== false,
  };
  if (typeof raw.time === 'string') s.time = raw.time.slice(0, 5);
  if (Array.isArray(raw.days)) s.days = (raw.days as unknown[]).map(num).filter((d) => d >= 1 && d <= 7);
  if (raw.duration_s != null) s.duration_s = num(raw.duration_s);
  if (raw.solar_offset_min != null) s.solar_offset_min = num(raw.solar_offset_min);
  return s;
}

function normalizeConfig(raw: unknown): DeviceConfig {
  const o = ((raw as Loose)?.config ?? raw ?? {}) as Loose;
  const switches = Array.isArray(o.switches) ? (o.switches as Loose[]).map(normalizeSwitchConfig) : [];
  return {
    ...(o as unknown as DeviceConfig),
    utc_offset_min: num(o.utc_offset_min ?? 0) || 0,
    location_set: o.location_set === true,
    switches: switches.sort((a, b) => a.channel_idx - b.channel_idx),
    schedules: Array.isArray(o.schedules) ? (o.schedules as Loose[]).map(normalizeSchedule) : [],
  };
}

function normalizeOutgoingInvite(raw: Loose): OutgoingInvite {
  return {
    id: num(raw.id),
    invitedUserId: raw.invitedUserId != null ? num(raw.invitedUserId) : null,
    email: str(raw.invitedEmail ?? raw.email ?? raw.invitedUserEmail) ?? '',
    createdAt: str(raw.createdAt ?? raw.created_at),
    invitedByEmail: str(raw.invitedByEmail ?? raw.invited_by_email),
  };
}

function normalizeChannel(raw: Loose): DeviceChannel {
  const ch = { ...(raw as unknown as DeviceChannel) };
  // Keep `locked` undefined when an older backend omits it, so the switch config can decide.
  if (raw.locked != null) ch.locked = raw.locked === true;
  const since = raw.stateSince ?? raw.state_since;
  if (since !== undefined) ch.stateSince = str(since);
  return ch;
}

function normalizeDevice(raw: Loose): Device {
  return {
    device_id: str(raw.device_id ?? raw.deviceId) ?? '',
    friendly_name: str(raw.friendly_name ?? raw.friendlyName),
    is_online: Boolean(raw.is_online ?? raw.isOnline ?? raw.online),
    last_seen_at: str(raw.last_seen_at ?? raw.lastSeenAt),
    channels: Array.isArray(raw.channels) ? (raw.channels as Loose[]).map(normalizeChannel) : [],
    household_id:
      raw.household_id != null || raw.householdId != null
        ? num(raw.household_id ?? raw.householdId)
        : undefined,
  };
}

export function normalizeDevices(raw: unknown): Device[] {
  const list = Array.isArray(raw) ? raw : ((raw as Loose)?.devices as unknown[]);
  return Array.isArray(list) ? (list as Loose[]).map(normalizeDevice) : [];
}

/* --------------------------------------------------------------------- */
/* Auth (dedicated BFF handlers)                                          */
/* --------------------------------------------------------------------- */

export const authApi = {
  login: (email: string, password: string) =>
    request<{ ok: true }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      authRedirect: false,
    }),
  signup: (email: string, password: string) =>
    request<{ ok: true }>('/api/auth/signup', {
      method: 'POST',
      body: { email, password },
      authRedirect: false,
    }),
  logout: () => request<null>('/api/auth/logout', { method: 'POST', authRedirect: false }),
  session: async () => {
    const r = await request<{ authenticated: boolean; user: unknown }>('/api/auth/session', {
      authRedirect: false,
    });
    return { authenticated: r.authenticated, user: r.user ? normalizeMe(r.user) : null };
  },
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/api/auth/password', {
      method: 'PATCH',
      body: { currentPassword, newPassword },
    }),
  deleteAccount: (password: string) =>
    request<null>('/api/auth/account', { method: 'DELETE', body: { password } }),
  wsToken: () =>
    request<{ token: string; wsUrl: string }>('/api/auth/ws-token', { method: 'POST' }),
};

/* --------------------------------------------------------------------- */
/* Profile                                                                */
/* --------------------------------------------------------------------- */

export const profileApi = {
  me: async () => normalizeMe(await request<unknown>(bff('auth/me'))),
  changeEmail: (newEmail: string, password: string) =>
    request<unknown>(bff('auth/email'), { method: 'PATCH', body: { newEmail, password } }),
};

/* --------------------------------------------------------------------- */
/* Devices & switches                                                     */
/* --------------------------------------------------------------------- */

export const devicesApi = {
  list: async () => normalizeDevices(await request<unknown>(bff('devices'))),
  config: async (deviceId: string) =>
    normalizeConfig(await request<unknown>(bff(`devices/${enc(deviceId)}/config`))),
  rename: (deviceId: string, friendlyName: string) =>
    request<unknown>(bff(`devices/${enc(deviceId)}`), { method: 'PATCH', body: { friendlyName } }),
  remove: (deviceId: string) =>
    request<null>(bff(`devices/${enc(deviceId)}`), { method: 'DELETE' }),
  /** Partial switch update; resolves to the saved switch row (null if the body wasn't a row). */
  patchSwitch: async (deviceId: string, channelIdx: number, patch: SwitchPatch): Promise<SwitchConfig | null> => {
    const raw = await request<Loose | null>(bff(`devices/${enc(deviceId)}/switches/${channelIdx}`), {
      method: 'PATCH',
      body: patch,
    });
    const row = (raw?.switch ?? raw) as Loose | null;
    return row && typeof row === 'object' && (row.channel_idx != null || row.channelIdx != null)
      ? normalizeSwitchConfig(row)
      : null;
  },
  /** Per-switch daily on-time for the last `days` days (1..90). */
  usage: async (deviceId: string, days: number): Promise<DeviceUsage> => {
    const raw = (await request<Loose>(`${bff(`devices/${enc(deviceId)}/usage`)}?days=${days}`)) ?? {};
    return {
      timezone: str(raw.timezone) ?? 'UTC',
      days: Array.isArray(raw.days) ? (raw.days as unknown[]).map((d) => String(d)) : [],
      switches: listOf(raw, 'switches').map(normalizeSwitchUsage),
    };
  },
  /** Create (no `id`) or update (`id`) a schedule; resolves to the saved schedule. */
  upsertSchedule: async (deviceId: string, input: ScheduleInput) =>
    normalizeSchedule(
      (await request<Loose>(bff(`devices/${enc(deviceId)}/schedules`), { method: 'POST', body: input })) ?? {},
    ),
  deleteSchedule: (deviceId: string, scheduleId: string) =>
    request<null>(bff(`devices/${enc(deviceId)}/schedules/${enc(scheduleId)}`), { method: 'DELETE' }),
  /** Sets the device's location (needed by sunrise/sunset schedules). Never touches interlock. */
  setLocation: (deviceId: string, latitude: number, longitude: number) =>
    request<DeviceSettings>(bff(`devices/${enc(deviceId)}/settings`), {
      method: 'PATCH',
      body: { latitude, longitude },
    }),
  /** Actuates one channel through the relay endpoint. Throws ApiError on 503/504 or a device-side error. */
  setChannelState: async (deviceId: string, channelIdx: number, state: ChannelState) => {
    const result = await request<CommandResult>(bff(`devices/${enc(deviceId)}/command`), {
      method: 'POST',
      body: {
        method: 'POST',
        path: `/api/channels/${channelIdx}/state`,
        body: { state },
        source: 'dashboard',
      },
    });
    if (result && typeof result.status === 'number' && result.status >= 400) {
      throw extractError(result.status, result.body);
    }
    return result;
  },
};

/* --------------------------------------------------------------------- */
/* Households                                                             */
/* --------------------------------------------------------------------- */

export const householdsApi = {
  list: async () => (await request<{ households: Household[] }>(bff('households'))).households ?? [],
  rename: (id: number, name: string) =>
    request<unknown>(bff(`households/${id}`), { method: 'PATCH', body: { name } }),
  /** IANA timezone automations' schedule triggers are evaluated in (owner-only). */
  setTimezone: (id: number, timezone: string) =>
    request<unknown>(bff(`households/${id}`), { method: 'PATCH', body: { timezone } }),
  invite: (id: number, email: string) =>
    request<unknown>(bff(`households/${id}/invite`), { method: 'POST', body: { email } }),
  outgoingInvites: async (id: number) =>
    listOf(await request<unknown>(bff(`households/${id}/invites`)), 'invites').map(normalizeOutgoingInvite),
  cancelInvite: (id: number, inviteId: number) =>
    request<null>(bff(`households/${id}/invites/${inviteId}`), { method: 'DELETE' }),
  incomingInvites: async () =>
    (await request<{ invites: IncomingInvite[] }>(bff('households/invites'))).invites ?? [],
  acceptInvite: (inviteId: number) =>
    request<unknown>(bff(`households/invites/${inviteId}/accept`), { method: 'POST' }),
  declineInvite: (inviteId: number) =>
    request<unknown>(bff(`households/invites/${inviteId}/decline`), { method: 'POST' }),
  /** Owner removing a member, or a member removing themselves (leave). */
  removeMember: (id: number, userId: number) =>
    request<null>(bff(`households/${id}/members/${userId}`), { method: 'DELETE' }),
};

/* --------------------------------------------------------------------- */
/* Groups & automations                                                   */
/* --------------------------------------------------------------------- */

function normalizeRef(raw: Loose): SwitchRef {
  return { deviceId: str(raw.deviceId ?? raw.device_id) ?? '', channelIdx: num(raw.channelIdx ?? raw.channel_idx) };
}

function normalizeGroup(raw: Loose): Group {
  const hh = raw.householdId ?? raw.household_id;
  return {
    id: num(raw.id),
    householdId: hh != null ? num(hh) : null,
    name: str(raw.name) ?? '',
    members: listOf(raw, 'members').map(normalizeRef),
  };
}

function normalizeTrigger(raw: Loose): AutomationTrigger {
  if (raw.type === 'state') {
    return { type: 'state', ...normalizeRef(raw), state: raw.state === 'OFF' ? 'OFF' : 'ON' };
  }
  return {
    type: 'schedule',
    days: Array.isArray(raw.days) ? (raw.days as unknown[]).map(num) : [],
    time: (str(raw.time) ?? '00:00').slice(0, 5),
  };
}

function normalizeAutomation(raw: Loose): Automation {
  return {
    id: num(raw.id),
    householdId: num(raw.householdId ?? raw.household_id),
    name: str(raw.name) ?? '',
    enabled: raw.enabled !== false,
    trigger: normalizeTrigger((raw.trigger as Loose) ?? {}),
    actions: listOf(raw, 'actions').map(
      (a): AutomationAction => ({ ...normalizeRef(a), state: a.state === 'OFF' ? 'OFF' : 'ON' }),
    ),
    lastFiredAt: str(raw.lastFiredAt ?? raw.last_fired_at),
  };
}

export const groupsApi = {
  list: async () => listOf(await request<unknown>(bff('groups')), 'groups').map(normalizeGroup),
  /** Create (no `id`) or update (`id`: replaces name + members). Any household member may. */
  save: async (input: GroupInput) =>
    normalizeGroup((await request<Loose>(bff('groups'), { method: 'POST', body: input })) ?? {}),
  remove: (id: number) => request<null>(bff(`groups/${id}`), { method: 'DELETE' }),
};

function normalizeSwitchUsage(raw: Loose): SwitchUsage {
  const daily = Array.isArray(raw.dailyOnSeconds) ? (raw.dailyOnSeconds as unknown[]).map((v) => num(v) || 0) : [];
  const watts = optNum(raw.watts);
  return {
    channelIdx: num(raw.channelIdx ?? raw.channel_idx),
    name: str(raw.name) ?? '',
    watts,
    dailyOnSeconds: daily,
    totalOnSeconds: num(raw.totalOnSeconds ?? daily.reduce((a, b) => a + b, 0)) || 0,
    kwh: optNum(raw.kwh),
  };
}

export const usageApi = {
  household: async (householdId: number, days: number): Promise<HouseholdUsage> => {
    const raw = (await request<Loose>(`${bff('usage')}${query({ householdId, days })}`)) ?? {};
    const totals = (raw.totals ?? {}) as Loose;
    return {
      timezone: str(raw.timezone) ?? 'UTC',
      days: Array.isArray(raw.days) ? (raw.days as unknown[]).map((d) => String(d)) : [],
      switches: listOf(raw, 'switches').map(
        (s): HouseholdSwitchUsage => ({
          ...normalizeSwitchUsage(s),
          deviceId: str(s.deviceId ?? s.device_id) ?? '',
          deviceName: str(s.deviceName ?? s.device_name) ?? '',
        }),
      ),
      totals: { onSeconds: num(totals.onSeconds ?? 0) || 0, kwh: optNum(totals.kwh) },
    };
  },
};

function normalizeSceneAction(a: Loose): SceneAction {
  return { ...normalizeRef(a), state: a.state === 'OFF' ? 'OFF' : 'ON' };
}

function normalizeScene(raw: Loose): Scene {
  const hh = raw.householdId ?? raw.household_id;
  return {
    id: num(raw.id),
    householdId: hh != null ? num(hh) : null,
    name: str(raw.name) ?? '',
    icon: str(raw.icon),
    actions: listOf(raw, 'actions').map(normalizeSceneAction),
    createdAt: str(raw.createdAt ?? raw.created_at),
    updatedAt: str(raw.updatedAt ?? raw.updated_at),
  };
}

export const scenesApi = {
  list: async (householdId?: number) =>
    listOf(await request<unknown>(`${bff('scenes')}${query({ householdId })}`), 'scenes').map(normalizeScene),
  /** Create (no `id`) or replace (`id`). Any household member may (mirrors groups). */
  save: async (input: SceneInput) => {
    const raw = (await request<Loose>(bff('scenes'), { method: 'POST', body: input })) ?? {};
    return normalizeScene(((raw.scene as Loose) ?? raw) as Loose);
  },
  remove: (id: number) => request<null>(bff(`scenes/${id}`), { method: 'DELETE' }),
  run: async (id: number): Promise<SceneRunResult> => {
    const raw = (await request<Loose>(bff(`scenes/${id}/run`), { method: 'POST' })) ?? {};
    const results = listOf(raw, 'results').map((r) => ({
      ...normalizeSceneAction(r),
      ok: r.ok === true,
      error: str(r.error && typeof r.error === 'object' ? (r.error as Loose).code : r.error),
      retryAfterSeconds: optNum(
        r.retryAfterSeconds ?? (r.error && typeof r.error === 'object' ? (r.error as Loose).retryAfterSeconds : null),
      ),
    }));
    const succeeded = results.filter((r) => r.ok).length;
    return {
      results,
      succeeded: raw.succeeded != null ? num(raw.succeeded) : succeeded,
      failed: raw.failed != null ? num(raw.failed) : results.length - succeeded,
    };
  },
};

export const automationsApi = {
  list: async () => listOf(await request<unknown>(bff('automations')), 'automations').map(normalizeAutomation),
  /** Create (no `id`) or replace (`id`). Owner-only on the backend. */
  save: async (input: AutomationInput) =>
    normalizeAutomation((await request<Loose>(bff('automations'), { method: 'POST', body: input })) ?? {}),
  remove: (id: number) => request<null>(bff(`automations/${id}`), { method: 'DELETE' }),
};

/* --------------------------------------------------------------------- */
/* Activity                                                               */
/* --------------------------------------------------------------------- */

export const activityApi = {
  page: (householdId: number, before?: number | null, limit = 50) => {
    const qs = new URLSearchParams({ householdId: String(householdId), limit: String(limit) });
    if (before) qs.set('before', String(before));
    return request<ActivityPage>(`${bff('activity')}?${qs.toString()}`);
  },
};

/* --------------------------------------------------------------------- */
/* API keys & hooks                                                       */
/* --------------------------------------------------------------------- */

function normalizeApiKey(raw: Loose): ApiKey {
  return {
    id: num(raw.id),
    name: str(raw.name) ?? '',
    prefix: str(raw.prefix) ?? '',
    createdAt: str(raw.createdAt) ?? '',
    lastUsedAt: str(raw.lastUsedAt),
    hookCount: num(raw.hookCount ?? 0) || 0,
  };
}

function normalizeHook(raw: Loose): Hook {
  const switchIdRaw = str(raw.switchId) ?? '';
  const cut = switchIdRaw.lastIndexOf(':');
  return {
    id: num(raw.id),
    apiKeyId: num(raw.apiKeyId),
    apiKeyName: str(raw.apiKeyName),
    switchId: switchIdRaw,
    deviceId: str(raw.deviceId) ?? (cut > 0 ? switchIdRaw.slice(0, cut) : ''),
    channel: raw.channel != null ? num(raw.channel) : cut > 0 ? Number(switchIdRaw.slice(cut + 1)) : 0,
    name: str(raw.name),
    tokenPrefix: str(raw.tokenPrefix ?? raw.prefix) ?? '',
    createdAt: str(raw.createdAt) ?? '',
    lastUsedAt: str(raw.lastUsedAt),
  };
}

function listOf(raw: unknown, key: string): Loose[] {
  const list = Array.isArray(raw) ? raw : (raw as Loose)?.[key];
  return Array.isArray(list) ? (list as Loose[]) : [];
}

export const integrationsApi = {
  keys: async () => listOf(await request<unknown>(bff('api-keys')), 'apiKeys').map(normalizeApiKey),
  /** Returns the key plus its secret — the only time the secret is ever available. */
  createKey: async (name: string): Promise<CreatedApiKey> => {
    const raw = (await request<Loose>(bff('api-keys'), { method: 'POST', body: { name } })) ?? {};
    return { ...normalizeApiKey(raw), secret: str(raw.secret) ?? '' };
  },
  revokeKey: (id: ApiKey['id']) => request<null>(bff(`api-keys/${id}`), { method: 'DELETE' }),
  hooks: async () => listOf(await request<unknown>(bff('hooks')), 'hooks').map(normalizeHook),
  /** Returns the hook plus its token/URLs — the only time they are ever available. */
  createHook: async (apiKeyId: ApiKey['id'], switchId: string, name?: string): Promise<CreatedHook> => {
    const raw =
      (await request<Loose>(bff('hooks'), {
        method: 'POST',
        body: { apiKeyId, switchId, ...(name ? { name } : {}) },
      })) ?? {};
    return {
      ...normalizeHook(raw),
      token: str(raw.token) ?? '',
      urls: (raw.urls as CreatedHook['urls']) ?? { on: '', off: '', toggle: '', status: '' },
    };
  },
  revokeHook: (id: Hook['id']) => request<null>(bff(`hooks/${id}`), { method: 'DELETE' }),
};

/* --------------------------------------------------------------------- */
/* Admin (backend enforces is_admin on every call — see routes/admin.js)  */
/* --------------------------------------------------------------------- */

function query(params: Record<string, string | number | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

function normalizeAdminUser(raw: Loose): AdminUser {
  return {
    id: num(raw.id),
    email: str(raw.email) ?? '',
    createdAt: str(raw.createdAt),
    isAdmin: raw.isAdmin === true,
    disabledAt: str(raw.disabledAt),
    householdCount: num(raw.householdCount ?? 0) || 0,
    deviceCount: num(raw.deviceCount ?? 0) || 0,
    apiKeyCount: num(raw.apiKeyCount ?? 0) || 0,
    lastActiveAt: str(raw.lastActiveAt),
  };
}

export interface AdminListParams {
  q?: string;
  limit?: number;
  offset?: number;
}

export const adminApi = {
  stats: () => request<AdminStats>(bff('admin/stats')),

  users: async (p: AdminListParams = {}): Promise<Paged<AdminUser>> => {
    const raw = await request<Loose>(`${bff('admin/users')}${query({ ...p })}`);
    return { items: listOf(raw, 'users').map(normalizeAdminUser), total: num(raw?.total ?? 0) || 0 };
  },
  user: async (id: number): Promise<AdminUserDetail> => {
    const raw = (await request<Loose>(bff(`admin/users/${id}`))) ?? {};
    return {
      ...normalizeAdminUser(raw),
      households: listOf(raw, 'households').map((h) => ({
        id: num(h.id),
        name: str(h.name) ?? '',
        role: (str(h.role) ?? 'member') as Role,
      })),
      devices: listOf(raw, 'devices').map((d) => ({
        deviceId: str(d.deviceId) ?? '',
        friendlyName: str(d.friendlyName),
        householdId: d.householdId != null ? num(d.householdId) : null,
        online: d.online === true,
      })),
      apiKeys: listOf(raw, 'apiKeys').map(normalizeApiKey),
    };
  },
  disableUser: (id: number) => request<unknown>(bff(`admin/users/${id}/disable`), { method: 'POST' }),
  enableUser: (id: number) => request<unknown>(bff(`admin/users/${id}/enable`), { method: 'POST' }),
  logoutUser: (id: number) => request<null>(bff(`admin/users/${id}/logout`), { method: 'POST' }),
  resetPassword: (id: number, newPassword: string) =>
    request<null>(bff(`admin/users/${id}/reset-password`), { method: 'POST', body: { newPassword } }),
  setAdmin: (id: number, isAdmin: boolean) =>
    request<unknown>(bff(`admin/users/${id}`), { method: 'PATCH', body: { isAdmin } }),
  deleteUser: (id: number) => request<null>(bff(`admin/users/${id}`), { method: 'DELETE' }),

  households: async (q: string) =>
    listOf(
      await request<unknown>(`${bff('admin/households')}${query({ q: q.replace(/^#/, ''), limit: 20 })}`),
      'households',
    ).map(
      (h): AdminHousehold => ({
        id: num(h.id),
        name: str(h.name) ?? '',
        memberCount: num(h.memberCount ?? 0) || 0,
        ownerEmail: str(h.ownerEmail),
      }),
    ),

  devices: async (p: AdminListParams & { status?: AdminDeviceStatus } = {}): Promise<Paged<AdminDevice>> => {
    const raw = await request<Loose>(`${bff('admin/devices')}${query({ ...p })}`);
    return {
      items: listOf(raw, 'devices').map((d) => ({
        deviceId: str(d.deviceId) ?? '',
        friendlyName: str(d.friendlyName),
        householdId: d.householdId != null ? num(d.householdId) : null,
        householdName: str(d.householdName),
        ownerEmail: str(d.ownerEmail),
        online: d.online === true,
        isOnlineFlag: d.isOnlineFlag === true,
        lastSeenAt: str(d.lastSeenAt),
        lastConnectedAt: str(d.lastConnectedAt),
        diagnostics: d.diagnostics && typeof d.diagnostics === 'object' ? (d.diagnostics as AdminDevice['diagnostics']) : null,
        switchCount: num(d.switchCount ?? 0) || 0,
      })),
      total: num(raw?.total ?? 0) || 0,
    };
  },
  unclaimDevice: (deviceId: string) =>
    request<unknown>(bff(`admin/devices/${enc(deviceId)}/unclaim`), { method: 'POST' }),
  reassignDevice: (deviceId: string, householdId: number) =>
    request<unknown>(bff(`admin/devices/${enc(deviceId)}/reassign`), { method: 'POST', body: { householdId } }),
  resetDeviceSecret: (deviceId: string) =>
    request<{ deviceId: string; disconnected: boolean }>(bff(`admin/devices/${enc(deviceId)}/reset-secret`), {
      method: 'POST',
    }),

  activity: (before?: number | null, limit = 50) =>
    request<CursorPage<AdminActivityEntry>>(`${bff('admin/activity')}${query({ before, limit })}`),

  apiKeys: async (p: AdminListParams = {}): Promise<Paged<AdminApiKey>> => {
    const raw = await request<Loose>(`${bff('admin/api-keys')}${query({ ...p })}`);
    return {
      items: listOf(raw, 'apiKeys').map((k) => ({
        ...normalizeApiKey(k),
        userId: num(k.userId),
        userEmail: str(k.userEmail) ?? '',
        userDisabled: k.userDisabled === true,
      })),
      total: num(raw?.total ?? 0) || 0,
    };
  },
  revokeApiKey: (id: number) => request<null>(bff(`admin/api-keys/${id}`), { method: 'DELETE' }),

  audit: (before?: number | null, limit = 50) =>
    request<CursorPage<AuditEntry>>(`${bff('admin/audit')}${query({ before, limit })}`),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
