import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { attachHouseholds, isHouseholdMember } from '../middleware/household.js';

export const groupsRouter = Router();
groupsRouter.use(requireAuth, attachHouseholds);

const memberSchema = z.object({
  deviceId: z.string().trim().min(1).max(64),
  channelIdx: z.number().int().min(0).max(255),
});

const groupSchema = z.object({
  id: z.number().int().positive().optional(),
  householdId: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(64),
  members: z.array(memberSchema).max(64),
});

groupsRouter.get('/', async (req, res) => {
  const ids = [...req.householdRoles.keys()].map(Number);
  if (ids.length === 0) {
    return res.json({ groups: [] });
  }
  const { rows } = await pool.query(
    `SELECT g.id, g.name,
            COALESCE(
              json_agg(
                json_build_object('deviceId', m.device_id, 'channelIdx', m.channel_idx)
              ) FILTER (WHERE m.device_id IS NOT NULL),
              '[]'
            ) AS members
     FROM groups g
     LEFT JOIN group_members m ON m.group_id = g.id
     WHERE g.household_id = ANY($1::bigint[])
     GROUP BY g.id, g.name
     ORDER BY g.id`,
    [ids],
  );
  res.json({ groups: rows });
});

/**
 * Create (`id` omitted) or update (`id` given) a group. Update replaces the
 * full member list (delete-all + reinsert) rather than diffing — groups
 * are small (spec-level cap of 64 members) so this stays simple. Every
 * member's device must belong to the group's own household — a group
 * can't span two households, even if the caller belongs to both, and
 * can't reference a device the household doesn't have. Any household
 * member (not just the owner) may create/edit/delete groups — they're a
 * control convenience, not a household-management action.
 */
groupsRouter.post('/', async (req, res) => {
  const parsed = groupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { id, name, members } = parsed.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let groupId = id;
    let householdId;
    if (groupId) {
      const { rows } = await client.query('SELECT household_id FROM groups WHERE id = $1', [
        groupId,
      ]);
      householdId = rows[0]?.household_id;
      if (!householdId || !isHouseholdMember(req, householdId)) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'group not found' });
      }
    } else {
      householdId = parsed.data.householdId ?? req.defaultHouseholdId;
      if (!householdId || !isHouseholdMember(req, householdId)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'not a member of the target household' });
      }
    }

    if (members.length > 0) {
      const { rows: owned } = await client.query(
        `SELECT device_id FROM devices WHERE household_id = $1 AND device_id = ANY($2::text[])`,
        [householdId, members.map((m) => m.deviceId)],
      );
      const ownedIds = new Set(owned.map((r) => r.device_id));
      const unowned = members.find((m) => !ownedIds.has(m.deviceId));
      if (unowned) {
        await client.query('ROLLBACK');
        return res
          .status(403)
          .json({ error: `device ${unowned.deviceId} is not in this household` });
      }
    }

    if (groupId) {
      await client.query('UPDATE groups SET name = $1 WHERE id = $2', [name, groupId]);
      await client.query('DELETE FROM group_members WHERE group_id = $1', [groupId]);
    } else {
      const { rows } = await client.query(
        'INSERT INTO groups (owner_user_id, household_id, name) VALUES ($1, $2, $3) RETURNING id',
        [req.userId, householdId, name],
      );
      groupId = rows[0].id;
    }

    for (const member of members) {
      await client.query(
        'INSERT INTO group_members (group_id, device_id, channel_idx) VALUES ($1, $2, $3)',
        [groupId, member.deviceId, member.channelIdx],
      );
    }

    await client.query('COMMIT');
    res.status(200).json({ id: groupId, name, members });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

groupsRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid group id' });
  }
  const { rows } = await pool.query('SELECT household_id FROM groups WHERE id = $1', [id]);
  const householdId = rows[0]?.household_id;
  if (!householdId || !isHouseholdMember(req, householdId)) {
    return res.status(404).json({ error: 'group not found' });
  }
  await pool.query('DELETE FROM groups WHERE id = $1', [id]);
  res.status(204).end();
});
