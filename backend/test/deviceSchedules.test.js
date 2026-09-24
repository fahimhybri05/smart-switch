import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { pool } = await import('../src/db/pool.js');
const { runDeviceScheduleTick } = await import('../src/deviceSchedules/scheduler.js');
const { localSolarMinutes } = await import('../src/deviceSchedules/solar.js');
const { registerDevice, unregisterDevice, resolveDeviceResponse } = await import('../src/ws/registry.js');

// Same FakeSocket used by registry.test.js/deviceApi.test.js — setChannelState
// goes through the REAL registry.js (relayCommand can't be mock.method'd:
// it's a plain ESM named export, and module-namespace properties are
// non-configurable), so the relay is observed by inspecting what a
// registered fake device socket actually received.
class FakeSocket {
  static OPEN = 1;
  OPEN = 1;
  readyState = 1;
  sent = [];

  send(json) {
    this.sent.push(JSON.parse(json));
  }
}

function mockQueryResults(results) {
  let call = 0;
  return mock.method(pool, 'query', async () => {
    const result = results[Math.min(call, results.length - 1)];
    call += 1;
    return result;
  });
}

/** 1=Mon..7=Sun, "HH:MM", for "right now" in UTC (device utc_offset_min=0
 * throughout this suite, so device-local time === UTC here) — computed
 * fresh per test rather than hardcoded, since Date can't be faked on this
 * Node version's mock.timers (Date support landed later than setTimeout's). */
function nowUtcParts() {
  const now = new Date();
  const jsDay = now.getUTCDay();
  return {
    day: jsDay === 0 ? 7 : jsDay,
    hhmm: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
    minutesSinceMidnight: now.getUTCHours() * 60 + now.getUTCMinutes(),
    isoDate: now.toISOString().slice(0, 10),
  };
}

function maskForDay(day) {
  return 1 << (day - 1);
}

function baseRow(overrides) {
  const { day, hhmm } = nowUtcParts();
  return {
    device_id: 'esp-sched-1',
    id: 's-1',
    channel_idx: 0,
    action: 'ON',
    type: 'weekly',
    days_mask: maskForDay(day),
    time: hhmm,
    duration_s: null,
    solar_offset_min: null,
    countdown_started_at: null,
    last_fired_at: null,
    utc_offset_min: 0,
    latitude: null,
    longitude: null,
    location_set: false,
    ...overrides,
  };
}

test('runDeviceScheduleTick fires a due schedule, relays it to the device, and records last_fired_at', async (t) => {
  const socket = new FakeSocket();
  registerDevice('esp-sched-1', socket);
  t.after(() => {
    unregisterDevice('esp-sched-1', socket);
    mock.restoreAll();
  });

  mockQueryResults([
    { rows: [baseRow()] },
    { rows: [] }, // last_fired_at UPDATE
  ]);

  const tickPromise = runDeviceScheduleTick();
  // Let the mocked pool.query microtask chain (list -> settings -> relay)
  // actually reach the point of sending over the socket before resolving it.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socket.sent.length, 1, 'expected the schedule to relay a channel-state command');
  assert.equal(socket.sent[0].method, 'POST');
  assert.equal(socket.sent[0].path, '/api/channels/0/state');
  assert.deepEqual(socket.sent[0].body, { state: 'ON' });

  resolveDeviceResponse(socket.sent[0].reqId, 200, { channel_idx: 0, state: 'ON' });
  await tickPromise;

  // list + safety-guard check (lock/min-off, inside relayCommand) + update.
  assert.equal(pool.query.mock.calls.length, 3);
  const updateCall = pool.query.mock.calls[2];
  assert.match(updateCall.arguments[0], /UPDATE device_schedules SET last_fired_at/);
  assert.deepEqual(updateCall.arguments[1], ['esp-sched-1', 's-1', false]);
});

test('runDeviceScheduleTick skips a schedule whose days_mask excludes today', async (t) => {
  const { day } = nowUtcParts();
  const yesterday = day === 1 ? 7 : day - 1;
  mockQueryResults([
    { rows: [baseRow({ days_mask: maskForDay(yesterday) })] },
  ]);
  t.after(() => mock.restoreAll());

  await runDeviceScheduleTick();

  // Only the list query runs — no relay/last_fired_at update follows.
  assert.equal(pool.query.mock.calls.length, 1);
});

test('runDeviceScheduleTick skips a schedule scheduled later today (not reached yet)', async (t) => {
  const { minutesSinceMidnight } = nowUtcParts();
  const futureMinutes = (minutesSinceMidnight + 30) % (24 * 60);
  const hhmm = `${String(Math.floor(futureMinutes / 60)).padStart(2, '0')}:${String(futureMinutes % 60).padStart(2, '0')}`;
  mockQueryResults([{ rows: [baseRow({ time: hhmm })] }]);
  t.after(() => mock.restoreAll());

  await runDeviceScheduleTick();

  // Only the list query, no relay/update beyond that.
  assert.equal(pool.query.mock.calls.length, 1);
});

test('runDeviceScheduleTick skips a schedule missed by more than the catch-up grace window', async (t) => {
  const { minutesSinceMidnight } = nowUtcParts();
  const pastMinutes = (minutesSinceMidnight - 30 + 24 * 60) % (24 * 60);
  const hhmm = `${String(Math.floor(pastMinutes / 60)).padStart(2, '0')}:${String(pastMinutes % 60).padStart(2, '0')}`;
  mockQueryResults([{ rows: [baseRow({ time: hhmm })] }]);
  t.after(() => mock.restoreAll());

  await runDeviceScheduleTick();

  assert.equal(pool.query.mock.calls.length, 1);
});

test('runDeviceScheduleTick does not re-fire a schedule already fired earlier today (per-local-day guard)', async (t) => {
  const { isoDate } = nowUtcParts();
  mockQueryResults([
    { rows: [baseRow({ last_fired_at: `${isoDate}T00:00:01.000Z` })] },
  ]);
  t.after(() => mock.restoreAll());

  await runDeviceScheduleTick();

  assert.equal(pool.query.mock.calls.length, 1, 'no relay/update for an already-fired-today schedule');
});

test('runDeviceScheduleTick fires a schedule last fired on a previous day', async (t) => {
  const socket = new FakeSocket();
  registerDevice('esp-sched-1', socket);
  t.after(() => {
    unregisterDevice('esp-sched-1', socket);
    mock.restoreAll();
  });

  mockQueryResults([
    { rows: [baseRow({ last_fired_at: '2020-01-01T00:00:00.000Z' })] },
    { rows: [] },
  ]);

  const tickPromise = runDeviceScheduleTick();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socket.sent.length, 1);
  resolveDeviceResponse(socket.sent[0].reqId, 200, { channel_idx: 0, state: 'ON' });
  await tickPromise;
});

test('runDeviceScheduleTick retries once on a failed relay (device mid-reconnect), then gives up without updating last_fired_at', async (t) => {
  mock.timers.enable(['setTimeout']);
  t.after(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  // No device socket registered at all for esp-sched-offline -> every
  // relayCommand attempt rejects with device_offline, exactly like a real
  // disconnected device.
  mockQueryResults([{ rows: [baseRow({ device_id: 'esp-sched-offline' })] }]);

  const tickPromise = runDeviceScheduleTick();
  // Let the first (failing) relay attempt run and the retry's sleep() timer get scheduled.
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(3000); // RELAY_RETRY_DELAY_MS
  await tickPromise;

  // list + first failed attempt + retry attempt = still only 1 pool.query
  // call (relayCommand doesn't touch the DB) and, crucially, no second call
  // for the last_fired_at UPDATE since both attempts failed.
  assert.equal(pool.query.mock.calls.length, 1);
});

test('runDeviceScheduleTick is a no-op when no schedules are due', async (t) => {
  mockQueryResults([{ rows: [] }]);
  t.after(() => mock.restoreAll());

  await runDeviceScheduleTick();

  assert.equal(pool.query.mock.calls.length, 1);
});

/** Runs one tick against `row` with a live fake socket, answering any relay
 * with 200. Returns the socket so callers can inspect what was sent. */
async function tickWithDevice(t, row) {
  const socket = new FakeSocket();
  registerDevice(row.device_id, socket);
  t.after(() => {
    unregisterDevice(row.device_id, socket);
    mock.restoreAll();
  });
  mockQueryResults([{ rows: [row] }, { rows: [] }]);
  const tickPromise = runDeviceScheduleTick();
  await new Promise((resolve) => setImmediate(resolve));
  for (const frame of socket.sent) {
    resolveDeviceResponse(frame.reqId, 200, {});
  }
  await tickPromise;
  return socket;
}

test('daily schedules fire every day regardless of days_mask', async (t) => {
  const { day } = nowUtcParts();
  const otherDay = day === 1 ? 7 : day - 1;
  const socket = await tickWithDevice(t, baseRow({ type: 'daily', days_mask: maskForDay(otherDay) }));
  assert.equal(socket.sent.length, 1);
});

test('once schedules disable themselves after firing', async (t) => {
  const socket = await tickWithDevice(t, baseRow({ type: 'once', days_mask: 0 }));
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(pool.query.mock.calls[2].arguments[1], ['esp-sched-1', 's-1', true]);
});

test('countdown fires once its duration has elapsed, then disables itself', async (t) => {
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const socket = await tickWithDevice(
    t,
    baseRow({ type: 'countdown', time: null, days_mask: 0, duration_s: 60, countdown_started_at: startedAt }),
  );
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(pool.query.mock.calls[2].arguments[1], ['esp-sched-1', 's-1', true]);
});

test('countdown does not fire before its duration has elapsed', async (t) => {
  const startedAt = new Date().toISOString();
  const socket = await tickWithDevice(
    t,
    baseRow({ type: 'countdown', time: null, days_mask: 0, duration_s: 3600, countdown_started_at: startedAt }),
  );
  assert.equal(socket.sent.length, 0);
});

test('sunrise/sunset schedules are skipped while the device location is unset', async (t) => {
  const socket = await tickWithDevice(t, baseRow({ type: 'sunset', time: null, location_set: false }));
  assert.equal(socket.sent.length, 0);
});

test('localSolarMinutes matches known sunrise/sunset times', () => {
  // Equator/prime meridian near the March equinox (yday 79): ~06:04 / ~18:10 UTC.
  const sunrise = localSolarMinutes(79, 0, 0, 0, true);
  const sunset = localSolarMinutes(79, 0, 0, 0, false);
  assert.ok(Math.abs(sunrise - (6 * 60 + 4)) <= 5, `sunrise ${sunrise}`);
  assert.ok(Math.abs(sunset - (18 * 60 + 10)) <= 5, `sunset ${sunset}`);
  // Dhaka (23.81N, 90.41E, UTC+6) on the June solstice (yday 171): ~05:11 / ~18:48.
  assert.ok(Math.abs(localSolarMinutes(171, 23.81, 90.41, 360, true) - (5 * 60 + 11)) <= 5);
  assert.ok(Math.abs(localSolarMinutes(171, 23.81, 90.41, 360, false) - (18 * 60 + 48)) <= 5);
  // Polar night: no sunrise at 80N in late December.
  assert.equal(localSolarMinutes(355, 80, 0, 0, true), -1);
});
