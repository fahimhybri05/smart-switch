-- Phone-local groups are being promoted to account-wide (see docs/plan.md's
-- "Account-wide device/room/group sync" section) — a group is now owned by
-- a user, not a single phone, so every phone on the same account sees the
-- same groups.
CREATE TABLE IF NOT EXISTS groups (
    id BIGSERIAL PRIMARY KEY,
    owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_groups_owner_user_id ON groups(owner_user_id);

-- Mirrors the app's existing GroupMember{deviceId, channelIdx} shape
-- exactly. device_id (not devices.id) is the FK target since that's the
-- natural external key every other table already uses.
CREATE TABLE IF NOT EXISTS group_members (
    group_id BIGINT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    channel_idx SMALLINT NOT NULL,
    PRIMARY KEY (group_id, device_id, channel_idx)
);
