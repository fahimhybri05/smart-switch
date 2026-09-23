-- Backend becomes the primary store for per-device switch/schedule/settings
-- config (see docs/plan.md's server-authoritative ESP8266 rewrite) — the
-- trimmed-down firmware holds none of this itself anymore, beyond the tiny
-- hw_config_push cache (input_mode/inching_ms/interlock) it needs for the
-- disclosed instant/offline physical-input exception. cached_channel_state
-- (001_init.sql) keeps its existing display-only live-state-cache role
-- unchanged — these new tables are config, not live state.

-- Field names/shapes here mirror the OLD firmware's SsSwitch struct and its
-- wire JSON exactly (docs/firmware-esp8266.md §5), which is also exactly
-- what app/lib/models/device/switch_config.dart already sends/expects —
-- so the app needs zero changes.
CREATE TABLE IF NOT EXISTS device_switches (
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    channel_idx SMALLINT NOT NULL,
    name TEXT,
    zone TEXT,
    -- Always "ON_OFF" in practice (this board is ON/OFF only, same as the
    -- old firmware forcing it server-side regardless of caller input) —
    -- left as free TEXT rather than a CHECK, matching the old firmware's
    -- own lack of a real enum here.
    type TEXT NOT NULL DEFAULT 'ON_OFF',
    default_boot_state TEXT NOT NULL DEFAULT 'OFF' CHECK (default_boot_state IN ('ON', 'OFF')),
    -- Physical wall-switch/button behavior for this channel — the one
    -- piece of config the device still needs cached locally (hw_config_push).
    input_mode TEXT NOT NULL DEFAULT 'DISABLED' CHECK (input_mode IN ('DISABLED', 'TOGGLE', 'EDGE')),
    inching_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, channel_idx)
);

-- Old firmware's `next_schedule_id` was a per-device in-memory counter
-- (config_store.cpp) with no separate persisted column of its own — rather
-- than inventing new per-device counter state, a single shared sequence
-- generates the same "s-<n>" opaque-id wire shape; uniqueness of
-- (device_id, id) is guaranteed since the sequence never repeats. See
-- deviceApi/schedules.js's upsertSchedule.
CREATE SEQUENCE IF NOT EXISTS device_schedule_id_seq;

-- Field names mirror the OLD firmware's SsSchedule struct/wire shape
-- (docs/firmware-esp8266.md §5) and app/lib/models/device/schedule.dart —
-- with one deliberate addition: last_fired_at, an internal-only bookkeeping
-- column (never on the wire) needed by deviceSchedules/scheduler.js's
-- once-per-local-day catch-up guard, the same role
-- automations.last_fired_at already plays for automations/scheduler.js.
-- days_mask is the on-disk bitfield form; the wire/JSON form is a `days`
-- array (1=Mon..7=Sun) — deviceApi/schedules.js converts between the two,
-- same as the old firmware's handlePostSchedules did.
CREATE TABLE IF NOT EXISTS device_schedules (
    id TEXT NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    channel_idx SMALLINT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('ON', 'OFF')),
    -- Matches app/lib/models/device/schedule.dart's ScheduleType enum
    -- exactly. Only 'daily'/'weekly' are evaluated by
    -- deviceSchedules/scheduler.js in this pass (see its own comments) —
    -- 'once'/'countdown'/'sunrise'/'sunset' are stored (full CRUD works)
    -- but not yet fired automatically; flagged gap, not silent misfire.
    type TEXT NOT NULL CHECK (type IN ('once', 'daily', 'weekly', 'countdown', 'sunrise', 'sunset')),
    time TEXT,               -- "HH:MM", clock-based types only
    days_mask SMALLINT NOT NULL DEFAULT 0,  -- bit (day-1), 1=Mon..7=Sun
    duration_s INTEGER,      -- countdown types only
    solar_offset_min INTEGER, -- sunrise/sunset types only
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_fired_at TIMESTAMPTZ,
    PRIMARY KEY (device_id, id)
);
CREATE INDEX IF NOT EXISTS device_schedules_device_id_idx ON device_schedules(device_id);
CREATE INDEX IF NOT EXISTS device_schedules_enabled_idx ON device_schedules(device_id, enabled) WHERE enabled;

-- One row per device, created lazily on first setTimezone/setSettings call
-- (deviceApi/settings.js) rather than backfilled here — a device with no
-- row yet simply reads back all-defaults (utc_offset_min=0,
-- interlock_enabled=false, location unset), matching the old firmware's
-- own fresh-device defaults (docs/firmware-esp8266.md §5's loadDefault()).
CREATE TABLE IF NOT EXISTS device_settings (
    device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
    utc_offset_min SMALLINT NOT NULL DEFAULT 0,
    interlock_enabled BOOLEAN NOT NULL DEFAULT false,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    location_set BOOLEAN NOT NULL DEFAULT false
);
