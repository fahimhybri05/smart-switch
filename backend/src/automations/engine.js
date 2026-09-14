import { pool } from '../db/pool.js';
import { noteExpectedStateChange } from '../ws/attribution.js';
import { relayCommand } from '../ws/registry.js';

// Generous for real multi-step chains, small enough to bound worst-case
// fan-out fast. See the loop-protection worked example in docs/plan.md.
const MAX_AUTOMATION_HOP_DEPTH = 5;

/**
 * Executes one automation's actions. `depth`/`chainAutomationIds` come
 * from the attribution of the state change that triggered this (0/empty
 * for a schedule-tick or a human-caused trigger) — this is the loop/
 * cascade-protection mechanism: an automation whose own actions feed back
 * into itself (directly or via another automation already in this
 * cascade) is refused, fail-closed, rather than looping.
 */
export async function fireAutomation(automation, { depth = 0, chainAutomationIds = new Set() } = {}) {
  if (depth >= MAX_AUTOMATION_HOP_DEPTH) {
    console.warn(`automation ${automation.id} (${automation.name}) skipped: max hop depth reached`);
    return;
  }
  if (chainAutomationIds.has(automation.id)) {
    console.warn(`automation ${automation.id} (${automation.name}) skipped: already fired in this cascade`);
    return;
  }
  const nextChain = new Set([...chainAutomationIds, automation.id]);

  for (const action of automation.actions) {
    // Noted BEFORE relaying so the resulting state_changed echo (if the
    // device is online and the command succeeds) carries the cascade
    // forward into the next evaluateStateTriggeredAutomations call.
    noteExpectedStateChange(action.deviceId, action.channelIdx, action.state, {
      source: 'automation',
      actorUserId: null,
      automationId: automation.id,
      depth: depth + 1,
      chainAutomationIds: nextChain,
    });
    try {
      await relayCommand(action.deviceId, {
        method: 'POST',
        path: `/api/channels/${action.channelIdx}/state`,
        body: { state: action.state },
      });
    } catch (err) {
      // Device offline/unreachable — activity_log only ever records
      // confirmed changes (via the state_changed echo), so a failed
      // action here is console-only this pass (no automation-run-history
      // UI yet — flagged gap, see docs/plan.md).
      console.error(`automation ${automation.id} action failed for ${action.deviceId}`, err);
    }
  }

  await pool.query('UPDATE automations SET last_fired_at = now() WHERE id = $1', [automation.id]);
}

/**
 * Called from deviceServer.js's `state_changed` handler — the single hook
 * point for both activity logging and automation triggering (see
 * docs/plan.md). Direct function call, not a pub/sub emitter: there's
 * exactly one call site today.
 */
export async function evaluateStateTriggeredAutomations({
  deviceId,
  channelIdx,
  state,
  householdId,
  depth = 0,
  chainAutomationIds = new Set(),
}) {
  const { rows } = await pool.query(
    `SELECT id, household_id, name, actions FROM automations
     WHERE trigger_type = 'state' AND enabled
       AND trigger_device_id = $1 AND trigger_channel_idx = $2 AND trigger_state = $3
       AND household_id = $4`,
    [deviceId, channelIdx, state, householdId],
  );
  for (const automation of rows) {
    await fireAutomation(automation, { depth, chainAutomationIds });
  }
}
