import 'dotenv/config';

import { writeAudit } from '../admin/audit.js';
import { pool } from '../db/pool.js';

/**
 * One-time bootstrap (and break-glass recovery) for admin accounts:
 *
 *   npm run make-admin -- someone@example.com            # grant
 *   npm run make-admin -- someone@example.com --revoke   # remove
 *
 * Run from backend/ (reads DATABASE_URL from .env, like `npm run migrate`).
 * The account must already exist (sign up first). Writes an audit row with
 * admin_email 'cli'. After the first admin exists, promote/demote from the
 * dashboard's Admin > Users page instead.
 */
const USAGE = 'usage: npm run make-admin -- <email> [--revoke]';

async function run() {
  const args = process.argv.slice(2);
  const revoke = args.includes('--revoke');
  const unknown = args.filter((a) => a.startsWith('--') && a !== '--revoke');
  const emails = args.filter((a) => !a.startsWith('--'));
  if (unknown.length || emails.length !== 1) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const email = emails[0].trim().toLowerCase();
  const makeAdmin = !revoke;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id, email, is_admin, disabled_at FROM users WHERE email = $1 FOR UPDATE',
      [email],
    );
    const user = rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      console.error(`no account with email ${email} — sign up first`);
      process.exitCode = 1;
      return;
    }
    if (user.is_admin === makeAdmin) {
      await client.query('ROLLBACK');
      console.log(`${user.email} (id ${user.id}) is already ${makeAdmin ? 'an admin' : 'not an admin'} — nothing changed`);
      return;
    }
    await client.query('UPDATE users SET is_admin = $1 WHERE id = $2', [makeAdmin, user.id]);
    await writeAudit(client, {
      adminUserId: null,
      adminEmail: 'cli',
      action: makeAdmin ? 'user.promote' : 'user.demote',
      targetType: 'user',
      targetId: user.id,
      details: { email: user.email, via: 'cli' },
    });
    const { rows: remaining } = await client.query(
      'SELECT count(*) AS n FROM users WHERE is_admin AND disabled_at IS NULL',
    );
    await client.query('COMMIT');

    console.log(`${user.email} (id ${user.id}) is ${makeAdmin ? 'now an admin' : 'no longer an admin'}`);
    if (makeAdmin && user.disabled_at) {
      console.warn('warning: this account is disabled — it cannot use the admin console until re-enabled');
    }
    if (Number(remaining[0].n) === 0) {
      console.warn('warning: there are now no active admins — run make-admin again to add one');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

run()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
