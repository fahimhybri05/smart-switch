import { pool } from './pool.js';

/** Used outside request context (deviceServer.js, the automation engine). */
export async function getHouseholdMemberIds(householdId) {
  const { rows } = await pool.query(
    'SELECT user_id FROM household_members WHERE household_id = $1',
    [householdId],
  );
  return rows.map((r) => r.user_id);
}

/** Mirrors the DB lookup `middleware/household.js`'s `attachHouseholds` does
 * for the REST path — used by ws/clientServer.js, whose WS upgrade never
 * goes through that Express middleware. */
export async function getUserHouseholdIds(userId) {
  const { rows } = await pool.query(
    'SELECT household_id FROM household_members WHERE user_id = $1',
    [userId],
  );
  return rows.map((r) => r.household_id);
}
