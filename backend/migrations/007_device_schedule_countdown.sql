-- Countdown schedules fire at countdown_started_at + duration_s. Internal-only
-- (never on the wire), armed by deviceApi/schedules.js on create and on a
-- disabled->enabled transition — same rules the old firmware applied.
ALTER TABLE device_schedules ADD COLUMN IF NOT EXISTS countdown_started_at TIMESTAMPTZ;
