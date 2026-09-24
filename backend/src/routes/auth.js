import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import { wouldRemoveLastAdmin } from '../admin/guards.js';
import {
  createRefreshToken,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  signAccessToken,
  verifyRefreshToken,
} from '../auth/tokens.js';
import { isUserDisabled, verifyCredentials, verifyPasswordForUser } from '../auth/credentials.js';
import { deleteUserAccount } from '../auth/deleteAccount.js';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

// Self-hosted product, not a huge public SaaS — 10 requests per IP per 15
// minutes is a reasonable starting throttle against credential stuffing /
// brute force on the two credential-checking endpoints. `/refresh` and
// `/logout` don't take a password guess, so they're left unlimited.
const credentialsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});

const ACCOUNT_DISABLED = { error: 'account disabled' };

async function issueTokenPair(userId, res, status = 200) {
  const accessToken = signAccessToken(userId);
  const refreshToken = await createRefreshToken(userId);
  res.status(status).json({ accessToken, refreshToken });
}

authRouter.post('/signup', credentialsLimiter, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { email, password } = parsed.data;

  const passwordHash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, passwordHash],
    );
    const userId = rows[0].id;
    // Every user gets a personal "owner" household immediately — formalizes
    // the existing "account = de-facto Home" model. See docs/plan.md's
    // households section.
    const { rows: household } = await client.query(
      'INSERT INTO households (name) VALUES ($1) RETURNING id',
      [`${email}'s Home`],
    );
    await client.query(
      `INSERT INTO household_members (household_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [household[0].id, userId],
    );
    await client.query('COMMIT');
    await issueTokenPair(userId, res, 201);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      // unique_violation on users.email
      return res.status(409).json({ error: 'email already registered' });
    }
    throw err;
  } finally {
    client.release();
  }
});

authRouter.post('/login', credentialsLimiter, async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { email, password } = parsed.data;

  const userId = await verifyCredentials(email, password);
  if (!userId) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  // Only revealed after a correct password, so it can't be used to probe
  // which accounts exist or are disabled.
  if (await isUserDisabled(userId)) {
    return res.status(403).json(ACCOUNT_DISABLED);
  }
  await issueTokenPair(userId, res);
});

authRouter.post('/refresh', async (req, res) => {
  const parsed = z
    .object({ refreshToken: z.string().min(1) })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  const userId = await verifyRefreshToken(parsed.data.refreshToken);
  if (!userId) {
    return res.status(401).json({ error: 'invalid or expired refresh token' });
  }
  // Disabling revokes every refresh token, so this is belt-and-braces
  // (e.g. a token minted in a race with the disable). Already-issued access
  // tokens stay valid until they expire (≤15 min) — see middleware/admin.js.
  if (await isUserDisabled(userId)) {
    await revokeRefreshToken(parsed.data.refreshToken);
    return res.status(403).json(ACCOUNT_DISABLED);
  }
  // Rotate: the old refresh token is single-use.
  await revokeRefreshToken(parsed.data.refreshToken);
  await issueTokenPair(userId, res);
});

authRouter.post('/logout', async (req, res) => {
  const parsed = z
    .object({ refreshToken: z.string().min(1) })
    .safeParse(req.body);
  if (parsed.success) {
    await revokeRefreshToken(parsed.data.refreshToken);
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Profile (JWT). Password-confirmed actions share a stricter limiter: 5
// failed attempts per 15 minutes per account — keyed on the user (these
// routes are authenticated), so a stolen access token can't be used to
// brute-force the password, and users behind one IP (e.g. the dashboard
// BFF) don't share a bucket. Successful requests don't count.
// ---------------------------------------------------------------------------

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `user:${req.userId}`,
  message: { error: 'too many attempts, try again later' },
});

// A wrong password answers 403, not 401: 401 means "your session is
// invalid" to every client here (the app and the dashboard BFF both
// refresh-and-retry on it).
const WRONG_PASSWORD = { error: 'incorrect password' };

authRouter.get('/me', requireAuth, async (req, res) => {
  const [{ rows: users }, { rows: households }] = await Promise.all([
    pool.query('SELECT id, email, created_at, is_admin FROM users WHERE id = $1', [req.userId]),
    pool.query(
      `SELECT h.id, h.name, hm.role
       FROM household_members hm
       JOIN households h ON h.id = hm.household_id
       WHERE hm.user_id = $1
       ORDER BY h.id`,
      [req.userId],
    ),
  ]);
  const user = users[0];
  if (!user) {
    return res.status(401).json({ error: 'account no longer exists' });
  }
  res.json({
    id: Number(user.id),
    email: user.email,
    createdAt: user.created_at,
    isAdmin: user.is_admin === true,
    households: households.map((h) => ({ id: Number(h.id), name: h.name, role: h.role })),
  });
});

const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

/** Signs out every session (all refresh tokens revoked) and returns a fresh
 * pair for the caller. API keys are deliberately left valid. */
authRouter.patch('/password', requireAuth, sensitiveLimiter, async (req, res) => {
  const parsed = passwordChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  if (!(await verifyPasswordForUser(req.userId, parsed.data.currentPassword))) {
    return res.status(403).json(WRONG_PASSWORD);
  }
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, req.userId]);
    await revokeAllRefreshTokens(req.userId, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await issueTokenPair(req.userId, res);
});

const emailChangeSchema = z.object({
  newEmail: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

authRouter.patch('/email', requireAuth, sensitiveLimiter, async (req, res) => {
  const parsed = emailChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  if (!(await verifyPasswordForUser(req.userId, parsed.data.password))) {
    return res.status(403).json(WRONG_PASSWORD);
  }
  try {
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [parsed.data.newEmail, req.userId]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email already registered' });
    }
    throw err;
  }
  res.json({ id: req.userId, email: parsed.data.newEmail });
});

const deleteAccountSchema = z.object({
  password: z.string().min(1).max(128),
});

/** Deletes the account in ONE transaction — see auth/deleteAccount.js for
 * exactly what happens to shared households, devices and groups. */
authRouter.delete('/account', requireAuth, sensitiveLimiter, async (req, res) => {
  const parsed = deleteAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  if (!(await verifyPasswordForUser(req.userId, parsed.data.password))) {
    return res.status(403).json(WRONG_PASSWORD);
  }
  const userId = req.userId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await wouldRemoveLastAdmin(client, userId)) {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'you are the only admin; promote another admin before deleting your account' });
    }
    await deleteUserAccount(client, userId);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.status(204).end();
});
