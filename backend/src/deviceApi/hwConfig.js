import { pool } from '../db/pool.js';
import { sendHwConfigPush } from '../ws/registry.js';

/**
 * Reads the current hw-relevant config — per-channel `input_mode`/
 * `inching_ms` (device_switches) plus the device-wide `interlock_enabled`
 * flag (device_settings) — and fire-and-forget pushes it down to the
 * device as `{event: "hw_config_push", channels, interlockEnabled}`. This
 * is the one config the trimmed-down firmware still needs cached locally,
 * because it's required for the instant/offline physical-input exception
 * to work correctly (see docs/plan.md's Wire protocol section).
 *
 * Called from two places: once right after auth on every device connect
 * (ws/deviceServer.js), and again whenever upsertSwitch/setSettings
 * touches one of these specific fields — both go through this single
 * function so the two occasions can never drift out of sync with each
 * other about what the "current" hw config actually is.
 */
export async function pushHwConfigToDevice(deviceId) {
  const [{ rows: switchRows }, { rows: settingsRows }] = await Promise.all([
    pool.query(
      'SELECT channel_idx, input_mode, inching_ms FROM device_switches WHERE device_id = $1 ORDER BY channel_idx',
      [deviceId],
    ),
    pool.query('SELECT interlock_enabled FROM device_settings WHERE device_id = $1', [deviceId]),
  ]);

  const channels = switchRows.map((row) => ({
    channelIdx: row.channel_idx,
    inputMode: row.input_mode,
    inchingMs: row.inching_ms,
  }));
  const interlockEnabled = settingsRows[0]?.interlock_enabled ?? false;

  sendHwConfigPush(deviceId, { channels, interlockEnabled });
}
