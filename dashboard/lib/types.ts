/**
 * Wire types for the backend, as seen through the BFF (/api/bff/* is a
 * transparent proxy). If a backend shape changes, adjust it here and in the
 * matching normaliser in lib/api.ts — nothing else should parse raw JSON.
 */

/* ----------------------------- Auth / profile ---------------------------- */

export type Role = 'owner' | 'member';

/** GET /auth/me (normalised). */
export interface Me {
  id: number;
  email: string;
  createdAt: string | null;
  /** Admin role flag (backend re-checks it on every /admin call). */
  isAdmin: boolean;
  households: { id: number; name: string; role: Role }[];
}

/* -------------------------------- Devices -------------------------------- */

export type ChannelState = 'ON' | 'OFF';

/** One row of cached_channel_state, as returned inside GET /devices. */
export interface DeviceChannel {
  channelIdx: number;
  name: string | null;
  zone: string | null;
  state: string | null;
  updatedAt: string | null;
  /** Switch lock (device_switches.locked_at set) — remote commands are refused. */
  locked?: boolean;
  /** When the channel last actually changed state (ISO), if known. */
  stateSince?: string | null;
}

/** GET /devices → { devices: Device[] } (also the WS `snapshot` payload). */
export interface Device {
  device_id: string;
  friendly_name: string | null;
  is_online: boolean;
  last_seen_at: string | null;
  channels: DeviceChannel[];
  /**
   * Selected by getHouseholdDevicesSnapshot (GET /devices and the WS
   * snapshot). Pages filter devices by the selected household when present;
   * when absent, all devices are shown.
   */
  household_id?: number | null;
}

export type InputMode = 'DISABLED' | 'TOGGLE' | 'EDGE';

/** One entry of DeviceConfig.switches (device_switches row). */
export interface SwitchConfig {
  channel_idx: number;
  name: string;
  zone: string;
  type: string;
  default_boot_state: ChannelState;
  input_mode: InputMode;
  inching_ms: number;
  /** Rated power draw; enables kWh estimates. null = unknown. */
  watts: number | null;
  /** Safety: auto-OFF after this long ON. null = off. */
  max_on_s: number | null;
  /** Safety: must stay OFF this long before a new ON. null = off. */
  min_off_s: number | null;
  /** Remote control blocked (app, schedules, automations, scenes, API, groups). */
  locked: boolean;
  locked_at: string | null;
}

export type ScheduleType = 'once' | 'daily' | 'weekly' | 'countdown' | 'sunrise' | 'sunset';

/**
 * One device schedule — backend/src/deviceApi/schedules.js rowToScheduleWire
 * (same shape as the app's Schedule.fromJson). Optional fields are present
 * only when meaningful for `type`: time for once/daily/weekly, days for
 * weekly, duration_s for countdown, solar_offset_min for sunrise/sunset.
 */
export interface Schedule {
  id: string;
  channel_idx: number;
  action: ChannelState;
  type: ScheduleType;
  enabled: boolean;
  /** "HH:MM" in the device's local time (DeviceConfig.utc_offset_min). */
  time?: string;
  /** 1=Mon..7=Sun. */
  days?: number[];
  duration_s?: number;
  solar_offset_min?: number;
}

/**
 * POST /devices/:id/schedules body. No `id` creates (backend assigns
 * "s-<n>"); an existing `id` updates (404 if unknown — not an upsert by
 * caller-chosen id). Countdowns arm on create and on a disabled→enabled edit.
 */
export interface ScheduleInput {
  id?: string;
  channel_idx: number;
  action: ChannelState;
  type: ScheduleType;
  enabled: boolean;
  time?: string;
  days?: number[];
  duration_s?: number;
  solar_offset_min?: number;
}

/** PATCH /devices/:id/settings response (setSettings). */
export interface DeviceSettings {
  interlock_enabled: boolean;
  latitude: number | null;
  longitude: number | null;
  location_set: boolean;
}

/** GET /devices/:id/config — backend/src/deviceApi/info.js getConfig(). */
export interface DeviceConfig {
  device_id: string;
  name: string;
  board_type: string;
  channel_count: number;
  channel_driver: string;
  fw_version: string;
  switches: SwitchConfig[];
  schedules: Schedule[];
  utc_offset_min: number;
  interlock_enabled: boolean;
  latitude: number | null;
  longitude: number | null;
  location_set: boolean;
  /** Live connection state of the device (added by the dashboard-era backend). */
  online?: boolean;
}

/** PATCH /devices/:id/switches/:idx body — every field optional (merge on the backend). */
export interface SwitchPatch {
  name?: string;
  zone?: string;
  defaultBootState?: ChannelState;
  inputMode?: InputMode;
  inchingMs?: number;
  /** null clears. */
  watts?: number | null;
  /** null clears (no max run time). */
  maxOnSeconds?: number | null;
  /** null clears (no min off time). */
  minOffSeconds?: number | null;
  locked?: boolean;
}

/** POST /devices/:id/command response: the device's own {status, body}. */
export interface CommandResult {
  status: number;
  body: unknown;
}

/** UI model: one physical switch = device channel merged with its config. */
export interface SwitchView {
  /** Public API switch id: "<deviceId>:<channel>". */
  id: string;
  deviceId: string;
  deviceName: string;
  channelIdx: number;
  name: string;
  zone: string;
  state: ChannelState | null;
  online: boolean;
  updatedAt: string | null;
  /** From the /devices snapshot channel, falling back to the switch config. */
  locked: boolean;
  config: SwitchConfig | null;
}

/* ------------------------------- Households ------------------------------ */

export interface HouseholdMember {
  userId: number;
  email: string;
  role: Role;
}

/** GET /households → { households: Household[] } */
export interface Household {
  id: number;
  name: string;
  timezone: string | null;
  members: HouseholdMember[];
  role: Role;
}

/** GET /households/invites → { invites: IncomingInvite[] } (invites sent TO me). */
export interface IncomingInvite {
  id: number;
  householdId: number;
  householdName: string;
  invitedByEmail: string;
}

/** GET /households/:id/invites → { invites } — pending invites a household has sent (normalised). */
export interface OutgoingInvite {
  id: number;
  invitedUserId: number | null;
  email: string;
  createdAt: string | null;
  invitedByEmail: string | null;
}

/* --------------------------------- Groups -------------------------------- */

/** One switch reference inside a group (or an automation). */
export interface SwitchRef {
  deviceId: string;
  channelIdx: number;
}

/** GET /groups → { groups: Group[] } (backend/src/routes/groups.js). */
export interface Group {
  id: number;
  /** Returned by the backend since the dashboard groups page; null on older backends. */
  householdId: number | null;
  name: string;
  members: SwitchRef[];
}

/** POST /groups body: no `id` creates, `id` replaces name + the full member list. */
export interface GroupInput {
  id?: number;
  householdId?: number;
  name: string;
  members: SwitchRef[];
}

/* ------------------------------ Automations ------------------------------ */

export type AutomationTrigger =
  /** Household-local time (households.timezone) on each of `days` (1=Mon..7=Sun). */
  | { type: 'schedule'; days: number[]; time: string }
  /** Fires when that channel changes to `state`. */
  | { type: 'state'; deviceId: string; channelIdx: number; state: ChannelState };

export interface AutomationAction extends SwitchRef {
  state: ChannelState;
}

/** GET /automations → { automations: Automation[] } (routes/automations.js rowToAutomation). */
export interface Automation {
  id: number;
  householdId: number;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
  lastFiredAt: string | null;
}

/** POST /automations body — owner-only; no `id` creates, `id` replaces the whole rule. */
export interface AutomationInput {
  id?: number;
  householdId?: number;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
}

/* --------------------------------- Scenes -------------------------------- */

/** Icon keys the app and the dashboard agree on (free text on the wire). */
export type SceneIcon = 'moon' | 'sun' | 'home' | 'away' | 'movie' | 'power' | 'leaf' | 'droplet';

export type SceneAction = AutomationAction;

/** GET /scenes → { scenes: Scene[] } */
export interface Scene {
  id: number;
  householdId: number | null;
  name: string;
  /** One of SceneIcon, or any other string from a newer client (rendered as a fallback). */
  icon: string | null;
  actions: SceneAction[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** POST /scenes body — upsert like groups (no `id` creates). Max 64 actions. */
export interface SceneInput {
  id?: number;
  householdId?: number;
  name: string;
  icon?: string | null;
  actions: SceneAction[];
}

/** One action's outcome in POST /scenes/:id/run. */
export interface SceneRunResultItem extends SceneAction {
  ok: boolean;
  /** Machine code (switch_locked, min_off_time, device_offline, …). */
  error?: string | null;
  retryAfterSeconds?: number | null;
}

/** POST /scenes/:id/run */
export interface SceneRunResult {
  results: SceneRunResultItem[];
  succeeded: number;
  failed: number;
}

/* ---------------------------------- Usage -------------------------------- */

export interface SwitchUsage {
  channelIdx: number;
  name: string;
  watts: number | null;
  /** Seconds ON per entry of `days`. */
  dailyOnSeconds: number[];
  totalOnSeconds: number;
  /** null when watts isn't set. */
  kwh: number | null;
}

/** GET /devices/:id/usage?days= */
export interface DeviceUsage {
  timezone: string;
  /** "YYYY-MM-DD" in the household timezone, oldest first. */
  days: string[];
  switches: SwitchUsage[];
}

export interface HouseholdSwitchUsage extends SwitchUsage {
  deviceId: string;
  deviceName: string;
}

/** GET /usage?householdId=&days= */
export interface HouseholdUsage {
  timezone: string;
  days: string[];
  switches: HouseholdSwitchUsage[];
  totals: { onSeconds: number; kwh: number | null };
}

/* -------------------------------- Activity ------------------------------- */

export type ActivitySource =
  | 'app'
  | 'widget'
  | 'group'
  | 'scene'
  | 'automation'
  | 'device'
  | 'api'
  | 'hook'
  | 'dashboard'
  | 'safety'
  | (string & {});

export interface ActivityEntry {
  id: number;
  deviceId: string;
  deviceFriendlyName: string | null;
  channelIdx: number;
  state: string;
  source: ActivitySource;
  actorEmail: string | null;
  automationId: number | null;
  createdAt: string;
}

/** GET /activity?householdId=&before=&limit= */
export interface ActivityPage {
  entries: ActivityEntry[];
  nextCursor: number | null;
}

/* ------------------------------ Integrations ----------------------------- */

/** GET /api-keys → { apiKeys: ApiKey[] } (active keys only). */
export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  hookCount: number;
}

/** POST /api-keys → 201, flat: the key fields plus `secret` (shown exactly once). */
export interface CreatedApiKey extends ApiKey {
  secret: string;
}

/** GET /hooks → { hooks: Hook[] } */
export interface Hook {
  id: number;
  apiKeyId: number;
  apiKeyName: string | null;
  /** "<deviceId>:<channel>" */
  switchId: string;
  deviceId: string;
  channel: number;
  name: string | null;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface HookUrls {
  on: string;
  off: string;
  toggle: string;
  status: string;
}

/** POST /hooks → 201, flat: the hook fields plus `token` and `urls` (shown exactly once). */
export interface CreatedHook extends Hook {
  token: string;
  urls: HookUrls;
}

/* ---------------------------------- Admin -------------------------------- */

/** GET /admin/stats */
export interface AdminDeviceAttention {
  deviceId: string;
  name: string | null;
  household: string | null;
  lastSeenAt: string | null;
  rssi: number | null;
}

export interface AdminStats {
  users: { total: number; admins: number; disabled: number };
  devices: { total: number; online: number; claimed: number; unclaimed: number };
  activity: { last24h: number; bySource24h: Record<string, number> };
  apiKeys: { active: number };
  hooks: { active: number };
  // Detail sections — optional so an older backend still renders the basics.
  growth?: { usersNew7d: number; usersNew30d: number; usersActive24h: number; usersActive7d: number; devicesNew7d: number };
  households?: { total: number; withoutDevices: number; pendingInvites: number };
  switches?: { total: number; on: number; locked: number; withSafetyRules: number; metered: number };
  automation?: {
    schedules: number;
    schedulesEnabled: number;
    automations: number;
    automationsEnabled: number;
    groups: number;
    scenes: number;
    safetyAutoOff24h: number;
  };
  trends?: {
    activity7d: number;
    daily: { day: string; activity: number; signups: number }[];
    hourly24h: { hour: string; count: number }[];
    topDevices7d: { deviceId: string; name: string | null; count: number }[];
  };
  attention?: {
    offlineClaimed: number;
    offlineDevices: AdminDeviceAttention[];
    weakSignal: AdminDeviceAttention[];
    firmware: { version: string; count: number }[];
  };
  recentUsers?: { id: number; email: string; createdAt: string; isAdmin: boolean }[];
  system?: {
    version: string | null;
    node: string;
    uptimeS: number;
    memoryRssBytes: number;
    heapUsedBytes: number;
    dbBytes: number;
    dbQueryMs: number;
    clients: { users: number; sockets: number };
    serverTime: string;
  };
}

/** One row of GET /admin/users → { users, total }. */
export interface AdminUser {
  id: number;
  email: string;
  createdAt: string | null;
  isAdmin: boolean;
  disabledAt: string | null;
  householdCount: number;
  deviceCount: number;
  apiKeyCount: number;
  lastActiveAt: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

/** GET /admin/users/:id */
export interface AdminUserDetail extends AdminUser {
  households: { id: number; name: string; role: Role }[];
  devices: { deviceId: string; friendlyName: string | null; householdId: number | null; online: boolean }[];
  apiKeys: ApiKey[];
}

/** Firmware diagnostics from the device's last auth frame (all optional). */
export interface DeviceDiagnostics {
  fw?: string | number;
  resetReason?: string | number;
  uptimeS?: number | string;
  freeHeap?: number | string;
  rssi?: number | string;
  at?: string;
}

export type AdminDeviceStatus = 'online' | 'offline' | 'unclaimed';

/** One row of GET /admin/devices → { devices, total }. */
export interface AdminDevice {
  deviceId: string;
  friendlyName: string | null;
  householdId: number | null;
  householdName: string | null;
  ownerEmail: string | null;
  /** Live socket registry — the source of truth. */
  online: boolean;
  /** devices.is_online column (can lag after a crash). */
  isOnlineFlag: boolean;
  lastSeenAt: string | null;
  lastConnectedAt: string | null;
  diagnostics: DeviceDiagnostics | null;
  switchCount: number;
}

/** GET /admin/households → { households } (reassign picker). */
export interface AdminHousehold {
  id: number;
  name: string;
  memberCount: number;
  ownerEmail: string | null;
}

/** GET /admin/activity → { entries, nextCursor } */
export interface AdminActivityEntry extends ActivityEntry {
  householdId: number | null;
  householdName: string | null;
}

export interface CursorPage<T> {
  entries: T[];
  nextCursor: number | null;
}

/** GET /admin/api-keys → { apiKeys, total } */
export interface AdminApiKey extends ApiKey {
  userId: number;
  userEmail: string;
  userDisabled: boolean;
}

/** GET /admin/audit → { entries, nextCursor } */
export interface AuditEntry {
  id: number;
  adminUserId: number | null;
  adminEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

/* ---------------------------------- Live --------------------------------- */

/** Messages on the backend client WebSocket (backend/src/ws/*). */
export type LiveEvent =
  | { event: 'snapshot'; devices: Device[] }
  | { event: 'state_changed'; deviceId: string; channelIdx: number; state: string }
  | { event: 'device_online'; deviceId: string }
  | { event: 'device_offline'; deviceId: string };
