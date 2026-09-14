import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { attachHouseholds, isHouseholdMember, isHouseholdOwner } from '../middleware/household.js';

export const automationsRouter = Router();
automationsRouter.use(requireAuth, attachHouseholds);

const actionSchema = z.object({
  deviceId: z.string().trim().min(1).max(64),
  channelIdx: z.number().int().min(0).max(255),
  state: z.enum(['ON', 'OFF']),
});

const triggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('schedule'),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM'),
  }),
  z.object({
    type: z.literal('state'),
    deviceId: z.string().trim().min(1).max(64),
    channelIdx: z.number().int().min(0).max(255),
    state: z.enum(['ON', 'OFF']),
  }),
]);

const automationSchema = z.object({
  id: z.number().int().positive().optional(),
  householdId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean().default(true),
  trigger: triggerSchema,
  actions: z.array(actionSchema).min(1).max(32),
});

function rowToAutomation(row) {
  const trigger =
    row.trigger_type === 'schedule'
      ? { type: 'schedule', days: row.schedule_days, time: row.schedule_time?.slice(0, 5) }
      : {
          type: 'state',
          deviceId: row.trigger_device_id,
          channelIdx: row.trigger_channel_idx,
          state: row.trigger_state,
        };
  return {
    id: row.id,
    householdId: row.household_id,
    name: row.name,
    enabled: row.enabled,
    trigger,
    actions: row.actions,
    lastFiredAt: row.last_fired_at,
  };
}

automationsRouter.get('/', async (req, res) => {
  let ids = [...req.householdRoles.keys()].map(Number);
  const queried = req.query.householdId ? Number(req.query.householdId) : undefined;
  if (queried !== undefined) {
    if (!isHouseholdMember(req, queried)) {
      return res.status(404).json({ error: 'household not found' });
    }
    ids = [queried];
  }
  if (ids.length === 0) {
    return res.json({ automations: [] });
  }
  const { rows } = await pool.query(
    `SELECT * FROM automations WHERE household_id = ANY($1::bigint[]) ORDER BY id`,
    [ids],
  );
  res.json({ automations: rows.map(rowToAutomation) });
});

/** Every referenced device (trigger's + every action's) must belong to `householdId`. */
async function validateDevicesInHousehold(client, householdId, deviceIds) {
  if (deviceIds.length === 0) return null;
  const { rows } = await client.query(
    'SELECT device_id FROM devices WHERE household_id = $1 AND device_id = ANY($2::text[])',
    [householdId, deviceIds],
  );
  const owned = new Set(rows.map((r) => r.device_id));
  return deviceIds.find((id) => !owned.has(id)) ?? null;
}

/** Create (`id` omitted) or update (`id` given) — owner-only, per docs/plan.md's roles decision. */
automationsRouter.post('/', async (req, res) => {
  const parsed = automationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { id, name, enabled, trigger, actions } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let householdId;
    if (id) {
      const { rows } = await client.query('SELECT household_id FROM automations WHERE id = $1', [id]);
      householdId = rows[0]?.household_id;
      if (!householdId || !isHouseholdMember(req, householdId)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'automation not found' });
      }
      if (!isHouseholdOwner(req, householdId)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'only a household owner can edit automations' });
      }
    } else {
      householdId = parsed.data.householdId ?? req.defaultHouseholdId;
      if (!householdId || !isHouseholdOwner(req, householdId)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'must be an owner of the target household' });
      }
    }

    const deviceIds = [
      ...(trigger.type === 'state' ? [trigger.deviceId] : []),
      ...actions.map((a) => a.deviceId),
    ];
    const badDevice = await validateDevicesInHousehold(client, householdId, deviceIds);
    if (badDevice) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: `device ${badDevice} is not in this household` });
    }

    const values = [
      householdId,
      name,
      enabled,
      trigger.type,
      trigger.type === 'schedule' ? trigger.days : null,
      trigger.type === 'schedule' ? trigger.time : null,
      trigger.type === 'state' ? trigger.deviceId : null,
      trigger.type === 'state' ? trigger.channelIdx : null,
      trigger.type === 'state' ? trigger.state : null,
      JSON.stringify(actions),
    ];

    let row;
    if (id) {
      const { rows } = await client.query(
        `UPDATE automations SET
           name = $2, enabled = $3, trigger_type = $4, schedule_days = $5, schedule_time = $6,
           trigger_device_id = $7, trigger_channel_idx = $8, trigger_state = $9, actions = $10
         WHERE id = $1 RETURNING *`,
        [id, ...values],
      );
      row = rows[0];
    } else {
      const { rows } = await client.query(
        `INSERT INTO automations
           (household_id, name, enabled, trigger_type, schedule_days, schedule_time,
            trigger_device_id, trigger_channel_idx, trigger_state, actions, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [...values, req.userId],
      );
      row = rows[0];
    }

    await client.query('COMMIT');
    res.status(200).json(rowToAutomation(row));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

automationsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid automation id' });
  }
  const { rows } = await pool.query('SELECT household_id FROM automations WHERE id = $1', [id]);
  const householdId = rows[0]?.household_id;
  if (!householdId || !isHouseholdMember(req, householdId)) {
    return res.status(404).json({ error: 'automation not found' });
  }
  if (!isHouseholdOwner(req, householdId)) {
    return res.status(403).json({ error: 'only a household owner can delete automations' });
  }
  await pool.query('DELETE FROM automations WHERE id = $1', [id]);
  res.status(204).end();
});
