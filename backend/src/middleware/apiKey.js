import { hashSecret, looksLikeApiKey, touchLastUsed } from '../auth/apiKeys.js';
import { pool } from '../db/pool.js';
import { sendError } from '../v1/errors.js';

/**
 * `/v1` auth: requires `Authorization: Bearer sk_...` and attaches
 * `req.userId` + `req.apiKey` ({id, name, prefix}). App/dashboard JWTs are
 * rejected here on purpose (and `requireAuth` rejects API keys on the
 * internal routes), so a leaked key can never manage the account and the
 * public API has exactly one credential kind. Mount `attachHouseholds`
 * after this — household access is re-read on every request.
 */
export async function requireApiKey(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return sendError(
      res,
      401,
      'missing_api_key',
      'Send your API key as "Authorization: Bearer sk_...".',
    );
  }
  const token = header.slice('Bearer '.length).trim();
  if (!looksLikeApiKey(token)) {
    return sendError(res, 401, 'invalid_api_key', 'Invalid API key. Only API keys (sk_...) are accepted.');
  }
  // Keys of an admin-disabled account are dead while it stays disabled
  // (and come back if it is re-enabled — they aren't revoked).
  const { rows } = await pool.query(
    `SELECT k.id, k.user_id, k.name, k.prefix
     FROM api_keys k
     JOIN users u ON u.id = k.user_id AND u.disabled_at IS NULL
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashSecret(token)],
  );
  const key = rows[0];
  if (!key) {
    return sendError(res, 401, 'invalid_api_key', 'Invalid or revoked API key.');
  }
  req.userId = Number(key.user_id);
  req.apiKey = { id: Number(key.id), name: key.name, prefix: key.prefix };
  touchLastUsed('api_keys', req.apiKey.id);
  next();
}
