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
}

/** GET /devices → { devices: Device[] } (also the WS `snapshot` payload). */
export interface Device {
  device_id: string;
  friendly_name: string | null;
  is_online: boolean;
  last_seen_at: string | null;
  channels: DeviceChannel[];
  /**
   * NOT returned by the backend today (getHouseholdDevicesSnapshot doesn't
   * select it). When present, the overview filters devices by the selected
   * household; when absent, all devices are shown.
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
}

export interface Schedule {
  id: string | number;
  channel_idx: number;
  action: ChannelState;
  type: 'once' | 'daily' | 'weekly' | 'countdown' | 'sunrise' | 'sunset' | string;
  enabled: boolean;
  time?: string;
  days?: number[];
  duration_s?: number;
  solar_offset_min?: number;
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
export interface AdminStats {
  users: { total: number; admins: number; disabled: number };
  devices: { total: number; online: number; claimed: number; unclaimed: number };
  activity: { last24h: number; bySource24h: Record<string, number> };
  apiKeys: { active: number };
  hooks: { active: number };
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
