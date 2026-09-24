import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { pool } = await import('../src/db/pool.js');
const { hashDeviceSecret } = await import('../src/auth/deviceSecret.js');
const { handleDeviceConnection } = await import('../src/ws/deviceServer.js');
const { registerClient, unregisterClient } = await import('../src/ws/registry.js');

const DEVICE = 'esp-offline-a';
const SECRET = 'a-device-secret-that-is-long-enough';
const MEMBER = 77;

class FakeWs extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent = [];
  send(json) {
    this.sent.push(JSON.parse(json));
  }
  close(code, reason) {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    setImmediate(() => this.emit('close', code, reason));
  }
  ping() {}
  terminate() {
    this.close(1006);
  }
}

function mockDb() {
  const calls = [];
  const handlers = [
    ['SELECT household_id, cloud_secret_hash FROM devices', () => [
      { household_id: 10, cloud_secret_hash: hashDeviceSecret(SECRET) },
    ]],
    ['SELECT user_id FROM household_members', () => [{ user_id: MEMBER }]],
    ['UPDATE devices SET is_online = false', () => [{ household_id: 10 }]],
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

async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function connect() {
  const ws = new FakeWs();
  handleDeviceConnection(ws);
  ws.emit('message', Buffer.from(JSON.stringify({ deviceId: DEVICE, cloudSecret: SECRET })));
  return ws;
}

function clientSocket(t) {
  const client = new FakeWs();
  registerClient(MEMBER, client);
  t.after(() => unregisterClient(MEMBER, client));
  return client;
}

const events = (client, name) => client.sent.filter((m) => m.event === name);
const offlineWrites = (calls) => calls.filter((c) => c.sql.includes('UPDATE devices SET is_online = false'));

test('a device disconnect broadcasts device_offline to the household', async (t) => {
  const calls = mockDb();
  t.after(() => mock.restoreAll());
  const client = clientSocket(t);

  const ws = connect();
  await waitFor(() => events(client, 'device_online').length === 1, 'device_online');
  ws.close(1000, 'bye');
  await waitFor(() => events(client, 'device_offline').length === 1, 'device_offline');
  assert.deepEqual(events(client, 'device_offline')[0], { event: 'device_offline', deviceId: DEVICE });
  assert.equal(offlineWrites(calls).length, 1);
});

test('a superseded socket closing neither marks the device offline nor broadcasts', async (t) => {
  const calls = mockDb();
  t.after(() => mock.restoreAll());
  const client = clientSocket(t);

  const first = connect();
  await waitFor(() => events(client, 'device_online').length === 1, 'first device_online');
  const second = connect(); // registerDevice closes `first` with 4000
  await waitFor(() => events(client, 'device_online').length === 2, 'second device_online');
  await waitFor(() => first.readyState === 3, 'first socket closed');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events(client, 'device_offline').length, 0);
  assert.equal(offlineWrites(calls).length, 0);

  second.close(1000, 'bye');
  await waitFor(() => events(client, 'device_offline').length === 1, 'device_offline');
});
