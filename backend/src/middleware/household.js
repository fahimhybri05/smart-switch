import { pool } from '../db/pool.js';

/**
 * Attaches `req.householdRoles` (Map<householdId string, 'owner'|'member'>)
 * and `req.defaultHouseholdId` (the caller's owner household, falling back
 * to whichever household they belong to first) for every household-aware
 * route. Mount after `requireAuth`.
 */
export async function attachHouseholds(req, res, next) {
  const { rows } = await pool.query(
    'SELECT household_id, role FROM household_members WHERE user_id = $1',
    [req.userId],
  );
  req.householdRoles = new Map(rows.map((r) => [String(r.household_id), r.role]));
  req.defaultHouseholdId =
    rows.find((r) => r.role === 'owner')?.household_id ?? rows[0]?.household_id ?? null;
  next();
}

export function isHouseholdMember(req, householdId) {
  return req.householdRoles.has(String(householdId));
}

export function isHouseholdOwner(req, householdId) {
  return req.householdRoles.get(String(householdId)) === 'owner';
}
