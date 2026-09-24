import { Router } from 'express';
import { z } from 'zod';

import { displayPrefix, generateHookToken, hashSecret } from '../auth/apiKeys.js';
import { publicApiUrl } from '../config.js';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { attachHouseholds } from '../middleware/household.js';
import { formatSwitchId, getSwitch, parseSwitchId } from '../switches.js';

export const hooksRouter = Router();
hooksRouter.use(requireAuth, attachHouseholds);

export const MAX_HOOKS_PER_KEY = 50;

const createSchema = z.object({
  apiKeyId: z.number().int().positive(),
  switchId: z.string().trim().min(3).max(128),
  name: z.string().trim().max(64).optional(),
});

function hookUrls(token) {
  const base = `${publicApiUrl()}/v1/hook/${token}`;
  return {
    on: `${base}/on`,
    off: `${base}/off`,
    toggle: `${base}/toggle`,
    status: `${base}/status`,
  };
}

function rowToHook(row) {
  return {
    id: Number(row.id),
    apiKeyId: Number(row.api_key_id),
    apiKeyName: row.api_key_name,
    switchId: formatSwitchId(row.device_id, row.channel_idx),
    deviceId: row.device_id,
    channel: Number(row.channel_idx),
    name: row.name ?? '',
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** The caller's active hooks (under active keys). Never includes tokens. */
hooksRouter.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT h.id, h.api_key_id, k.name AS api_key_name, h.device_id, h.channel_idx, h.name,
            h.token_prefix, h.created_at, h.last_used_at
     FROM switch_hooks h
     JOIN api_keys k ON k.id = h.api_key_id
     WHERE k.user_id = $1 AND k.revoked_at IS NULL AND h.revoked_at IS NULL
     ORDER BY h.created_at DESC, h.id DESC`,
    [req.userId],
  );
  res.json({ hooks: rows.map(rowToHook) });
});

/** Creates a hook URL set for one switch. The raw `token` and `urls` are in
 * this response ONLY (stored hash-only). "Regenerate" = revoke + create. */
hooksRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { apiKeyId, switchId, name } = parsed.data;

  const { rows: keyRows } = await pool.query(
    'SELECT id, name FROM api_keys WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [apiKeyId, req.userId],
  );
  if (keyRows.length === 0) {
    return res.status(404).json({ error: 'api key not found' });
  }
  const target = parseSwitchId(switchId);
  const sw = target
    ? await getSwitch([...req.householdRoles.keys()].map(Number), target.deviceId, target.channelIdx)
    : null;
  if (!sw) {
    return res.status(404).json({ error: 'switch not found' });
  }

  const token = generateHookToken();
  const { rows } = await pool.query(
    `INSERT INTO switch_hooks (api_key_id, device_id, channel_idx, name, token_prefix, token_hash)
     SELECT $1, $2, $3, $4, $5, $6
     WHERE (SELECT count(*) FROM switch_hooks WHERE api_key_id = $1 AND revoked_at IS NULL) < $7
     RETURNING id, api_key_id, device_id, channel_idx, name, token_prefix, created_at, last_used_at`,
    [apiKeyId, sw.deviceId, sw.channel, name || null, displayPrefix(token), hashSecret(token), MAX_HOOKS_PER_KEY],
  );
  if (rows.length === 0) {
    return res
      .status(409)
      .json({ error: `hook limit reached for this API key (${MAX_HOOKS_PER_KEY})` });
  }
  res.status(201).json({
    ...rowToHook({ ...rows[0], api_key_name: keyRows[0].name }),
    token,
    urls: hookUrls(token),
  });
});

hooksRouter.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: 'hook not found' });
  }
  const { rows } = await pool.query(
    `UPDATE switch_hooks h SET revoked_at = now()
     FROM api_keys k
     WHERE h.id = $1 AND h.api_key_id = k.id AND k.user_id = $2 AND h.revoked_at IS NULL
     RETURNING h.id`,
    [id, req.userId],
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'hook not found' });
  }
  res.status(204).end();
});
