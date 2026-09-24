import crypto from 'node:crypto';

import { pool } from '../db/pool.js';
import { hashToken } from './tokens.js';

export const API_KEY_PREFIX = 'sk_';
export const HOOK_TOKEN_PREFIX = 'wh_';

// 32 random bytes -> 43 base64url chars.
const SECRET_BODY = '[A-Za-z0-9_-]{43}';
const API_KEY_RE = new RegExp(`^${API_KEY_PREFIX}${SECRET_BODY}$`);
const HOOK_TOKEN_RE = new RegExp(`^${HOOK_TOKEN_PREFIX}${SECRET_BODY}$`);

// Shown in lists after creation ("sk_AbCdEfGh…") — enough to tell keys
// apart, far too little to be useful to an attacker.
const DISPLAY_PREFIX_LEN = 11;

function randomSecret(prefix) {
  return prefix + crypto.randomBytes(32).toString('base64url');
}

/** `sk_` + base64url(32 random bytes). The raw value is returned to the
 * user exactly once; only `hashSecret()` of it is stored. */
export function generateApiKey() {
  return randomSecret(API_KEY_PREFIX);
}

/** `wh_` + base64url(32 random bytes) — the secret part of a hook URL. */
export function generateHookToken() {
  return randomSecret(HOOK_TOKEN_PREFIX);
}

export const hashSecret = hashToken;

export function displayPrefix(secret) {
  return secret.slice(0, DISPLAY_PREFIX_LEN);
}

export function looksLikeApiKey(value) {
  return typeof value === 'string' && API_KEY_RE.test(value);
}

export function looksLikeHookToken(value) {
  return typeof value === 'string' && HOOK_TOKEN_RE.test(value);
}

const TOUCH_INTERVAL_MS = 60_000;
const TOUCH_TABLES = new Set(['api_keys', 'switch_hooks']);
/** `${table}:${id}` -> last time a last_used_at write was issued. */
const lastTouched = new Map();

/**
 * Fire-and-forget `last_used_at = now()`, throttled to at most once per
 * minute per row (in memory, plus a SQL guard so multiple processes don't
 * hammer the row either) — every /v1 request would otherwise be a write.
 */
export function touchLastUsed(table, id) {
  if (!TOUCH_TABLES.has(table)) {
    throw new Error(`touchLastUsed: unsupported table ${table}`);
  }
  const k = `${table}:${id}`;
  const now = Date.now();
  if (now - (lastTouched.get(k) ?? 0) < TOUCH_INTERVAL_MS) {
    return;
  }
  lastTouched.set(k, now);
  pool
    .query(
      `UPDATE ${table} SET last_used_at = now()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [id],
    )
    .catch((err) => console.error(`touchLastUsed failed for ${table} ${id}`, err));
}

/**
 * Soft-revokes key `keyId` and every hook URL created under it. Run inside
 * a transaction on `client` (the caller owns BEGIN/COMMIT). With `userId`,
 * only a key owned by that user matches (self-service); without it, any
 * key does (admin). Returns the revoked key's `{id, user_id, name, prefix}`,
 * or null when no active key matched.
 */
export async function revokeApiKeyWithHooks(client, keyId, { userId = null } = {}) {
  const { rows } = await client.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL AND ($2::bigint IS NULL OR user_id = $2)
     RETURNING id, user_id, name, prefix`,
    [keyId, userId],
  );
  if (rows.length === 0) {
    return null;
  }
  await client.query(
    'UPDATE switch_hooks SET revoked_at = now() WHERE api_key_id = $1 AND revoked_at IS NULL',
    [keyId],
  );
  return rows[0];
}
