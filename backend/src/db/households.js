import { pool } from './pool.js';

/** Used outside request context (deviceServer.js, the automation engine). */
export async function getHouseholdMemberIds(householdId) {
  const { rows } = await pool.query(
    'SELECT user_id FROM household_members WHERE household_id = $1',
    [householdId],
  );
  return rows.map((r) => r.user_id);
}
