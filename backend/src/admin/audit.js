import { pool } from '../db/pool.js';

/** Inserts one admin_audit_log row. `db` is the pool or a transaction
 * client — pass the client so the row commits/rolls back with the action. */
export async function writeAudit(
  db,
  { adminUserId = null, adminEmail = null, action, targetType = null, targetId = null, details = null },
) {
  await db.query(
    `INSERT INTO admin_audit_log (admin_user_id, admin_email, action, target_type, target_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      adminUserId,
      adminEmail,
      action,
      targetType,
      targetId == null ? null : String(targetId),
      details == null ? null : JSON.stringify(details),
    ],
  );
}

/** Audit row for an action taken by the admin making request `req`
 * (after requireAuth + requireAdmin). */
export function audit(db, req, action, targetType, targetId, details) {
  return writeAudit(db ?? pool, {
    adminUserId: req.userId,
    adminEmail: req.adminEmail ?? null,
    action,
    targetType,
    targetId,
    details,
  });
}
