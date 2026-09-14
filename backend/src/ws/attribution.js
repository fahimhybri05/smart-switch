// Short-TTL attribution map — the device's `state_changed` WS event is
// origin-blind (fires the same way whether a change came from a direct app
// call, a cloud relay, a group/scene, an automation, or the device's own
// local schedule), so logging/loop-protection can't rely on that event
// alone. Whoever *initiates* a channel-state command notes the expected
// outcome here right before sending it; the `state_changed` handler in
// deviceServer.js consumes it once, on the matching echo. Also carries
// automation cascade-depth/chain data for loop protection (see
// automations/engine.js) — same map, one mechanism, per docs/plan.md.
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
  pending.set(key(deviceId, channelIdx, state), {
    ...attribution,
    expiresAt: Date.now() + TTL_MS,
  });
}

/** Consumes (removes) and returns the attribution, or null if none/expired. */
export function takeAttribution(deviceId, channelIdx, state) {
  const k = key(deviceId, channelIdx, state);
  const entry = pending.get(k);
  if (!entry) {
    return null;
  }
  pending.delete(k);
  return entry.expiresAt >= Date.now() ? entry : null;
}
