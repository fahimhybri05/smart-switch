import crypto from 'node:crypto';

import { getHouseholdMemberIds } from '../db/households.js';

/** deviceId -> WebSocket (one live connection per device, the newest wins). */
const deviceSockets = new Map();

/** userId -> Set<WebSocket> (every open dashboard/app connection for that user). */
const clientSocketsByUser = new Map();

/** internal device-facing reqId -> { resolve, deviceId, timeout } */
const pendingRequests = new Map();

/** deviceId -> Set<reqId> — lets a device's disconnect immediately settle
 * every request still in flight to it, instead of leaving each one to sit
 * out the full RELAY_TIMEOUT_MS. */
const pendingReqIdsByDevice = new Map();

const RELAY_TIMEOUT_MS = 10_000;

export function registerDevice(deviceId, ws) {
  const existing = deviceSockets.get(deviceId);
  if (existing && existing !== ws) {
    existing.close(4000, 'superseded by a new connection');
  }
  deviceSockets.set(deviceId, ws);
}

export function unregisterDevice(deviceId, ws) {
  if (deviceSockets.get(deviceId) === ws) {
    deviceSockets.delete(deviceId);
  }
}

export function isDeviceOnline(deviceId) {
  return deviceSockets.has(deviceId);
}

/** Every currently-registered device WebSocket — used by the heartbeat
 * interval in deviceServer.js to ping/terminate dead connections. */
export function getDeviceSockets() {
  return deviceSockets.values();
}

export function registerClient(userId, ws) {
  if (!clientSocketsByUser.has(userId)) {
    clientSocketsByUser.set(userId, new Set());
  }
  clientSocketsByUser.get(userId).add(ws);
}

export function unregisterClient(userId, ws) {
  clientSocketsByUser.get(userId)?.delete(ws);
}

/** Sends `payload` to every open client connection for `userId`. */
export function broadcastToUser(userId, payload) {
  const sockets = clientSocketsByUser.get(userId);
  if (!sockets) {
    return;
  }
  const json = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(json);
    }
  }
}

/** Sends `payload` to every open client connection for every member of `householdId`. */
export async function broadcastToHousehold(householdId, payload) {
  for (const userId of await getHouseholdMemberIds(householdId)) {
    broadcastToUser(userId, payload);
  }
}

/**
 * Sends `{method, path, body}` to `deviceId` and settles a Promise with
 * the device's `{status, body}` response, or rejects with a `.code`-tagged
 * Error (`device_offline`/`device_timeout`) — the one real primitive every
 * relay path (client WS, automations, the REST relay endpoint) builds on.
 */
function sendRelay(deviceId, { method, path, body }) {
  const deviceWs = deviceSockets.get(deviceId);
  if (!deviceWs || deviceWs.readyState !== deviceWs.OPEN) {
    return null;
  }

  const reqId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      pendingRequests.delete(reqId);
      pendingReqIdsByDevice.get(deviceId)?.delete(reqId);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error('device_timeout'), { code: 'device_timeout' }));
    }, RELAY_TIMEOUT_MS);

    pendingRequests.set(reqId, {
      deviceId,
      reject: (err) => {
        clearTimeout(timeout);
        cleanup();
        reject(err);
      },
      resolve: (status, respBody) => {
        clearTimeout(timeout);
        cleanup();
        resolve({ status, body: respBody });
      },
    });
    if (!pendingReqIdsByDevice.has(deviceId)) {
      pendingReqIdsByDevice.set(deviceId, new Set());
    }
    pendingReqIdsByDevice.get(deviceId).add(reqId);

    deviceWs.send(JSON.stringify({ reqId, method, path, body }));
  });
}

/**
 * Relays a command and resolves with the device's `{status, body}`
 * response. Used by the automation engine and the REST relay endpoint
 * (`POST /devices/:deviceId/command`) — anything without a persistent
 * client WS to route a reply back through.
 */
export async function relayCommand(deviceId, { method, path, body }) {
  const promise = sendRelay(deviceId, { method, path, body });
  if (!promise) {
    throw Object.assign(new Error('device_offline'), { code: 'device_offline' });
  }
  return promise;
}

/**
 * Same relay, routed back to a specific client WS connection instead of
 * returned as a Promise — what `clientServer.js`'s message handler uses.
 * Sends `{reqId: clientReqId, status: 0, error: 'device_offline'|'device_timeout'}`
 * on failure, matching the wire shape clients have always gotten.
 */
export function relayToDevice(deviceId, { method, path, body }, clientWs, clientReqId) {
  const promise = sendRelay(deviceId, { method, path, body });
  if (!promise) {
    clientWs?.send(JSON.stringify({ reqId: clientReqId, status: 0, error: 'device_offline' }));
    return;
  }
  promise
    .then(({ status, body: respBody }) => {
      clientWs?.send(JSON.stringify({ reqId: clientReqId, status, body: respBody }));
    })
    .catch((err) => {
      clientWs?.send(JSON.stringify({ reqId: clientReqId, status: 0, error: err.code ?? 'device_timeout' }));
    });
}

/**
 * Fire-and-forget push of `{event: "hw_config_push", channels,
 * interlockEnabled}` down to `deviceId` — no reqId, no response expected,
 * the same one-way shape as the device's own unsolicited `state_changed`
 * event, just in the opposite direction. This is the one config the
 * trimmed-down firmware still caches locally (per-channel input mode/
 * inching duration, plus the device-wide interlock flag), needed for the
 * instant/offline physical-input exception to behave correctly. Sent once
 * right after auth on every connect and again whenever an admin edits one
 * of these fields (see deviceApi/hwConfig.js's pushHwConfigToDevice,
 * the only caller). Silently a no-op if the device isn't currently
 * connected — nothing to queue, since the device gets the full picture
 * again in full on its next reconnect.
 */
export function sendHwConfigPush(deviceId, { channels, interlockEnabled }) {
  const deviceWs = deviceSockets.get(deviceId);
  if (!deviceWs || deviceWs.readyState !== deviceWs.OPEN) {
    return;
  }
  deviceWs.send(JSON.stringify({ event: 'hw_config_push', channels, interlockEnabled }));
}

/** Called from deviceServer.js when a device replies `{reqId, status, body}`. */
export function resolveDeviceResponse(reqId, status, body) {
  const pending = pendingRequests.get(reqId);
  if (!pending) {
    return; // already timed out, or an unsolicited/unknown reqId
  }
  pending.resolve(status, body);
}

/**
 * Immediately rejects every request still in flight to `deviceId` with the
 * same `device_offline`-coded error `sendRelay`'s no-connection path uses,
 * clearing each one's timeout — called right after `unregisterDevice` when
 * a device's socket drops, so an in-flight command fails fast instead of
 * sitting out the full RELAY_TIMEOUT_MS.
 */
export function rejectPendingForDevice(deviceId) {
  const reqIds = pendingReqIdsByDevice.get(deviceId);
  if (!reqIds) {
    return;
  }
  for (const reqId of [...reqIds]) {
    const pending = pendingRequests.get(reqId);
    pending?.reject(Object.assign(new Error('device_offline'), { code: 'device_offline' }));
  }
  pendingReqIdsByDevice.delete(deviceId);
}
