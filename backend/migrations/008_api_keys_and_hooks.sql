-- External API access (see src/v1/). Two secret kinds, both stored
-- hash-only (SHA-256 of the raw secret — same scheme as refresh_tokens);
-- the raw value is shown to the user exactly once at creation time, and
-- only the short prefix is ever displayed afterwards. Revocation is soft
-- (revoked_at) so "last used" history survives.

-- `sk_...` keys: Authorization: Bearer sk_... against /v1. Scoped to the
-- user — household access is re-checked on every request, so a user who
-- leaves a household immediately loses API access to its devices.
CREATE TABLE IF NOT EXISTS api_keys (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys(user_id);

-- `wh_...` per-switch secret URLs (/v1/hook/:token/on|off|toggle|status).
-- Tied to an API key: revoking the key (or deleting the user) kills every
-- hook created under it.
CREATE TABLE IF NOT EXISTS switch_hooks (
    id BIGSERIAL PRIMARY KEY,
    api_key_id BIGINT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    channel_idx SMALLINT NOT NULL,
    name TEXT,
    token_prefix TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS switch_hooks_api_key_id_idx ON switch_hooks(api_key_id);

-- New activity sources: the public API, hook URLs, and the web dashboard.
ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_source_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_source_check
  CHECK (source IN ('app', 'widget', 'group', 'scene', 'automation', 'device', 'api', 'hook', 'dashboard'));
