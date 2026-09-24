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
const DEVICE = 'esp-patch-a';

function mockDb({ existing = null } = {}) {
  const calls = [];
  const handlers = [
    ['FROM household_members WHERE user_id', () => [{ household_id: 10, role: 'member' }]],
    ['SELECT household_id FROM devices WHERE device_id', ([id]) => (id === DEVICE ? [{ household_id: 10 }] : [])],
    ['SELECT name, zone, default_boot_state FROM device_switches', () => (existing ? [existing] : [])],
    ['INSERT INTO device_switches', (p) => [{
      channel_idx: p[1], name: p[2], zone: p[3], type: p[4], default_boot_state: p[5],
      input_mode: p[8] ? p[6] : (existing?.input_mode ?? 'DISABLED'),
      inching_ms: p[9] ? p[7] : (existing?.inching_ms ?? 0),
    }]],
    ['SELECT channel_idx, input_mode, inching_ms FROM device_switches', () => [
      { channel_idx: 0, input_mode: 'TOGGLE', inching_ms: 0 },
    ]],
    ['SELECT device_id, friendly_name FROM devices', () => [{ device_id: DEVICE, friendly_name: 'Hall' }]],
    ['FROM device_switches WHERE device_id = $1 ORDER BY channel_idx', () => [
      { channel_idx: 0, name: 'Lamp', zone: 'Hall', type: 'ON_OFF', default_boot_state: 'OFF', input_mode: 'DISABLED', inching_ms: 0 },
    ]],
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
  const jwt = signAccessToken(USER_ID);
  return (path, { body, ...init } = {}) =>
    fetch(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
}

function withDevice(t) {
  const device = new FakeDevice();
  registerDevice(DEVICE, device);
  t.after(() => unregisterDevice(DEVICE, device));
  return device;
}

const upsertCall = (calls) => calls.find((c) => c.sql.includes('INSERT INTO device_switches'));

test('a name-only PATCH keeps the stored zone and boot state and pushes no hw config', async (t) => {
  const calls = mockDb({ existing: { name: 'Lamp', zone: 'Kitchen', default_boot_state: 'ON' } });
  const device = withDevice(t);
  const call = await start(t);

  const res = await call(`/devices/${DEVICE}/switches/0`, { method: 'PATCH', body: { name: 'Big lamp' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'Big lamp');
  assert.equal(body.zone, 'Kitchen');
  assert.equal(body.default_boot_state, 'ON');

  const p = upsertCall(calls).params;
  assert.deepEqual(p.slice(0, 6), [DEVICE, 0, 'Big lamp', 'Kitchen', 'ON_OFF', 'ON']);
  assert.equal(p[8], false, 'input_mode must be preserved (not provided)');
  assert.equal(p[9], false, 'inching_ms must be preserved (not provided)');
  assert.equal(device.sent.filter((m) => m.event === 'hw_config_push').length, 0);
});

test('a PATCH with inputMode/inchingMs updates them and pushes hw config to the device', async (t) => {
  const calls = mockDb({ existing: { name: 'Lamp', zone: 'Kitchen', default_boot_state: 'OFF' } });
  const device = withDevice(t);
  const call = await start(t);

  const res = await call(`/devices/${DEVICE}/switches/0`, {
    method: 'PATCH',
    body: { inputMode: 'TOGGLE', inchingMs: 1500 },
  });
  assert.equal(res.status, 200);
  const p = upsertCall(calls).params;
  assert.deepEqual(p.slice(2, 10), ['Lamp', 'Kitchen', 'ON_OFF', 'OFF', 'TOGGLE', 1500, true, true]);
  const pushes = device.sent.filter((m) => m.event === 'hw_config_push');
  assert.equal(pushes.length, 1);
});

test('PATCH on a switch with no stored row falls back to defaults', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  const res = await call(`/devices/${DEVICE}/switches/3`, { method: 'PATCH', body: { zone: 'Garage' } });
  assert.equal(res.status, 200);
  assert.deepEqual(upsertCall(calls).params.slice(1, 6), [3, 'Channel 3', 'Garage', 'ON_OFF', 'OFF']);
});

test('PATCH validates the index, the body and household membership', async (t) => {
  mockDb();
  const call = await start(t);
  assert.equal((await call(`/devices/${DEVICE}/switches/6`, { method: 'PATCH', body: { name: 'x' } })).status, 400);
  assert.equal((await call(`/devices/${DEVICE}/switches/-1`, { method: 'PATCH', body: { name: 'x' } })).status, 400);
  assert.equal((await call(`/devices/${DEVICE}/switches/0`, { method: 'PATCH', body: {} })).status, 400);
  assert.equal(
    (await call(`/devices/${DEVICE}/switches/0`, { method: 'PATCH', body: { inputMode: 'SIDEWAYS' } })).status,
    400,
  );
  assert.equal((await call('/devices/esp-foreign/switches/0', { method: 'PATCH', body: { name: 'x' } })).status, 404);
});

test('GET /devices/:id/config works while the device is offline', async (t) => {
  mockDb();
  const call = await start(t);
  const res = await call(`/devices/${DEVICE}/config`);
  assert.equal(res.status, 200);
  const config = await res.json();
  assert.equal(config.device_id, DEVICE);
  assert.equal(config.online, false);
  assert.equal(config.switches[0].name, 'Lamp');
  assert.equal((await call('/devices/esp-foreign/config')).status, 404);
});

test('POST /devices/:id/command attributes to the given source (default widget)', async (t) => {
  mockDb();
  withDevice(t);
  const call = await start(t);
  const command = (state, extra = {}) =>
    call(`/devices/${DEVICE}/command`, {
      method: 'POST',
      body: { method: 'POST', path: '/api/channels/1/state', body: { state }, ...extra },
    });

  assert.equal((await command('ON', { source: 'dashboard' })).status, 200);
  assert.equal(takeAttribution(DEVICE, 1, 'ON').source, 'dashboard');

  assert.equal((await command('OFF')).status, 200);
  assert.equal(takeAttribution(DEVICE, 1, 'OFF').source, 'widget');

  assert.equal((await command('ON', { source: 'api' })).status, 400);
});
