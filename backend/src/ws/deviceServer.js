import { logActivity } from '../activity.js';
import { evaluateStateTriggeredAutomations } from '../automations/engine.js';
import { hashDeviceSecret } from '../auth/deviceSecret.js';
import { dispatchDeviceApi, ensureDeviceDefaults, pushHwConfigToDevice } from '../deviceApi/index.js';
import { pool } from '../db/pool.js';
import { takeAttribution } from './attribution.js';
import {
  broadcastToHousehold,
  getDeviceSockets,
  isDeviceOnline,
  registerDevice,
  rejectPendingForDevice,
  resolveDeviceResponse,
  unregisterDevice,
} from './registry.js';

const AUTH_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

const DIAG_KEYS = ['fw', 'resetReason', 'uptimeS', 'freeHeap', 'rssi'];

/**
 * Firmware diagnostics from the auth frame's optional fields (older
 * firmware omits them), sanitized for storage in devices.diagnostics:
 * numbers stay numbers, anything else becomes a short string. Returns
 * null when the frame carried none of them.
 */
export function extractDiagnostics(msg) {
  const diag = {};
  for (const k of DIAG_KEYS) {
    const v = msg?.[k];
    if (v === undefined || v === null) continue;
    diag[k] = typeof v === 'number' && Number.isFinite(v) ? v : String(v).slice(0, 64);
  }
  if (Object.keys(diag).length === 0) {
    return null;
  }
  diag.at = new Date().toISOString();
  return diag;
}

/** Marks `deviceId` online (plus last_connected_at and, when present, the
 * auth frame's diagnostics) and returns its household, given a row already
 * known to exist and whose secret already matched. Single unlocked
 * statement — no held client checkout, no transaction — this is the hot
 * path for the routine "already-claimed device reconnecting" case. */
async function markExistingDeviceOnline(deviceId, householdId, diagnostics) {
  await pool.query(
    `UPDATE devices
     SET is_online = true, last_seen_at = now(), last_connected_at = now(),
         diagnostics = COALESCE($2::jsonb, diagnostics)
     WHERE device_id = $1`,
    [deviceId, diagnostics ? JSON.stringify(diagnostics) : null],
  );
  return { householdId };
}

/** Looks up (or trust-on-first-use creates) the device row, verifying the
 * presented secret against whatever hash is already stored. Mirrors
 * routes/devices.js's claim logic so it doesn't matter whether the device
 * or the claiming app connects/registers first. A row whose hash is NULL
 * (an admin ran "reset secret", e.g. after a factory reset generated a new
 * secret on the device) adopts the presented secret — trust-on-next-use,
 * the same trust model as the first-ever connect. */
export async function authenticateDevice(deviceId, cloudSecret, diagnostics = null) {
  const secretHash = hashDeviceSecret(cloudSecret);

  // Plain unlocked read first — this alone resolves the common case (row
  // already exists) without ever taking a transaction or holding a
  // checked-out client across the round trip.
  const { rows } = await pool.query(
    'SELECT household_id, cloud_secret_hash FROM devices WHERE device_id = $1',
    [deviceId],
  );
  const existing = rows[0];

  if (existing) {
    if (existing.cloud_secret_hash === null) {
      return adoptSecret(deviceId, secretHash, diagnostics);
    }
    if (existing.cloud_secret_hash !== secretHash) {
      // An UNCLAIMED board presenting a different secret was almost always
      // erased/re-flashed (a fresh flash generates a new secret). Nobody owns
      // the row, so re-trusting it is the same risk as a brand-new device.
      // Claimed devices still require an exact match.
      if (existing.household_id === null) {
        return repairUnclaimed(deviceId, secretHash, diagnostics);
      }
      return null;
    }
    return markExistingDeviceOnline(deviceId, existing.household_id, diagnostics);
  }

  // First-ever-connect (trust-on-first-use): two devices with the same
  // never-before-seen deviceId could race here. Rather than holding a
  // `BEGIN ... SELECT FOR UPDATE ... COMMIT` transaction across the whole
  // auth exchange just to guard this rare path, a single atomic
  // `INSERT ... ON CONFLICT DO NOTHING RETURNING` lets exactly one racer
  // create the row — no duplicate-row risk, and the loser (if any) simply
  // falls through to re-read and validate against whatever row won,
  // identically to the "row already exists" branch above.
  const inserted = await pool.query(
    `INSERT INTO devices (device_id, cloud_secret_hash, friendly_name, is_online, last_seen_at,
                          last_connected_at, diagnostics)
     VALUES ($1, $2, $1, true, now(), now(), $3::jsonb)
     ON CONFLICT (device_id) DO NOTHING
     RETURNING household_id`,
    [deviceId, secretHash, diagnostics ? JSON.stringify(diagnostics) : null],
  );
  if (inserted.rows[0]) {
    return { householdId: inserted.rows[0].household_id };
  }

  // Lost the race — some other connection (or a concurrent /claim) won.
  // Re-read and validate exactly as the existing-row branch does.
  return revalidate(deviceId, secretHash, diagnostics);
}

/** NULL hash -> presented hash, atomically: of two racers only one UPDATE
 * matches `cloud_secret_hash IS NULL`; the other re-validates against the
 * secret that won. */
async function adoptSecret(deviceId, secretHash, diagnostics) {
  const { rows } = await pool.query(
    `UPDATE devices
     SET cloud_secret_hash = $2, is_online = true, last_seen_at = now(), last_connected_at = now(),
         diagnostics = COALESCE($3::jsonb, diagnostics)
     WHERE device_id = $1 AND cloud_secret_hash IS NULL
     RETURNING household_id`,
    [deviceId, secretHash, diagnostics ? JSON.stringify(diagnostics) : null],
  );
  if (rows[0]) {
    console.log(`device ${deviceId} adopted a new cloud secret (hash was reset)`);
    return { householdId: rows[0].household_id };
  }
  return revalidate(deviceId, secretHash, diagnostics);
}

/** Unclaimed row, new secret -> adopt it. Guarded by `household_id IS NULL`
 * so a claim that lands concurrently is never overwritten. */
async function repairUnclaimed(deviceId, secretHash, diagnostics) {
  const { rows } = await pool.query(
    `UPDATE devices
     SET cloud_secret_hash = $2, is_online = true, last_seen_at = now(), last_connected_at = now(),
         diagnostics = COALESCE($3::jsonb, diagnostics)
     WHERE device_id = $1 AND household_id IS NULL
     RETURNING household_id`,
    [deviceId, secretHash, diagnostics ? JSON.stringify(diagnostics) : null],
  );
  if (rows[0]) {
    console.log(`unclaimed device ${deviceId} re-paired with a new cloud secret`);
    return { householdId: null };
  }
  return revalidate(deviceId, secretHash, diagnostics);
}

async function revalidate(deviceId, secretHash, diagnostics) {
  const { rows } = await pool.query(
    'SELECT household_id, cloud_secret_hash FROM devices WHERE device_id = $1',
    [deviceId],
  );
  const winner = rows[0];
  if (!winner || winner.cloud_secret_hash !== secretHash) {
    return null;
  }
  return markExistingDeviceOnline(deviceId, winner.household_id, diagnostics);
}

/** Returns the device's household id (null when unclaimed). */
async function markOffline(deviceId) {
  const { rows } = await pool.query(
    'UPDATE devices SET is_online = false WHERE device_id = $1 RETURNING household_id',
    [deviceId],
  );
  return rows[0]?.household_id ?? null;
}

async function recordStateChange(deviceId, channelIdx, state) {
  const { rows } = await pool.query(
    `INSERT INTO cached_channel_state (device_id, channel_idx, state, updated_at, state_since)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (device_id, channel_idx)
     DO UPDATE SET state = EXCLUDED.state, updated_at = now(),
       -- Only a real change moves state_since (echo replays of the same
       -- state must not reset max-runtime / min-off timing).
       state_since = CASE
         WHEN cached_channel_state.state IS DISTINCT FROM EXCLUDED.state
           OR cached_channel_state.state_since IS NULL THEN now()
         ELSE cached_channel_state.state_since
       END
     RETURNING (SELECT household_id FROM devices WHERE device_id = $1) AS household_id`,
    [deviceId, channelIdx, state],
  );
  return rows[0]?.household_id ?? null;
}

export function handleDeviceConnection(ws) {
  let deviceId = null;
  let authenticated = false;

  const authTimer = setTimeout(() => {
    if (!authenticated) {
      ws.close(4001, 'auth timeout');
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames rather than tearing down the socket
    }

    try {
      if (!authenticated) {
        if (!msg.deviceId || !msg.cloudSecret) {
          return ws.close(4001, 'expected {deviceId, cloudSecret}');
        }
        try {
          const diagnostics = extractDiagnostics(msg);
          const result = await authenticateDevice(msg.deviceId, msg.cloudSecret, diagnostics);
          if (!result) {
            console.warn(`device auth rejected: invalid secret for ${msg.deviceId}`);
            return ws.close(4003, 'invalid device secret');
          }
          clearTimeout(authTimer);
          deviceId = msg.deviceId;
          authenticated = true;
          ws.isAlive = true;
          registerDevice(deviceId, ws);
          // Firmware diagnostics (optional fields; older firmware omits them).
          const diag = DIAG_KEYS.filter((k) => msg[k] !== undefined)
            .map((k) => `${k}=${JSON.stringify(msg[k])}`)
            .join(' ');
          console.log(`device connected: ${deviceId}${diag ? ` (${diag})` : ''}`);
          if (result.householdId) {
            broadcastToHousehold(result.householdId, { event: 'device_online', deviceId });
          }
          // The trimmed-down firmware holds no config of its own besides
          // this hw-actuation cache (interlock/input-mode/inching) — give
          // it the current picture on every fresh connect, same as it
          // would have loaded from its own /config.json before this
          // architecture change. Fire-and-forget; a failure here just
          // means the device keeps whatever it last cached, logged rather
          // than failing the connection.
          ensureDeviceDefaults(deviceId)
            .then(() => pushHwConfigToDevice(deviceId))
            .catch((err) => console.error(`initial hw_config_push failed for ${deviceId}`, err));
        } catch (err) {
          console.error(`device auth failed for ${msg.deviceId}`, err);
          ws.close(1011, 'internal error');
        }
        return;
      }

      // Relayed responses.
      if (msg.reqId && 'status' in msg) {
        resolveDeviceResponse(msg.reqId, msg.status, msg.body);
        return;
      }

      // Device-initiated request: a LAN caller hit the device's own local
      // HTTP API, and the device is forwarding it here (its
      // forward-and-wait) to decide, since the backend now owns every
      // /api/* decision. Distinct from the reply branch above — that one
      // matches on `'status' in msg`, this one on `method`/`path` being
      // present instead. See docs/plan.md's Wire protocol section.
      if (msg.reqId && msg.method && msg.path) {
        const { status, body: respBody } = await dispatchDeviceApi(
          deviceId,
          msg.method,
          msg.path,
          msg.body,
        );
        ws.send(JSON.stringify({ reqId: msg.reqId, status, body: respBody }));
        return;
      }

      // Unsolicited local-schedule-fired state change. This is the ONE
      // true "a channel actually changed" signal in the whole system,
      // regardless of what caused it — activity logging and (once
      // automations ships) automation-trigger evaluation both hook here.
      if (msg.event === 'state_changed' && typeof msg.channelIdx === 'number') {
        const attribution = takeAttribution(deviceId, msg.channelIdx, msg.state) ?? {
          source: 'device',
          actorUserId: null,
          automationId: null,
        };
        const { depth = 0, chainAutomationIds = new Set() } = attribution;
        const householdId = await recordStateChange(deviceId, msg.channelIdx, msg.state);
        if (householdId) {
          logActivity({
            householdId,
            deviceId,
            channelIdx: msg.channelIdx,
            state: msg.state,
            ...attribution,
          }).catch((err) => console.error('logActivity failed', err));
          broadcastToHousehold(householdId, {
            event: 'state_changed',
            deviceId,
            channelIdx: msg.channelIdx,
            state: msg.state,
          });
          evaluateStateTriggeredAutomations({
            deviceId,
            channelIdx: msg.channelIdx,
            state: msg.state,
            householdId,
            depth,
            chainAutomationIds,
          }).catch((err) => console.error('evaluateStateTriggeredAutomations failed', err));
        }
      }
    } catch (err) {
      // Express-async-errors doesn't cover WS event handlers — an unhandled
      // rejection here would otherwise crash the whole process (see
      // server.js's process-level safety net for the last-resort backstop).
      console.error(`device message handler failed for ${deviceId}`, err);
    }
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('close', (code, reason) => {
    clearTimeout(authTimer);
    if (deviceId) {
      console.log(
        `device disconnected: ${deviceId} (code=${code} reason=${reason})`,
      );
      const wasCurrent = unregisterDevice(deviceId, ws);
      // Fail any in-flight relay to this device fast instead of leaving it
      // to sit out the full RELAY_TIMEOUT_MS now that the socket is gone.
      rejectPendingForDevice(deviceId);
      // A socket superseded by a newer connection from the same device
      // (registerDevice closes the old one with 4000) must not mark the
      // device offline or tell clients it went away — it didn't.
      if (wasCurrent) {
        markOffline(deviceId)
          .then((householdId) => {
            // Skip if it already reconnected while the UPDATE ran.
            if (householdId && !isDeviceOnline(deviceId)) {
              return broadcastToHousehold(householdId, { event: 'device_offline', deviceId });
            }
            return undefined;
          })
          .catch((err) => console.error(`failed to mark ${deviceId} offline`, err));
      }
    }
  });
}

/**
 * One heartbeat tick: any device socket that didn't answer the previous
 * ping (`isAlive === false`) gets `terminate()`'d — this fires the same
 * `close` handler above, which already does `unregisterDevice` +
 * `markOffline`, so there's no separate cleanup path to keep in sync.
 * Everything else gets pinged and flipped back to "not yet answered"
 * until its `pong` handler proves otherwise. Exported separately (instead
 * of only inline in `setInterval`) so it's directly unit-testable without
 * needing to fake timers.
 */
export function runDeviceHeartbeatTick() {
  for (const ws of getDeviceSockets()) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}

/**
 * Starts the shared device-socket heartbeat interval. Returns the handle
 * so callers (server.js) can `clearInterval` it on shutdown.
 */
export function startDeviceHeartbeat() {
  return setInterval(runDeviceHeartbeatTick, HEARTBEAT_INTERVAL_MS);
}
