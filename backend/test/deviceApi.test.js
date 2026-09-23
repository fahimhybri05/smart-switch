import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { pool } = await import('../src/db/pool.js');
const { dispatchDeviceApi } = await import('../src/deviceApi/dispatch.js');
const { registerDevice, unregisterDevice, resolveDeviceResponse } = await import('../src/ws/registry.js');

// Matches registry.test.js's own FakeSocket exactly, so hw_config_push/
// relayCommand paths exercise the REAL registry.js (not a mock of it) —
// ESM named exports can't be `mock.method`'d in place (their module-
// namespace properties are non-configurable), so registry.js's actual
// send-over-the-wire behavior is verified the same way registry.test.js
// already does: register a fake device socket and inspect what it
// received. Only `pool.query` (a real method on a real Pool instance, not
// a module-namespace export) is mockable this way.
class FakeSocket {
  static OPEN = 1;
  OPEN = 1;
  readyState = 1;
  sent = [];

  send(json) {
    this.sent.push(JSON.parse(json));
  }
}

/** Queues canned `{rows}` results for successive pool.query() calls within
 * one test, in call order. */
function mockQueryResults(results) {
  let call = 0;
  return mock.method(pool, 'query', async () => {
    const result = results[Math.min(call, results.length - 1)];
    call += 1;
    return result;
  });
}

test('dispatchDeviceApi GET /api/info returns identity fields derived from device_switches count', async (t) => {
  mockQueryResults([{ rows: [{ device_id: 'esp-1' }] }, { rows: [{ count: 4 }] }]);
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-1', 'GET', '/api/info', undefined);

  assert.equal(status, 200);
  assert.equal(body.device_id, 'esp-1');
  assert.equal(body.channel_count, 4);
  assert.deepEqual(body.capabilities, ['switch']);
});

test('dispatchDeviceApi GET /api/info 404s for an unknown device', async (t) => {
  mockQueryResults([{ rows: [] }]);
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-unknown', 'GET', '/api/info', undefined);

  assert.equal(status, 404);
  assert.equal(body.error, 'device not found');
});

test('dispatchDeviceApi GET /api/config assembles switches/schedules/settings and omits the device-local network block', async (t) => {
  mockQueryResults([
    { rows: [{ device_id: 'esp-1', friendly_name: 'Living Room' }] },
    {
      rows: [
        {
          channel_idx: 0,
          name: 'Lamp',
          zone: 'Living Room',
          type: 'ON_OFF',
          default_boot_state: 'OFF',
          input_mode: 'DISABLED',
          inching_ms: 0,
        },
      ],
    },
    {
      rows: [
        {
          id: 's-1',
          channel_idx: 0,
          action: 'ON',
          type: 'daily',
          time: '18:00',
          days_mask: 0b1111111,
          duration_s: null,
          solar_offset_min: null,
          enabled: true,
        },
      ],
    },
    { rows: [{ device_id: 'esp-1', utc_offset_min: 330, interlock_enabled: true, latitude: null, longitude: null, location_set: false }] },
  ]);
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-1', 'GET', '/api/config', undefined);

  assert.equal(status, 200);
  assert.equal(body.name, 'Living Room');
  assert.equal(body.switches.length, 1);
  assert.equal(body.switches[0].channel_idx, 0);
  assert.equal(body.schedules.length, 1);
  assert.deepEqual(body.schedules[0].days, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(body.utc_offset_min, 330);
  assert.equal(body.interlock_enabled, true);
  assert.equal('network' in body, false);
});

test('dispatchDeviceApi POST /api/switches rejects an out-of-range channel_idx without touching the DB', async (t) => {
  mock.method(pool, 'query', async () => {
    throw new Error('should not query the DB for a request that fails validation');
  });
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-1', 'POST', '/api/switches', {
    channel_idx: 99,
    name: 'Kitchen',
  });

  assert.equal(status, 400);
  assert.match(body.error, /channel_idx/);
});

test('dispatchDeviceApi POST /api/switches upserts and pushes hw_config_push when input_mode is touched', async (t) => {
  const socket = new FakeSocket();
  registerDevice('esp-switch-push', socket);
  t.after(() => {
    unregisterDevice('esp-switch-push', socket);
    mock.restoreAll();
  });

  mockQueryResults([
    {
      rows: [
        {
          channel_idx: 0,
          name: 'Porch',
          zone: 'Outside',
          type: 'ON_OFF',
          default_boot_state: 'OFF',
          input_mode: 'TOGGLE',
          inching_ms: 0,
        },
      ],
    },
    { rows: [{ channel_idx: 0, input_mode: 'TOGGLE', inching_ms: 0 }] }, // pushHwConfigToDevice: switches
    { rows: [{ interlock_enabled: false }] }, // pushHwConfigToDevice: settings
  ]);

  const { status, body } = await dispatchDeviceApi('esp-switch-push', 'POST', '/api/switches', {
    channel_idx: 0,
    name: 'Porch',
    zone: 'Outside',
    input_mode: 'TOGGLE',
  });

  assert.equal(status, 200);
  assert.equal(body.input_mode, 'TOGGLE');
  const pushed = socket.sent.find((m) => m.event === 'hw_config_push');
  assert.ok(pushed, 'expected an hw_config_push frame to be sent');
  assert.deepEqual(pushed.channels, [{ channelIdx: 0, inputMode: 'TOGGLE', inchingMs: 0 }]);
  assert.equal(pushed.interlockEnabled, false);
});

test('dispatchDeviceApi POST /api/switches does NOT push hw_config_push for a plain rename', async (t) => {
  const socket = new FakeSocket();
  registerDevice('esp-switch-norename-push', socket);
  t.after(() => {
    unregisterDevice('esp-switch-norename-push', socket);
    mock.restoreAll();
  });

  mockQueryResults([
    {
      rows: [
        {
          channel_idx: 0,
          name: 'New Name',
          zone: 'Outside',
          type: 'ON_OFF',
          default_boot_state: 'OFF',
          input_mode: 'DISABLED',
          inching_ms: 0,
        },
      ],
    },
  ]);

  const { status } = await dispatchDeviceApi('esp-switch-norename-push', 'POST', '/api/switches', {
    channel_idx: 0,
    name: 'New Name',
    zone: 'Outside',
  });

  assert.equal(status, 200);
  assert.equal(socket.sent.length, 0, 'a plain rename must not trigger any push to the device');
});

test('dispatchDeviceApi DELETE /api/switches/:idx always returns 204 and refreshes hw_config_push', async (t) => {
  const socket = new FakeSocket();
  registerDevice('esp-switch-delete', socket);
  t.after(() => {
    unregisterDevice('esp-switch-delete', socket);
    mock.restoreAll();
  });

  mockQueryResults([{ rows: [] }, { rows: [] }, { rows: [] }]);

  const { status, body } = await dispatchDeviceApi('esp-switch-delete', 'DELETE', '/api/switches/2', undefined);

  assert.equal(status, 204);
  assert.equal(body, null);
  assert.ok(socket.sent.find((m) => m.event === 'hw_config_push'));
});

test('dispatchDeviceApi GET /api/channels reads straight from cached_channel_state', async (t) => {
  mockQueryResults([
    {
      rows: [
        { channel_idx: 0, state: 'ON' },
        { channel_idx: 1, state: 'OFF' },
      ],
    },
  ]);
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-1', 'GET', '/api/channels', undefined);

  assert.equal(status, 200);
  assert.deepEqual(body, [
    { channel_idx: 0, state: 'ON' },
    { channel_idx: 1, state: 'OFF' },
  ]);
});

test('dispatchDeviceApi POST /api/channels/:idx/state (device-forwarded) authorizes without relaying back to the device', async () => {
  // No device registered at all for this id — if this path incorrectly
  // tried to relay back down, relayCommand would throw device_offline and
  // this would come back as something other than a clean 200.
  const { status, body } = await dispatchDeviceApi('esp-no-such-socket', 'POST', '/api/channels/3/state', {
    state: 'ON',
  });

  assert.equal(status, 200);
  assert.deepEqual(body, { channel_idx: 3, state: 'ON' });
});

test('dispatchDeviceApi POST /api/channels/:idx/state rejects a bad state value', async () => {
  const { status, body } = await dispatchDeviceApi('esp-1', 'POST', '/api/channels/3/state', {
    state: 'MAYBE',
  });
  assert.equal(status, 400);
  assert.ok(body.error);
});

test('dispatchDeviceApi POST /api/schedules creates a new schedule with a generated id when id is empty, packing days into days_mask', async (t) => {
  mockQueryResults([
    {
      rows: [
        {
          id: 's-42',
          channel_idx: 1,
          action: 'ON',
          type: 'daily',
          time: '07:30',
          days_mask: 0b0011111, // Mon-Fri
          duration_s: null,
          solar_offset_min: null,
          enabled: true,
        },
      ],
    },
  ]);
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-1', 'POST', '/api/schedules', {
    id: '',
    channel_idx: 1,
    action: 'ON',
    type: 'daily',
    time: '07:30',
    days: [1, 2, 3, 4, 5],
    enabled: true,
  });

  assert.equal(status, 200);
  assert.equal(body.id, 's-42');
  assert.deepEqual(body.days, [1, 2, 3, 4, 5]);
  assert.equal(body.time, '07:30');
  assert.equal('duration_s' in body, false, 'null optional fields are omitted from the wire shape');
});

test('dispatchDeviceApi POST /api/schedules 404s updating an id that does not exist', async (t) => {
  mockQueryResults([{ rows: [] }]);
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-1', 'POST', '/api/schedules', {
    id: 's-does-not-exist',
    channel_idx: 1,
    action: 'ON',
    type: 'daily',
    time: '07:30',
  });

  assert.equal(status, 404);
  assert.ok(body.error);
});

test('dispatchDeviceApi POST /api/schedules rejects an invalid type', async () => {
  const { status, body } = await dispatchDeviceApi('esp-1', 'POST', '/api/schedules', {
    channel_idx: 1,
    action: 'ON',
    type: 'yearly',
  });
  assert.equal(status, 400);
  assert.match(body.error, /type/);
});

test('dispatchDeviceApi DELETE /api/schedules/:id 404s when the schedule is not found', async (t) => {
  mockQueryResults([{ rows: [] }]);
  t.after(() => mock.restoreAll());

  const { status } = await dispatchDeviceApi('esp-1', 'DELETE', '/api/schedules/s-1', undefined);
  assert.equal(status, 404);
});

test('dispatchDeviceApi DELETE /api/schedules/:id 204s on success', async (t) => {
  mockQueryResults([{ rows: [{ id: 's-1' }] }]);
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-1', 'DELETE', '/api/schedules/s-1', undefined);
  assert.equal(status, 204);
  assert.equal(body, null);
});

test('dispatchDeviceApi POST /api/timezone persists utc_offset_min', async (t) => {
  mockQueryResults([{ rows: [] }]);
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-1', 'POST', '/api/timezone', {
    utc_offset_min: 330,
  });
  assert.equal(status, 200);
  assert.equal(body.utc_offset_min, 330);
});

test('dispatchDeviceApi POST /api/settings rejects latitude without longitude', async (t) => {
  mockQueryResults([
    {
      rows: [
        {
          device_id: 'esp-1',
          utc_offset_min: 0,
          interlock_enabled: false,
          latitude: null,
          longitude: null,
          location_set: false,
        },
      ],
    },
  ]);
  t.after(() => mock.restoreAll());

  const { status, body } = await dispatchDeviceApi('esp-1', 'POST', '/api/settings', { latitude: 12.9 });
  assert.equal(status, 400);
  assert.match(body.error, /together/);
});

test('dispatchDeviceApi POST /api/settings sets interlock_enabled and pushes hw_config_push', async (t) => {
  const socket = new FakeSocket();
  registerDevice('esp-settings-push', socket);
  t.after(() => {
    unregisterDevice('esp-settings-push', socket);
    mock.restoreAll();
  });

  mockQueryResults([
    {
      rows: [
        {
          device_id: 'esp-settings-push',
          utc_offset_min: 0,
          interlock_enabled: false,
          latitude: null,
          longitude: null,
          location_set: false,
        },
      ],
    },
    { rows: [] }, // the upsert itself
    { rows: [] }, // pushHwConfigToDevice: switches
    { rows: [{ interlock_enabled: true }] }, // pushHwConfigToDevice: settings
  ]);

  const { status, body } = await dispatchDeviceApi('esp-settings-push', 'POST', '/api/settings', {
    interlock_enabled: true,
  });

  assert.equal(status, 200);
  assert.equal(body.interlock_enabled, true);
  const pushed = socket.sent.find((m) => m.event === 'hw_config_push');
  assert.ok(pushed);
  assert.equal(pushed.interlockEnabled, true);
});

test('dispatchDeviceApi POST /api/network relays straight through to the device over the real registry', async (t) => {
  const socket = new FakeSocket();
  registerDevice('esp-network-relay', socket);
  t.after(() => unregisterDevice('esp-network-relay', socket));

  const resultPromise = dispatchDeviceApi('esp-network-relay', 'POST', '/api/network', { mode: 'dhcp' });

  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].method, 'POST');
  assert.equal(socket.sent[0].path, '/api/network');
  assert.deepEqual(socket.sent[0].body, { mode: 'dhcp' });

  resolveDeviceResponse(socket.sent[0].reqId, 200, { ok: true, rebooting: true });

  const { status, body } = await resultPromise;
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, rebooting: true });
});

test('dispatchDeviceApi POST /api/network maps an offline device to 503 (no socket registered)', async () => {
  const { status, body } = await dispatchDeviceApi('esp-definitely-not-connected', 'POST', '/api/network', {
    mode: 'dhcp',
  });
  assert.equal(status, 503);
  assert.equal(body.error, 'device_offline');
});

test('dispatchDeviceApi POST /api/auth/password is dropped (410), not silently 404', async () => {
  const { status, body } = await dispatchDeviceApi('esp-1', 'POST', '/api/auth/password', {
    password: 'whatever',
  });
  assert.equal(status, 410);
  assert.equal(body.error, 'device_password_removed');
});

test('dispatchDeviceApi returns 404 for an unmatched method/path', async () => {
  const { status } = await dispatchDeviceApi('esp-1', 'PATCH', '/api/does-not-exist', undefined);
  assert.equal(status, 404);
});
