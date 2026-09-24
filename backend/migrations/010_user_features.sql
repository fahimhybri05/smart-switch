-- User features: usage stats, scenes, safety rules, switch lock.
-- See the shared "user features" contract (backend is authoritative).

-- Per-switch safety/energy config. All nullable: NULL = feature off.
--   watts      nominal load, for kWh estimates in usage stats
--   max_on_s   auto-OFF after this long ON (safety/scheduler.js)
--   min_off_s  must stay OFF this long before a new remote ON (safety/guard.js)
--   locked_at  non-NULL = locked: every remote ON/OFF command is rejected
--              (physical presses on the board are device-local, unaffected)
ALTER TABLE device_switches ADD COLUMN IF NOT EXISTS watts INTEGER
  CONSTRAINT device_switches_watts_check CHECK (watts IS NULL OR watts BETWEEN 0 AND 100000);
ALTER TABLE device_switches ADD COLUMN IF NOT EXISTS max_on_s INTEGER
  CONSTRAINT device_switches_max_on_s_check CHECK (max_on_s IS NULL OR max_on_s BETWEEN 1 AND 604800);
ALTER TABLE device_switches ADD COLUMN IF NOT EXISTS min_off_s INTEGER
  CONSTRAINT device_switches_min_off_s_check CHECK (min_off_s IS NULL OR min_off_s BETWEEN 1 AND 86400);
ALTER TABLE device_switches ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE device_switches ADD COLUMN IF NOT EXISTS locked_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- When the cached state last actually CHANGED (updated_at moves on every
-- echo, including replays of the same state). Maintained by
-- ws/deviceServer.js's recordStateChange. Existing rows are backfilled with
-- updated_at — the closest known upper bound — so max-runtime protection
-- applies to channels that were already ON before this migration.
ALTER TABLE cached_channel_state ADD COLUMN IF NOT EXISTS state_since TIMESTAMPTZ;
UPDATE cached_channel_state SET state_since = updated_at WHERE state_since IS NULL;
ALTER TABLE cached_channel_state ALTER COLUMN state_since SET DEFAULT now();

-- Account-wide scenes (were phone-local). Permissions mirror groups: any
-- household member may create/edit/delete/run. actions:
-- [{deviceId, channelIdx, state: "ON"|"OFF"}], max 64.
CREATE TABLE IF NOT EXISTS scenes (
    id BIGSERIAL PRIMARY KEY,
    household_id BIGINT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 64),
    icon TEXT,
    actions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
      CASE WHEN jsonb_typeof(actions) = 'array' THEN jsonb_array_length(actions) <= 64 ELSE false END
    ),
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenes_household_id_idx ON scenes(household_id);

-- New activity source: max-runtime auto-OFF. Keeps every existing value.
ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_source_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_source_check
  CHECK (source IN ('app', 'widget', 'group', 'scene', 'automation', 'device', 'api', 'hook', 'dashboard', 'safety'));

-- Usage stats read one switch's history ("last state before the window",
-- then every change inside it) — the existing indexes lead with
-- household_id / created_at only.
CREATE INDEX IF NOT EXISTS activity_log_device_channel_created_idx
  ON activity_log(device_id, channel_idx, created_at DESC, id DESC);
