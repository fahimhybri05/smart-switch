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
