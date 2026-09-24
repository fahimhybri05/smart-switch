-- Admin console (see src/routes/admin.js). Admins are ordinary accounts with
-- a role flag; the first one is set with `npm run make-admin -- <email>`
-- (src/scripts/makeAdmin.js), after which admins promote/demote each other
-- from the dashboard. Every admin API re-reads is_admin from this table on
-- each request — the JWT carries no role.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
-- Disabled accounts can't log in or refresh, and their API keys / hook URLs
-- stop working. Soft flag: the account and its data stay intact.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- Last successful device WS auth, and the firmware diagnostics sent in that
-- auth frame ({fw, resetReason, uptimeS, freeHeap, rssi, at}).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_connected_at TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS diagnostics JSONB;

-- "Reset secret" (admin) clears the stored hash; the device's next connect
-- (or the next /devices/claim) adopts whatever secret it presents —
-- the recovery path for a factory-reset device that generated a new secret.
ALTER TABLE devices ALTER COLUMN cloud_secret_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    -- NULL for actions run from the CLI (admin_email = 'cli'), or once the
    -- acting admin's account is deleted — admin_email keeps the snapshot.
    admin_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    admin_email TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_log_created_idx
  ON admin_audit_log(created_at DESC, id DESC);

-- The admin activity feed and 24h stats read activity_log across every
-- household, newest first — the existing index leads with household_id.
CREATE INDEX IF NOT EXISTS activity_log_created_idx
  ON activity_log(created_at DESC, id DESC);
