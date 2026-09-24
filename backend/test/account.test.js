import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';

import bcrypt from 'bcryptjs';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { signAccessToken, verifyAccessToken } = await import('../src/auth/tokens.js');

const PASSWORD = 'correct-horse-battery';
const PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);

/** Routes pool.query (and transaction clients) by SQL substring; unmatched
 * statements (BEGIN/COMMIT/UPDATE ...) resolve to no rows. */
function mockDb(handlers = []) {
  const calls = [];
  const all = [
    ['SELECT password_hash FROM users WHERE id', () => [{ password_hash: PASSWORD_HASH }]],
    ...handlers,
  ];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    for (const [needle, fn] of all) {
      if (sql.includes(needle)) {
        const r = await fn(params, sql);
        return Array.isArray(r) ? { rows: r, rowCount: r.length } : r;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  mock.method(pool, 'query', query);
  mock.method(pool, 'connect', async () => ({ query, release() {} }));
  return calls;
}

async function start(t, userId) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    mock.restoreAll();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jwt = signAccessToken(userId);
  return (path, { body, ...init } = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

const firstWords = (calls) => calls.map((c) => c.sql.trim().replace(/\s+/g, ' '));

test('GET /auth/me returns the profile and households', async (t) => {
  const createdAt = new Date('2026-01-01T00:00:00Z');
  mockDb([
    ['SELECT id, email, created_at, is_admin FROM users', () => [{ id: 101, email: 'me@example.com', created_at: createdAt, is_admin: false }]],
    ['FROM household_members hm', () => [{ id: 1, name: 'Home', role: 'owner' }]],
  ]);
  const call = await start(t, 101);
  const res = await call('/auth/me');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: 101,
    email: 'me@example.com',
    createdAt: createdAt.toISOString(),
    isAdmin: false,
    households: [{ id: 1, name: 'Home', role: 'owner' }],
  });
});

test('PATCH /auth/password: wrong current password is 403 and changes nothing', async (t) => {
  const calls = mockDb();
  const call = await start(t, 102);
  const res = await call('/auth/password', {
    method: 'PATCH',
    body: { currentPassword: 'wrong-password', newPassword: 'new-password-123' },
  });
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.sql.includes('UPDATE users')));
});

test('PATCH /auth/password updates the hash, revokes all refresh tokens, returns a new pair', async (t) => {
  const calls = mockDb();
  const call = await start(t, 103);
  const res = await call('/auth/password', {
    method: 'PATCH',
    body: { currentPassword: PASSWORD, newPassword: 'new-password-123' },
  });
  assert.equal(res.status, 200);
  const { accessToken, refreshToken } = await res.json();
  assert.equal(verifyAccessToken(accessToken).sub, '103');
  assert.match(refreshToken, /^[0-9a-f]{64}$/);

  const sql = firstWords(calls);
  const begin = sql.indexOf('BEGIN');
  const update = sql.findIndex((s) => s.startsWith('UPDATE users SET password_hash'));
  const revoke = sql.findIndex((s) => s.startsWith('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id'));
  const commit = sql.indexOf('COMMIT');
  const insert = sql.findIndex((s) => s.startsWith('INSERT INTO refresh_tokens'));
  assert.ok(begin < update && update < revoke && revoke < commit && commit < insert, sql.join('\n'));
  const newHash = calls[update].params[0];
  assert.ok(await bcrypt.compare('new-password-123', newHash));
  assert.deepEqual(calls[revoke].params, [103]);
});

test('PATCH /auth/email: 409 when taken, 200 otherwise', async (t) => {
  let taken = true;
  mockDb([
    ['UPDATE users SET email', () => {
      if (taken) throw Object.assign(new Error('dup'), { code: '23505' });
      return [];
    }],
  ]);
  const call = await start(t, 104);
  let res = await call('/auth/email', { method: 'PATCH', body: { newEmail: 'Taken@Example.com', password: PASSWORD } });
  assert.equal(res.status, 409);
  taken = false;
  res = await call('/auth/email', { method: 'PATCH', body: { newEmail: 'New@Example.com', password: PASSWORD } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 104, email: 'new@example.com' });
  res = await call('/auth/email', { method: 'PATCH', body: { newEmail: 'x@example.com', password: 'nope' } });
  assert.equal(res.status, 403);
});

test('sensitive routes allow 5 failed attempts per 15 minutes per account', async (t) => {
  mockDb();
  const call = await start(t, 105);
  for (let i = 0; i < 5; i += 1) {
    const res = await call('/auth/account', { method: 'DELETE', body: { password: 'wrong' } });
    assert.equal(res.status, 403);
  }
  const res = await call('/auth/account', { method: 'DELETE', body: { password: PASSWORD } });
  assert.equal(res.status, 429);
});

test('DELETE /auth/account promotes, unclaims, reassigns and deletes in one transaction', async (t) => {
  const USER = 106;
  const calls = mockDb([
    ['FOR UPDATE OF h', () => [{ household_id: 1 }, { household_id: 2 }, { household_id: 3 }]],
    ['SELECT user_id, role FROM household_members', ([householdId]) => ({
      1: [{ user_id: 20, role: 'member' }, { user_id: 21, role: 'member' }], // sole owner, others remain
      2: [], // only member
      3: [{ user_id: 30, role: 'owner' }], // someone else's household
    })[householdId]],
  ]);
  const call = await start(t, USER);
  const res = await call('/auth/account', { method: 'DELETE', body: { password: PASSWORD } });
  assert.equal(res.status, 204);

  const tx = calls
    .filter((c) => !c.sql.includes('SELECT password_hash'))
    .map((c) => ({ sql: c.sql.trim().replace(/\s+/g, ' '), params: c.params }));
  const find = (prefix, params) =>
    tx.findIndex((c) => c.sql.startsWith(prefix) && (!params || JSON.stringify(c.params) === JSON.stringify(params)));

  assert.equal(tx[0].sql, 'BEGIN');
  assert.equal(tx.at(-1).sql, 'COMMIT');
  // hh1: earliest-joined member promoted, groups handed over.
  const promote = find("UPDATE household_members SET role = 'owner'", [1, 20]);
  assert.ok(promote > 0);
  assert.ok(find('UPDATE groups SET owner_user_id', [20, 1, USER]) > promote);
  // hh2: schedules disabled, devices unclaimed, groups + household deleted.
  const disable = find('UPDATE device_schedules SET enabled = false', [2]);
  const unclaim = find('UPDATE devices SET owner_user_id = NULL, household_id = NULL', [2]);
  const dropGroups = find('DELETE FROM groups WHERE household_id', [2]);
  const dropHousehold = find('DELETE FROM households WHERE id', [2]);
  assert.ok(disable > 0 && disable < unclaim && unclaim < dropGroups && dropGroups < dropHousehold);
  // hh3: no promotion, groups go to the existing owner.
  assert.equal(find("UPDATE household_members SET role = 'owner'", [3, 30]), -1);
  assert.ok(find('UPDATE groups SET owner_user_id', [30, 3, USER]) > 0);
  // Only one promotion overall, and the user row goes last.
  assert.equal(tx.filter((c) => c.sql.startsWith("UPDATE household_members SET role = 'owner'")).length, 1);
  assert.equal(find('DELETE FROM users WHERE id', [USER]), tx.length - 2);
});

test('DELETE /auth/account with a wrong password deletes nothing', async (t) => {
  const calls = mockDb();
  const call = await start(t, 107);
  const res = await call('/auth/account', { method: 'DELETE', body: { password: 'nope' } });
  assert.equal(res.status, 403);
  assert.ok(!calls.some((c) => c.sql.includes('DELETE FROM users')));
});

// --- Household invites / leaving -------------------------------------------

function householdDb(extra = []) {
  return mockDb([
    // user is owner of 1, member of 2
    ['SELECT household_id, role FROM household_members WHERE user_id', () => [
      { household_id: 1, role: 'owner' },
      { household_id: 2, role: 'member' },
    ]],
    ...extra,
  ]);
}

test('GET /households/:id/invites lists pending outgoing invites to members only', async (t) => {
  householdDb([
    ['FROM household_invites i', ([id]) => (id === 2
      ? [{ id: 9, invitedUserId: 50, invitedEmail: 'friend@example.com', invitedByEmail: 'owner@example.com', createdAt: new Date() }]
      : [])],
  ]);
  const call = await start(t, 110);
  const res = await call('/households/2/invites');
  assert.equal(res.status, 200);
  const { invites } = await res.json();
  assert.equal(invites[0].invitedEmail, 'friend@example.com');
  assert.equal((await call('/households/5/invites')).status, 404);
});

test('DELETE /households/:id/invites/:inviteId is owner-only', async (t) => {
  const calls = householdDb([
    ['DELETE FROM household_invites', ([inviteId]) => (inviteId === 9 ? [{ id: 9 }] : [])],
  ]);
  const call = await start(t, 111);
  assert.equal((await call('/households/2/invites/9', { method: 'DELETE' })).status, 404); // member
  assert.equal((await call('/households/1/invites/9', { method: 'DELETE' })).status, 204);
  assert.equal((await call('/households/1/invites/8', { method: 'DELETE' })).status, 404);
  const del = calls.find((c) => c.sql.includes('DELETE FROM household_invites') && c.params[0] === 9);
  assert.deepEqual(del.params, [9, 1]);
});

test('members can leave; only owners remove others; the last owner stays', async (t) => {
  const USER = 112;
  householdDb([
    ['DELETE FROM household_members', ([householdId, userId]) =>
      householdId === 2 && userId === USER ? [{ role: 'member' }] : []],
    ['SELECT 1 FROM household_members', () => [{ '?column?': 1 }]],
  ]);
  const call = await start(t, USER);
  assert.equal((await call(`/households/2/members/${USER}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call('/households/2/members/999', { method: 'DELETE' })).status, 403);
  const lastOwner = await call(`/households/1/members/${USER}`, { method: 'DELETE' });
  assert.equal(lastOwner.status, 409);
  assert.equal((await call(`/households/7/members/${USER}`, { method: 'DELETE' })).status, 404);
});
