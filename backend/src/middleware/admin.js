import { pool } from '../db/pool.js';

/**
 * Admin-only gate. Mount after `requireAuth`. The admin flag is re-read
 * from the database on every request (never trusted from the JWT, which
 * carries no role anyway), so a demotion or disable takes effect on the
 * very next request. Attaches `req.adminEmail` for the audit log.
 */
export async function requireAdmin(req, res, next) {
  const { rows } = await pool.query(
    'SELECT email FROM users WHERE id = $1 AND is_admin AND disabled_at IS NULL',
    [req.userId],
  );
  if (rows.length === 0) {
    return res.status(403).json({ error: 'admin only' });
  }
  req.adminEmail = rows[0].email;
  next();
}
