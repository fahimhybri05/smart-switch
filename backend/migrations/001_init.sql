CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- owner_user_id is NULLABLE: a device row is created (unclaimed) the
-- moment it first connects over WebSocket, and claimed later by whichever
-- user's app submits the matching cloud_secret — see routes/devices.js.
CREATE TABLE IF NOT EXISTS devices (
    id BIGSERIAL PRIMARY KEY,
    device_id TEXT UNIQUE NOT NULL,
    owner_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    friendly_name TEXT,
    cloud_secret_hash TEXT NOT NULL,
    is_online BOOLEAN NOT NULL DEFAULT false,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_owner_user_id ON devices(owner_user_id);

-- Display-only cache — never treated as truth. Refreshed whenever the
-- device pushes a state_changed event or a relayed command succeeds.
CREATE TABLE IF NOT EXISTS cached_channel_state (
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    channel_idx SMALLINT NOT NULL,
    name TEXT,
    zone TEXT,
    state TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, channel_idx)
);
