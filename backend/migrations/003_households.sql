-- Households replace owner_user_id as the access-control boundary, so a
-- device/group can be shared by more than one account (a family). Every
-- user gets exactly one "owner" household (their personal home) — either
-- backfilled here for existing users, or created inline at signup for new
-- ones (see routes/auth.js). owner_user_id columns are left in place on
-- devices/groups (informational "originally claimed/created by" only) —
-- not dropped, no destructive change.
CREATE TABLE IF NOT EXISTS households (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS household_members (
    household_id BIGINT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (household_id, user_id)
);
CREATE INDEX IF NOT EXISTS household_members_user_id_idx ON household_members(user_id);

-- In-app-only invitations (no SMTP in this project) — the invited email
-- must already have an account, or the invite is rejected at creation
-- time rather than queued. See routes/households.js.
CREATE TABLE IF NOT EXISTS household_invites (
    id BIGSERIAL PRIMARY KEY,
    household_id BIGINT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    invited_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invited_by_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    responded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS household_invites_unique_pending
  ON household_invites(household_id, invited_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS household_invites_invited_user_idx
  ON household_invites(invited_user_id) WHERE status = 'pending';

ALTER TABLE devices ADD COLUMN IF NOT EXISTS household_id BIGINT REFERENCES households(id) ON DELETE SET NULL;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS household_id BIGINT REFERENCES households(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS devices_household_id_idx ON devices(household_id);
CREATE INDEX IF NOT EXISTS groups_household_id_idx ON groups(household_id);

-- Backfill: one personal household per existing user, their already-claimed
-- devices/groups reassigned into it.
DO $$
DECLARE
  u RECORD;
  new_household_id BIGINT;
BEGIN
  FOR u IN SELECT id, email FROM users LOOP
    IF NOT EXISTS (SELECT 1 FROM household_members WHERE user_id = u.id) THEN
      INSERT INTO households (name) VALUES (u.email || '''s Home') RETURNING id INTO new_household_id;
      INSERT INTO household_members (household_id, user_id, role) VALUES (new_household_id, u.id, 'owner');
      UPDATE devices SET household_id = new_household_id WHERE owner_user_id = u.id AND household_id IS NULL;
      UPDATE groups SET household_id = new_household_id WHERE owner_user_id = u.id AND household_id IS NULL;
    END IF;
  END LOOP;
END $$;
