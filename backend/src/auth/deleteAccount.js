/**
 * Deletes user `userId` without collateral damage. Runs on `client`, which
 * must already be inside a transaction (the caller owns BEGIN/COMMIT):
 *  - household where the user is the sole owner but others remain: the
 *    earliest-joined remaining member is promoted to owner;
 *  - household where the user is the only member: its devices are unclaimed
 *    (their device schedules disabled so they stop firing on an ownerless
 *    device), its groups removed, and the household deleted;
 *  - groups the user created in surviving households are handed to that
 *    household's (remaining) owner instead of cascading away;
 *  - finally the user row goes (cascading refresh tokens, API keys + hooks,
 *    memberships and invites).
 * Shared by DELETE /auth/account (self-service) and DELETE /admin/users/:id.
 */
export async function deleteUserAccount(client, userId) {
  // Lock the user's households: a concurrent invite-accept inserts a
  // household_members row whose FK check needs a lock on the household
  // row, so it waits for us instead of joining a household mid-delete.
  const { rows: memberships } = await client.query(
    `SELECT h.id AS household_id
     FROM household_members hm
     JOIN households h ON h.id = hm.household_id
     WHERE hm.user_id = $1
     ORDER BY h.id
     FOR UPDATE OF h`,
    [userId],
  );

  for (const { household_id: householdId } of memberships) {
    const { rows: others } = await client.query(
      `SELECT user_id, role FROM household_members
       WHERE household_id = $1 AND user_id <> $2
       ORDER BY joined_at, user_id`,
      [householdId, userId],
    );

    if (others.length === 0) {
      await client.query(
        `UPDATE device_schedules SET enabled = false
         WHERE device_id IN (SELECT device_id FROM devices WHERE household_id = $1)`,
        [householdId],
      );
      await client.query(
        'UPDATE devices SET owner_user_id = NULL, household_id = NULL WHERE household_id = $1',
        [householdId],
      );
      await client.query('DELETE FROM groups WHERE household_id = $1', [householdId]);
      await client.query('DELETE FROM households WHERE id = $1', [householdId]);
      continue;
    }

    let newOwnerId = others.find((m) => m.role === 'owner')?.user_id;
    if (!newOwnerId) {
      // No other owner means the user is the sole owner (every household
      // keeps at least one) — promote the earliest-joined member.
      newOwnerId = others[0].user_id;
      await client.query(
        `UPDATE household_members SET role = 'owner' WHERE household_id = $1 AND user_id = $2`,
        [householdId, newOwnerId],
      );
    }
    await client.query(
      'UPDATE groups SET owner_user_id = $1 WHERE household_id = $2 AND owner_user_id = $3',
      [newOwnerId, householdId, userId],
    );
  }

  await client.query('DELETE FROM users WHERE id = $1', [userId]);
}
