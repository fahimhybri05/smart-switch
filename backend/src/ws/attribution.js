// Short-TTL attribution map — the device's `state_changed` WS event is
// origin-blind (fires the same way whether a change came from a direct app
// call, a cloud relay, a group/scene, an automation, or the device's own
// local schedule), so logging/loop-protection can't rely on that event
// alone. Whoever *initiates* a channel-state command notes the expected
// outcome here right before sending it; the `state_changed` handler in
// deviceServer.js consumes it once, on the matching echo. Also carries
// automation cascade-depth/chain data for loop protection (see
// automations/engine.js) — same map, one mechanism, per docs/plan.md.
//
// Each key holds a FIFO queue of pending entries, not a single value — a
// second command to the same deviceId/channelIdx/state landing within the
// TTL of an in-flight one would otherwise clobber (Map.set-overwrite) the
// first entry's cascade-depth/chain data, letting MAX_AUTOMATION_HOP_DEPTH
// be bypassed. Ordering is preserved: first command in, first echo
// consumed.
const pending = new Map();
const TTL_MS = 8_000;

function key(deviceId, channelIdx, state) {
  return `${deviceId}:${channelIdx}:${state}`;
}

/**
 * @param {object} attribution
 * @param {'app'|'widget'|'group'|'scene'|'automation'} attribution.source
 * @param {number|null} [attribution.actorUserId]
 * @param {number|null} [attribution.automationId]
 * @param {number} [attribution.depth]
 * @param {Set<number>} [attribution.chainAutomationIds]
 */
export function noteExpectedStateChange(deviceId, channelIdx, state, attribution) {
  const k = key(deviceId, channelIdx, state);
  const entry = { ...attribution, expiresAt: Date.now() + TTL_MS };
  if (!pending.has(k)) {
    pending.set(k, []);
  }
  pending.get(k).push(entry);
}

/** Consumes (shifts off) and returns the OLDEST still-non-expired queued
 * attribution for this key, or null if none/expired. Any expired entries
 * ahead of it in the queue are discarded along the way. */
export function takeAttribution(deviceId, channelIdx, state) {
  const k = key(deviceId, channelIdx, state);
  const queue = pending.get(k);
  if (!queue) {
    return null;
  }
  let result = null;
  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry.expiresAt >= Date.now()) {
      result = entry;
      break;
    }
  }
  if (queue.length === 0) {
    pending.delete(k);
  }
  return result;
}
