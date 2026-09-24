import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import { pool } from '../db/pool.js';

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET env var is required');
  }
  return secret;
}

export function signAccessToken(userId) {
  return jwt.sign({ sub: String(userId) }, jwtSecret(), {
    expiresIn: ACCESS_TOKEN_TTL,
  });
}

/** Returns the decoded payload, or throws if invalid/expired. */
export function verifyAccessToken(token) {
  return jwt.verify(token, jwtSecret());
}

/** SHA-256 hex — shared by refresh tokens, API keys and hook tokens. */
export function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/** Returns the raw refresh token — only the hash is ever persisted. */
export async function createRefreshToken(userId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(rawToken), expiresAt],
  );
  return rawToken;
}

/** Returns the associated user_id, or null if invalid/expired/revoked. */
export async function verifyRefreshToken(rawToken) {
  const { rows } = await pool.query(
    `SELECT user_id FROM refresh_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashToken(rawToken)],
  );
  return rows[0]?.user_id ?? null;
}

export async function revokeRefreshToken(rawToken) {
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1',
    [hashToken(rawToken)],
  );
}

/**
 * Revokes every still-active refresh token for `userId` (password change
 * signs every session out). Pass a transaction client as `db` to make it
 * part of a larger transaction.
 */
export async function revokeAllRefreshTokens(userId, db = pool) {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}
