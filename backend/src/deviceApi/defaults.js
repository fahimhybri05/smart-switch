import { pool } from '../db/pool.js';
import { DEFAULT_CHANNEL_COUNT } from './constants.js';

/**
 * One-time per-device seed of "Channel <i>" switch rows, matching the old
 * firmware's fresh-device defaults. Keyed on the device_settings row being
 * newly created, so a switch the user later deletes isn't resurrected on
 * the next reconnect.
 */
export async function ensureDeviceDefaults(deviceId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      'INSERT INTO device_settings (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING',
      [deviceId],
    );
    if (rowCount > 0) {
      await client.query(
        `INSERT INTO device_switches (device_id, channel_idx, name, zone)
         SELECT $1, i, 'Channel ' || i, '' FROM generate_series(0, $2 - 1) AS i
         ON CONFLICT (device_id, channel_idx) DO NOTHING`,
        [deviceId, DEFAULT_CHANNEL_COUNT],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
