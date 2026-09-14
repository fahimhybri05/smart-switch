import { pool } from './db/pool.js';

/**
 * Logs one confirmed channel state change. Called only from
 * deviceServer.js's `state_changed` handler — the one place a state
 * change is ever confirmed — never at relay-request time (would
 * double-count against the resulting echo). Never throws past itself;
 * callers should `.catch(console.error)`.
 */
export async function logActivity({
  householdId,
  deviceId,
  channelIdx,
  state,
  source,
  actorUserId = null,
  automationId = null,
}) {
  await pool.query(
    `INSERT INTO activity_log (household_id, device_id, channel_idx, state, source, actor_user_id, automation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [householdId, deviceId, channelIdx, state, source, actorUserId, automationId],
  );
}
