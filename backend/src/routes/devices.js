import { Router } from 'express';
import { z } from 'zod';

import { hashDeviceSecret } from '../auth/deviceSecret.js';
import { getHouseholdDevicesSnapshot } from '../db/devices.js';
import { pool } from '../db/pool.js';
import {
  DEFAULT_CHANNEL_COUNT,
  deleteSchedule,
  dispatchDeviceApi,
  getConfig,
  setSettings,
  upsertSchedule,
  upsertSwitch,
} from '../deviceApi/index.js';
import { requireAuth } from '../middleware/auth.js';
import { attachHouseholds, isHouseholdMember, isHouseholdOwner } from '../middleware/household.js';
import { guardRestResponse, isGuardError } from '../safety/guard.js';
import { getUsage, usageQuerySchema } from '../usage.js';
import { noteExpectedStateChange } from '../ws/attribution.js';
import { isDeviceOnline, relayCommand } from '../ws/registry.js';

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
      // A NULL hash means an admin reset the secret (e.g. the device was
      // factory-reset and generated a new one): the claimer's secret is
      // adopted, like the device's own next connect would (ws/deviceServer.js).
      // The row is locked FOR UPDATE, so this can't race another claim.
      if (existing.cloud_secret_hash !== null && existing.cloud_secret_hash !== secretHash) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'invalid device secret' });
      }
      await client.query(
        `UPDATE devices SET owner_user_id = $1, household_id = $2, friendly_name = COALESCE($3, friendly_name),
                            cloud_secret_hash = COALESCE(cloud_secret_hash, $5)
         WHERE device_id = $4`,
        [req.userId, householdId, friendlyName ?? null, deviceId, secretHash],
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
  const devices = await getHouseholdDevicesSnapshot(ids);
  res.json({ devices });
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
  // Activity attribution only (self-reported, like the client WS's
  // msg.source) — the web dashboard sends 'dashboard'.
  source: z.enum(['widget', 'dashboard']).default('widget'),
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

  const { method, path, body, source } = parsed.data;
  const match = path.match(CHANNEL_STATE_PATH);
  if (!match || method !== 'POST') {
    // Everything except actuation is answered by the backend itself — the
    // device holds no config to answer it from. Still gated on the device
    // being online so callers' offline detection behaves as before.
    if (!isDeviceOnline(req.params.deviceId)) {
      return res.status(503).json({ error: 'device_offline' });
    }
    return res
      .status(200)
      .json(await dispatchDeviceApi(req.params.deviceId, method, path, body, { actorUserId: req.userId }));
  }
  if (body?.state) {
    noteExpectedStateChange(req.params.deviceId, Number(match[1]), body.state, {
      source,
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
    // Switch lock / min-off rules, enforced inside relayCommand (safety/guard.js).
    if (isGuardError(err)) {
      const { status, body: errBody } = guardRestResponse(err);
      if (errBody.retryAfterSeconds !== undefined) res.set('Retry-After', String(errBody.retryAfterSeconds));
      return res.status(status).json(errBody);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Clean REST config routes (web dashboard). Unlike the /command relay these
// never require the device to be online — the backend owns this config and
// the device picks up hw changes on its next connect.
// ---------------------------------------------------------------------------

/** Resolves the device's household and enforces membership; null (after
 * answering 404) when the caller may not see it. */
async function requireMemberDevice(req, res) {
  const householdId = await loadDeviceHousehold(req.params.deviceId);
  if (!householdId || !isHouseholdMember(req, householdId)) {
    res.status(404).json({ error: 'device not found' });
    return null;
  }
  return householdId;
}

/** Same body as the app's GET /api/config (via getConfig), plus `online`. */
devicesRouter.get('/:deviceId/config', async (req, res) => {
  if (!(await requireMemberDevice(req, res))) return;
  const result = await getConfig(req.params.deviceId);
  if (result.status !== 200) {
    return res.status(result.status).json(result.body);
  }
  res.json({ ...result.body, online: isDeviceOnline(req.params.deviceId) });
});

const switchPatchSchema = z.object({
  name: z.string().trim().max(64).optional(),
  zone: z.string().trim().max(64).optional(),
  defaultBootState: z.enum(['ON', 'OFF']).optional(),
  inputMode: z.enum(['DISABLED', 'TOGGLE', 'EDGE']).optional(),
  // Same upper bound the app's edit dialog clamps to.
  inchingMs: z.number().int().min(0).max(600_000).optional(),
  // Safety/energy fields: null clears, omitted preserves (upsertSwitch).
  watts: z.number().int().min(0).max(100_000).nullable().optional(),
  maxOnSeconds: z.number().int().min(1).max(604_800).nullable().optional(),
  minOffSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
  locked: z.boolean().optional(),
});

/**
 * Partial switch update. upsertSwitch is a full replace of name/zone/
 * default_boot_state (input_mode/inching_ms/watts/max_on_s/min_off_s/lock
 * are preserved when omitted), so the stored row is merged in first — a rename no longer wipes
 * the zone or boot state. upsertSwitch itself pushes hw config to the
 * device only when inputMode/inchingMs are part of the request.
 */
devicesRouter.patch('/:deviceId/switches/:idx', async (req, res) => {
  const idx = Number(req.params.idx);
  if (!/^\d+$/.test(req.params.idx) || idx >= DEFAULT_CHANNEL_COUNT) {
    return res.status(400).json({ error: `idx must be within [0, ${DEFAULT_CHANNEL_COUNT})` });
  }
  const parsed = switchPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const patch = parsed.data;
  if (Object.values(patch).every((v) => v === undefined)) {
    return res.status(400).json({ error: 'nothing to update' });
  }
  if (!(await requireMemberDevice(req, res))) return;

  const { rows } = await pool.query(
    `SELECT name, zone, default_boot_state FROM device_switches
     WHERE device_id = $1 AND channel_idx = $2`,
    [req.params.deviceId, idx],
  );
  const existing = rows[0];
  const body = {
    channel_idx: idx,
    name: patch.name ?? existing?.name ?? `Channel ${idx}`,
    zone: patch.zone ?? existing?.zone ?? '',
    default_boot_state: patch.defaultBootState ?? existing?.default_boot_state ?? 'OFF',
  };
  if (patch.inputMode !== undefined) body.input_mode = patch.inputMode;
  if (patch.inchingMs !== undefined) body.inching_ms = patch.inchingMs;
  if (patch.watts !== undefined) body.watts = patch.watts;
  if (patch.maxOnSeconds !== undefined) body.max_on_s = patch.maxOnSeconds;
  if (patch.minOffSeconds !== undefined) body.min_off_s = patch.minOffSeconds;
  if (patch.locked !== undefined) body.locked = patch.locked;

  const result = await upsertSwitch(req.params.deviceId, body, { actorUserId: req.userId });
  res.status(result.status).json(result.body);
});

/** Per-switch ON time (and kWh when watts is set) for this device over the
 * last `days` household-local days — see usage.js. */
devicesRouter.get('/:deviceId/usage', async (req, res) => {
  const parsed = usageQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const householdId = await requireMemberDevice(req, res);
  if (!householdId) return;
  const usage = await getUsage({ householdId, deviceId: req.params.deviceId, days: parsed.data.days });
  res.json({
    timezone: usage.timezone,
    days: usage.days,
    switches: usage.switches.map(({ deviceId, deviceName, ...sw }) => sw),
  });
});

/** Create (no `id`) or update (`id`) a device schedule — same wire shape as
 * the app's POST /api/schedules (see deviceApi/schedules.js). */
devicesRouter.post('/:deviceId/schedules', async (req, res) => {
  if (!(await requireMemberDevice(req, res))) return;
  const result = await upsertSchedule(req.params.deviceId, req.body ?? {});
  res.status(result.status).json(result.body);
});

devicesRouter.delete('/:deviceId/schedules/:scheduleId', async (req, res) => {
  if (!(await requireMemberDevice(req, res))) return;
  const result = await deleteSchedule(req.params.deviceId, req.params.scheduleId);
  if (result.status === 204) {
    return res.status(204).end();
  }
  res.status(result.status).json(result.body);
});

/** Interlock and/or location — same wire shape as the app's POST /api/settings. */
devicesRouter.patch('/:deviceId/settings', async (req, res) => {
  if (!(await requireMemberDevice(req, res))) return;
  const result = await setSettings(req.params.deviceId, req.body ?? {});
  res.status(result.status).json(result.body);
});
