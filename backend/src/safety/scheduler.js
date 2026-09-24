import { pool } from '../db/pool.js';
import { setChannelState } from '../deviceApi/channels.js';
import { DEFAULT_CHANNEL_COUNT } from '../deviceApi/constants.js';
import { noteExpectedStateChange } from '../ws/attribution.js';
import { isDeviceOnline } from '../ws/registry.js';

/**
 * Max-runtime protection: turns OFF any channel that has been ON (per
 * cached_channel_state.state_since, which only moves on a real change)
 * for at least its switch's `max_on_s`. Logged with source 'safety'.
 *
 * Protection wins: this is the one actuation that bypasses the switch lock
 * (safety/guard.js). It still goes through the normal relay + attribution,
 * so the device's confirming echo updates the cache, the activity log and
 * every client exactly like any other change.
 */

const TICK_MS = 15_000;
// Same bounded single retry as automations/engine.js and
// deviceSchedules/scheduler.js (device mid-reconnect).
export const RELAY_RETRY_DELAY_MS = 3000;
// After an attempt (successful or not), leave that channel alone for a
// while — e.g. a device that acks but never echoes (stale cache) must not
// be hammered every tick.
const COOLDOWN_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** `${deviceId}:${channelIdx}` currently being turned off (incl. retry). */
const inFlight = new Set();
/** `${deviceId}:${channelIdx}` -> ms timestamp of the last attempt. */
const lastAttemptAt = new Map();

const keyOf = (deviceId, channelIdx) => `${deviceId}:${channelIdx}`;

async function turnOffOnce(deviceId, channelIdx) {
  noteExpectedStateChange(deviceId, channelIdx, 'OFF', { source: 'safety', actorUserId: null });
  const result = await setChannelState(deviceId, channelIdx, 'OFF', { bypassGuard: true });
  if (!result || result.status < 200 || result.status >= 300) {
    throw Object.assign(new Error('device_error'), { code: 'device_error' });
  }
}

async function fireSafetyOff(deviceId, channelIdx) {
  const k = keyOf(deviceId, channelIdx);
  inFlight.add(k);
  lastAttemptAt.set(k, Date.now());
  try {
    try {
      await turnOffOnce(deviceId, channelIdx);
    } catch {
      await sleep(RELAY_RETRY_DELAY_MS);
      try {
        await turnOffOnce(deviceId, channelIdx);
      } catch (retryErr) {
        console.error(`safety auto-off failed for ${deviceId} ch${channelIdx} (after 1 retry)`, retryErr);
        return false;
      }
    }
    console.log(`safety auto-off: ${deviceId} ch${channelIdx} exceeded its max ON time`);
    return true;
  } finally {
    inFlight.delete(k);
    lastAttemptAt.set(k, Date.now());
  }
}

/**
 * One tick. Exported so it's unit-testable without fake interval timers
 * (same pattern as deviceSchedules/scheduler.js's runDeviceScheduleTick).
 * Fires every overdue channel in parallel; resolves once all are settled.
 */
export async function runSafetyTick() {
  try {
    const { rows } = await pool.query(
      `SELECT c.device_id, c.channel_idx
       FROM cached_channel_state c
       JOIN device_switches s ON s.device_id = c.device_id AND s.channel_idx = c.channel_idx
       WHERE c.state = 'ON' AND s.max_on_s IS NOT NULL AND c.state_since IS NOT NULL
         AND c.channel_idx < $1
         AND now() - c.state_since >= make_interval(secs => s.max_on_s)`,
      [DEFAULT_CHANNEL_COUNT],
    );
    const now = Date.now();
    const due = rows.filter(({ device_id: deviceId, channel_idx: channelIdx }) => {
      const k = keyOf(deviceId, channelIdx);
      if (!isDeviceOnline(deviceId) || inFlight.has(k)) return false;
      const last = lastAttemptAt.get(k);
      return last === undefined || now - last >= COOLDOWN_MS;
    });
    await Promise.all(due.map((r) => fireSafetyOff(r.device_id, Number(r.channel_idx))));
  } catch (err) {
    console.error('safety scheduler tick failed', err);
  }
}

/** Test helper: forget cooldown/in-flight bookkeeping. */
export function resetSafetyState() {
  inFlight.clear();
  lastAttemptAt.clear();
}

let tickInFlight = null;

function runTick() {
  // A slow tick (retry sleeps) must not overlap the next one.
  if (tickInFlight) return;
  tickInFlight = runSafetyTick().finally(() => {
    tickInFlight = null;
  });
}

/** Returns a stop function — call from server.js's graceful shutdown. */
export function startSafetyScheduler() {
  const handle = setInterval(runTick, TICK_MS);
  return () => clearInterval(handle);
}

/** Awaits the in-flight tick, if any (graceful shutdown). */
export async function waitForCurrentSafetyTick() {
  if (tickInFlight) {
    await tickInFlight;
  }
}
