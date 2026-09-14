import { verifyAccessToken } from '../auth/tokens.js';
import { pool } from '../db/pool.js';
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

export function handleClientConnection(ws, userId) {
  registerClient(userId, ws);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
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
    if (match && body?.state) {
      noteExpectedStateChange(deviceId, Number(match[1]), body.state, {
        source: msg.source ?? 'app',
        actorUserId: userId,
      });
    }
    relayToDevice(deviceId, { method, path, body }, ws, reqId);
  });

  ws.on('close', () => unregisterClient(userId, ws));
}
