import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/auth/tokens.js');

const USER_ID = 7;
const HOUSEHOLD = 10;
const DEVICE = 'esp-group-a';

function mockDb({ groupHousehold = HOUSEHOLD } = {}) {
  const calls = [];
  const handlers = [
    ['FROM household_members WHERE user_id', () => [{ household_id: HOUSEHOLD, role: 'member' }]],
    ['FROM groups g', () => [
      { id: 3, householdId: HOUSEHOLD, name: 'Porch', members: [{ deviceId: DEVICE, channelIdx: 1 }] },
    ]],
    ['SELECT household_id FROM groups WHERE id', ([id]) => (id === 3 && groupHousehold ? [{ household_id: groupHousehold }] : [])],
    ['SELECT device_id FROM devices WHERE household_id', ([, ids]) => ids.filter((id) => id === DEVICE).map((device_id) => ({ device_id }))],
    ['INSERT INTO groups', () => [{ id: 42 }]],
  ];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
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

async function start(t) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    mock.restoreAll();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jwt = signAccessToken(USER_ID);
  return (path, { body, ...init } = {}) =>
    fetch(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
}

test('GET /groups returns each group with its householdId', async (t) => {
  const calls = mockDb();
  const call = await start(t);

  const res = await call('/groups');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.groups, [
    { id: 3, householdId: HOUSEHOLD, name: 'Porch', members: [{ deviceId: DEVICE, channelIdx: 1 }] },
  ]);
  const list = calls.find((c) => c.sql.includes('FROM groups g'));
  assert.match(list.sql, /g\.household_id AS "householdId"/);
  assert.deepEqual(list.params, [[HOUSEHOLD]]);
});

test('POST /groups creates in the default household and echoes householdId', async (t) => {
  const calls = mockDb();
  const call = await start(t);

  const res = await call('/groups', {
    method: 'POST',
    body: { name: 'Porch', members: [{ deviceId: DEVICE, channelIdx: 0 }] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: 42,
    householdId: HOUSEHOLD,
    name: 'Porch',
    members: [{ deviceId: DEVICE, channelIdx: 0 }],
  });
  const member = calls.find((c) => c.sql.includes('INSERT INTO group_members'));
  assert.deepEqual(member.params, [42, DEVICE, 0]);
  assert.ok(calls.some((c) => c.sql === 'COMMIT'));
});

test('POST /groups with an id updates in place (name + full member replace)', async (t) => {
  const calls = mockDb();
  const call = await start(t);

  const res = await call('/groups', {
    method: 'POST',
    body: { id: 3, name: 'Front', members: [{ deviceId: DEVICE, channelIdx: 2 }] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: 3,
    householdId: HOUSEHOLD,
    name: 'Front',
    members: [{ deviceId: DEVICE, channelIdx: 2 }],
  });
  assert.ok(calls.some((c) => c.sql.startsWith('UPDATE groups SET name') && c.params[0] === 'Front'));
  assert.ok(calls.some((c) => c.sql.startsWith('DELETE FROM group_members')));
});

test('POST /groups rejects a member device outside the household', async (t) => {
  const calls = mockDb();
  const call = await start(t);

  const res = await call('/groups', {
    method: 'POST',
    body: { name: 'Porch', members: [{ deviceId: 'someone-elses', channelIdx: 0 }] },
  });
  assert.equal(res.status, 403);
  assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
  assert.ok(!calls.some((c) => c.sql.includes('INSERT INTO groups')));
});

test('POST /groups with an unknown id is a 404', async (t) => {
  mockDb({ groupHousehold: null });
  const call = await start(t);

  const res = await call('/groups', { method: 'POST', body: { id: 3, name: 'X', members: [] } });
  assert.equal(res.status, 404);
});
