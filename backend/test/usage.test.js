import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { signAccessToken } = await import('../src/auth/tokens.js');
const { bucketSeconds, dayWindows, kwhFor, onIntervals, resolveTimeZone, summarizeSwitch } = await import(
  '../src/usage.js'
);

const USER_ID = 7;
const HOUSEHOLD_ID = 10;
const DEVICE = 'esp-usage-a';
const H = 3_600_000;

// ---------------------------------------------------------------------------
// Pure interval math
// ---------------------------------------------------------------------------

test('onIntervals collapses consecutive duplicate states', () => {
  const events = [
    { state: 'ON', at: 10 }, { state: 'ON', at: 20 }, { state: 'OFF', at: 30 },
    { state: 'OFF', at: 40 }, { state: 'ON', at: 50 }, { state: 'OFF', at: 70 },
  ];
  assert.deepEqual(onIntervals(events, { startMs: 0, endMs: 100 }), [[10, 30], [50, 70]]);
});

test('onIntervals counts a switch ON at the window start from the start', () => {
  const events = [{ state: 'ON', at: -50 }, { state: 'OFF', at: 30 }, { state: 'ON', at: 60 }, { state: 'OFF', at: 90 }];
  // The pre-window event is ignored; initialState carries it.
  assert.deepEqual(onIntervals(events, { initialState: 'ON', startMs: 0, endMs: 100 }), [[0, 30], [60, 90]]);
  // An ON echo replay right at the start doesn't restart the interval.
  assert.deepEqual(
    onIntervals([{ state: 'ON', at: 5 }, { state: 'OFF', at: 30 }], { initialState: 'ON', startMs: 0, endMs: 100 }),
    [[0, 30]],
  );
  assert.deepEqual(onIntervals([], { initialState: 'OFF', startMs: 0, endMs: 100 }), []);
});

test('onIntervals counts a switch that is ON now until now', () => {
  assert.deepEqual(
    onIntervals([{ state: 'ON', at: 80 }], { initialState: 'OFF', startMs: 0, endMs: 100 }),
    [[80, 100]],
  );
  assert.deepEqual(onIntervals([], { initialState: 'ON', startMs: 0, endMs: 100 }), [[0, 100]]);
});

test('bucketSeconds clips intervals to each window', () => {
  const windows = [{ startMs: 0, endMs: 10_000 }, { startMs: 10_000, endMs: 20_000 }];
  assert.deepEqual(bucketSeconds([[5_000, 12_000], [15_000, 16_500]], windows), [5, 4]);
});

test('dayWindows splits days at household-local midnight', () => {
  // 2026-09-24T12:00Z = 18:00 in Dhaka (UTC+6, no DST).
  const now = Date.parse('2026-09-24T12:00:00Z');
  const windows = dayWindows('Asia/Dhaka', 2, now);
  assert.deepEqual(windows.map((w) => w.key), ['2026-09-23', '2026-09-24']);
  assert.equal(new Date(windows[0].startMs).toISOString(), '2026-09-22T18:00:00.000Z');
  assert.equal(new Date(windows[1].startMs).toISOString(), '2026-09-23T18:00:00.000Z');

  // ON 17:00Z-19:00Z on the 23rd straddles Dhaka midnight: 1 h each side.
  const s = summarizeSwitch({
    events: [
      { state: 'ON', at: Date.parse('2026-09-23T17:00:00Z') },
      { state: 'OFF', at: Date.parse('2026-09-23T19:00:00Z') },
    ],
    initialState: null,
    windows,
    nowMs: now,
    watts: 1000,
  });
  assert.deepEqual(s.dailyOnSeconds, [3600, 3600]);
  assert.equal(s.totalOnSeconds, 7200);
  assert.equal(s.kwh, 2);

  // Same instants in UTC land on one day.
  const utc = dayWindows('UTC', 2, now);
  assert.deepEqual(utc.map((w) => w.key), ['2026-09-23', '2026-09-24']);
  assert.deepEqual(bucketSeconds([[Date.parse('2026-09-23T17:00:00Z'), Date.parse('2026-09-23T19:00:00Z')]], utc), [7200, 0]);
});

test('dayWindows handles DST days and falls back to UTC for unknown zones', () => {
  const windows = dayWindows('America/New_York', 2, Date.parse('2026-03-09T12:00:00Z'));
  assert.deepEqual(windows.map((w) => w.key), ['2026-03-08', '2026-03-09']);
  assert.equal(new Date(windows[0].startMs).toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(windows[0].endMs - windows[0].startMs, 23 * H, 'spring-forward day has 23 h');
  assert.equal(new Date(windows[1].startMs).toISOString(), '2026-03-09T04:00:00.000Z');

  assert.equal(resolveTimeZone('Not/AZone'), 'UTC');
  assert.equal(resolveTimeZone(null), 'UTC');
  assert.equal(resolveTimeZone('Asia/Dhaka'), 'Asia/Dhaka');
});

test('summarizeSwitch: ON at window start and still ON now; kWh only with watts', () => {
  const now = Date.parse('2026-09-24T06:00:00Z');
  const windows = dayWindows('UTC', 3, now);
  const s = summarizeSwitch({ events: [], initialState: 'ON', windows, nowMs: now, watts: null });
  assert.deepEqual(s.dailyOnSeconds, [86_400, 86_400, 6 * 3600]);
  assert.equal(s.totalOnSeconds, 2 * 86_400 + 6 * 3600);
  assert.equal(s.kwh, null);
  assert.equal(kwhFor(7200, 60), 0.12);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function mockDb({ timezone = 'Asia/Dhaka' } = {}) {
  const now = Date.now();
  const calls = [];
  const handlers = [
    ['FROM household_members WHERE user_id', () => [{ household_id: HOUSEHOLD_ID, role: 'member' }]],
    ['SELECT household_id FROM devices WHERE device_id', ([id]) => (id === DEVICE ? [{ household_id: HOUSEHOLD_ID }] : [])],
    ['SELECT timezone FROM households', () => [{ timezone }]],
    ['CROSS JOIN LATERAL', () => [{ device_id: DEVICE, channel_idx: 0, state: 'OFF' }]],
    ['SELECT s.device_id, d.friendly_name', () => [
      { device_id: DEVICE, friendly_name: 'Yard', channel_idx: 0, name: 'Pump', watts: 1000 },
      { device_id: DEVICE, friendly_name: 'Yard', channel_idx: 1, name: '', watts: null },
    ]],
    ['ORDER BY a.created_at, a.id', () => [
      // ch0: ON 2 min ago (plus an echo replay), still ON.
      { device_id: DEVICE, channel_idx: 0, state: 'ON', created_at: new Date(now - 120_000) },
      { device_id: DEVICE, channel_idx: 0, state: 'ON', created_at: new Date(now - 60_000) },
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
  return calls;
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
  return (path) => fetch(base + path, { headers: { Authorization: `Bearer ${jwt}` } });
}

test('GET /devices/:id/usage returns per-switch daily ON seconds in the household timezone', async (t) => {
  const calls = mockDb();
  const call = await start(t);

  const res = await call(`/devices/${DEVICE}/usage?days=3`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.timezone, 'Asia/Dhaka');
  assert.equal(body.days.length, 3);
  assert.match(body.days[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.switches.length, 2);
  const [pump, ch1] = body.switches;
  assert.deepEqual(Object.keys(pump).sort(), ['channelIdx', 'dailyOnSeconds', 'kwh', 'name', 'totalOnSeconds', 'watts']);
  assert.equal(pump.name, 'Pump');
  assert.equal(pump.dailyOnSeconds.length, 3);
  assert.ok(pump.totalOnSeconds >= 119 && pump.totalOnSeconds <= 122, `total ${pump.totalOnSeconds}`);
  assert.equal(pump.dailyOnSeconds.reduce((a, b) => a + b, 0), pump.totalOnSeconds);
  assert.equal(pump.kwh, (pump.totalOnSeconds * 1000) / 3.6e6);
  assert.equal(ch1.name, 'Channel 1');
  assert.equal(ch1.totalOnSeconds, 0);
  assert.equal(ch1.kwh, null);

  // Scoped to the device and to this household's own history.
  const events = calls.find((c) => c.sql.includes('ORDER BY a.created_at, a.id'));
  assert.deepEqual(events.params.slice(0, 2), [HOUSEHOLD_ID, DEVICE]);
});

test('GET /devices/:id/usage validates days and membership', async (t) => {
  mockDb();
  const call = await start(t);
  assert.equal((await call(`/devices/${DEVICE}/usage?days=0`)).status, 400);
  assert.equal((await call(`/devices/${DEVICE}/usage?days=91`)).status, 400);
  assert.equal((await call('/devices/esp-foreign/usage')).status, 404);
  const res = await call(`/devices/${DEVICE}/usage`);
  assert.equal((await res.json()).days.length, 7, 'defaults to 7 days');
});

test('GET /usage aggregates the household with totals', async (t) => {
  const calls = mockDb({ timezone: 'Nowhere/Invalid' });
  const call = await start(t);

  const res = await call('/usage?days=2');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.timezone, 'UTC');
  assert.equal(body.days.length, 2);
  assert.equal(body.switches[0].deviceId, DEVICE);
  assert.equal(body.switches[0].deviceName, 'Yard');
  assert.equal(body.totals.onSeconds, body.switches[0].totalOnSeconds + body.switches[1].totalOnSeconds);
  assert.equal(body.totals.kwh, body.switches[0].kwh);
  const events = calls.find((c) => c.sql.includes('ORDER BY a.created_at, a.id'));
  assert.deepEqual(events.params.slice(0, 2), [HOUSEHOLD_ID, null]);

  assert.equal((await call('/usage?householdId=99')).status, 404);
  assert.equal((await call('/usage?days=abc')).status, 400);
});
