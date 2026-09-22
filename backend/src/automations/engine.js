import { pool } from '../db/pool.js';
import { noteExpectedStateChange } from '../ws/attribution.js';
import { relayCommand } from '../ws/registry.js';

// Generous for real multi-step chains, small enough to bound worst-case
// fan-out fast. See the loop-protection worked example in docs/plan.md.
const MAX_AUTOMATION_HOP_DEPTH = 5;

// Automations are unattended — unlike a direct app command, there's no user
// to just tap the switch again if the first attempt lands in the middle of
// a device's reconnect. One bounded retry after a short delay catches the
// common "device is mid-reconnect" case (ESP8266's cloud tunnel reconnects
// every ~4-9s baseline) without materially delaying the action or risking
// an unbounded retry loop.
const RELAY_RETRY_DELAY_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True if `deviceId` still belongs to `householdId` — a device can be
 * unclaimed (routes/devices.js's DELETE /:deviceId only clears
 * owner_user_id/household_id, the row and device_id persist) and later
 * reclaimed by an unrelated household, so an automation's action-side
 * device references need re-checking at fire time, not just at
 * create/update time (see routes/automations.js's validateDevicesInHousehold,
 * which guards the create/update path only). */
async function isDeviceInHousehold(deviceId, householdId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM devices WHERE device_id = $1 AND household_id = $2',
    [deviceId, householdId],
  );
  return rows.length > 0;
}

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
    // Cross-tenant guard: the device referenced by this action may have
    // been unclaimed and reclaimed by a different household since this
    // automation was created/last fired — skip rather than relay to a
    // device this automation's household no longer owns.
    if (!(await isDeviceInHousehold(action.deviceId, automation.household_id))) {
      console.warn(
        `automation ${automation.id} action skipped: device ${action.deviceId} no longer in household ${automation.household_id}`,
      );
      continue;
    }

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
    const relay = () =>
      relayCommand(action.deviceId, {
        method: 'POST',
        path: `/api/channels/${action.channelIdx}/state`,
        body: { state: action.state },
      });
    try {
      await relay();
    } catch (firstErr) {
      await sleep(RELAY_RETRY_DELAY_MS);
      // Re-note the attribution — the first attempt's entry may already
      // have expired or been consumed by the time this retry's own
      // state_changed echo (if any) arrives.
      noteExpectedStateChange(action.deviceId, action.channelIdx, action.state, {
        source: 'automation',
        actorUserId: null,
        automationId: automation.id,
        depth: depth + 1,
        chainAutomationIds: nextChain,
      });
      try {
        await relay();
      } catch (retryErr) {
        // Still unreachable — activity_log only ever records confirmed
        // changes (via the state_changed echo), so a failed action here is
        // console-only this pass (no automation-run-history UI yet —
        // flagged gap, see docs/plan.md).
        console.error(
          `automation ${automation.id} action failed for ${action.deviceId} (after 1 retry)`,
          retryErr,
        );
      }
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
