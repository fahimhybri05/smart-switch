import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { attachHouseholds, isHouseholdMember } from '../middleware/household.js';

export const activityRouter = Router();
activityRouter.use(requireAuth, attachHouseholds);

const querySchema = z.object({
  householdId: z.coerce.number().int().positive().optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Cursor-paginated (created_at DESC, id DESC) — the table is unbounded by
 * design (keep-everything, no retention job, per docs/plan.md), so offset
 * pagination would degrade badly; the cursor is cheap on the existing
 * index. `before` is the id of the last row already seen.
 */
activityRouter.get('/', async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { before, limit } = parsed.data;

  let householdId = parsed.data.householdId;
  if (householdId === undefined) {
    const ids = [...req.householdRoles.keys()];
    if (ids.length !== 1) {
      return res.status(400).json({ error: 'householdId is required' });
    }
    householdId = Number(ids[0]);
  }
  if (!isHouseholdMember(req, householdId)) {
    return res.status(404).json({ error: 'household not found' });
  }

  const conditions = ['a.household_id = $1'];
  const params = [householdId];
  if (before !== undefined) {
    params.push(before);
    conditions.push(`a.id < $${params.length}`);
  }
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT a.id, a.device_id AS "deviceId", d.friendly_name AS "deviceFriendlyName",
            a.channel_idx AS "channelIdx", a.state, a.source,
            u.email AS "actorEmail", a.automation_id AS "automationId", a.created_at AS "createdAt"
     FROM activity_log a
     JOIN devices d ON d.device_id = a.device_id
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $${params.length}`,
    params,
  );
  res.json({ entries: rows, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null });
});
