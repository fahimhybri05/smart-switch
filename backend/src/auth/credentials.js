import bcrypt from 'bcryptjs';

import { pool } from '../db/pool.js';

// Compared against when no user matches, so a bad email and a bad password
// take the same time — avoids leaking which emails are registered.
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8Yb1qsm.MtRhAxIzTv6HqSlvBk4uYK';

/** Returns the user id for a valid email/password pair, else null. */
export async function verifyCredentials(email, password) {
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [
    email.trim().toLowerCase(),
  ]);
  const user = rows[0];
  const valid = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  return user && valid ? user.id : null;
}

/** True when `password` matches `userId`'s current password. Same
 * constant-time-ish dummy compare as verifyCredentials for unknown ids. */
export async function verifyPasswordForUser(userId, password) {
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  const valid = await bcrypt.compare(password, rows[0]?.password_hash ?? DUMMY_HASH);
  return Boolean(rows[0]) && valid;
}

/** True when the account exists and has been disabled by an admin. */
export async function isUserDisabled(userId) {
  const { rows } = await pool.query('SELECT disabled_at FROM users WHERE id = $1', [userId]);
  return rows[0]?.disabled_at != null;
}
