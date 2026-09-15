import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runDeviceHeartbeatTick } from '../src/ws/deviceServer.js';
import { registerDevice, unregisterDevice } from '../src/ws/registry.js';

class FakeSocket {
  static OPEN = 1;
  OPEN = 1;
  readyState = 1;
  isAlive;
  pinged = 0;
  terminated = false;

  ping() {
    this.pinged += 1;
  }

  terminate() {
    this.terminated = true;
  }
}

test('runDeviceHeartbeatTick pings a live socket and flips isAlive to false until the next pong', () => {
  const ws = new FakeSocket();
  ws.isAlive = true;
  registerDevice('esp-heartbeat-live', ws);

  runDeviceHeartbeatTick();

  assert.equal(ws.pinged, 1);
  assert.equal(ws.isAlive, false);
  assert.equal(ws.terminated, false);

  unregisterDevice('esp-heartbeat-live', ws);
});

test('runDeviceHeartbeatTick terminates a socket that never answered the previous ping', () => {
  const ws = new FakeSocket();
  ws.isAlive = false; // didn't pong since the last tick
  registerDevice('esp-heartbeat-dead', ws);

  runDeviceHeartbeatTick();

  assert.equal(ws.terminated, true);
  assert.equal(ws.pinged, 0);

  unregisterDevice('esp-heartbeat-dead', ws);
});

test('a socket that pongs in time survives repeated ticks', () => {
  const ws = new FakeSocket();
  ws.isAlive = true;
  ws.on = (event, handler) => {
    if (event === 'pong') {
      ws._pongHandler = handler;
    }
  };
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  registerDevice('esp-heartbeat-recovers', ws);

  runDeviceHeartbeatTick(); // ping sent, isAlive -> false
  assert.equal(ws.isAlive, false);

  ws._pongHandler(); // simulate the device answering
  assert.equal(ws.isAlive, true);

  runDeviceHeartbeatTick(); // still alive, not terminated
  assert.equal(ws.terminated, false);
  assert.equal(ws.pinged, 2);

  unregisterDevice('esp-heartbeat-recovers', ws);
});
