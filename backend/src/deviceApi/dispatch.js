import { checkChannelCommand, guardRestResponse } from '../safety/guard.js';
import { relayCommand } from '../ws/registry.js';
import { getChannels } from './channels.js';
import { getConfig, getInfo } from './info.js';
import { deleteSchedule, upsertSchedule } from './schedules.js';
import { setSettings, setTimezone } from './settings.js';
import { deleteSwitch, upsertSwitch } from './switches.js';

const SWITCH_PATH = /^\/api\/switches\/(\d+)$/;
const SCHEDULE_PATH = /^\/api\/schedules\/([^/]+)$/;
const CHANNEL_STATE_PATH = /^\/api\/channels\/(\d+)\/state$/;

/**
 * `POST /api/channels/{idx}/state`, but only the device-forwarded-LAN-
 * request direction (see dispatchDeviceApi's doc comment). The device that
 * forwarded this request already holds the command in hand and will apply
 * `channelControlSetState()` itself once it sees our 2xx reply
 * (docs/plan.md's firmware section: "applies it locally ... before
 * replying to the LAN caller"). Relaying it back down via
 * `deviceApi.setChannelState()`/`relayCommand` here would be a redundant,
 * and potentially confusing, second round trip to the very socket that
 * just asked — the backend's job on THIS path is authorize + validate
 * only, not push. The resulting `state_changed` echo the device emits
 * after applying it falls back to `source: 'device'` attribution
 * (ws/attribution.js has no pending note for it), which is the correct
 * read here — it plausibly came from something on the device's own LAN.
 */
async function authorizeChannelStateFromDevice(deviceId, channelIdx, body) {
  const state = body?.state;
  if (!Number.isInteger(channelIdx) || channelIdx < 0 || (state !== 'ON' && state !== 'OFF')) {
    return { status: 400, body: { error: 'channel_idx and state ("ON"|"OFF") are required' } };
  }
  // A LAN request is still a remote command (not a physical press): the
  // switch lock / min-off rules apply exactly as on the cloud relay. The
  // device only applies the command on a 2xx.
  const block = await checkChannelCommand(deviceId, channelIdx, state);
  if (block) {
    return guardRestResponse(block);
  }
  return { status: 200, body: { channel_idx: channelIdx, state } };
}

/** `POST /api/network` — genuinely device-local network reconfiguration
 * (static IP / DHCP), not business logic. Per docs/plan.md, this is the
 * one path `dispatchDeviceApi` does NOT implement server-side — it relays
 * straight through via the same `relayCommand` primitive every other
 * backend-initiated actuation uses. In practice a LAN caller's own network
 * request is expected to be handled entirely on-device (it can't depend on
 * the cloud link it's trying to establish), so this branch mainly exists
 * for dispatchDeviceApi's other stated caller — a future first-party
 * dashboard REST route reusing the same dispatch table. */
async function relayNetworkConfig(deviceId, body) {
  try {
    return await relayCommand(deviceId, { method: 'POST', path: '/api/network', body });
  } catch (err) {
    if (err.code === 'device_offline') return { status: 503, body: { error: 'device_offline' } };
    if (err.code === 'device_timeout') return { status: 504, body: { error: 'device_timeout' } };
    throw err;
  }
}

// Judgment call (see report): the old firmware's one password/local-auth
// concept has no server-side equivalent now that there's no local LAN
// state to gate (docs/plan.md's own assumption: "No local password/auth
// check on the LAN API"). Rather than a bare 404 (indistinguishable from
// "unknown path"), this path answers explicitly with 410 Gone, so the
// still-unmodified app's `setPassword()` call fails with a clear, specific
// reason instead of a generic not-found.
const PASSWORD_ROUTE_REMOVED_RESPONSE = {
  status: 410,
  body: {
    error: 'device_password_removed',
    message:
      'Local device passwords are no longer supported — access is controlled by your account login instead.',
  },
};

/**
 * The server-side reimplementation of the old firmware's `http_api.cpp`
 * dispatch table (docs/firmware-esp8266.md §7's registered-handlers list).
 * Two callers, per docs/plan.md: `ws/deviceServer.js`'s new branch for a
 * device-initiated `{reqId, method, path, body}` forward (a LAN caller hit
 * the device's own HTTP API, which forwards it here to decide), and,
 * later, a first-party dashboard's own REST routes calling this directly.
 *
 * Always resolves to `{status, body}` — callers reply/render that
 * directly, mirroring how each old firmware handler produced its own
 * status+body. `actorUserId` (optional) is the user behind the request
 * when known (client WS / REST relay) — recorded as `locked_by`.
 */
export async function dispatchDeviceApi(deviceId, method, path, body, { actorUserId = null } = {}) {
  try {
    if (method === 'GET' && path === '/api/info') {
      return await getInfo(deviceId);
    }
    if (method === 'GET' && path === '/api/config') {
      return await getConfig(deviceId);
    }
    if (method === 'POST' && path === '/api/switches') {
      return await upsertSwitch(deviceId, body, { actorUserId });
    }
    if (method === 'GET' && path === '/api/channels') {
      return await getChannels(deviceId);
    }
    if (method === 'POST' && path === '/api/schedules') {
      return await upsertSchedule(deviceId, body);
    }
    if (method === 'POST' && path === '/api/timezone') {
      return await setTimezone(deviceId, body);
    }
    if (method === 'POST' && path === '/api/settings') {
      return await setSettings(deviceId, body);
    }
    if (method === 'POST' && path === '/api/network') {
      return await relayNetworkConfig(deviceId, body);
    }
    if (method === 'POST' && path === '/api/auth/password') {
      return PASSWORD_ROUTE_REMOVED_RESPONSE;
    }

    if (method === 'POST') {
      const channelMatch = path.match(CHANNEL_STATE_PATH);
      if (channelMatch) {
        return await authorizeChannelStateFromDevice(deviceId, Number(channelMatch[1]), body);
      }
    }

    if (method === 'DELETE') {
      const switchMatch = path.match(SWITCH_PATH);
      if (switchMatch) {
        return await deleteSwitch(deviceId, Number(switchMatch[1]));
      }
      const scheduleMatch = path.match(SCHEDULE_PATH);
      if (scheduleMatch) {
        return await deleteSchedule(deviceId, scheduleMatch[1]);
      }
    }

    return { status: 404, body: { error: 'not_found' } };
  } catch (err) {
    console.error(`dispatchDeviceApi failed for ${deviceId} ${method} ${path}`, err);
    return { status: 500, body: { error: 'internal_error' } };
  }
}
