import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';
process.env.PUBLIC_API_URL = 'https://api.example.test/';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { generateHookToken, hashSecret } = await import('../src/auth/apiKeys.js');
const { signAccessToken } = await import('../src/auth/tokens.js');
const { takeAttribution } = await import('../src/ws/attribution.js');
const { registerDevice, resolveDeviceResponse, unregisterDevice } = await import('../src/ws/registry.js');

const USER_ID = 7;
const HOUSEHOLD_ID = 10;
const DEVICE = 'esp-hook-a';
const HOOK_TOKEN = generateHookToken();
const JWT = signAccessToken(USER_ID);

function switchRows([ids, count, deviceId, idx]) {
  if (!ids.includes(HOUSEHOLD_ID) || (deviceId != null && deviceId !== DEVICE)) return [];
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    if (idx !== undefined && i !== idx) continue;
    rows.push({
      device_id: DEVICE,
      friendly_name: 'Hall',
      channel_idx: i,
      name: i === 2 ? 'Porch' : null,
      zone: 'Outside',
      state: i === 2 ? 'ON' : null,
      updated_at: i === 2 ? new Date() : null,
    });
  }
  return rows;
}

function mockDb({ capReached = false } = {}) {
  const calls = [];
  const handlers = [
    ['WHERE h.token_hash', ([hash]) =>
      hash === hashSecret(HOOK_TOKEN)
        ? [{ id: 5, device_id: DEVICE, channel_idx: 2, user_id: USER_ID, household_id: HOUSEHOLD_ID }]
        : []],
    ['FROM household_members WHERE user_id', () => [{ household_id: HOUSEHOLD_ID, role: 'member' }]],
    ['generate_series', switchRows],
    ['SELECT id, name FROM api_keys WHERE id = $1 AND user_id = $2', ([id, userId]) =>
      id === 3 && userId === USER_ID ? [{ id: 3, name: 'HA' }] : []],
    ['INSERT INTO switch_hooks', (p) =>
      capReached
        ? []
        : [{ id: 42, api_key_id: p[0], device_id: p[1], channel_idx: p[2], name: p[3], token_prefix: p[4], created_at: new Date(), last_used_at: null }]],
    ['WHERE k.user_id = $1 AND k.revoked_at IS NULL AND h.revoked_at IS NULL', () => [
      { id: 5, api_key_id: 3, api_key_name: 'HA', device_id: DEVICE, channel_idx: 2, name: 'Porch light', token_prefix: 'wh_abcdefgh', created_at: new Date(), last_used_at: null },
    ]],
    ['UPDATE switch_hooks h SET revoked_at', ([id, userId]) => (id === 5 && userId === USER_ID ? [{ id: 5 }] : [])],
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

class FakeDevice {
  OPEN = 1;
  readyState = 1;
  sent = [];
  send(json) {
    const msg = JSON.parse(json);
    this.sent.push(msg);
    if (msg.reqId) setImmediate(() => resolveDeviceResponse(msg.reqId, 200, { state: msg.body?.state }));
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
  return (path, init = {}) => fetch(base + path, init);
}

function assertHookHeaders(res) {
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
}

test('hook status returns the switch (JSON and ?format=text) with no-store headers', async (t) => {
  mockDb();
  const call = await start(t);

  const res = await call(`/v1/hook/${HOOK_TOKEN}/status`);
  assert.equal(res.status, 200);
  assertHookHeaders(res);
  const sw = await res.json();
  assert.equal(sw.id, `${DEVICE}:2`);
  assert.equal(sw.name, 'Porch');
  assert.equal(sw.state, 'on');

  const text = await call(`/v1/hook/${HOOK_TOKEN}/status?format=text`);
  assert.equal(text.status, 200);
  assert.match(text.headers.get('content-type'), /^text\/plain/);
  assert.equal(await text.text(), 'on');
});

test('every hook failure is the same 404 (unknown token, bad format, bad action, bad method)', async (t) => {
  mockDb();
  const call = await start(t);
  const expected = { error: { code: 'not_found', message: 'Not found.' } };
  for (const [path, init] of [
    [`/v1/hook/${generateHookToken()}/status`, {}],
    ['/v1/hook/not-a-token/on', {}],
    [`/v1/hook/${HOOK_TOKEN}/explode`, {}],
    [`/v1/hook/${HOOK_TOKEN}/on`, { method: 'DELETE' }],
    ['/v1/hook/x', {}],
  ]) {
    const res = await call(path, init);
    assert.equal(res.status, 404, path);
    assertHookHeaders(res);
    assert.deepEqual(await res.json(), expected);
  }
});

test('hook on/off/toggle actuate with source "hook" via GET or POST; HEAD never actuates', async (t) => {
  mockDb();
  const device = new FakeDevice();
  registerDevice(DEVICE, device);
  t.after(() => unregisterDevice(DEVICE, device));
  const call = await start(t);

  let res = await call(`/v1/hook/${HOOK_TOKEN}/off`, { method: 'POST' });
  assert.equal(res.status, 200);
  assertHookHeaders(res);
  assert.equal((await res.json()).state, 'off');
  assert.deepEqual(device.sent.at(-1).body, { state: 'OFF' });
  const attribution = takeAttribution(DEVICE, 2, 'OFF');
  assert.equal(attribution.source, 'hook');
  assert.equal(attribution.actorUserId, USER_ID);

  // Cached state is ON -> toggle turns OFF; GET works for bookmarks.
  res = await call(`/v1/hook/${HOOK_TOKEN}/toggle?format=text`);
  assert.equal(await res.text(), 'off');
  takeAttribution(DEVICE, 2, 'OFF');

  const before = device.sent.length;
  res = await call(`/v1/hook/${HOOK_TOKEN}/on`, { method: 'HEAD' });
  assert.equal(res.status, 405);
  assertHookHeaders(res);
  assert.equal(device.sent.length, before);
});

test('hook actuation on an offline device answers 503 device_offline', async (t) => {
  mockDb();
  const call = await start(t);
  const res = await call(`/v1/hook/${HOOK_TOKEN}/on`, { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'device_offline');
});

test('POST /hooks returns the token and URLs once, storing only the hash', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  const res = await call('/hooks', {
    method: 'POST',
    headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKeyId: 3, switchId: `${DEVICE}:2`, name: 'Porch light' }),
  });
  assert.equal(res.status, 201);
  const hook = await res.json();
  assert.match(hook.token, /^wh_[A-Za-z0-9_-]{43}$/);
  assert.equal(hook.switchId, `${DEVICE}:2`);
  assert.equal(hook.apiKeyName, 'HA');
  assert.equal(hook.tokenPrefix, hook.token.slice(0, 11));
  assert.deepEqual(hook.urls, {
    on: `https://api.example.test/v1/hook/${hook.token}/on`,
    off: `https://api.example.test/v1/hook/${hook.token}/off`,
    toggle: `https://api.example.test/v1/hook/${hook.token}/toggle`,
    status: `https://api.example.test/v1/hook/${hook.token}/status`,
  });
  const insert = calls.find((c) => c.sql.includes('INSERT INTO switch_hooks'));
  assert.equal(insert.params[5], hashSecret(hook.token));
  assert.ok(!insert.params.includes(hook.token), 'raw token must never be stored');

  const list = await (await call('/hooks', { headers: { Authorization: `Bearer ${JWT}` } })).json();
  assert.equal(list.hooks.length, 1);
  assert.equal(list.hooks[0].switchId, `${DEVICE}:2`);
  assert.equal(list.hooks[0].token, undefined);
  assert.equal(list.hooks[0].urls, undefined);
});

test('POST /hooks rejects foreign keys/switches and enforces the per-key cap', async (t) => {
  mockDb({ capReached: true });
  const call = await start(t);
  const post = (body) =>
    call('/hooks', {
      method: 'POST',
      headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ apiKeyId: 4, switchId: `${DEVICE}:2` })).status, 404);
  assert.equal((await post({ apiKeyId: 3, switchId: 'esp-other:0' })).status, 404);
  assert.equal((await post({ apiKeyId: 3, switchId: `${DEVICE}:9` })).status, 404);
  assert.equal((await post({ apiKeyId: 'x', switchId: `${DEVICE}:2` })).status, 400);
  assert.equal((await post({ apiKeyId: 3, switchId: `${DEVICE}:2` })).status, 409);
});

test('20 failed hook lookups per IP lock that IP out of hook URLs for the window', async (t) => {
  mockDb();
  const call = await start(t);
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await call(`/v1/hook/${generateHookToken()}/status`)).status, 404);
  }
  const res = await call(`/v1/hook/${HOOK_TOKEN}/status`);
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error.code, 'rate_limited');
});

test('DELETE /hooks/:id revokes only the caller\'s hook', async (t) => {
  mockDb();
  const call = await start(t);
  const auth = { Authorization: `Bearer ${JWT}` };
  assert.equal((await call('/hooks/5', { method: 'DELETE', headers: auth })).status, 204);
  assert.equal((await call('/hooks/6', { method: 'DELETE', headers: auth })).status, 404);
});
