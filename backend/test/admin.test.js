import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mock, test } from 'node:test';

import bcrypt from 'bcryptjs';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/auth/tokens.js');
const { hashDeviceSecret } = await import('../src/auth/deviceSecret.js');
const { generateApiKey } = await import('../src/auth/apiKeys.js');
const { authenticateDevice, extractDiagnostics } = await import('../src/ws/deviceServer.js');
const { registerClient, registerDevice, unregisterClient, unregisterDevice } = await import(
  '../src/ws/registry.js'
);

const ADMIN = 1;
const OTHER_ADMIN = 2;
const USER = 5;
const PASSWORD = 'correct-horse-battery';
const PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);

/**
 * In-memory users table consulted by requireAdmin and the row locks.
 * `activeAdmins` overrides what the admin-row lock returns (to simulate a
 * concurrent demotion racing the request).
 */
function mockDb({ users: userOverrides = {}, activeAdmins, extra = [] } = {}) {
  const users = {
    [ADMIN]: { id: ADMIN, email: 'admin@example.com', is_admin: true, disabled_at: null },
    [OTHER_ADMIN]: { id: OTHER_ADMIN, email: 'second@example.com', is_admin: true, disabled_at: null },
    [USER]: { id: USER, email: 'user@example.com', is_admin: false, disabled_at: null },
    ...userOverrides,
  };
  const calls = [];
  const handlers = [
    ...extra,
    ['FROM users WHERE id = $1 AND is_admin AND disabled_at IS NULL', ([id]) => {
      const u = users[id];
      return u && u.is_admin && !u.disabled_at ? [{ email: u.email }] : [];
    }],
    ['ORDER BY id FOR UPDATE', () =>
      (activeAdmins ?? Object.values(users).filter((u) => u.is_admin && !u.disabled_at).map((u) => u.id))
        .map((id) => ({ id }))],
    ['SELECT id, email, is_admin, disabled_at FROM users WHERE id = $1 FOR UPDATE', ([id]) =>
      (users[id] ? [users[id]] : [])],
    ['AS household_count', ([id]) => (users[id]
      ? [{ ...users[id], created_at: new Date(), household_count: 1, device_count: 2, api_key_count: 0, last_active_at: null }]
      : [])],
  ];
  const query = async (sql, params = []) => {
    calls.push({ sql: sql.trim().replace(/\s+/g, ' '), params });
    for (const [needle, fn] of handlers) {
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

async function start(t, userId = ADMIN) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    mock.restoreAll();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, { body, token = userId == null ? null : signAccessToken(userId), ...init } = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  closedWith = null;
  send() {}
  close(code, reason) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.emit('close', code, reason);
  }
}

const idx = (calls, prefix) => calls.findIndex((c) => c.sql.startsWith(prefix));
const has = (calls, needle) => calls.some((c) => c.sql.includes(needle));

/* ------------------------------ requireAdmin ------------------------------ */

test('requireAdmin: non-admins and disabled admins get 403 admin only; no token is 401', async (t) => {
  mockDb({ users: { 3: { id: 3, email: 'off@example.com', is_admin: true, disabled_at: new Date() } } });
  const asUser = await start(t, USER);
  let res = await asUser('/admin/stats');
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'admin only' });

  res = await asUser('/admin/users', { token: signAccessToken(3) }); // disabled admin
  assert.equal(res.status, 403);

  res = await asUser('/admin/users', { token: null });
  assert.equal(res.status, 401);
  res = await asUser('/admin/users', { token: generateApiKey() }); // API keys never work here
  assert.equal(res.status, 401);
});

test('GET /admin/stats returns the documented shape', async (t) => {
  mockDb({
    extra: [
      ['AS users_total', () => [{
        users_total: 12, users_admins: 2, users_disabled: 1, devices_total: 9, devices_claimed: 7,
        activity_24h: 40, api_keys_active: 3, hooks_active: 4,
      }]],
      ['GROUP BY source', () => [{ source: 'app', n: 30 }, { source: 'widget', n: 10 }]],
    ],
  });
  const dev = new FakeWs();
  registerDevice('esp-stats-a', dev);
  t.after(() => unregisterDevice('esp-stats-a', dev));
  const call = await start(t);
  const res = await call('/admin/stats');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.users, { total: 12, admins: 2, disabled: 1 });
  assert.equal(body.devices.total, 9);
  assert.equal(body.devices.claimed, 7);
  assert.equal(body.devices.unclaimed, 2);
  assert.ok(body.devices.online >= 1);
  assert.deepEqual(body.activity, { last24h: 40, bySource24h: { app: 30, widget: 10 } });
  assert.deepEqual(body.apiKeys, { active: 3 });
  assert.deepEqual(body.hooks, { active: 4 });
});

test('GET /admin/users escapes ILIKE wildcards and never selects password hashes', async (t) => {
  const calls = mockDb({ extra: [['SELECT count(*) AS n FROM users', () => [{ n: 1 }]]] });
  const call = await start(t);
  const res = await call('/admin/users?q=a_b%25&limit=10&offset=20');
  assert.equal(res.status, 200);
  const list = calls.find((c) => c.sql.includes('AS household_count') && c.sql.includes('ILIKE'));
  assert.deepEqual(list.params, ['%a\\_b\\%%', 10, 20]);
  assert.ok(!calls.some((c) => c.sql.includes('password_hash')));
  assert.equal((await res.json()).total, 1);
});

/* ------------------------------- Self guards ------------------------------ */

test('an admin cannot disable, demote or delete themselves', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  for (const [path, init] of [
    [`/admin/users/${ADMIN}/disable`, { method: 'POST' }],
    [`/admin/users/${ADMIN}`, { method: 'PATCH', body: { isAdmin: false } }],
    [`/admin/users/${ADMIN}`, { method: 'DELETE' }],
  ]) {
    const res = await call(path, init);
    assert.equal(res.status, 400, path);
    assert.match((await res.json()).error, /your own/);
  }
  assert.ok(!has(calls, 'UPDATE users'));
  assert.ok(!has(calls, 'DELETE FROM users'));
  assert.ok(!has(calls, 'INSERT INTO admin_audit_log'));
});

/* ---------------------------- Last-admin guard ---------------------------- */

test('never leaves zero active admins: 409 and a rollback', async (t) => {
  // Only OTHER_ADMIN still counts as active once the row locks are taken
  // (e.g. ADMIN was demoted by a concurrent request).
  const calls = mockDb({ activeAdmins: [OTHER_ADMIN] });
  const call = await start(t);
  for (const [path, init] of [
    [`/admin/users/${OTHER_ADMIN}/disable`, { method: 'POST' }],
    [`/admin/users/${OTHER_ADMIN}`, { method: 'PATCH', body: { isAdmin: false } }],
    [`/admin/users/${OTHER_ADMIN}`, { method: 'DELETE' }],
  ]) {
    const res = await call(path, init);
    assert.equal(res.status, 409, path);
  }
  assert.ok(!has(calls, 'UPDATE users'));
  assert.ok(!has(calls, 'DELETE FROM users'));
  assert.ok(!has(calls, 'INSERT INTO admin_audit_log'));
  assert.equal(calls.filter((c) => c.sql === 'ROLLBACK').length, 3);
});

test('demoting another admin works while a second active admin remains', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  const res = await call(`/admin/users/${OTHER_ADMIN}`, { method: 'PATCH', body: { isAdmin: false } });
  assert.equal(res.status, 200);
  const update = calls.find((c) => c.sql.startsWith('UPDATE users SET is_admin'));
  assert.deepEqual(update.params, [false, OTHER_ADMIN]);
  const auditRow = calls.find((c) => c.sql.startsWith('INSERT INTO admin_audit_log'));
  assert.equal(auditRow.params[2], 'user.demote');
});

/* --------------------------------- Disable -------------------------------- */

test('disable: sets disabled_at, revokes sessions, audits, closes live sockets — one transaction', async (t) => {
  const calls = mockDb();
  const client = new FakeWs();
  registerClient(USER, client);
  t.after(() => unregisterClient(USER, client));
  const call = await start(t);

  const res = await call(`/admin/users/${USER}/disable`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.id, USER);

  const begin = idx(calls, 'BEGIN');
  const lockAdmins = idx(calls, 'SELECT id FROM users WHERE is_admin');
  const lockUser = idx(calls, 'SELECT id, email, is_admin, disabled_at FROM users');
  const disable = idx(calls, 'UPDATE users SET disabled_at = now()');
  const revoke = idx(calls, 'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id');
  const auditIdx = idx(calls, 'INSERT INTO admin_audit_log');
  const commit = idx(calls, 'COMMIT');
  assert.ok(
    begin < lockAdmins && lockAdmins < lockUser && lockUser < disable && disable < revoke &&
      revoke < auditIdx && auditIdx < commit,
    calls.map((c) => c.sql).join('\n'),
  );
  assert.deepEqual(calls[revoke].params, [USER]);
  assert.deepEqual(calls[auditIdx].params, [
    ADMIN,
    'admin@example.com',
    'user.disable',
    'user',
    String(USER),
    JSON.stringify({ email: 'user@example.com' }),
  ]);
  assert.equal(client.closedWith?.code, 4001);
});

test('reset-password hashes the new password, revokes sessions and never logs it', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  let res = await call(`/admin/users/${USER}/reset-password`, { method: 'POST', body: { newPassword: 'short' } });
  assert.equal(res.status, 400);
  res = await call(`/admin/users/${USER}/reset-password`, {
    method: 'POST',
    body: { newPassword: 'brand-new-password' },
  });
  assert.equal(res.status, 204);
  const update = calls.find((c) => c.sql.startsWith('UPDATE users SET password_hash'));
  assert.ok(await bcrypt.compare('brand-new-password', update.params[0]));
  assert.ok(has(calls, 'UPDATE refresh_tokens SET revoked_at'));
  const auditRow = calls.find((c) => c.sql.startsWith('INSERT INTO admin_audit_log'));
  assert.equal(auditRow.params[2], 'user.reset_password');
  assert.ok(!JSON.stringify(auditRow.params).includes('brand-new-password'));
});

test('admin delete runs deleteUserAccount and audits in the same transaction', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  assert.equal((await call('/admin/users/999', { method: 'DELETE' })).status, 404);
  const res = await call(`/admin/users/${USER}`, { method: 'DELETE' });
  assert.equal(res.status, 204);
  const del = idx(calls, 'DELETE FROM users WHERE id');
  const auditIdx = idx(calls, 'INSERT INTO admin_audit_log');
  assert.ok(idx(calls, 'SELECT h.id AS household_id') < del && del < auditIdx && auditIdx < calls.length - 1);
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.deepEqual(calls[del].params, [USER]);
});

/* ---------------------------- Disabled accounts --------------------------- */

test('disabled users: login and refresh answer 403 account disabled; a wrong password is still 401', async (t) => {
  const calls = mockDb({
    extra: [
      ['SELECT id, password_hash FROM users WHERE email', () => [{ id: USER, password_hash: PASSWORD_HASH }]],
      ['SELECT disabled_at FROM users WHERE id', () => [{ disabled_at: new Date() }]],
      ['FROM refresh_tokens', () => [{ user_id: USER }]],
    ],
  });
  const call = await start(t, null);
  let res = await call('/auth/login', { method: 'POST', body: { email: 'user@example.com', password: PASSWORD } });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'account disabled' });

  res = await call('/auth/login', { method: 'POST', body: { email: 'user@example.com', password: 'wrong-password' } });
  assert.equal(res.status, 401);

  res = await call('/auth/refresh', { method: 'POST', body: { refreshToken: 'a'.repeat(64) } });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'account disabled' });
  assert.ok(!has(calls, 'INSERT INTO refresh_tokens'));
});

test('API keys and hook URLs of disabled users are filtered out in SQL', async (t) => {
  const calls = mockDb();
  const call = await start(t, null);
  const res = await call('/v1/switches', { token: generateApiKey() });
  assert.equal(res.status, 401);
  const lookup = calls.find((c) => c.sql.includes('k.key_hash'));
  assert.match(lookup.sql, /JOIN users u ON u.id = k.user_id AND u.disabled_at IS NULL/);

  const hookRes = await call(`/v1/hook/wh_${'A'.repeat(43)}/status`);
  assert.equal(hookRes.status, 404);
  const hookLookup = calls.find((c) => c.sql.includes('WHERE h.token_hash'));
  assert.match(hookLookup.sql, /JOIN users u ON u.id = k.user_id AND u.disabled_at IS NULL/);
});

test('GET /auth/me exposes isAdmin', async (t) => {
  mockDb({
    extra: [['SELECT id, email, created_at, is_admin FROM users', () => [
      { id: ADMIN, email: 'admin@example.com', created_at: new Date(), is_admin: true },
    ]]],
  });
  const call = await start(t);
  const res = await call('/auth/me');
  assert.equal((await res.json()).isAdmin, true);
});

test('the last admin cannot self-delete via /auth/account', async (t) => {
  const calls = mockDb({
    activeAdmins: [ADMIN],
    extra: [['SELECT password_hash FROM users WHERE id', () => [{ password_hash: PASSWORD_HASH }]]],
  });
  const call = await start(t);
  const res = await call('/auth/account', { method: 'DELETE', body: { password: PASSWORD } });
  assert.equal(res.status, 409);
  assert.ok(!has(calls, 'DELETE FROM users'));
});

/* --------------------------------- Devices -------------------------------- */

test('reset-secret NULLs the hash, audits, and drops the live socket', async (t) => {
  const calls = mockDb({
    extra: [['FROM devices WHERE device_id = $1 FOR UPDATE', ([id]) =>
      id === 'esp-reset-a' ? [{ device_id: id, household_id: 10, owner_user_id: USER }] : []]],
  });
  const dev = new FakeWs();
  registerDevice('esp-reset-a', dev);
  t.after(() => unregisterDevice('esp-reset-a', dev));
  const call = await start(t);

  assert.equal((await call('/admin/devices/nope/reset-secret', { method: 'POST' })).status, 404);
  const res = await call('/admin/devices/esp-reset-a/reset-secret', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { deviceId: 'esp-reset-a', disconnected: true });
  const reset = calls.find((c) => c.sql.startsWith('UPDATE devices SET cloud_secret_hash = NULL'));
  assert.deepEqual(reset.params, ['esp-reset-a']);
  const auditRow = calls.find((c) => c.sql.startsWith('INSERT INTO admin_audit_log'));
  assert.deepEqual(auditRow.params.slice(2, 5), ['device.reset_secret', 'device', 'esp-reset-a']);
  assert.equal(dev.closedWith?.code, 4000);
});

test('unclaim disables schedules and clears the household; reassign picks the household owner', async (t) => {
  const calls = mockDb({
    extra: [
      ['FROM devices WHERE device_id = $1 FOR UPDATE', ([id]) => [{ device_id: id, household_id: 10, owner_user_id: USER }]],
      ['SELECT id, name FROM households WHERE id', ([id]) => (id === 20 ? [{ id: 20, name: 'Cabin' }] : [])],
      ["role = 'owner'", () => [{ user_id: 42 }]],
    ],
  });
  const call = await start(t);
  let res = await call('/admin/devices/esp-a/unclaim', { method: 'POST' });
  assert.equal(res.status, 200);
  const disable = idx(calls, 'UPDATE device_schedules SET enabled = false');
  const unclaim = idx(calls, 'UPDATE devices SET owner_user_id = NULL, household_id = NULL');
  assert.ok(disable > 0 && disable < unclaim);

  res = await call('/admin/devices/esp-a/reassign', { method: 'POST', body: { householdId: 99 } });
  assert.equal(res.status, 404);
  res = await call('/admin/devices/esp-a/reassign', { method: 'POST', body: { householdId: 20 } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ownerUserId, 42);
  const move = calls.find((c) => c.sql.startsWith('UPDATE devices SET household_id'));
  assert.deepEqual(move.params, [20, 42, 'esp-a']);
});

test('authenticateDevice: a NULL hash adopts the presented secret atomically', async (t) => {
  t.after(() => mock.restoreAll());
  const SECRET = 'a-brand-new-secret-after-factory-reset';
  let adopted = false;
  const calls = mockDb({
    extra: [
      ['SELECT household_id, cloud_secret_hash FROM devices', () => [
        { household_id: 10, cloud_secret_hash: adopted ? hashDeviceSecret(SECRET) : null },
      ]],
      ['WHERE device_id = $1 AND cloud_secret_hash IS NULL', () => {
        if (adopted) return [];
        adopted = true;
        return [{ household_id: 10 }];
      }],
    ],
  });
  const diag = extractDiagnostics({ fw: '1.2.3', rssi: -61, freeHeap: 21000, resetReason: 'Power On', uptimeS: 5 });
  assert.deepEqual(await authenticateDevice('esp-null-a', SECRET, diag), { householdId: 10 });
  const adopt = calls.find((c) => c.sql.includes('cloud_secret_hash IS NULL'));
  assert.match(adopt.sql, /^UPDATE devices SET cloud_secret_hash = \$2/);
  assert.equal(adopt.params[0], 'esp-null-a');
  assert.equal(adopt.params[1], hashDeviceSecret(SECRET));
  assert.equal(JSON.parse(adopt.params[2]).fw, '1.2.3');

  // Once adopted, a different secret is rejected like any mismatch.
  assert.equal(await authenticateDevice('esp-null-a', 'some-other-secret-value-123'), null);
  // ...and the adopted one keeps working (plain reconnect path).
  assert.deepEqual(await authenticateDevice('esp-null-a', SECRET), { householdId: 10 });
});

test('authenticateDevice: losing the adoption race re-validates against the winner', async (t) => {
  t.after(() => mock.restoreAll());
  let reads = 0;
  mockDb({
    extra: [
      ['SELECT household_id, cloud_secret_hash FROM devices', () => {
        reads += 1;
        // First read sees the reset (NULL); the re-read sees the winner's hash.
        return [{ household_id: 10, cloud_secret_hash: reads === 1 ? null : hashDeviceSecret('winner-secret-xxxxxxxx') }];
      }],
      ['WHERE device_id = $1 AND cloud_secret_hash IS NULL', () => []],
    ],
  });
  assert.equal(await authenticateDevice('esp-race-a', 'loser-secret-yyyyyyyyyy'), null);
  assert.equal(reads, 2);
});

test('extractDiagnostics keeps known fields only, sanitized', () => {
  assert.equal(extractDiagnostics({ deviceId: 'x', cloudSecret: 'y' }), null);
  const d = extractDiagnostics({ fw: 'x'.repeat(100), rssi: -70, evil: 'nope', freeHeap: '123' });
  assert.equal(d.fw.length, 64);
  assert.equal(d.rssi, -70);
  assert.equal(d.freeHeap, '123');
  assert.equal(d.evil, undefined);
  assert.ok(!Number.isNaN(Date.parse(d.at)));
});

test('/devices/claim adopts the secret when the stored hash was reset', async (t) => {
  const calls = mockDb({
    extra: [
      ['SELECT household_id, role FROM household_members WHERE user_id', () => [{ household_id: 10, role: 'owner' }]],
      ['SELECT household_id, cloud_secret_hash, friendly_name FROM devices', () => [
        { household_id: 10, cloud_secret_hash: null, friendly_name: 'Hall' },
      ]],
    ],
  });
  const call = await start(t, USER);
  const res = await call('/devices/claim', {
    method: 'POST',
    body: { deviceId: 'esp-claim-a', cloudSecret: 'new-secret-after-reset-123' },
  });
  assert.equal(res.status, 200);
  const update = calls.find((c) => c.sql.startsWith('UPDATE devices SET owner_user_id'));
  assert.match(update.sql, /cloud_secret_hash = COALESCE\(cloud_secret_hash, \$5\)/);
  assert.equal(update.params[4], hashDeviceSecret('new-secret-after-reset-123'));
});

/* ----------------------------- API keys / audit ---------------------------- */

test('admin API-key revoke revokes the key and its hooks, with an audit row', async (t) => {
  const calls = mockDb({
    extra: [['UPDATE api_keys SET revoked_at', ([id]) =>
      id === 11 ? [{ id: 11, user_id: USER, name: 'HA', prefix: 'sk_abcdefgh' }] : []]],
  });
  const call = await start(t);
  assert.equal((await call('/admin/api-keys/12', { method: 'DELETE' })).status, 404);
  assert.equal((await call('/admin/api-keys/11', { method: 'DELETE' })).status, 204);
  const revoke = calls.findLast((c) => c.sql.startsWith('UPDATE api_keys SET revoked_at'));
  assert.deepEqual(revoke.params, [11, null]);
  assert.ok(has(calls, 'UPDATE switch_hooks SET revoked_at'));
  const auditRow = calls.find((c) => c.sql.startsWith('INSERT INTO admin_audit_log'));
  assert.equal(auditRow.params[2], 'api_key.revoke');
});

test('GET /admin/audit is cursor-paginated newest first', async (t) => {
  const calls = mockDb({
    extra: [['FROM admin_audit_log', () => [{ id: 9, action: 'user.disable' }, { id: 8, action: 'user.enable' }]]],
  });
  const call = await start(t);
  const res = await call('/admin/audit?limit=2&before=10');
  assert.deepEqual(await res.json(), {
    entries: [{ id: 9, action: 'user.disable' }, { id: 8, action: 'user.enable' }],
    nextCursor: 8,
  });
  const q = calls.find((c) => c.sql.includes('FROM admin_audit_log'));
  assert.deepEqual(q.params, [10, 2]);
  assert.match(q.sql, /ORDER BY id DESC/);
});
