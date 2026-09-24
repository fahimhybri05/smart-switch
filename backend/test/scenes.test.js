import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/auth/tokens.js');
const { takeAttribution } = await import('../src/ws/attribution.js');
const { registerDevice, resolveDeviceResponse, unregisterDevice } = await import('../src/ws/registry.js');

const USER_ID = 7;
const HOUSEHOLD = 10;
const ONLINE = 'esp-scene-a';
const OFFLINE = 'esp-scene-b';
const CREATED = new Date('2026-09-24T10:00:00Z');

function sceneRow(overrides = {}) {
  return {
    id: 3, householdId: HOUSEHOLD, name: 'Movie', icon: 'movie',
    actions: [{ deviceId: ONLINE, channelIdx: 0, state: 'OFF' }],
    createdAt: CREATED, updatedAt: CREATED, ...overrides,
  };
}

function mockDb({ sceneHousehold = HOUSEHOLD, runActions = [], lockedChannels = [] } = {}) {
  const calls = [];
  const handlers = [
    ['AS k(device_id, channel_idx)', ([deviceId, idx]) => [{
      locked: lockedChannels.includes(`${deviceId}:${idx}`), min_off_s: null, state: null, state_age_s: null,
    }]],
    ['FROM household_members WHERE user_id', () => [{ household_id: HOUSEHOLD, role: 'member' }]],
    ['SELECT household_id, actions FROM scenes', ([id]) =>
      (id === 3 && sceneHousehold ? [{ household_id: sceneHousehold, actions: runActions }] : [])],
    ['SELECT household_id FROM scenes WHERE id', ([id]) => (id === 3 && sceneHousehold ? [{ household_id: sceneHousehold }] : [])],
    ['SELECT device_id FROM devices WHERE household_id', ([, ids]) =>
      ids.filter((id) => id === ONLINE || id === OFFLINE).map((device_id) => ({ device_id }))],
    ['FROM scenes WHERE household_id', () => [sceneRow()]],
    ['INSERT INTO scenes', (p) => [sceneRow({ id: 42, householdId: p[0], name: p[1], icon: p[2], actions: JSON.parse(p[3]) })]],
    ['UPDATE scenes SET', (p) => [sceneRow({ id: p[0], name: p[1], actions: JSON.parse(p[2]), icon: p[4] ? p[3] : 'movie' })]],
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

test('GET /scenes lists the caller\'s households\' scenes', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  const res = await call('/scenes');
  assert.equal(res.status, 200);
  const { scenes } = await res.json();
  assert.deepEqual(scenes, [{
    id: 3, householdId: HOUSEHOLD, name: 'Movie', icon: 'movie',
    actions: [{ deviceId: ONLINE, channelIdx: 0, state: 'OFF' }],
    createdAt: CREATED.toISOString(), updatedAt: CREATED.toISOString(),
  }]);
  assert.deepEqual(calls.find((c) => c.sql.includes('FROM scenes WHERE household_id')).params, [[HOUSEHOLD]]);

  assert.equal((await call(`/scenes?householdId=${HOUSEHOLD}`)).status, 200);
  assert.equal((await call('/scenes?householdId=99')).status, 404);
});

test('POST /scenes creates (201) in the default household and updates (200), keeping an omitted icon', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  const actions = [{ deviceId: ONLINE, channelIdx: 1, state: 'ON' }];

  let res = await call('/scenes', { method: 'POST', body: { name: ' Evening ', icon: 'moon', actions } });
  assert.equal(res.status, 201);
  let body = await res.json();
  assert.equal(body.id, 42);
  assert.equal(body.householdId, HOUSEHOLD);
  assert.equal(body.name, 'Evening');
  assert.equal(body.icon, 'moon');
  assert.deepEqual(body.actions, actions);
  const insert = calls.find((c) => c.sql.includes('INSERT INTO scenes'));
  assert.equal(insert.params[4], USER_ID, 'created_by');

  res = await call('/scenes', { method: 'POST', body: { id: 3, name: 'Late movie', actions } });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.name, 'Late movie');
  assert.equal(body.icon, 'movie', 'omitted icon is preserved');
  const update = calls.find((c) => c.sql.includes('UPDATE scenes SET'));
  assert.equal(update.params[4], false);
});

test('POST /scenes validates body, household membership and device ownership', async (t) => {
  mockDb();
  const call = await start(t);
  const post = (body) => call('/scenes', { method: 'POST', body });

  assert.equal((await post({ name: '', actions: [] })).status, 400);
  assert.equal((await post({ name: 'x', actions: [{ deviceId: ONLINE, channelIdx: 0, state: 'on' }] })).status, 400);
  assert.equal((await post({ name: 'x', actions: [{ deviceId: ONLINE, channelIdx: 6, state: 'ON' }] })).status, 400);
  const tooMany = Array.from({ length: 65 }, () => ({ deviceId: ONLINE, channelIdx: 0, state: 'ON' }));
  assert.equal((await post({ name: 'x', actions: tooMany })).status, 400);

  assert.equal((await post({ householdId: 99, name: 'x', actions: [] })).status, 403);
  const res = await post({ name: 'x', actions: [{ deviceId: 'esp-foreign', channelIdx: 0, state: 'ON' }] });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /esp-foreign/);
});

test('non-members get 404 on update, delete and run', async (t) => {
  mockDb({ sceneHousehold: 99 });
  const call = await start(t);
  assert.equal((await call('/scenes', { method: 'POST', body: { id: 3, name: 'x', actions: [] } })).status, 404);
  assert.equal((await call('/scenes/3', { method: 'DELETE' })).status, 404);
  assert.equal((await call('/scenes/3/run', { method: 'POST' })).status, 404);
  assert.equal((await call('/scenes/4/run', { method: 'POST' })).status, 404);
});

test('DELETE /scenes/:id -> 204', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  const res = await call('/scenes/3', { method: 'DELETE' });
  assert.equal(res.status, 204);
  assert.ok(calls.some((c) => c.sql.includes('DELETE FROM scenes WHERE id = $1') && c.params[0] === 3));
  assert.equal((await call('/scenes/abc', { method: 'DELETE' })).status, 400);
});

test('POST /scenes/:id/run actuates in parallel with source scene and reports partial failure', async (t) => {
  mockDb({
    runActions: [
      { deviceId: ONLINE, channelIdx: 0, state: 'ON' },
      { deviceId: ONLINE, channelIdx: 1, state: 'OFF' },
      { deviceId: ONLINE, channelIdx: 2, state: 'ON' },
      { deviceId: OFFLINE, channelIdx: 0, state: 'ON' },
      { deviceId: 'esp-reclaimed', channelIdx: 0, state: 'ON' },
    ],
    lockedChannels: [`${ONLINE}:2`],
  });
  // Answers only after every command has been sent -> proves they run in parallel.
  const device = {
    OPEN: 1, readyState: 1, sent: [],
    send(json) { this.sent.push(JSON.parse(json)); },
    close() {},
  };
  registerDevice(ONLINE, device);
  t.after(() => unregisterDevice(ONLINE, device));
  const call = await start(t);

  const pending = call('/scenes/3/run', { method: 'POST' });
  for (let i = 0; i < 200 && device.sent.length < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(device.sent.length, 2, 'both allowed actions in flight at once');
  for (const frame of device.sent) resolveDeviceResponse(frame.reqId, 200, { state: frame.body.state });

  const res = await pending;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.results, [
    { deviceId: ONLINE, channelIdx: 0, state: 'ON', ok: true },
    { deviceId: ONLINE, channelIdx: 1, state: 'OFF', ok: true },
    { deviceId: ONLINE, channelIdx: 2, state: 'ON', ok: false, error: 'switch_locked' },
    { deviceId: OFFLINE, channelIdx: 0, state: 'ON', ok: false, error: 'device_offline' },
    { deviceId: 'esp-reclaimed', channelIdx: 0, state: 'ON', ok: false, error: 'not_found' },
  ]);
  assert.equal(body.succeeded, 2);
  assert.equal(body.failed, 3);

  const attribution = takeAttribution(ONLINE, 0, 'ON');
  assert.equal(attribution.source, 'scene');
  assert.equal(attribution.actorUserId, USER_ID);
  assert.equal(takeAttribution(ONLINE, 1, 'OFF').source, 'scene');
  assert.equal(takeAttribution(ONLINE, 2, 'ON'), null, 'locked action left no attribution');
});
