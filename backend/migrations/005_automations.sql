CREATE TABLE IF NOT EXISTS automations (
    id BIGSERIAL PRIMARY KEY,
    household_id BIGINT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule', 'state')),
    -- schedule trigger: 1=Mon..7=Sun, same convention as the app's existing
    -- per-device schedules_screen.dart. household-local time, per households.timezone.
    schedule_days SMALLINT[],
    schedule_time TIME,
    -- state trigger: fires when trigger_device_id's trigger_channel_idx
    -- changes to trigger_state.
    trigger_device_id TEXT REFERENCES devices(device_id) ON DELETE CASCADE,
    trigger_channel_idx SMALLINT,
    trigger_state TEXT CHECK (trigger_state IN ('ON', 'OFF')),
    -- [{deviceId, channelIdx, state}] — embedded, not a Scene reference
    -- (Scenes are still Hive-only/unsynced — see docs/plan.md).
    actions JSONB NOT NULL,
    created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_fired_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS automations_household_idx ON automations(household_id);
CREATE INDEX IF NOT EXISTS automations_state_trigger_idx
  ON automations(trigger_device_id, trigger_channel_idx, trigger_state)
  WHERE trigger_type = 'state' AND enabled;

ALTER TABLE activity_log ADD CONSTRAINT activity_log_automation_id_fkey
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE SET NULL;
