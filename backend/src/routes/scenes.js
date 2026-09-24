import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../db/pool.js';
import { DEFAULT_CHANNEL_COUNT } from '../deviceApi/constants.js';
import { requireAuth } from '../middleware/auth.js';
import { attachHouseholds, isHouseholdMember } from '../middleware/household.js';
import { actuate, SwitchError } from '../switches.js';

/**
 * Account-wide scenes: a named set of `{deviceId, channelIdx, state}`
 * actions run together. Permissions mirror routes/groups.js exactly — any
 * household member may list/create/edit/delete/run (a control
 * convenience, not household management), and every action's device must
 * belong to the scene's own household.
 */
export const scenesRouter = Router();
scenesRouter.use(requireAuth, attachHouseholds);

const actionSchema = z.object({
  deviceId: z.string().trim().min(1).max(64),
  channelIdx: z.number().int().min(0).max(DEFAULT_CHANNEL_COUNT - 1),
  state: z.enum(['ON', 'OFF']),
});

const sceneSchema = z.object({
  id: z.number().int().positive().optional(),
  householdId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(64),
  // Free text; the UIs agree on moon/sun/home/away/movie/power/leaf/droplet.
  icon: z.string().trim().max(32).nullable().optional(),
  actions: z.array(actionSchema).max(64),
});

const listQuerySchema = z.object({
  householdId: z.coerce.number().int().positive().optional(),
});

const SCENE_COLUMNS = `id, household_id AS "householdId", name, icon, actions,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

scenesRouter.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  let ids = [...req.householdRoles.keys()].map(Number);
  if (parsed.data.householdId !== undefined) {
    if (!isHouseholdMember(req, parsed.data.householdId)) {
      return res.status(404).json({ error: 'household not found' });
    }
    ids = [parsed.data.householdId];
  }
  if (ids.length === 0) {
    return res.json({ scenes: [] });
  }
  const { rows } = await pool.query(
    `SELECT ${SCENE_COLUMNS} FROM scenes WHERE household_id = ANY($1::bigint[]) ORDER BY id`,
    [ids],
  );
  res.json({ scenes: rows });
});

/** Device ids among `actions` that aren't in `householdId`. */
async function foreignDevice(householdId, actions) {
  if (actions.length === 0) return null;
  const { rows } = await pool.query(
    'SELECT device_id FROM devices WHERE household_id = $1 AND device_id = ANY($2::text[])',
    [householdId, [...new Set(actions.map((a) => a.deviceId))]],
  );
  const owned = new Set(rows.map((r) => r.device_id));
  return actions.find((a) => !owned.has(a.deviceId))?.deviceId ?? null;
}

async function loadSceneHousehold(id) {
  const { rows } = await pool.query('SELECT household_id FROM scenes WHERE id = $1', [id]);
  return rows[0]?.household_id ?? null;
}

/** Create (`id` omitted → 201) or update (`id` given → 200; full replace
 * of name/actions, `icon` kept when omitted, cleared with null). */
scenesRouter.post('/', async (req, res) => {
  const parsed = sceneSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { id, name, icon, actions } = parsed.data;

  let householdId;
  if (id) {
    householdId = await loadSceneHousehold(id);
    if (!householdId || !isHouseholdMember(req, householdId)) {
      return res.status(404).json({ error: 'scene not found' });
    }
  } else {
    householdId = parsed.data.householdId ?? req.defaultHouseholdId;
    if (!householdId || !isHouseholdMember(req, householdId)) {
      return res.status(403).json({ error: 'not a member of the target household' });
    }
  }

  const foreign = await foreignDevice(householdId, actions);
  if (foreign) {
    return res.status(403).json({ error: `device ${foreign} is not in this household` });
  }

  const actionsJson = JSON.stringify(actions);
  if (id) {
    const { rows } = await pool.query(
      `UPDATE scenes SET name = $2, actions = $3::jsonb, updated_at = now(),
              icon = CASE WHEN $5 THEN $4 ELSE icon END
       WHERE id = $1
       RETURNING ${SCENE_COLUMNS}`,
      [id, name, actionsJson, icon ?? null, icon !== undefined],
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'scene not found' });
    }
    return res.status(200).json(rows[0]);
  }
  const { rows } = await pool.query(
    `INSERT INTO scenes (household_id, name, icon, actions, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING ${SCENE_COLUMNS}`,
    [householdId, name, icon ?? null, actionsJson, req.userId],
  );
  res.status(201).json(rows[0]);
});

scenesRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid scene id' });
  }
  const householdId = await loadSceneHousehold(id);
  if (!householdId || !isHouseholdMember(req, householdId)) {
    return res.status(404).json({ error: 'scene not found' });
  }
  await pool.query('DELETE FROM scenes WHERE id = $1', [id]);
  res.status(204).end();
});

/**
 * Runs every action in parallel through the same actuation path as the
 * public API (switches.js#actuate → relay, with the lock / min-off guard
 * enforced inside the relay), attributed to source 'scene' + the caller.
 * One action failing never stops the others; each gets its own result.
 */
scenesRouter.post('/:id/run', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid scene id' });
  }
  const { rows } = await pool.query('SELECT household_id, actions FROM scenes WHERE id = $1', [id]);
  const scene = rows[0];
  if (!scene || !isHouseholdMember(req, scene.household_id)) {
    return res.status(404).json({ error: 'scene not found' });
  }
  const actions = Array.isArray(scene.actions) ? scene.actions : [];

  // Re-checked at run time: a device can be unclaimed/reclaimed since the
  // scene was saved (same guard as automations/engine.js).
  const { rows: owned } = actions.length
    ? await pool.query(
      'SELECT device_id FROM devices WHERE household_id = $1 AND device_id = ANY($2::text[])',
      [scene.household_id, [...new Set(actions.map((a) => a.deviceId))]],
    )
    : { rows: [] };
  const ownedIds = new Set(owned.map((r) => r.device_id));

  const results = await Promise.all(
    actions.map(async ({ deviceId, channelIdx, state }) => {
      const base = { deviceId, channelIdx, state };
      if (!ownedIds.has(deviceId)) {
        return { ...base, ok: false, error: 'not_found' };
      }
      try {
        await actuate({
          deviceId,
          channelIdx,
          state: state === 'ON' ? 'on' : 'off',
          source: 'scene',
          actorUserId: req.userId,
        });
        return { ...base, ok: true };
      } catch (err) {
        const known = err instanceof SwitchError;
        if (!known) console.error(`scene ${id} action failed for ${deviceId} ch${channelIdx}`, err);
        return {
          ...base,
          ok: false,
          error: known ? err.code : 'internal_error',
          ...(err.extra?.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.extra.retryAfterSeconds } : {}),
        };
      }
    }),
  );
  const succeeded = results.filter((r) => r.ok).length;
  res.json({ results, succeeded, failed: results.length - succeeded });
});
