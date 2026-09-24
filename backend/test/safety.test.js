import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { generateApiKey, generateHookToken, hashSecret } = await import('../src/auth/apiKeys.js');
const { signAccessToken } = await import('../src/auth/tokens.js');
const { fireAutomation } = await import('../src/automations/engine.js');
const { dispatchDeviceApi } = await import('../src/deviceApi/dispatch.js');
const { upsertSwitch } = await import('../src/deviceApi/switches.js');
const { runDeviceScheduleTick } = await import('../src/deviceSchedules/scheduler.js');
const { checkChannelCommand } = await import('../src/safety/guard.js');
const { resetSafetyState, runSafetyTick } = await import('../src/safety/scheduler.js');
const { noteExpectedStateChange, takeAttribution } = await import('../src/ws/attribution.js');
const { handleClientConnection } = await import('../src/ws/clientServer.js');
const { registerDevice, relayToDevice, resolveDeviceResponse, unregisterDevice } = await import(
  '../src/ws/registry.js'
);

const USER_ID = 7;
const HOUSEHOLD_ID = 10;
const DEVICE = 'esp-safety-a';
const API_KEY = generateApiKey();
const HOOK_TOKEN = generateHookToken();

/** `${deviceId}:${channelIdx}` -> the safety guard's view of that switch. */
const guardRows = new Map();
const setGuard = (idx, row, deviceId = DEVICE) => guardRows.set(`${deviceId}:${idx}`, row);
const LOCKED = { locked: true, min_off_s: null, state: 'ON', state_age_s: 5 };
/** OFF for 10 s, min-off 60 s -> 50 s left. */
const MIN_OFF = { locked: false, min_off_s: 60, state: 'OFF', state_age_s: 10 };

function switchRows([ids, count, deviceId, idx]) {
  if (!ids.includes(HOUSEHOLD_ID) || (deviceId != null && deviceId !== DEVICE)) return [];
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    if (idx !== undefined && i !== idx) continue;
    rows.push({
      device_id: DEVICE, friendly_name: 'Hall', channel_idx: i, name: null, zone: '',
      state: 'OFF', updated_at: new Date(),
    });
  }
  return rows;
}

function mockDb(extra = []) {
  const calls = [];
  const handlers = [
    ['AS k(device_id, channel_idx)', ([deviceId, idx]) => {
      const row = guardRows.get(`${deviceId}:${idx}`);
      return row ? [row] : [{ locked: false, min_off_s: null, state: null, state_age_s: null }];
    }],
    ['WHERE k.key_hash', ([hash]) =>
      hash === hashSecret(API_KEY) ? [{ id: 3, user_id: USER_ID, name: 'HA', prefix: API_KEY.slice(0, 11) }] : []],
    ['WHERE h.token_hash', ([hash]) =>
      hash === hashSecret(HOOK_TOKEN)
        ? [{ id: 5, device_id: DEVICE, channel_idx: 2, user_id: USER_ID, household_id: HOUSEHOLD_ID }]
        : []],
    ['FROM household_members WHERE user_id', () => [{ household_id: HOUSEHOLD_ID, role: 'member' }]],
    ['generate_series', switchRows],
    ['SELECT household_id FROM devices WHERE device_id', ([id]) => (id === DEVICE ? [{ household_id: HOUSEHOLD_ID }] : [])],
    ['JOIN household_members hm ON hm.household_id = d.household_id', () => [{ '?column?': 1 }]],
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

/** Device socket that answers every relayed command with 200. */
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

class FakeClient extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent = [];
  send(json) {
    this.sent.push(JSON.parse(json));
  }
}

function withDevice(t, deviceId = DEVICE) {
  const device = new FakeDevice();
  registerDevice(deviceId, device);
  t.after(() => unregisterDevice(deviceId, device));
  return device;
}

function setup(t, extra) {
  guardRows.clear();
  const calls = mockDb(extra);
  t.after(() => {
    mock.restoreAll();
    guardRows.clear();
  });
  return calls;
}

async function start(t) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const jwt = signAccessToken(USER_ID);
  return (path, { body, auth = `Bearer ${jwt}`, ...init } = {}) =>
    fetch(base + path, {
      ...init,
      headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// The guard itself
// ---------------------------------------------------------------------------

test('checkChannelCommand: lock blocks everything, min-off blocks only an early ON', async (t) => {
  setup(t);
  assert.equal(await checkChannelCommand(DEVICE, 0, 'ON'), null, 'no rules -> allowed');

  setGuard(0, LOCKED);
  assert.deepEqual(await checkChannelCommand(DEVICE, 0, 'OFF'), { error: 'switch_locked' });
  assert.deepEqual(await checkChannelCommand(DEVICE, 0, 'ON'), { error: 'switch_locked' });

  setGuard(0, MIN_OFF);
  assert.deepEqual(await checkChannelCommand(DEVICE, 0, 'ON'), { error: 'min_off_time', retryAfterSeconds: 50 });
  assert.equal(await checkChannelCommand(DEVICE, 0, 'OFF'), null);

  setGuard(0, { ...MIN_OFF, state_age_s: 59.2 });
  assert.equal((await checkChannelCommand(DEVICE, 0, 'ON')).retryAfterSeconds, 1);
  setGuard(0, { ...MIN_OFF, state_age_s: 61 });
  assert.equal(await checkChannelCommand(DEVICE, 0, 'ON'), null, 'min-off elapsed');
  setGuard(0, { ...MIN_OFF, state: 'ON' });
  assert.equal(await checkChannelCommand(DEVICE, 0, 'ON'), null, 'already ON');
  setGuard(0, { ...MIN_OFF, state_age_s: null });
  assert.equal(await checkChannelCommand(DEVICE, 0, 'ON'), null, 'unknown state_since');
});

// ---------------------------------------------------------------------------
// Per-transport error shapes
// ---------------------------------------------------------------------------

test('REST /command: locked -> 423, min-off -> 409 + retryAfterSeconds; nothing reaches the device', async (t) => {
  setup(t);
  const device = withDevice(t);
  const call = await start(t);
  const command = (idx, state) =>
    call(`/devices/${DEVICE}/command`, {
      method: 'POST',
      body: { method: 'POST', path: `/api/channels/${idx}/state`, body: { state }, source: 'dashboard' },
    });

  setGuard(1, LOCKED);
  let res = await command(1, 'OFF');
  assert.equal(res.status, 423);
  assert.deepEqual(await res.json(), { error: 'switch_locked' });
  assert.equal(takeAttribution(DEVICE, 1, 'OFF'), null, 'refused command leaves no attribution behind');

  setGuard(2, MIN_OFF);
  res = await command(2, 'ON');
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'min_off_time', retryAfterSeconds: 50 });
  assert.equal(res.headers.get('retry-after'), '50');
  assert.equal(device.sent.length, 0);

  // Unrestricted channel still works.
  res = await command(3, 'ON');
  assert.equal(res.status, 200);
  assert.equal(device.sent.length, 1);
  assert.equal(takeAttribution(DEVICE, 3, 'ON').source, 'dashboard');
});

test('client WS relay: guard refusals reply {reqId, status:0, error[, retryAfterSeconds]}', async (t) => {
  setup(t);
  const device = withDevice(t);
  setGuard(0, LOCKED);
  setGuard(1, MIN_OFF);

  // Registry level.
  const clientWs = new FakeClient();
  assert.equal(
    await relayToDevice(DEVICE, { method: 'POST', path: '/api/channels/0/state', body: { state: 'ON' } }, clientWs, 'r1'),
    null,
  );
  assert.deepEqual(clientWs.sent.at(-1), { reqId: 'r1', status: 0, error: 'switch_locked' });

  // Through the real client WS handler (as the app uses it).
  const ws = new FakeClient();
  handleClientConnection(ws, USER_ID);
  ws.emit('message', JSON.stringify({
    reqId: 'r2', deviceId: DEVICE, method: 'POST', path: '/api/channels/1/state', body: { state: 'ON' }, source: 'group',
  }));
  await waitFor(() => ws.sent.some((m) => m.reqId === 'r2'), 'r2 reply');
  assert.deepEqual(ws.sent.find((m) => m.reqId === 'r2'), {
    reqId: 'r2', status: 0, error: 'min_off_time', retryAfterSeconds: 50,
  });
  assert.equal(takeAttribution(DEVICE, 1, 'ON'), null);

  ws.emit('message', JSON.stringify({
    reqId: 'r3', deviceId: DEVICE, method: 'POST', path: '/api/channels/4/state', body: { state: 'ON' },
  }));
  await waitFor(() => ws.sent.some((m) => m.reqId === 'r3'), 'r3 reply');
  assert.equal(ws.sent.find((m) => m.reqId === 'r3').status, 200);
  assert.equal(device.sent.length, 1);
  ws.emit('close');
});

test('/v1 and hooks: {error:{code,message}} with 423 / 409 (+ retryAfterSeconds)', async (t) => {
  setup(t);
  const device = withDevice(t);
  const call = await start(t);

  setGuard(0, LOCKED);
  let res = await call(`/v1/switches/${DEVICE}:0/off`, { method: 'POST', auth: `Bearer ${API_KEY}` });
  assert.equal(res.status, 423);
  let body = await res.json();
  assert.equal(body.error.code, 'switch_locked');
  assert.equal(typeof body.error.message, 'string');

  setGuard(0, MIN_OFF);
  res = await call(`/v1/switches/${DEVICE}:0`, {
    method: 'PATCH', auth: `Bearer ${API_KEY}`, body: { state: 'on' },
  });
  assert.equal(res.status, 409);
  body = await res.json();
  assert.equal(body.error.code, 'min_off_time');
  assert.equal(body.error.retryAfterSeconds, 50);
  assert.equal(typeof body.error.message, 'string');

  setGuard(2, LOCKED);
  res = await call(`/v1/hook/${HOOK_TOKEN}/on`, { method: 'POST' });
  assert.equal(res.status, 423);
  assert.equal((await res.json()).error.code, 'switch_locked');

  setGuard(2, MIN_OFF);
  res = await call(`/v1/hook/${HOOK_TOKEN}/on`);
  assert.equal(res.status, 409);
  body = await res.json();
  assert.equal(body.error.code, 'min_off_time');
  assert.equal(body.error.retryAfterSeconds, 50);
  assert.equal(device.sent.length, 0);
});

test('device-forwarded LAN command is authorized through the same guard', async (t) => {
  setup(t);
  setGuard(3, LOCKED);
  assert.deepEqual(await dispatchDeviceApi(DEVICE, 'POST', '/api/channels/3/state', { state: 'OFF' }), {
    status: 423, body: { error: 'switch_locked' },
  });
  setGuard(3, MIN_OFF);
  assert.deepEqual(await dispatchDeviceApi(DEVICE, 'POST', '/api/channels/3/state', { state: 'ON' }), {
    status: 409, body: { error: 'min_off_time', retryAfterSeconds: 50 },
  });
});

test('automations: a refused action is skipped without the relay retry', async (t) => {
  setup(t, [['SELECT 1 FROM devices WHERE device_id', () => [{ 1: 1 }]]]);
  const device = withDevice(t);
  setGuard(0, LOCKED);
  const started = Date.now();
  await fireAutomation({
    id: 9, household_id: HOUSEHOLD_ID, name: 'Night',
    actions: [{ deviceId: DEVICE, channelIdx: 0, state: 'OFF' }, { deviceId: DEVICE, channelIdx: 1, state: 'ON' }],
  });
  assert.ok(Date.now() - started < 2000, 'no 3 s retry sleep for a guard refusal');
  assert.equal(device.sent.length, 1, 'only the unrestricted action is relayed');
  assert.equal(device.sent[0].path, '/api/channels/1/state');
  assert.equal(takeAttribution(DEVICE, 0, 'OFF'), null);
  assert.equal(takeAttribution(DEVICE, 1, 'ON').source, 'automation');
});

test('device schedules: a refused fire is not retried and counts as handled', async (t) => {
  const now = new Date();
  const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
  const calls = setup(t, [['FROM device_schedules s', () => [{
    device_id: DEVICE, id: 's-9', channel_idx: 5, action: 'ON', type: 'once', days_mask: 0, time: hhmm,
    duration_s: null, solar_offset_min: null, countdown_started_at: null, last_fired_at: null,
    utc_offset_min: 0, latitude: null, longitude: null, location_set: false,
  }]]]);
  const device = withDevice(t);
  setGuard(5, MIN_OFF);
  await runDeviceScheduleTick();
  assert.equal(device.sent.length, 0);
  const update = calls.find((c) => c.sql.includes('UPDATE device_schedules SET last_fired_at'));
  assert.deepEqual(update.params, [DEVICE, 's-9', true]);
});

// ---------------------------------------------------------------------------
// Max-runtime ticker
// ---------------------------------------------------------------------------

test('safety ticker turns overdue channels OFF with source safety, even when locked', async (t) => {
  resetSafetyState();
  const calls = setup(t, [['FROM cached_channel_state c', () => [
    { device_id: DEVICE, channel_idx: 2 },
    { device_id: 'esp-safety-offline', channel_idx: 0 },
  ]]]);
  const device = withDevice(t);
  setGuard(2, LOCKED);

  await runSafetyTick();

  assert.equal(device.sent.length, 1);
  assert.equal(device.sent[0].path, '/api/channels/2/state');
  assert.deepEqual(device.sent[0].body, { state: 'OFF' });
  const attribution = takeAttribution(DEVICE, 2, 'OFF');
  assert.equal(attribution.source, 'safety');
  assert.equal(attribution.actorUserId, null);
  assert.ok(!calls.some((c) => c.sql.includes('AS k(device_id, channel_idx)')), 'safety bypasses the guard');
  const select = calls.find((c) => c.sql.includes('FROM cached_channel_state c'));
  assert.match(select.sql, /now\(\) - c\.state_since >= make_interval\(secs => s\.max_on_s\)/);

  // Cooldown: the next tick doesn't re-fire the same channel straight away.
  await runSafetyTick();
  assert.equal(device.sent.length, 1);
  resetSafetyState();
});

test('safety ticker retries once, and never double-fires a channel in flight', async (t) => {
  resetSafetyState();
  mock.timers.enable(['setTimeout']);
  t.after(() => {
    mock.timers.reset();
    resetSafetyState();
  });
  setup(t, [['FROM cached_channel_state c', () => [{ device_id: DEVICE, channel_idx: 4 }]]]);
  // A device that answers 500 the first time, 200 afterwards.
  const device = new FakeDevice();
  let attempts = 0;
  device.send = function send(json) {
    const msg = JSON.parse(json);
    this.sent.push(msg);
    attempts += 1;
    const status = attempts === 1 ? 500 : 200;
    setImmediate(() => resolveDeviceResponse(msg.reqId, status, {}));
  };
  registerDevice(DEVICE, device);
  t.after(() => unregisterDevice(DEVICE, device));

  const first = runSafetyTick();
  await waitFor(() => attempts === 1, 'first attempt');
  await tick();
  // While the first tick sleeps before its retry, a second tick must skip it.
  await runSafetyTick();
  assert.equal(attempts, 1);
  mock.timers.tick(3000);
  await first;
  assert.equal(attempts, 2);
  assert.equal(takeAttribution(DEVICE, 4, 'OFF').source, 'safety');
});

// ---------------------------------------------------------------------------
// Switch config: new fields
// ---------------------------------------------------------------------------

const insertCall = (calls) => calls.find((c) => c.sql.includes('INSERT INTO device_switches'));

test('upsertSwitch preserves omitted safety fields and the lock; null clears; lock records the actor', async (t) => {
  const calls = setup(t);

  let res = await upsertSwitch(DEVICE, { channel_idx: 1, name: 'Pump' });
  assert.equal(res.status, 200);
  let p = insertCall(calls).params;
  // $12/$14/$16 = watts/max_on_s/min_off_s provided, $19 = locked provided.
  assert.equal(p[11], false);
  assert.equal(p[13], false);
  assert.equal(p[15], false);
  assert.equal(p[18], false);
  const sql = insertCall(calls).sql;
  assert.match(sql, /watts = CASE WHEN \$12 THEN EXCLUDED\.watts ELSE device_switches\.watts END/);
  assert.match(sql, /COALESCE\(device_switches\.locked_at, now\(\)\)/);
  assert.match(sql, /\(locked_at IS NOT NULL\) AS locked, locked_at/);

  calls.length = 0;
  res = await upsertSwitch(
    DEVICE,
    { channel_idx: 1, name: 'Pump', watts: 750, max_on_s: null, min_off_s: 300, locked: true },
    { actorUserId: USER_ID },
  );
  assert.equal(res.status, 200);
  p = insertCall(calls).params;
  assert.deepEqual(p.slice(10), [750, true, null, true, 300, true, true, USER_ID, true]);

  calls.length = 0;
  await upsertSwitch(DEVICE, { channel_idx: 1, locked: false });
  p = insertCall(calls).params;
  assert.deepEqual(p.slice(16), [false, null, true]);
});

test('upsertSwitch validates the new fields', async (t) => {
  const calls = setup(t);
  for (const body of [
    { watts: -1 }, { watts: 100_001 }, { watts: 1.5 }, { max_on_s: 0 }, { max_on_s: 604_801 },
    { min_off_s: 0 }, { min_off_s: 86_401 }, { min_off_s: '60' }, { locked: 'yes' },
  ]) {
    const res = await upsertSwitch(DEVICE, { channel_idx: 0, ...body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(insertCall(calls), undefined);
});

test('PATCH /devices/:id/switches/:idx maps camelCase fields and records locked_by', async (t) => {
  const calls = setup(t, [
    ['SELECT name, zone, default_boot_state FROM device_switches', () => [
      { name: 'Pump', zone: 'Yard', default_boot_state: 'OFF' },
    ]],
    ['INSERT INTO device_switches', (p) => [{
      channel_idx: p[1], name: p[2], zone: p[3], type: p[4], default_boot_state: p[5],
      input_mode: 'DISABLED', inching_ms: 0, watts: p[10], max_on_s: p[12], min_off_s: p[14],
      locked: p[16], locked_at: p[16] ? new Date('2026-09-24T10:00:00Z') : null,
    }]],
  ]);
  const call = await start(t);

  let res = await call(`/devices/${DEVICE}/switches/2`, {
    method: 'PATCH', body: { watts: 60, maxOnSeconds: 3600, minOffSeconds: null, locked: true },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.watts, 60);
  assert.equal(body.max_on_s, 3600);
  assert.equal(body.min_off_s, null);
  assert.equal(body.locked, true);
  assert.equal(body.locked_at, '2026-09-24T10:00:00.000Z');
  assert.deepEqual(insertCall(calls).params.slice(10), [60, true, 3600, true, null, true, true, USER_ID, true]);

  for (const bad of [{ maxOnSeconds: 0 }, { minOffSeconds: 86_401 }, { watts: -5 }, { locked: 'no' }]) {
    res = await call(`/devices/${DEVICE}/switches/2`, { method: 'PATCH', body: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test('a refused command drops only its own fresh attribution', () => {
  noteExpectedStateChange('esp-attr', 0, 'ON', { source: 'app' });
  noteExpectedStateChange('esp-attr', 0, 'ON', { source: 'widget' });
  return import('../src/ws/attribution.js').then(({ discardRecentExpectedStateChange }) => {
    discardRecentExpectedStateChange('esp-attr', 0, 'ON');
    assert.equal(takeAttribution('esp-attr', 0, 'ON').source, 'app');
    assert.equal(takeAttribution('esp-attr', 0, 'ON'), null);
  });
});
