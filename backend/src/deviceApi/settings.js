import { pool } from '../db/pool.js';
import { pushHwConfigToDevice } from './hwConfig.js';

/** A device with no device_settings row yet reads back as all-defaults —
 * matches the old firmware's own fresh-device defaults
 * (docs/firmware-esp8266.md §5's loadDefault(): utc_offset_min=0, no auth/
 * location set). Used by deviceApi/info.js's getConfig too. */
export async function getSettings(deviceId) {
  const { rows } = await pool.query('SELECT * FROM device_settings WHERE device_id = $1', [deviceId]);
  return (
    rows[0] ?? {
      device_id: deviceId,
      utc_offset_min: 0,
      interlock_enabled: false,
      latitude: null,
      longitude: null,
      location_set: false,
    }
  );
}

/** `POST /api/timezone` — persists `utc_offset_min`, matching the old
 * firmware's `handlePostTimezone`/`configStore.setUtcOffset()`. */
export async function setTimezone(deviceId, body) {
  const utcOffsetMin = Number(body?.utc_offset_min);
  if (!Number.isInteger(utcOffsetMin)) {
    return { status: 400, body: { error: 'utc_offset_min must be an integer' } };
  }
  await pool.query(
    `INSERT INTO device_settings (device_id, utc_offset_min)
     VALUES ($1, $2)
     ON CONFLICT (device_id) DO UPDATE SET utc_offset_min = EXCLUDED.utc_offset_min`,
    [deviceId, utcOffsetMin],
  );
  return { status: 200, body: { utc_offset_min: utcOffsetMin } };
}

/**
 * `POST /api/settings` — interlock and/or location, independently
 * optional (matches app/lib/services/device_api_client.dart's
 * setDeviceSettings: "pass only what changed"). Passing exactly one of
 * latitude/longitude without the other is rejected with 400, per that same
 * client's contract ("always supply both together"). Returns the
 * resulting, persisted `{interlock_enabled, latitude, longitude,
 * location_set}`.
 *
 * When the request touches `interlock_enabled`, also pushes the updated
 * hw config down to the device (per docs/plan.md: "setSettings ... when
 * they touch interlock_enabled ... also send the device a hw_config_push
 * frame").
 */
export async function setSettings(deviceId, body) {
  const hasLat = body?.latitude !== undefined;
  const hasLng = body?.longitude !== undefined;
  if (hasLat !== hasLng) {
    return { status: 400, body: { error: 'latitude and longitude must be set together' } };
  }

  const current = await getSettings(deviceId);
  const interlockTouched = body?.interlock_enabled !== undefined;
  const interlockEnabled = interlockTouched ? Boolean(body.interlock_enabled) : current.interlock_enabled;
  const latitude = hasLat ? Number(body.latitude) : current.latitude;
  const longitude = hasLng ? Number(body.longitude) : current.longitude;
  const locationSet = hasLat && hasLng ? true : current.location_set;

  await pool.query(
    `INSERT INTO device_settings (device_id, utc_offset_min, interlock_enabled, latitude, longitude, location_set)
     VALUES ($1, COALESCE((SELECT utc_offset_min FROM device_settings WHERE device_id = $1), 0), $2, $3, $4, $5)
     ON CONFLICT (device_id) DO UPDATE SET
       interlock_enabled = EXCLUDED.interlock_enabled,
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       location_set = EXCLUDED.location_set`,
    [deviceId, interlockEnabled, latitude, longitude, locationSet],
  );

  if (interlockTouched) {
    await pushHwConfigToDevice(deviceId);
  }

  return {
    status: 200,
    body: {
      interlock_enabled: interlockEnabled,
      latitude,
      longitude,
      location_set: locationSet,
    },
  };
}
