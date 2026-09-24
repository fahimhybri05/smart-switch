import { verifyAccessToken } from '../auth/tokens.js';
import { getHouseholdDevicesSnapshot } from '../db/devices.js';
import { getUserHouseholdIds } from '../db/households.js';
import { pool } from '../db/pool.js';
import { dispatchDeviceApi } from '../deviceApi/index.js';
import { noteExpectedStateChange } from './attribution.js';
import { isDeviceOnline, registerClient, relayToDevice, unregisterClient } from './registry.js';

const CHANNEL_STATE_PATH = /^\/api\/channels\/(\d+)\/state$/;

/** Returns the userId for a valid access token in the connection URL's
 * `?token=` query param, or null. Browsers' WebSocket API can't set
 * custom headers, so the token travels as a query param here instead of
 * the `Authorization` header `requireAuth` uses for plain REST calls. */
export function authenticateClientUpgrade(requestUrl) {
  const token = new URL(requestUrl, 'http://internal').searchParams.get('token');
  if (!token) {
    return null;
  }
  try {
    return Number(verifyAccessToken(token).sub);
  } catch {
    return null;
  }
}

async function isOwnedByUser(deviceId, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM devices d
     JOIN household_members hm ON hm.household_id = d.household_id
     WHERE d.device_id = $1 AND hm.user_id = $2`,
    [deviceId, userId],
  );
  return rows.length > 0;
}

/** Sends the connecting user's current device list right away, so a
 * WS-connected client has a baseline even if the REST `GET /devices` call
 * (the other source of this data) is momentarily slow. Never allowed to
 * throw/crash the connection — worst case, no snapshot arrives and the
 * client falls back to REST-only, which is today's status quo anyway. */
async function sendInitialSnapshot(ws, userId) {
  try {
    const householdIds = await getUserHouseholdIds(userId);
    const devices = await getHouseholdDevicesSnapshot(householdIds);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ event: 'snapshot', devices }));
    }
  } catch (err) {
    console.error(`failed to send initial device snapshot to user ${userId}`, err);
  }
}

export function handleClientConnection(ws, userId) {
  registerClient(userId, ws);
  sendInitialSnapshot(ws, userId);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    try {
      const { reqId, deviceId, method, path, body } = msg;
      if (!reqId || !deviceId || !method || !path) {
        return;
      }

      if (!(await isOwnedByUser(deviceId, userId))) {
        return ws.send(JSON.stringify({ reqId, status: 0, error: 'not_found' }));
      }
      if (!isDeviceOnline(deviceId)) {
        return ws.send(JSON.stringify({ reqId, status: 0, error: 'device_offline' }));
      }
      // msg.source is a new optional, self-reported, trusted-not-verified
      // field the app sets to 'group'/'scene' when it knows the semantic
      // origin of a relayed command — informational only for activity
      // history, not a security boundary. See docs/plan.md.
      const match = typeof path === 'string' && path.match(CHANNEL_STATE_PATH);
      if (!match || method !== 'POST') {
        // Everything except actuation is answered by the backend itself —
        // the device holds no config to answer it from.
        const { status, body: respBody } = await dispatchDeviceApi(deviceId, method, path, body, {
          actorUserId: userId,
        });
        return ws.send(JSON.stringify({ reqId, status, body: respBody }));
      }
      if (body?.state) {
        noteExpectedStateChange(deviceId, Number(match[1]), body.state, {
          source: msg.source ?? 'app',
          actorUserId: userId,
        });
      }
      // Switch lock / min-off rules are enforced inside relayToDevice
      // (safety/guard.js), which replies {reqId, status: 0, error} itself.
      relayToDevice(deviceId, { method, path, body }, ws, reqId);
    } catch (err) {
      // Express-async-errors doesn't cover WS event handlers — an unhandled
      // rejection here would otherwise crash the whole process (see
      // server.js's process-level safety net for the last-resort backstop).
      console.error(`client message handler failed for user ${userId}`, err);
    }
  });

  ws.on('close', () => unregisterClient(userId, ws));
}
