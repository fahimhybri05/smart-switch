import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { pool } from '../src/db/pool.js';
import {
  broadcastToUser,
  registerClient,
  registerDevice,
  relayToDevice,
  resolveDeviceResponse,
  unregisterClient,
  unregisterDevice,
} from '../src/ws/registry.js';

class FakeSocket {
  static OPEN = 1;
  OPEN = 1;
  readyState = 1;
  sent = [];

  send(json) {
    this.sent.push(JSON.parse(json));
  }
}

test('relayToDevice returns null when the device has no live connection', () => {
  const result = relayToDevice('esp-not-connected', {
    method: 'GET',
    path: '/api/info',
  });
  assert.equal(result, null);
});

test('relayToDevice forwards to the device socket, resolveDeviceResponse routes the reply back to the right client', async (t) => {
  // Channel-state commands pass the lock/min-off guard first (no switch row -> allowed).
  mock.method(pool, 'query', async () => ({ rows: [] }));
  t.after(() => mock.restoreAll());
  const deviceWs = new FakeSocket();
  const clientWs = new FakeSocket();
  registerDevice('esp-registry-test-1', deviceWs);

  const internalReqId = await relayToDevice(
    'esp-registry-test-1',
    { method: 'POST', path: '/api/channels/0/state', body: { state: 'ON' } },
    clientWs,
    'client-chosen-id-123',
  );

  assert.equal(deviceWs.sent.length, 1);
  assert.equal(deviceWs.sent[0].reqId, internalReqId);
  assert.equal(deviceWs.sent[0].method, 'POST');
  assert.deepEqual(deviceWs.sent[0].body, { state: 'ON' });

  resolveDeviceResponse(internalReqId, 200, { state: 'ON' });
  // The reply is delivered via the relay promise's .then — one tick later.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(clientWs.sent.length, 1);
  // The client gets back ITS OWN reqId, not the internal device-facing one.
  assert.equal(clientWs.sent[0].reqId, 'client-chosen-id-123');
  assert.equal(clientWs.sent[0].status, 200);

  unregisterDevice('esp-registry-test-1', deviceWs);
});

test('resolveDeviceResponse for an unknown/already-resolved reqId is a no-op, not a crash', () => {
  assert.doesNotThrow(() => resolveDeviceResponse('no-such-req-id', 200, {}));
});

test('a superseding device connection closes the old socket', () => {
  const oldWs = new FakeSocket();
  oldWs.closed = null;
  oldWs.close = (code, reason) => {
    oldWs.closed = { code, reason };
  };
  const newWs = new FakeSocket();

  registerDevice('esp-registry-test-2', oldWs);
  registerDevice('esp-registry-test-2', newWs);

  assert.ok(oldWs.closed, 'old connection should have been closed');
  unregisterDevice('esp-registry-test-2', newWs);
});

test('broadcastToUser sends to every registered client socket for that user, and only that user', () => {
  const userAWs1 = new FakeSocket();
  const userAWs2 = new FakeSocket();
  const userBWs = new FakeSocket();

  registerClient(9001, userAWs1);
  registerClient(9001, userAWs2);
  registerClient(9002, userBWs);

  broadcastToUser(9001, { event: 'state_changed', deviceId: 'x', channelIdx: 0, state: 'ON' });

  assert.equal(userAWs1.sent.length, 1);
  assert.equal(userAWs2.sent.length, 1);
  assert.equal(userBWs.sent.length, 0);

  unregisterClient(9001, userAWs1);
  unregisterClient(9001, userAWs2);
  unregisterClient(9002, userBWs);
});
