import { pool } from '../db/pool.js';
import { DEFAULT_CHANNEL_COUNT } from './constants.js';
import { listSchedules } from './schedules.js';
import { getSettings } from './settings.js';

/**
 * `GET /api/info` — lightweight identity/discovery payload
 * (app/lib/models/device/device_info.dart). NOTE (judgment call, see
 * report): `board_type`/`fw_version`/`wifi_reconfig_state` are genuine
 * hardware/runtime facts the old firmware read from its own RAM — the new
 * migration (006_device_config.sql) doesn't add columns for them to
 * `devices`, since the approved plan's backend section doesn't call for
 * that. These are returned as fixed best-effort placeholders rather than
 * per-device truth; `channel_count` is the one field derived from real
 * data (device_switches row count, falling back to the one board this
 * firmware targets today).
 */
export async function getInfo(deviceId) {
  const { rows } = await pool.query('SELECT device_id FROM devices WHERE device_id = $1', [deviceId]);
  if (!rows[0]) {
    return { status: 404, body: { error: 'device not found' } };
  }
  const { rows: switchRows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM device_switches WHERE device_id = $1',
    [deviceId],
  );
  return {
    status: 200,
    body: {
      device_id: deviceId,
      board_type: 'ESP8266_6CH',
      channel_count: switchRows[0].count || DEFAULT_CHANNEL_COUNT,
      fw_version: 'unknown',
      wifi_reconfig_state: 'IDLE',
      capabilities: ['switch'],
    },
  };
}

/**
 * `GET /api/config` — full config snapshot, matching
 * app/lib/models/device/device_config.dart's DeviceConfig.fromJson
 * field-for-field. `network` (device-local static-IP config) is
 * deliberately omitted — that's genuinely device-resident state the
 * backend never learns about here (see docs/plan.md: `/api/network` is
 * relayed straight through, not implemented server-side).
 */
export async function getConfig(deviceId) {
  const { rows } = await pool.query('SELECT device_id, friendly_name FROM devices WHERE device_id = $1', [
    deviceId,
  ]);
  const device = rows[0];
  if (!device) {
    return { status: 404, body: { error: 'device not found' } };
  }

  const [{ rows: switchRows }, schedules, settings] = await Promise.all([
    pool.query(
      `SELECT channel_idx, COALESCE(name, '') AS name, COALESCE(zone, '') AS zone, type, default_boot_state, input_mode, inching_ms,
              watts, max_on_s, min_off_s, (locked_at IS NOT NULL) AS locked
       FROM device_switches WHERE device_id = $1 ORDER BY channel_idx`,
      [deviceId],
    ),
    listSchedules(deviceId),
    getSettings(deviceId),
  ]);

  return {
    status: 200,
    body: {
      device_id: device.device_id,
      name: device.friendly_name ?? device.device_id,
      board_type: 'ESP8266_6CH',
      channel_count: switchRows.length || DEFAULT_CHANNEL_COUNT,
      channel_driver: 'GPIO_DIRECT',
      fw_version: 'unknown',
      switches: switchRows,
      schedules,
      utc_offset_min: settings.utc_offset_min,
      interlock_enabled: settings.interlock_enabled,
      latitude: settings.latitude,
      longitude: settings.longitude,
      location_set: settings.location_set,
    },
  };
}
