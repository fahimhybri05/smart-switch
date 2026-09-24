import { Router } from 'express';
import { z } from 'zod';

import { displayPrefix, generateApiKey, hashSecret, revokeApiKeyWithHooks } from '../auth/apiKeys.js';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

export const apiKeysRouter = Router();
apiKeysRouter.use(requireAuth);

export const MAX_API_KEYS_PER_USER = 25;

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
});

function rowToKey(row) {
  return {
    id: Number(row.id),
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    hookCount: Number(row.hook_count ?? 0),
  };
}

/** Active (non-revoked) keys of the caller. Never includes secrets. */
apiKeysRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at,
            (SELECT count(*) FROM switch_hooks h WHERE h.api_key_id = k.id AND h.revoked_at IS NULL) AS hook_count
     FROM api_keys k
     WHERE k.user_id = $1 AND k.revoked_at IS NULL
     ORDER BY k.created_at DESC, k.id DESC`,
    [req.userId],
  );
  res.json({ apiKeys: rows.map(rowToKey) });
});

/** Creates a key. The raw `secret` is in this response ONLY — it is stored
 * hash-only and can never be shown again. */
apiKeysRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const secret = generateApiKey();
  // Conditional insert keeps the cap check and the insert in one statement.
  const { rows } = await pool.query(
    `INSERT INTO api_keys (user_id, name, prefix, key_hash)
     SELECT $1, $2, $3, $4
     WHERE (SELECT count(*) FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL) < $5
     RETURNING id, name, prefix, created_at, last_used_at`,
    [req.userId, parsed.data.name, displayPrefix(secret), hashSecret(secret), MAX_API_KEYS_PER_USER],
  );
  if (rows.length === 0) {
    return res
      .status(409)
      .json({ error: `API key limit reached (${MAX_API_KEYS_PER_USER}); revoke one first` });
  }
  res.status(201).json({ ...rowToKey(rows[0]), secret });
});

/** Soft-revokes a key and every hook URL created under it, atomically. */
apiKeysRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: 'api key not found' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const revoked = await revokeApiKeyWithHooks(client, id, { userId: req.userId });
    if (!revoked) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'api key not found' });
    }
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});
