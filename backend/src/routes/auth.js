import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import {
  createRefreshToken,
  revokeRefreshToken,
  signAccessToken,
  verifyRefreshToken,
} from '../auth/tokens.js';
import { pool } from '../db/pool.js';

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

  const { rows } = await pool.query(
    'SELECT id, password_hash FROM users WHERE email = $1',
    [email],
  );
  const user = rows[0];
  // Always run bcrypt.compare, even with no matching user (against a fixed
  // dummy hash), so a bad email and a bad password take the same time —
  // avoids leaking which emails are registered via response timing.
  const hashToCheck =
    user?.password_hash ??
    '$2a$10$CwTycUXWue0Thq9StjUM0uJ8Yb1qsm.MtRhAxIzTv6HqSlvBk4uYK';
  const valid = await bcrypt.compare(password, hashToCheck);

  if (!user || !valid) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  await issueTokenPair(user.id, res);
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
