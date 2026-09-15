import { pool } from './pool.js';

/**
 * Devices visible to the given household ids, in the exact shape
 * `GET /devices` (routes/devices.js) returns. Factored out here so the
 * WS-side initial snapshot (ws/clientServer.js) and the REST route share
 * one query instead of drifting out of sync.
 */
export async function getHouseholdDevicesSnapshot(householdIds) {
  if (householdIds.length === 0) {
    return [];
  }
  const { rows } = await pool.query(
    `SELECT d.device_id, d.friendly_name, d.is_online, d.last_seen_at,
            COALESCE(
              json_agg(
                json_build_object(
                  'channelIdx', c.channel_idx, 'name', c.name,
                  'zone', c.zone, 'state', c.state, 'updatedAt', c.updated_at
                ) ORDER BY c.channel_idx
              ) FILTER (WHERE c.channel_idx IS NOT NULL),
              '[]'
            ) AS channels
     FROM devices d
     LEFT JOIN cached_channel_state c ON c.device_id = d.device_id
     WHERE d.household_id = ANY($1::bigint[])
     GROUP BY d.device_id, d.friendly_name, d.is_online, d.last_seen_at
     ORDER BY d.device_id`,
    [householdIds],
  );
  return rows;
}
