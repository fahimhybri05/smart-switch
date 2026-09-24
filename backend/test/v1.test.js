import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { generateApiKey, hashSecret } = await import('../src/auth/apiKeys.js');
const { signAccessToken } = await import('../src/auth/tokens.js');
const { parseSwitchId } = await import('../src/switches.js');
const { takeAttribution } = await import('../src/ws/attribution.js');
const { registerDevice, resolveDeviceResponse, unregisterDevice } = await import('../src/ws/registry.js');

const USER_ID = 7;
const HOUSEHOLD_ID = 10;
const API_KEY = generateApiKey();
const REVOKED_KEY = generateApiKey();

const DEVICES = {
  'esp-v1-a': { household: HOUSEHOLD_ID, name: 'Living room' },
  'esp-v1-b': { household: 99, name: 'Neighbour' }, // not the user's
};
const SWITCHES = { 'esp-v1-a': { 0: { name: 'Lamp', zone: 'Kitchen' }, 1: { name: '', zone: '' } } };
const CACHED = { 'esp-v1-a': { 0: 'ON', 1: 'OFF' } };
const UPDATED_AT = new Date('2026-01-02T03:04:05Z');

/** In-memory stand-in for listSwitchesForHouseholds/getSwitch's SQL. */
function switchRows([ids, count, deviceId, idx]) {
  const rows = [];
  for (const [id, d] of Object.entries(DEVICES)) {
    if (!ids.includes(d.household) || (deviceId != null && id !== deviceId)) continue;
    for (let i = 0; i < count; i += 1) {
      if (idx !== undefined && i !== idx) continue;
      rows.push({
        device_id: id,
        friendly_name: d.name,
        channel_idx: i,
        name: SWITCHES[id]?.[i]?.name ?? null,
        zone: SWITCHES[id]?.[i]?.zone ?? null,
        state: CACHED[id]?.[i] ?? null,
        updated_at: CACHED[id]?.[i] ? UPDATED_AT : null,
      });
    }
  }
  return rows;
}

/** Routes pool.query (and pool.connect clients) by SQL substring. */
function mockDb(extra = []) {
  const calls = [];
  const handlers = [
    ['WHERE k.key_hash', ([hash]) =>
      hash === hashSecret(API_KEY) ? [{ id: 3, user_id: USER_ID, name: 'Home Assistant', prefix: API_KEY.slice(0, 11) }] : []],
    ['FROM household_members WHERE user_id', () => [{ household_id: HOUSEHOLD_ID, role: 'owner' }]],
    ['generate_series', switchRows],
    ['SELECT id, email FROM users', () => [{ id: USER_ID, email: 'me@example.com' }]],
    ['SELECT id, name FROM households', () => [{ id: HOUSEHOLD_ID, name: 'Home' }]],
    ['FROM devices WHERE household_id', () => [
      { device_id: 'esp-v1-a', friendly_name: 'Living room', household_id: HOUSEHOLD_ID, last_seen_at: UPDATED_AT },
    ]],
    ...extra,
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

/** Device socket that answers every relayed channel command with success. */
class FakeDevice {
  OPEN = 1;
  readyState = 1;
  sent = [];
  send(json) {
    const msg = JSON.parse(json);
    this.sent.push(msg);
    if (msg.reqId) {
      setImmediate(() => resolveDeviceResponse(msg.reqId, 200, { state: msg.body?.state }));
    }
  }
  close() {}
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
  return (path, { key = API_KEY, headers = {}, ...init } = {}) =>
    fetch(base + path, {
      ...init,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    });
}

test('parseSwitchId splits on the last colon and bounds the channel', () => {
  assert.deepEqual(parseSwitchId('esp8266-3d87ce:0'), { deviceId: 'esp8266-3d87ce', channelIdx: 0 });
  assert.deepEqual(parseSwitchId('a:b:5'), { deviceId: 'a:b', channelIdx: 5 });
  assert.equal(parseSwitchId('esp:6'), null);
  assert.equal(parseSwitchId('esp:x'), null);
  assert.equal(parseSwitchId(':1'), null);
  assert.equal(parseSwitchId('nocolon'), null);
});

test('/v1 rejects a missing key, a JWT, and a revoked key with the v1 error shape', async (t) => {
  mockDb();
  const call = await start(t);

  let res = await call('/v1/me', { key: null });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'missing_api_key');

  res = await call('/v1/me', { key: signAccessToken(USER_ID) });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'invalid_api_key');

  res = await call('/v1/me', { key: REVOKED_KEY });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'invalid_api_key');
  assert.equal(typeof body.error.message, 'string');
});

test('GET /v1/me returns the account, households and key (no secret)', async (t) => {
  mockDb();
  const call = await start(t);
  const res = await call('/v1/me');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: USER_ID,
    email: 'me@example.com',
    households: [{ id: HOUSEHOLD_ID, name: 'Home', role: 'owner' }],
    apiKey: { id: 3, name: 'Home Assistant', prefix: API_KEY.slice(0, 11) },
  });
});

test('GET /v1/devices lists household devices', async (t) => {
  mockDb();
  const call = await start(t);
  const { devices } = await (await call('/v1/devices')).json();
  assert.deepEqual(devices, [
    {
      id: 'esp-v1-a',
      name: 'Living room',
      householdId: HOUSEHOLD_ID,
      online: false,
      lastSeenAt: UPDATED_AT.toISOString(),
      switchCount: 6,
    },
  ]);
});

test('GET /v1/switches returns the canonical switch shape for every physical channel', async (t) => {
  mockDb();
  const call = await start(t);
  const res = await call('/v1/switches');
  assert.equal(res.status, 200);
  const { switches } = await res.json();
  assert.equal(switches.length, 6);
  assert.deepEqual(switches[0], {
    id: 'esp-v1-a:0',
    deviceId: 'esp-v1-a',
    deviceName: 'Living room',
    channel: 0,
    name: 'Lamp',
    zone: 'Kitchen',
    state: 'on',
    online: false,
    updatedAt: UPDATED_AT.toISOString(),
  });
  assert.equal(switches[1].name, 'Channel 1'); // empty name falls back
  assert.equal(switches[1].state, 'off');
  assert.equal(switches[2].state, 'unknown');
  assert.equal(switches[2].updatedAt, null);

  const filtered = await (await call('/v1/switches?deviceId=esp-v1-a')).json();
  assert.equal(filtered.switches.length, 6);
  const missing = await call('/v1/switches?deviceId=esp-v1-b');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'not_found');
});

test('GET /v1/switches/:id 404s for a switch outside the caller\'s households', async (t) => {
  mockDb();
  const call = await start(t);
  assert.equal((await call('/v1/switches/esp-v1-a:1')).status, 200);
  const res = await call('/v1/switches/esp-v1-b:0');
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: { code: 'not_found', message: 'Switch not found.' } });
  assert.equal((await call('/v1/switches/garbage')).status, 404);
});

test('POST /v1/switches/:id/toggle actuates via the device with source "api"', async (t) => {
  mockDb();
  const device = new FakeDevice();
  registerDevice('esp-v1-a', device);
  t.after(() => unregisterDevice('esp-v1-a', device));
  const call = await start(t);

  // ch0 is cached ON -> toggle turns it OFF.
  const res = await call('/v1/switches/esp-v1-a:0/toggle', { method: 'POST' });
  assert.equal(res.status, 200);
  const sw = await res.json();
  assert.equal(sw.state, 'off');
  assert.equal(sw.online, true);
  const cmd = device.sent.at(-1);
  assert.equal(cmd.method, 'POST');
  assert.equal(cmd.path, '/api/channels/0/state');
  assert.deepEqual(cmd.body, { state: 'OFF' });
  const attribution = takeAttribution('esp-v1-a', 0, 'OFF');
  assert.equal(attribution.source, 'api');
  assert.equal(attribution.actorUserId, USER_ID);

  // ch2 has no cached state -> toggle turns it ON.
  const unknown = await (await call('/v1/switches/esp-v1-a:2/toggle', { method: 'POST' })).json();
  assert.equal(unknown.state, 'on');
  assert.deepEqual(device.sent.at(-1).body, { state: 'ON' });
  takeAttribution('esp-v1-a', 2, 'ON');

  const on = await call('/v1/switches/esp-v1-a%3A1/on', { method: 'POST' });
  assert.equal(on.status, 200);
  assert.equal((await on.json()).state, 'on');
  takeAttribution('esp-v1-a', 1, 'ON');
});

test('PATCH /v1/switches/:id sets the state and validates the body', async (t) => {
  mockDb();
  const device = new FakeDevice();
  registerDevice('esp-v1-a', device);
  t.after(() => unregisterDevice('esp-v1-a', device));
  const call = await start(t);

  const res = await call('/v1/switches/esp-v1-a:0', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'off' }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).state, 'off');
  assert.deepEqual(device.sent.at(-1).body, { state: 'OFF' });
  takeAttribution('esp-v1-a', 0, 'OFF');

  const bad = await call('/v1/switches/esp-v1-a:0', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'ON' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'invalid_request');

  const badJson = await call('/v1/switches/esp-v1-a:0', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'invalid_json');
});

test('actuating an offline device answers 503 device_offline without noting attribution', async (t) => {
  mockDb();
  const call = await start(t);
  const res = await call('/v1/switches/esp-v1-a:3/on', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'device_offline');
  assert.equal(takeAttribution('esp-v1-a', 3, 'ON'), null);
});

test('unknown /v1 paths get the v1 404 shape; openapi.json is public', async (t) => {
  mockDb();
  const call = await start(t);
  const res = await call('/v1/nope');
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');

  const spec = await call('/v1/openapi.json', { key: null });
  assert.equal(spec.status, 200);
  const doc = await spec.json();
  assert.equal(doc.openapi, '3.0.3');
  assert.ok(doc.paths['/v1/switches/{id}/toggle']);
});

test('30 failed authentications per IP lock that IP out of /v1 before auth', async (t) => {
  mockDb();
  const call = await start(t);
  // Successful requests don't count towards the failure budget.
  assert.equal((await call('/v1/me')).status, 200);
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await call('/v1/me', { key: REVOKED_KEY })).status, 401);
  }
  const res = await call('/v1/me');
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'rate_limited');
});

test('the per-key limiter answers 429 rate_limited after 120 requests a minute', async (t) => {
  mockDb();
  const call = await start(t);
  for (let i = 0; i < 120; i += 1) {
    const res = await call('/v1/switches/esp-v1-a:0');
    assert.equal(res.status, 200);
  }
  const res = await call('/v1/switches/esp-v1-a:0');
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'rate_limited');
});
