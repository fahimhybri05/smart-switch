import crypto from 'node:crypto';

import { getHouseholdMemberIds } from '../db/households.js';

/** deviceId -> WebSocket (one live connection per device, the newest wins). */
const deviceSockets = new Map();

/** userId -> Set<WebSocket> (every open dashboard/app connection for that user). */
const clientSocketsByUser = new Map();

/** internal device-facing reqId -> { clientWs, clientReqId, timeout } */
const pendingRequests = new Map();

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
    const timeout = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(Object.assign(new Error('device_timeout'), { code: 'device_timeout' }));
    }, RELAY_TIMEOUT_MS);

    pendingRequests.set(reqId, {
      resolve: (status, respBody) => {
        clearTimeout(timeout);
        pendingRequests.delete(reqId);
        resolve({ status, body: respBody });
      },
    });

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

/** Called from deviceServer.js when a device replies `{reqId, status, body}`. */
export function resolveDeviceResponse(reqId, status, body) {
  const pending = pendingRequests.get(reqId);
  if (!pending) {
    return; // already timed out, or an unsolicited/unknown reqId
  }
  pending.resolve(status, body);
}
