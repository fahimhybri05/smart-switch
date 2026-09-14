import { Router } from 'express';
import { z } from 'zod';

import { hashDeviceSecret } from '../auth/deviceSecret.js';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { attachHouseholds, isHouseholdMember, isHouseholdOwner } from '../middleware/household.js';
import { noteExpectedStateChange } from '../ws/attribution.js';
import { relayCommand } from '../ws/registry.js';

const CHANNEL_STATE_PATH = /^\/api\/channels\/(\d+)\/state$/;

export const devicesRouter = Router();
devicesRouter.use(requireAuth, attachHouseholds);

const claimSchema = z.object({
  deviceId: z.string().trim().min(1).max(64),
  cloudSecret: z.string().trim().min(16).max(256),
  friendlyName: z.string().trim().min(1).max(64).optional(),
  householdId: z.number().int().positive().optional(),
});

/**
 * Claims a device for the logged-in user. Works whether the device has
 * ever connected over WebSocket yet or not — the row is created here if
 * it doesn't exist, or verified-then-claimed if the device (or a previous
 * claim attempt) already created it. See docs/plan.md.
 */
devicesRouter.post('/claim', async (req, res) => {
  const parsed = claimSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { deviceId, cloudSecret, friendlyName } = parsed.data;
  const secretHash = hashDeviceSecret(cloudSecret);

  const householdId = parsed.data.householdId ?? req.defaultHouseholdId;
  if (!householdId || !isHouseholdOwner(req, householdId)) {
    return res.status(403).json({ error: 'must be an owner of the target household' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT household_id, cloud_secret_hash, friendly_name FROM devices WHERE device_id = $1 FOR UPDATE',
      [deviceId],
    );
    const existing = rows[0];

    if (existing) {
      if (existing.household_id && existing.household_id !== householdId) {
        await client.query('ROLLBACK');
        return res
          .status(409)
          .json({ error: 'device is already claimed by another household' });
      }
      if (existing.cloud_secret_hash !== secretHash) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'invalid device secret' });
      }
      await client.query(
        'UPDATE devices SET owner_user_id = $1, household_id = $2, friendly_name = COALESCE($3, friendly_name) WHERE device_id = $4',
        [req.userId, householdId, friendlyName ?? null, deviceId],
      );
    } else {
      await client.query(
        `INSERT INTO devices (device_id, owner_user_id, household_id, cloud_secret_hash, friendly_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [deviceId, req.userId, householdId, secretHash, friendlyName ?? deviceId],
      );
    }
    await client.query('COMMIT');
    res.status(200).json({ deviceId, friendlyName: friendlyName ?? existing?.friendly_name ?? deviceId });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

devicesRouter.get('/', async (req, res) => {
  const ids = [...req.householdRoles.keys()].map(Number);
  if (ids.length === 0) {
    return res.json({ devices: [] });
  }
  const { rows } = await pool.query(
    `SELECT d.device_id, d.friendly_name, d.is_online, d.last_seen_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'channelIdx', c.channel_idx, 'name', c.name,
                  'zone', c.zone, 'state', c.state, 'updatedAt', c.updated_at
                ) ORDER BY c.channel_idx
              ) FILTER (WHERE c.channel_idx IS NOT NULL),
              '[]'
            ) AS channels
     FROM devices d
     LEFT JOIN cached_channel_state c ON c.device_id = d.device_id
     WHERE d.household_id = ANY($1::bigint[])
     GROUP BY d.device_id, d.friendly_name, d.is_online, d.last_seen_at
     ORDER BY d.device_id`,
    [ids],
  );
  res.json({ devices: rows });
});

const renameSchema = z.object({
  friendlyName: z.string().trim().min(1).max(64),
});

/**
 * Renames an already-claimed device — unlike /claim, doesn't need the
 * device's cloudSecret (claim already proved ownership once; a rename is
 * just an account-side label edit). This is what lets a rename on one
 * phone actually reach every other phone on the same account, instead of
 * only the claim-time name ever being visible elsewhere. See docs/plan.md.
 */
async function loadDeviceHousehold(deviceId) {
  const { rows } = await pool.query('SELECT household_id FROM devices WHERE device_id = $1', [
    deviceId,
  ]);
  return rows[0]?.household_id ?? null;
}

/** Renaming is a cosmetic, non-destructive edit — any household member may do it. */
devicesRouter.patch('/:deviceId', async (req, res) => {
  const parsed = renameSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const householdId = await loadDeviceHousehold(req.params.deviceId);
  if (!householdId || !isHouseholdMember(req, householdId)) {
    return res.status(404).json({ error: 'device not found' });
  }
  await pool.query('UPDATE devices SET friendly_name = $1 WHERE device_id = $2', [
    parsed.data.friendlyName,
    req.params.deviceId,
  ]);
  res.status(200).json({ deviceId: req.params.deviceId, friendlyName: parsed.data.friendlyName });
});

/** Unclaiming removes a device from the household entirely — owner-only. */
devicesRouter.delete('/:deviceId', async (req, res) => {
  const householdId = await loadDeviceHousehold(req.params.deviceId);
  if (!householdId || !isHouseholdMember(req, householdId)) {
    return res.status(404).json({ error: 'device not found' });
  }
  if (!isHouseholdOwner(req, householdId)) {
    return res.status(403).json({ error: 'only a household owner can remove a device' });
  }
  await pool.query(
    'UPDATE devices SET owner_user_id = NULL, household_id = NULL WHERE device_id = $1',
    [req.params.deviceId],
  );
  res.status(204).end();
});

const commandSchema = z.object({
  method: z.enum(['GET', 'POST', 'DELETE']),
  path: z.string().trim().min(1).max(256),
  body: z.unknown().optional(),
});

/**
 * Synchronous relay over plain REST — for callers with no persistent
 * client WS: a headless widget/background-monitor isolate (see
 * lib/services/isolate_device_relay.dart), or anything else that just
 * needs to issue one command and get the device's response back. Any
 * household member may use it (control, not management). See
 * docs/plan.md's cloud-aware widget relay section.
 */
devicesRouter.post('/:deviceId/command', async (req, res) => {
  const parsed = commandSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const householdId = await loadDeviceHousehold(req.params.deviceId);
  if (!householdId || !isHouseholdMember(req, householdId)) {
    return res.status(404).json({ error: 'device not found' });
  }

  const { method, path, body } = parsed.data;
  const match = path.match(CHANNEL_STATE_PATH);
  if (match && body?.state) {
    noteExpectedStateChange(req.params.deviceId, Number(match[1]), body.state, {
      source: 'widget',
      actorUserId: req.userId,
    });
  }

  try {
    const result = await relayCommand(req.params.deviceId, { method, path, body });
    res.status(200).json(result);
  } catch (err) {
    if (err.code === 'device_offline') {
      return res.status(503).json({ error: 'device_offline' });
    }
    if (err.code === 'device_timeout') {
      return res.status(504).json({ error: 'device_timeout' });
    }
    throw err;
  }
});
