import { Router } from 'express';
import { z } from 'zod';

import { attachHouseholds, isHouseholdOwner } from '../middleware/household.js';
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

householdsRouter.delete('/:id/members/:userId', async (req, res) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (!Number.isInteger(id) || !isHouseholdOwner(req, id) || !Number.isInteger(userId)) {
    return res.status(404).json({ error: 'household not found' });
  }
  const { rows } = await pool.query(
    'SELECT user_id, role FROM household_members WHERE household_id = $1',
    [id],
  );
  const target = rows.find((r) => r.user_id === userId);
  if (!target) {
    return res.status(404).json({ error: 'member not found' });
  }
  const ownerCount = rows.filter((r) => r.role === 'owner').length;
  if (target.role === 'owner' && ownerCount <= 1) {
    return res.status(409).json({ error: 'cannot remove the last owner' });
  }
  await pool.query('DELETE FROM household_members WHERE household_id = $1 AND user_id = $2', [
    id,
    userId,
  ]);
  res.status(204).end();
});
