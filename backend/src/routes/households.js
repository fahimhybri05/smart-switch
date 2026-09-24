import { Router } from 'express';
import { z } from 'zod';

import { attachHouseholds, isHouseholdMember, isHouseholdOwner } from '../middleware/household.js';
import { requireAuth } from '../middleware/auth.js';
import { pool } from '../db/pool.js';

export const householdsRouter = Router();
householdsRouter.use(requireAuth, attachHouseholds);

householdsRouter.get('/', async (req, res) => {
  const ids = [...req.householdRoles.keys()].map(Number);
  if (ids.length === 0) {
    return res.json({ households: [] });
  }
  const { rows } = await pool.query(
    `SELECT h.id, h.name, h.timezone,
            COALESCE(
              json_agg(
                json_build_object('userId', u.id, 'email', u.email, 'role', hm.role)
                ORDER BY hm.role, u.email
              ) FILTER (WHERE u.id IS NOT NULL),
              '[]'
            ) AS members
     FROM households h
     JOIN household_members hm ON hm.household_id = h.id
     JOIN users u ON u.id = hm.user_id
     WHERE h.id = ANY($1::bigint[])
     GROUP BY h.id, h.name, h.timezone
     ORDER BY h.id`,
    [ids],
  );
  res.json({
    households: rows.map((r) => ({ ...r, role: req.householdRoles.get(String(r.id)) })),
  });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

householdsRouter.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !isHouseholdOwner(req, id)) {
    return res.status(404).json({ error: 'household not found' });
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { name, timezone } = parsed.data;
  if (name === undefined && timezone === undefined) {
    return res.status(400).json({ error: 'name or timezone is required' });
  }
  await pool.query(
    'UPDATE households SET name = COALESCE($1, name), timezone = COALESCE($2, timezone) WHERE id = $3',
    [name ?? null, timezone ?? null, id],
  );
  res.status(200).json({ id });
});

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

householdsRouter.post('/:id/invite', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !isHouseholdOwner(req, id)) {
    return res.status(404).json({ error: 'household not found' });
  }
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { rows: userRows } = await pool.query('SELECT id FROM users WHERE email = $1', [
    parsed.data.email,
  ]);
  const invitedUserId = userRows[0]?.id;
  if (!invitedUserId) {
    return res.status(404).json({ error: 'no account with that email' });
  }
  const { rows: memberRows } = await pool.query(
    'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
    [id, invitedUserId],
  );
  if (memberRows.length > 0) {
    return res.status(409).json({ error: 'already a household member' });
  }
  try {
    await pool.query(
      `INSERT INTO household_invites (household_id, invited_user_id, invited_by_user_id)
       VALUES ($1, $2, $3)`,
      [id, invitedUserId, req.userId],
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'invite already pending' });
    }
    throw err;
  }
  res.status(201).json({ ok: true });
});

householdsRouter.get('/invites', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT i.id, i.household_id AS "householdId", h.name AS "householdName",
            u.email AS "invitedByEmail"
     FROM household_invites i
     JOIN households h ON h.id = i.household_id
     JOIN users u ON u.id = i.invited_by_user_id
     WHERE i.invited_user_id = $1 AND i.status = 'pending'
     ORDER BY i.created_at DESC`,
    [req.userId],
  );
  res.json({ invites: rows });
});

async function respondToInvite(req, res, status) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid invite id' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE household_invites SET status = $1, responded_at = now()
       WHERE id = $2 AND invited_user_id = $3 AND status = 'pending'
       RETURNING household_id`,
      [status, id, req.userId],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'invite not found' });
    }
    if (status === 'accepted') {
      await client.query(
        `INSERT INTO household_members (household_id, user_id, role)
         VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
        [rows[0].household_id, req.userId],
      );
    }
    await client.query('COMMIT');
    res.status(200).json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

householdsRouter.post('/invites/:id/accept', (req, res) => respondToInvite(req, res, 'accepted'));
householdsRouter.post('/invites/:id/decline', (req, res) => respondToInvite(req, res, 'declined'));

/** Pending invites sent FROM this household (visible to any member; only
 * owners can cancel them). */
householdsRouter.get('/:id/invites', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || !isHouseholdMember(req, id)) {
    return res.status(404).json({ error: 'household not found' });
  }
  const { rows } = await pool.query(
    `SELECT i.id, i.invited_user_id AS "invitedUserId", u.email AS "invitedEmail",
            b.email AS "invitedByEmail", i.created_at AS "createdAt"
     FROM household_invites i
     JOIN users u ON u.id = i.invited_user_id
     JOIN users b ON b.id = i.invited_by_user_id
     WHERE i.household_id = $1 AND i.status = 'pending'
     ORDER BY i.created_at DESC`,
    [id],
  );
  res.json({ invites: rows });
});

/** Cancels a pending invite — owner-only. */
householdsRouter.delete('/:id/invites/:inviteId', async (req, res) => {
  const id = Number(req.params.id);
  const inviteId = Number(req.params.inviteId);
  if (!Number.isInteger(id) || !isHouseholdOwner(req, id)) {
    return res.status(404).json({ error: 'household not found' });
  }
  if (!Number.isInteger(inviteId)) {
    return res.status(404).json({ error: 'invite not found' });
  }
  const { rows } = await pool.query(
    `DELETE FROM household_invites
     WHERE id = $1 AND household_id = $2 AND status = 'pending'
     RETURNING id`,
    [inviteId, id],
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'invite not found' });
  }
  res.status(204).end();
});

/** Owners may remove anyone; any member may remove themselves (leave). The
 * last owner can never be removed, whoever asks. */
householdsRouter.delete('/:id/members/:userId', async (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (!Number.isInteger(id) || !Number.isInteger(userId) || !isHouseholdMember(req, id)) {
    return res.status(404).json({ error: 'household not found' });
  }
  if (userId !== req.userId && !isHouseholdOwner(req, id)) {
    return res.status(403).json({ error: 'only a household owner can remove other members' });
  }
  // Atomic check-and-delete — the previous version read all members,
  // computed ownerCount, and only then issued the DELETE as three separate
  // unlocked queries, letting two concurrent removals both read
  // ownerCount > 1, both pass the guard, and both delete, leaving zero
  // owners. A single conditional statement closes that window: the delete
  // only takes effect when the target isn't the household's sole owner.
  const { rows } = await pool.query(
    `DELETE FROM household_members
     WHERE household_id = $1 AND user_id = $2
       AND (role != 'owner' OR (
         SELECT count(*) FROM household_members WHERE household_id = $1 AND role = 'owner'
       ) > 1)
     RETURNING role`,
    [id, userId],
  );
  if (rows.length > 0) {
    return res.status(204).end();
  }
  // No row deleted: either the member doesn't exist at all (404, as
  // before), or they do exist and are the last owner (409, as before).
  const { rows: existing } = await pool.query(
    'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
    [id, userId],
  );
  if (existing.length === 0) {
    return res.status(404).json({ error: 'member not found' });
  }
  return res.status(409).json({ error: 'cannot remove the last owner' });
});
