-- Append-only log of confirmed channel state changes, household-scoped.
-- Unlike cached_channel_state (upsert-in-place, display-only), this table
-- is never overwritten — every row is a historical fact. automation_id has
-- no FK yet (automations table doesn't exist until 005_automations.sql).
CREATE TABLE IF NOT EXISTS activity_log (
    id BIGSERIAL PRIMARY KEY,
    household_id BIGINT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    channel_idx SMALLINT NOT NULL,
    state TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('app', 'widget', 'group', 'scene', 'automation', 'device')),
    actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    automation_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_log_household_created_idx
  ON activity_log(household_id, created_at DESC, id DESC);
