/**
 * Locks every active admin row (is_admin AND not disabled) for the rest of
 * the transaction on `client` and returns their ids. Two admins demoting/
 * disabling/deleting each other concurrently serialize on these locks, and
 * the second one re-evaluates the WHERE after the first commits — so the
 * "never zero active admins" check can't be raced.
 */
export async function lockActiveAdminIds(client) {
  const { rows } = await client.query(
    'SELECT id FROM users WHERE is_admin AND disabled_at IS NULL ORDER BY id FOR UPDATE',
  );
  return rows.map((r) => Number(r.id));
}

/** True when removing `userId` from the active admins would leave none. */
export async function wouldRemoveLastAdmin(client, userId) {
  const ids = await lockActiveAdminIds(client);
  return ids.includes(Number(userId)) && ids.length <= 1;
}
