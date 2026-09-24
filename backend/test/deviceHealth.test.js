import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/auth/tokens.js');
const { registerDevice, unregisterDevice } = await import('../src/ws/registry.js');

const USER_ID = 7;
const DEVICE = 'esp-health-a';

function mockDb(row) {
  const handlers = [
    ['FROM household_members WHERE user_id', () => [{ household_id: 10, role: 'member' }]],
    ['SELECT household_id FROM devices WHERE device_id', ([id]) => (id === DEVICE ? [{ household_id: 10 }] : [])],
    ['last_connected_at, diagnostics, created_at', () => [row]],
  ];
  const query = async (sql, params = []) => {
    for (const [needle, fn] of handlers) {
      if (sql.includes(needle)) {
        const r = fn(params);
        return { rows: r, rowCount: r.length };
      }
    }
    return { rows: [], rowCount: 0 };
  };
  mock.method(pool, 'query', query);
  mock.method(pool, 'connect', async () => ({ query, release() {} }));
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
  return (path) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${signAccessToken(USER_ID)}` } });
}

const row = (diagnostics) => ({
  device_id: DEVICE,
  friendly_name: 'Pump room',
  last_seen_at: new Date('2026-09-24T10:00:00Z'),
  last_connected_at: new Date('2026-09-24T09:00:00Z'),
  created_at: new Date('2026-01-01T00:00:00Z'),
  diagnostics,
});

test('online device: diagnostics plus uptime extrapolated from the connect report', async (t) => {
  const at = new Date(Date.now() - 60_000).toISOString();
  mockDb(row({ fw: '2.1.0', resetReason: 'Power On', uptimeS: 100, freeHeap: 30000, rssi: -61, at }));
  const ws = { OPEN: 1, readyState: 1, send() {}, close() {} };
  registerDevice(DEVICE, ws);
  t.after(() => unregisterDevice(DEVICE, ws));
  const call = await start(t);
  const res = await call(`/devices/${DEVICE}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.online, true);
  assert.equal(body.offlineSince, null);
  assert.equal(body.firmware, '2.1.0');
  assert.equal(body.resetReason, 'Power On');
  assert.equal(body.rssi, -61);
  assert.ok(body.uptimeS >= 159 && body.uptimeS <= 165, `uptime ${body.uptimeS}`);
});

test('offline device: offlineSince set, no live uptime; old firmware without diagnostics', async (t) => {
  mockDb(row(null));
  const call = await start(t);
  const body = await (await call(`/devices/${DEVICE}/health`)).json();
  assert.equal(body.online, false);
  assert.equal(body.offlineSince, '2026-09-24T10:00:00.000Z');
  assert.equal(body.uptimeS, null);
  assert.equal(body.rssi, null);
});

test('non-member gets 404', async (t) => {
  mockDb(row(null));
  const call = await start(t);
  const res = await call('/devices/someone-elses/health');
  assert.equal(res.status, 404);
});
