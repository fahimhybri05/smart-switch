# Smart Switch Backend — Technical Reference

This document describes what actually exists in `backend/` today, reconstructed
by reading the real source (`backend/src/**`, `backend/migrations/*.sql`,
`backend/test/*.test.js`, `backend/package.json`) as of the current `main`
commit. It supersedes `docs/plan.md` for backend purposes: that file is titled
"Serverless" and describes a no-backend design (device-to-app direct + Tailscale
for remote access); the code in `backend/` implements a real Express + Postgres
+ WebSocket relay service instead. Where a route file or module carries a code
comment referencing `docs/plan.md`, that reference is quoted as-is (it's part of
the real code's own reasoning trail), but the plan document itself is not used
here as a source of truth for behavior.

## 1. Overview

`backend/` is a Node.js (ESM, `"type": "module"`, Node >=18) service built with
Express (HTTP) and `ws` (WebSocket), backed by a single Postgres database via
`pg`. Per `backend/README.md`'s own description: "Relay + accounts service …
The device stays authoritative for its own config/schedules; this service only
handles user accounts, device ownership/claiming, and relaying commands between
app/dashboard clients and each device's persistent WebSocket tunnel."

Concretely, reading the route and WebSocket code, the backend provides:

- **Accounts**: email/password signup and login, JWT access tokens + opaque
  refresh tokens (`src/routes/auth.js`, `src/auth/tokens.js`).
- **Device claiming and command relay**: a device (ESP32/ESP8266 firmware)
  holds a persistent WebSocket ("device tunnel") to this backend; the Flutter
  app claims a device by proving knowledge of a per-device `cloudSecret`, then
  issues commands to it either over its own persistent WebSocket
  (`src/ws/clientServer.js`) or via a one-shot REST relay endpoint
  (`POST /devices/:deviceId/command`, for callers without a live socket, e.g. a
  background isolate/widget).
- **Households** (`src/routes/households.js`, `src/middleware/household.js`):
  the actual access-control boundary for devices/groups/automations/activity —
  a household is a shared "home" that multiple user accounts (family members)
  can belong to as `owner` or `member`.
- **Groups**: named collections of `{deviceId, channelIdx}` pairs, scoped to a
  household, for group-control convenience (`src/routes/groups.js`).
- **Automations**: schedule- or state-triggered rules that relay one or more
  channel-state actions to devices, evaluated in-process
  (`src/automations/engine.js`, `src/automations/scheduler.js`).
- **Activity history**: an append-only, household-scoped log of confirmed
  channel state changes with attributed cause (`src/activity.js`,
  `src/routes/activity.js`).

The device-resident config model described in `docs/plan.md` (each ESP is
source of truth for its own switches/schedules) still appears to hold at the
firmware level — this backend does not store device configuration, only
identity/ownership/household-membership, a display cache of last-known channel
state (`cached_channel_state`), and its own household/group/automation/activity
records layered on top.

## 2. Architecture

### Process structure

- `src/server.js` is the single process entry point (`npm start` /
  `npm run dev`). It:
  1. Loads `.env` via `import 'dotenv/config'`.
  2. Builds the Express app via `createApp()` (`src/app.js`) and wraps it in a
     plain `http.createServer(app)`.
  3. Creates **two independent `WebSocketServer` instances** with
     `{ noServer: true }` — `deviceWss` and `clientWss` — and manually
     dispatches HTTP `upgrade` events to one or the other based on URL path:
     - `/device` → `deviceWss`, connection handled by
       `handleDeviceConnection` (`src/ws/deviceServer.js`).
     - `/ws` → `clientWss`, but only after synchronously authenticating the
       connection via `authenticateClientUpgrade(req.url)`
       (`src/ws/clientServer.js`); on failure the raw socket is written a
       `401 Unauthorized` response and destroyed before any WebSocket
       handshake completes.
     - any other path → `socket.destroy()`.
  4. Starts `startAutomationScheduler()` (`src/automations/scheduler.js`), a
     `setInterval`-based ticker living in the same process.
  5. Listens on `process.env.PORT || 3000`.
  6. Installs `SIGTERM`/`SIGINT` handlers that close every open device and
     client WebSocket (code `1001`, "server shutting down"), stop the
     scheduler, close the Postgres pool, then `process.exit(0)` — with a
     10-second force-exit timer (`process.exit(1)`) if shutdown hangs.
- `src/app.js` (`createApp()`) only builds the Express app: a wildcard CORS
  middleware (see below), `express.json()` body parsing, `GET /healthz`, then
  mounts each route file under its prefix (`/auth`, `/devices`, `/groups`,
  `/households`, `/activity`, `/automations`), a 404 handler, and a generic
  error-handling middleware that logs the error and responds `500 {"error":
  "internal error"}`.

There is no clustering/multi-instance support visible in the code — device
sockets, client sockets, and pending relay requests all live in in-process
`Map`/`Set` state in `src/ws/registry.js` and `src/ws/attribution.js`, not in
Postgres or any shared cache. Running more than one instance of this process
behind a load balancer would split device and client connections
unpredictably across instances (not addressed anywhere in the code).

### CORS

`app.js`'s first middleware sets `Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`, and
`Access-Control-Allow-Headers: Content-Type, Authorization` on every response,
short-circuiting `OPTIONS` requests with `204`. The code comment explains this
is intentional: clients (Flutter web / a dashboard) are cross-origin from this
API and auth is Bearer-token/WS-query-param based (no cookies), so a wildcard
origin is considered safe.

### The registry as the connective tissue

`src/ws/registry.js` is the shared bookkeeping module both WebSocket servers
and the REST device-relay route depend on:

- `deviceSockets: Map<deviceId, ws>` — at most one live device connection per
  `deviceId`; a new connection for the same id closes the old one
  (`4000`, "superseded by a new connection").
- `clientSocketsByUser: Map<userId, Set<ws>>` — every open app/dashboard
  connection for a user (multi-device/multi-tab supported).
- `pendingRequests: Map<internalReqId, {resolve}>` — in-flight device
  commands, keyed by a server-generated `crypto.randomUUID()`, distinct from
  whatever `reqId` a client WS message supplied (translated in
  `relayToDevice`/`sendRelay`).
- `sendRelay(deviceId, {method, path, body})` is the one real primitive: sends
  `{reqId, method, path, body}` to the device socket and returns a Promise
  that resolves with `{status, body}` (the device's reply) or is null if the
  device has no live socket. A 10-second timeout (`RELAY_TIMEOUT_MS`) rejects
  with an `Error` tagged `.code = 'device_timeout'`.
- `relayCommand()` (Promise-returning; used by the REST relay route and the
  automations engine) and `relayToDevice()` (callback/WS-reply-routing form;
  used by `clientServer.js`) both build on `sendRelay`.
- `broadcastToUser()` / `broadcastToHousehold()` push unsolicited JSON payloads
  to every open client socket for a user, or for every member of a household
  (via `getHouseholdMemberIds()` in `src/db/households.js`).

### Request lifecycle (typical HTTP request)

1. `express.json()` parses the body.
2. `requireAuth` (`src/middleware/auth.js`) validates the `Authorization:
   Bearer <token>` header, sets `req.userId`.
3. `attachHouseholds` (`src/middleware/household.js`) loads the caller's
   `household_members` rows into `req.householdRoles` (a
   `Map<string householdId, 'owner'|'member'>`) and computes
   `req.defaultHouseholdId`.
4. The route handler validates the body/query with a `zod` schema, checks
   household membership/ownership via `isHouseholdMember`/`isHouseholdOwner`,
   runs its Postgres query/queries (often inside an explicit
   `BEGIN`/`COMMIT`/`ROLLBACK` transaction via a checked-out `client`), and
   responds.

Every router (`activity`, `automations`, `devices`, `groups`, `households`)
applies `requireAuth, attachHouseholds` via `router.use(...)` at the top of the
file — `/auth` itself is the only router with no such requirement (its routes
are how a caller obtains a token in the first place).

## 3. Data model

The schema is defined across five migration files, applied in order by
`src/db/migrate.js`. Columns/constraints below reflect the **final** state
after all five files (i.e., `ALTER TABLE` additions from later migrations are
folded into the table they modify).

`migrate.js` also creates a bookkeeping table not defined in any numbered
migration file:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `users` (001_init.sql)

| Column | Type | Constraints |
|---|---|---|
| id | BIGSERIAL | PRIMARY KEY |
| email | TEXT | UNIQUE NOT NULL |
| password_hash | TEXT | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |

### `refresh_tokens` (001_init.sql)

| Column | Type | Constraints |
|---|---|---|
| id | BIGSERIAL | PRIMARY KEY |
| user_id | BIGINT | NOT NULL, REFERENCES users(id) ON DELETE CASCADE |
| token_hash | TEXT | NOT NULL |
| expires_at | TIMESTAMPTZ | NOT NULL |
| revoked_at | TIMESTAMPTZ | nullable |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |

Index: `idx_refresh_tokens_user_id (user_id)`.

### `devices` (001_init.sql + 003_households.sql)

| Column | Type | Constraints |
|---|---|---|
| id | BIGSERIAL | PRIMARY KEY |
| device_id | TEXT | UNIQUE NOT NULL — the firmware's own external device identifier |
| owner_user_id | BIGINT | REFERENCES users(id) ON DELETE SET NULL, nullable |
| friendly_name | TEXT | nullable |
| cloud_secret_hash | TEXT | NOT NULL |
| is_online | BOOLEAN | NOT NULL DEFAULT false |
| last_seen_at | TIMESTAMPTZ | nullable |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |
| household_id | BIGINT | REFERENCES households(id) ON DELETE SET NULL, nullable (added in 003) |

Indexes: `idx_devices_owner_user_id (owner_user_id)`,
`devices_household_id_idx (household_id)`.

Per the 001 comment, `owner_user_id` is nullable because a row is created
(unclaimed) the moment a device first connects over WebSocket, claimed later
by whoever's app submits the matching `cloud_secret`. Per the 003 comment,
`household_id` (not `owner_user_id`) is the real access-control boundary once
households exist; `owner_user_id` is left in place only as an informational
"originally claimed by" field.

### `cached_channel_state` (001_init.sql)

| Column | Type | Constraints |
|---|---|---|
| device_id | TEXT | NOT NULL, REFERENCES devices(device_id) ON DELETE CASCADE |
| channel_idx | SMALLINT | NOT NULL |
| name | TEXT | nullable |
| zone | TEXT | nullable |
| state | TEXT | nullable |
| updated_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |

Primary key: `(device_id, channel_idx)`. Per the code comment: "Display-only
cache — never treated as truth. Refreshed whenever the device pushes a
`state_changed` event or a relayed command succeeds."

### `groups` (002_groups.sql + 003_households.sql)

| Column | Type | Constraints |
|---|---|---|
| id | BIGSERIAL | PRIMARY KEY |
| owner_user_id | BIGINT | NOT NULL, REFERENCES users(id) ON DELETE CASCADE |
| name | TEXT | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |
| household_id | BIGINT | REFERENCES households(id) ON DELETE SET NULL, nullable (added in 003) |

Indexes: `idx_groups_owner_user_id (owner_user_id)`,
`groups_household_id_idx (household_id)`.

### `group_members` (002_groups.sql)

| Column | Type | Constraints |
|---|---|---|
| group_id | BIGINT | NOT NULL, REFERENCES groups(id) ON DELETE CASCADE |
| device_id | TEXT | NOT NULL, REFERENCES devices(device_id) ON DELETE CASCADE |
| channel_idx | SMALLINT | NOT NULL |

Primary key: `(group_id, device_id, channel_idx)`. Code comment: "Mirrors the
app's existing `GroupMember{deviceId, channelIdx}` shape exactly."

### `households` (003_households.sql)

| Column | Type | Constraints |
|---|---|---|
| id | BIGSERIAL | PRIMARY KEY |
| name | TEXT | NOT NULL |
| timezone | TEXT | NOT NULL DEFAULT 'UTC' |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |

### `household_members` (003_households.sql)

| Column | Type | Constraints |
|---|---|---|
| household_id | BIGINT | NOT NULL, REFERENCES households(id) ON DELETE CASCADE |
| user_id | BIGINT | NOT NULL, REFERENCES users(id) ON DELETE CASCADE |
| role | TEXT | NOT NULL, CHECK (role IN ('owner', 'member')) |
| joined_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |

Primary key: `(household_id, user_id)`. Index:
`household_members_user_id_idx (user_id)`.

### `household_invites` (003_households.sql)

| Column | Type | Constraints |
|---|---|---|
| id | BIGSERIAL | PRIMARY KEY |
| household_id | BIGINT | NOT NULL, REFERENCES households(id) ON DELETE CASCADE |
| invited_user_id | BIGINT | NOT NULL, REFERENCES users(id) ON DELETE CASCADE |
| invited_by_user_id | BIGINT | NOT NULL, REFERENCES users(id) ON DELETE CASCADE |
| status | TEXT | NOT NULL DEFAULT 'pending', CHECK (status IN ('pending', 'accepted', 'declined')) |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |
| responded_at | TIMESTAMPTZ | nullable |

Indexes: unique `household_invites_unique_pending (household_id,
invited_user_id) WHERE status = 'pending'` (at most one pending invite per
household+invitee pair), and `household_invites_invited_user_idx
(invited_user_id) WHERE status = 'pending'`.

Per the code comment, invitations are in-app only (no SMTP anywhere in this
project) — inviting an email with no existing account is rejected at creation
time (`404`) rather than queued.

`003_households.sql` also runs a one-time backfill (`DO $$ ... $$`): for every
existing user with no `household_members` row, it creates a personal household
named `"<email>'s Home"`, an `owner` membership, and reassigns that user's
already-claimed devices/groups (`WHERE owner_user_id = u.id AND household_id IS
NULL`) into it.

### `activity_log` (004_activity.sql + 005_automations.sql)

| Column | Type | Constraints |
|---|---|---|
| id | BIGSERIAL | PRIMARY KEY |
| household_id | BIGINT | NOT NULL, REFERENCES households(id) ON DELETE CASCADE |
| device_id | TEXT | NOT NULL, REFERENCES devices(device_id) ON DELETE CASCADE |
| channel_idx | SMALLINT | NOT NULL |
| state | TEXT | NOT NULL |
| source | TEXT | NOT NULL, CHECK (source IN ('app', 'widget', 'group', 'scene', 'automation', 'device')) |
| actor_user_id | BIGINT | REFERENCES users(id) ON DELETE SET NULL, nullable |
| automation_id | BIGINT | REFERENCES automations(id) ON DELETE SET NULL (FK added in 005; column itself has no CHECK/NOT NULL) |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |

Index: `activity_log_household_created_idx (household_id, created_at DESC, id
DESC)`. Per the 004 comment: "Append-only log of confirmed channel state
changes … Unlike `cached_channel_state` (upsert-in-place, display-only), this
table is never overwritten — every row is a historical fact."

### `automations` (005_automations.sql)

| Column | Type | Constraints |
|---|---|---|
| id | BIGSERIAL | PRIMARY KEY |
| household_id | BIGINT | NOT NULL, REFERENCES households(id) ON DELETE CASCADE |
| name | TEXT | NOT NULL |
| enabled | BOOLEAN | NOT NULL DEFAULT true |
| trigger_type | TEXT | NOT NULL, CHECK (trigger_type IN ('schedule', 'state')) |
| schedule_days | SMALLINT[] | nullable — 1=Mon..7=Sun, "same convention as the app's existing per-device `schedules_screen.dart`" |
| schedule_time | TIME | nullable — household-local, per `households.timezone` |
| trigger_device_id | TEXT | REFERENCES devices(device_id) ON DELETE CASCADE, nullable |
| trigger_channel_idx | SMALLINT | nullable |
| trigger_state | TEXT | CHECK (trigger_state IN ('ON', 'OFF')), nullable |
| actions | JSONB | NOT NULL — `[{deviceId, channelIdx, state}]`, embedded (not a Scene reference — "Scenes are still Hive-only/unsynced") |
| created_by_user_id | BIGINT | REFERENCES users(id) ON DELETE SET NULL, nullable |
| created_at | TIMESTAMPTZ | NOT NULL DEFAULT now() |
| last_fired_at | TIMESTAMPTZ | nullable |

Indexes: `automations_household_idx (household_id)`, and a partial index
`automations_state_trigger_idx (trigger_device_id, trigger_channel_idx,
trigger_state) WHERE trigger_type = 'state' AND enabled` (matches exactly the
`WHERE` clause `evaluateStateTriggeredAutomations` queries with).

### Relationships summary

- `users` 1—N `refresh_tokens`, `household_members`, `household_invites`
  (both `invited_user_id` and `invited_by_user_id`), and optionally
  `devices.owner_user_id` / `groups.owner_user_id` /
  `automations.created_by_user_id` / `activity_log.actor_user_id`
  (all `SET NULL` on user deletion, i.e., these are informational, not
  access-controlling).
- `households` 1—N `household_members`, `household_invites`, `devices`,
  `groups`, `activity_log`, `automations` (all `CASCADE` except `devices`/
  `groups`, which `SET NULL` — unclaiming/losing a household doesn't delete
  the device/group row itself).
- `devices` 1—N `cached_channel_state`, `group_members`, `activity_log`; also
  referenced by `automations.trigger_device_id` and by device ids embedded
  inside `automations.actions` (JSONB, not a real FK — validated at the
  application layer instead, see §5).
- `groups` 1—N `group_members`.
- `automations` 0—N `activity_log` rows (`automation_id`, nullable).

## 4. Authentication & authorization

### JWT access tokens (`src/auth/tokens.js`)

- `signAccessToken(userId)` calls `jwt.sign({ sub: String(userId) },
  jwtSecret(), { expiresIn: '15m' })` — algorithm is `jsonwebtoken`'s default,
  **HS256**, since no `algorithm` option is passed. The only custom claim is
  `sub` (stringified user id); `iat`/`exp` are added by the library.
- `ACCESS_TOKEN_TTL = '15m'`.
- `jwtSecret()` reads `process.env.JWT_SECRET` and **throws** if unset — but
  only when a token is actually signed or verified (lazily), not at process
  startup, so a deployment missing `JWT_SECRET` starts successfully and only
  fails on the first login/signup/token-verify call.
- `verifyAccessToken(token)` returns the decoded payload or throws (invalid
  signature, wrong secret, or expired).

### Refresh tokens (`src/auth/tokens.js`, `refresh_tokens` table)

- Opaque, not a JWT: `crypto.randomBytes(32).toString('hex')`.
- Only the SHA-256 hash (`hashToken`, same `crypto.createHash('sha256')`
  approach as device secrets) is persisted, in `refresh_tokens.token_hash`.
- `createRefreshToken(userId)` inserts a row with `expires_at = now() + 30
  days` (`REFRESH_TOKEN_TTL_MS`) and returns the raw token to send to the
  caller.
- `verifyRefreshToken(rawToken)` looks up by hash, requiring `revoked_at IS
  NULL AND expires_at > now()`; returns the associated `user_id` or `null`.
- `revokeRefreshToken(rawToken)` sets `revoked_at = now()`.
- `POST /auth/refresh` **rotates**: it revokes the presented refresh token and
  issues a brand-new access+refresh pair — refresh tokens are single-use.

### Device secret scheme (`src/auth/deviceSecret.js`)

- `hashDeviceSecret(rawSecret)` is a plain `sha256` hex digest — not bcrypt.
  The code comment explains why this is considered acceptable: `cloudSecret`
  is a machine-generated random secret (not a human password), "same
  reasoning as the firmware's own `auth_password_hash` (plain SHA-256, not
  bcrypt)".
- The same secret is presented in two places and must hash-match
  `devices.cloud_secret_hash`:
  - By the device itself, over the `/device` WebSocket, as
    `{deviceId, cloudSecret}` (first message after connecting).
  - By the claiming app, over `POST /devices/claim`, as
    `{deviceId, cloudSecret, ...}`.
- **Trust-on-first-contact**: whichever of "device connects over WS" or "app
  calls `/claim`" happens first creates the `devices` row (with
  `household_id = NULL` if the device connected first, unclaimed); whichever
  happens second must present a hash-matching secret or is rejected (device
  WS: closed with code `4003`; REST claim: `401`).

### Auth middleware (`src/middleware/auth.js`)

`requireAuth(req, res, next)`:
- Requires header `Authorization: Bearer <token>`; missing/malformed →
  `401 {"error": "missing bearer token"}`.
- Calls `verifyAccessToken`; on success sets `req.userId = Number(payload.sub)`
  and calls `next()`; on any throw → `401 {"error": "invalid or expired
  token"}`.

### Household-scoping middleware (`src/middleware/household.js`)

`attachHouseholds(req, res, next)` (mounted after `requireAuth` on every
household-aware router):
- Queries `SELECT household_id, role FROM household_members WHERE user_id =
  $1` for the caller.
- Sets `req.householdRoles = new Map(...)` keyed by **stringified**
  `household_id` → `'owner'|'member'`.
- Sets `req.defaultHouseholdId` to the caller's `owner`-role household if any,
  else their first membership row, else `null`.
- Helpers: `isHouseholdMember(req, householdId)` and `isHouseholdOwner(req,
  householdId)` both look up via `String(householdId)` against
  `req.householdRoles`.

Route handlers use these two helpers uniformly to decide `404` (not a member —
existence is hidden from non-members) vs. `403` (a member, but not an owner,
attempting an owner-only action).

### WebSocket authentication

- **Device WS** (`/device`): no upgrade-time auth: the connection is accepted,
  then the first application-level message must be `{deviceId, cloudSecret}`
  within `AUTH_TIMEOUT_MS = 5000` ms or the socket is closed (`4001`, "auth
  timeout" or "expected {deviceId, cloudSecret}").
- **Client WS** (`/ws?token=<access token>`): authenticated synchronously
  during the HTTP `upgrade` event, before the WebSocket handshake completes.
  `authenticateClientUpgrade(requestUrl)` reads the `token` query-string
  parameter (not an `Authorization` header — the code comment notes browsers'
  WebSocket API can't set custom headers on the handshake) and runs it through
  `verifyAccessToken`. Failure → raw `401 Unauthorized` HTTP response, socket
  destroyed, no WS connection ever established.

## 5. HTTP API reference

All routes are mounted under the prefixes shown; all bodies are JSON
(`express.json()`); all validation is via `zod` `safeParse`, with failures
returning `400 {"error": "<first zod issue message>"}`. Every router except
`/auth` requires `requireAuth` + `attachHouseholds` (see §4).

### `GET /healthz`

No auth. Returns `200 {"ok": true}`.

### `/auth` (`src/routes/auth.js`) — no auth required

| Method & path | Body | Success | Errors |
|---|---|---|---|
| `POST /auth/signup` | `{email, password}` (email trimmed+lowercased+valid; password 8–128 chars) | `201 {accessToken, refreshToken}` | `400` validation; `409 {"error": "email already registered"}` on unique violation (Postgres code `23505`) |
| `POST /auth/login` | `{email, password}` | `200 {accessToken, refreshToken}` | `400` validation; `401 {"error": "invalid email or password"}` |
| `POST /auth/refresh` | `{refreshToken}` | `200 {accessToken, refreshToken}` (old refresh token revoked, new pair issued) | `400` if missing; `401 {"error": "invalid or expired refresh token"}` |
| `POST /auth/logout` | `{refreshToken}` | `204` (no body) | Always `204` even if body fails validation — a bad/missing `refreshToken` is silently ignored rather than erroring |

Signup, inside one transaction: inserts the `users` row (bcrypt cost 10 via
`bcryptjs`), then a personal `households` row named `"<email>'s Home"`, then an
`owner` `household_members` row — "every user gets a personal 'owner' household
immediately," per the code comment.

Login always runs `bcrypt.compare` — against a fixed dummy hash
(`$2a$10$CwTycUXWue0Thq9StjUM0uJ8Yb1qsm.MtRhAxIzTv6HqSlvBk4uYK`) when no user
row matches — specifically so a bad email and a bad password take the same
time, to avoid leaking which emails are registered via response timing.

### `/devices` (`src/routes/devices.js`)

| Method & path | Auth | Body/Query | Success | Errors |
|---|---|---|---|---|
| `POST /devices/claim` | owner of target household | `{deviceId, cloudSecret (16–256 chars), friendlyName?, householdId?}` | `200 {deviceId, friendlyName}` | `400` validation; `403` not an owner of target household; `409 {"error": "device is already claimed by another household"}`; `401 {"error": "invalid device secret"}` |
| `GET /devices/` | any member of ≥1 household | — | `200 {devices: [{device_id, friendly_name, is_online, last_seen_at, channels: [{channelIdx, name, zone, state, updatedAt}]}]}` (see note below on field casing) | — |
| `PATCH /devices/:deviceId` | any household member | `{friendlyName}` | `200 {deviceId, friendlyName}` | `400`; `404` if device/household not found or caller not a member |
| `DELETE /devices/:deviceId` | household owner | — | `204` (unclaims: sets `owner_user_id`/`household_id` to `NULL`; row and history are kept) | `404` not found/not a member; `403` member but not owner |
| `POST /devices/:deviceId/command` | any household member | `{method: 'GET'\|'POST'\|'DELETE', path, body?}` | `200` with the **device's own** `{status, body}` nested in the JSON response (the outer HTTP status is 200 even though `status` inside may be e.g. 200/4xx from the device itself) | `404` not found/not a member; `503 {"error": "device_offline"}`; `504 {"error": "device_timeout"}` |

Note on `GET /devices/` field casing: the top-level device fields are returned
**snake_case** (`device_id`, `friendly_name`, `is_online`, `last_seen_at`) —
straight from the SQL column names, no aliasing — while the nested `channels`
array entries are explicitly aliased to **camelCase**
(`channelIdx`, `updatedAt`) via `json_build_object`. This is inconsistent with
every other list endpoint in the API (activity, automations, groups,
households), which alias every column to camelCase. Not flagged as a bug in
the code itself; documented here as an observed inconsistency the Flutter
client needs to handle correctly.

`POST /devices/:deviceId/command` is described in its code comment as "for
callers with no persistent client WS: a headless widget/background-monitor
isolate (see `lib/services/isolate_device_relay.dart`), or anything else that
just needs to issue one command and get the device's response back." If the
relayed `path` matches `/api/channels/(\d+)/state` and the body carries a
`state`, the handler calls `noteExpectedStateChange(...)` with
`source: 'widget'` before relaying, for activity-log attribution (see §6).

### `/groups` (`src/routes/groups.js`)

| Method & path | Auth | Body | Success | Errors |
|---|---|---|---|---|
| `GET /groups/` | any member | — | `200 {groups: [{id, name, members: [{deviceId, channelIdx}]}]}` | — |
| `POST /groups/` | any member (create or full update) | `{id?, householdId?, name, members: [{deviceId, channelIdx}] (max 64)}` | `200 {id, name, members}` | `400` validation; `404` group not found (update, not a member); `403` not a member of target household, or a member device isn't in that household |
| `DELETE /groups/:id` | any member | — | `204` | `400` invalid id; `404` not found/not a member |

Unlike automations/devices, **any household member** (not just the owner) may
create/edit/delete groups — per the code comment, "they're a control
convenience, not a household-management action." Updating a group
(`id` given) fully replaces its member list (delete-all + re-insert), and every
member's device must belong to the group's own household — "a group can't span
two households, even if the caller belongs to both."

### `/households` (`src/routes/households.js`)

| Method & path | Auth | Body | Success | Errors |
|---|---|---|---|---|
| `GET /households/` | any member | — | `200 {households: [{id, name, timezone, members: [{userId, email, role}], role}]}` (`role` = caller's own role) | — |
| `PATCH /households/:id` | owner | `{name?, timezone?}` (≥1 required) | `200 {id}` | `404` not owner/not found; `400` validation or neither field given |
| `POST /households/:id/invite` | owner | `{email}` | `201 {ok: true}` | `404` not owner, or no account with that email; `409` already a member, or invite already pending |
| `GET /households/invites` | any authenticated user | — | `200 {invites: [{id, householdId, householdName, invitedByEmail}]}` (invites addressed to the caller, `status = 'pending'`) | — |
| `POST /households/invites/:id/accept` | invitee only | — | `200 {ok: true}` (inserts `household_members` role `'member'`, `ON CONFLICT DO NOTHING`) | `400` invalid id; `404` invite not found/not pending/not addressed to caller |
| `POST /households/invites/:id/decline` | invitee only | — | `200 {ok: true}` | same as accept |
| `DELETE /households/:id/members/:userId` | owner | — | `204` | `404` not owner/not found/member not found; `409 {"error": "cannot remove the last owner"}` |

### `/activity` (`src/routes/activity.js`)

| Method & path | Auth | Query | Success | Errors |
|---|---|---|---|---|
| `GET /activity/` | any member | `householdId?` (required if caller belongs to more than one household), `before?` (cursor = last-seen row id), `limit` (1–100, default 50) | `200 {entries: [{id, deviceId, deviceFriendlyName, channelIdx, state, source, actorEmail, automationId, createdAt}], nextCursor}` (`nextCursor` is `null` once a page comes back short of `limit`) | `400` validation, or `"householdId is required"` when omitted and caller belongs to ≠1 household; `404` not a member of the given household |

Ordering is `ORDER BY created_at DESC, id DESC`; the `before` cursor filters
`a.id < $before`. Per the code comment, the table is unbounded by design (no
retention job — "keep-everything"), so cursor pagination is used instead of
offset pagination, which would degrade on a large table.

### `/automations` (`src/routes/automations.js`)

| Method & path | Auth | Body/Query | Success | Errors |
|---|---|---|---|---|
| `GET /automations/` | any member | `householdId?` (defaults to **all** households the caller belongs to, unlike `/activity` which requires exactly one) | `200 {automations: [...]}` (shape below) | `404` if an explicit `householdId` isn't one the caller belongs to |
| `POST /automations/` | household **owner** (create: owner of target/default household; update: owner of the automation's existing household) | see schema below | `200` (note: `200`, not `201`, even when creating — inconsistent with `/auth/signup`'s `201`) with the created/updated automation | `400` validation; `403` not an owner, or a referenced device isn't in the household; `404` (update) automation not found/not a member |
| `DELETE /automations/:id` | household owner | — | `204` | `400` invalid id; `404` not found/not a member; `403` member but not owner |

Request/response automation shape (`rowToAutomation` in the route file):

```json
{
  "id": 1,
  "householdId": 5,
  "name": "Porch light off at 11pm",
  "enabled": true,
  "trigger": { "type": "schedule", "days": [1, 2, 3, 4, 5, 6, 7], "time": "23:00" },
  "actions": [{ "deviceId": "esp-abc", "channelIdx": 2, "state": "OFF" }],
  "lastFiredAt": "2026-09-14T23:00:01.234Z"
}
```

or, for a state trigger:

```json
"trigger": { "type": "state", "deviceId": "esp-xyz", "channelIdx": 0, "state": "ON" }
```

`actions` is validated as 1–32 entries of `{deviceId, channelIdx (0–255),
state: 'ON'|'OFF'}`. Every device referenced by the trigger (state-type) and
every action must already belong to the target household
(`validateDevicesInHousehold`), or the whole write is rejected `403` and rolled
back. On update (`id` provided), a `householdId` in the request body is
accepted by the zod schema but not actually used to move the automation
between households — it stays in whatever household the existing row already
belongs to.

## 6. WebSocket protocol

Two independent WebSocket endpoints share the one HTTP server (see §2).

### Device WS — `/device` (`src/ws/deviceServer.js`)

**Connection & auth handshake**

1. Device opens a WS connection to `/device` (no query params/headers
   required at the HTTP layer).
2. A 5-second (`AUTH_TIMEOUT_MS`) timer starts.
3. First JSON message must be `{"deviceId": "...", "cloudSecret": "..."}` —
   otherwise the socket is closed (`4001`, `"expected {deviceId,
   cloudSecret}"`).
4. `authenticateDevice(deviceId, cloudSecret)` hashes the secret and, inside a
   transaction with `SELECT ... FOR UPDATE`:
   - If a `devices` row exists: hash mismatch → returns `null` (caller closes
     with `4003`, `"invalid device secret"`); match → `UPDATE devices SET
     is_online = true, last_seen_at = now()`, returns
     `{householdId: existing.household_id}` (possibly `null` if unclaimed).
   - If no row exists: inserts one (`friendly_name` defaults to the
     `deviceId` itself, `is_online = true`), returns `{householdId: null}`
     (trust-on-first-connect).
   - Any unexpected error during auth closes the socket `1011` ("internal
     error").
5. On success: clears the auth timer, calls `registerDevice(deviceId, ws)`
   (superseding/closing any older connection for the same id, code `4000`),
   logs `device connected: <id>` to the console, and if the device is already
   claimed (`householdId` non-null) broadcasts `{event: 'device_online',
   deviceId}` to every client socket of every member of that household.

**Post-auth messages, device → server**

- **Relay reply**: any message with a `reqId` and a `status` key —
  `{reqId, status, body}` — is routed to `resolveDeviceResponse(reqId, status,
  body)`, settling the matching pending relay Promise in `registry.js`.
- **Unsolicited state change**: `{"event": "state_changed", "channelIdx":
  <number>, "state": "ON"|"OFF"}` — described in the code comment as "the ONE
  true 'a channel actually changed' signal in the whole system, regardless of
  what caused it." Handling:
  1. `takeAttribution(deviceId, channelIdx, state)` is consumed (see §attribution
     below); if nothing is pending (expired or never set), the change is
     attributed `{source: 'device', actorUserId: null, automationId: null}`
     — i.e., assumed to be the device's own local schedule/logic.
  2. `recordStateChange` upserts `cached_channel_state` and returns the
     device's `household_id`.
  3. If a `household_id` exists: `logActivity(...)` writes to `activity_log`
     (errors only logged, never thrown back), `broadcastToHousehold(...)`
     sends `{event: 'state_changed', deviceId, channelIdx, state}` to every
     app/dashboard client of every household member, and
     `evaluateStateTriggeredAutomations(...)` runs (see §7).
- Any other/malformed JSON is silently ignored (parse failures are swallowed,
  not closing the socket).

**Server → device**

- Relay command: `{"reqId": "<uuid>", "method": "GET"|"POST"|"DELETE", "path":
  "...", "body": {...}}` — sent by `sendRelay` in `registry.js` whenever a
  client, the REST relay route, or the automation engine issues a command.

**On close**: `unregisterDevice` (only if the closing socket is still the
registered one) and `markOffline` (`UPDATE devices SET is_online = false`,
errors logged). **No `device_offline` broadcast is sent to household clients**
on disconnect — asymmetric with the `device_online` broadcast sent on
(re)connect; this was not called out as intentional in any code comment.

### Client WS — `/ws?token=<access token>` (`src/ws/clientServer.js`)

**Connection**: authenticated at the HTTP-upgrade stage (see §4). Once
established, `registerClient(userId, ws)` adds the socket to that user's set.

**Client → server**

```json
{ "reqId": "client-chosen-id", "deviceId": "esp-abc", "method": "POST", "path": "/api/channels/0/state", "body": { "state": "ON" }, "source": "group" }
```

`reqId`, `deviceId`, `method`, `path` are all required or the message is
silently dropped. Handling:
1. `isOwnedByUser(deviceId, userId)` — a join of `devices` → `household_members`
   on `household_id`/`user_id` — must find a row, else the server replies
   `{reqId, status: 0, error: 'not_found'}`.
2. `isDeviceOnline(deviceId)` (registry lookup) must be true, else
   `{reqId, status: 0, error: 'device_offline'}`.
3. If `path` matches the channel-state pattern and `body.state` is present,
   `noteExpectedStateChange(...)` is recorded with `source: msg.source ??
   'app'` and `actorUserId: userId`. `msg.source` is described in the code
   comment as "a new optional, self-reported, trusted-not-verified field the
   app sets to `'group'`/`'scene'` when it knows the semantic origin of a
   relayed command — informational only for activity history, not a security
   boundary."
4. `relayToDevice(deviceId, {method, path, body}, ws, reqId)` forwards to the
   device and, asynchronously, replies to this same client socket with either
   `{reqId, status, body}` (device's real response) or `{reqId, status: 0,
   error: 'device_offline'|'device_timeout'}`.

**Server → client (unsolicited broadcasts)**, sent to every open socket of
every member of the relevant household:
- `{"event": "state_changed", "deviceId": "...", "channelIdx": 0, "state": "ON"}`
- `{"event": "device_online", "deviceId": "..."}`
- (no corresponding `device_offline` broadcast — see above)

**On close**: `unregisterClient(userId, ws)`.

### `registry.js` — connection bookkeeping

Documented in full in §2 (Architecture); the key point for protocol
understanding is that it holds **all** live-connection and in-flight-relay
state purely in-process (`Map`s/`Set`s), with no persistence or cross-instance
sharing, and is unit-tested directly in `backend/test/registry.test.js` (using
a `FakeSocket` test double) covering: relaying to an offline device returns
`null`, request/response round-tripping via distinct client-vs-internal
`reqId`s, a no-op (not a throw) when resolving an unknown/already-resolved
`reqId`, connection supersession closing the old socket, and per-user broadcast
isolation.

### `attribution.js` — linking actions to actors

An in-memory `Map` (`TTL_MS = 8000`) keyed by `` `${deviceId}:${channelIdx}:${state}` ``.
Purpose, per its own header comment: the device's `state_changed` event is
"origin-blind" (fires identically whether caused by a direct app call, a cloud
relay, a group/scene, an automation, or the device's own local schedule), so
whoever *initiates* a channel-state command calls
`noteExpectedStateChange(deviceId, channelIdx, state, attribution)` right
before sending it; `deviceServer.js`'s `state_changed` handler later calls
`takeAttribution(...)`, which **consumes** (deletes) and returns the entry if
still within its TTL, or `null` otherwise. The same mechanism also carries
automation cascade-depth/chain data (`depth`, `chainAutomationIds`) forward for
loop protection (see §7).

Because the map key does not include a per-request identifier, two different
actors commanding the same `(deviceId, channelIdx)` to the same `state` within
the same ~8-second window could have the first echo consume a stale/incorrect
attribution — an inherent race in this design, not called out explicitly in
the code comments.

## 7. Automations engine

### Evaluation trigger paths

There are exactly two ways an automation fires, both ultimately calling
`fireAutomation()` in `src/automations/engine.js`:

1. **State-triggered** (`trigger_type = 'state'`): from the single call site
   in `deviceServer.js`'s `state_changed` handler, `evaluateStateTriggeredAutomations({deviceId,
   channelIdx, state, householdId, depth, chainAutomationIds})` runs:
   ```sql
   SELECT id, household_id, name, actions FROM automations
   WHERE trigger_type = 'state' AND enabled
     AND trigger_device_id = $1 AND trigger_channel_idx = $2 AND trigger_state = $3
     AND household_id = $4
   ```
   — i.e., a state trigger only fires automations in the **same household**
   as the device whose state just changed, and calls `fireAutomation` for
   each match, forwarding the current cascade `depth`/`chainAutomationIds`.
2. **Schedule-triggered** (`trigger_type = 'schedule'`): `src/automations/scheduler.js`'s
   `tick()` runs every `TICK_MS = 60_000` ms (`setInterval`). It loads all
   enabled schedule-type automations joined to their household's `timezone`,
   computes the current local weekday (1=Mon..7=Sun) and `HH:MM` via
   `Intl.DateTimeFormat` (no external date library), and calls
   `fireAutomation(row)` (with default `depth = 0`, empty chain) for any row
   whose `schedule_days` includes today and whose `schedule_time` (first 5
   chars) equals the current `HH:MM` — with a double-fire guard: skip if
   `last_fired_at` is less than 55 seconds old.

### `fireAutomation(automation, {depth, chainAutomationIds})`

- **Loop/cascade protection**: `MAX_AUTOMATION_HOP_DEPTH = 5` — if `depth >=
  5`, the automation is skipped (`console.warn`), not executed. If
  `automation.id` is already in `chainAutomationIds` (this cascade already
  fired it), it's likewise skipped. Otherwise a `nextChain` set (current chain
  + this automation's id) is computed.
- For each `{deviceId, channelIdx, state}` in `automation.actions`:
  1. `noteExpectedStateChange(...)` is recorded **before** relaying, tagged
     `source: 'automation'`, `actorUserId: null`, `automationId:
     automation.id`, `depth: depth + 1`, `chainAutomationIds: nextChain` — so
     that if the action causes a real `state_changed` echo, the resulting
     cascade (further automations it might trigger) carries the incremented
     depth and updated chain forward.
  2. `relayCommand(deviceId, {method: 'POST', path:
     '/api/channels/<channelIdx>/state', body: {state}})` is awaited. On
     failure (device offline/unreachable), the error is only logged to the
     console — per the code's own comment, "`activity_log` only ever records
     confirmed changes (via the `state_changed` echo), so a failed action here
     is console-only this pass (no automation-run-history UI yet — flagged
     gap …)."
- After attempting every action (regardless of individual failures),
  `UPDATE automations SET last_fired_at = now()`.

### Automation rule data shape

See the JSON examples in §5 (`/automations` route) — the same
`{id, householdId, name, enabled, trigger, actions, lastFiredAt}` shape is used
for both the API contract and (modulo column-name mapping) the underlying row.

## 8. Environment variables & configuration

Confirmed by grepping `process.env` across `backend/src` — exactly three
variables are read anywhere in the code:

| Variable | Read in | Purpose | Default |
|---|---|---|---|
| `DATABASE_URL` | `src/db/pool.js` | Postgres connection string passed straight to `new pg.Pool({ connectionString })` | none — `pg` will fail to connect without it |
| `JWT_SECRET` | `src/auth/tokens.js` (`jwtSecret()`) | HMAC secret for signing/verifying access tokens | none — throws `Error('JWT_SECRET env var is required')`, but only lazily, on first sign/verify call, not at startup |
| `PORT` | `src/server.js` | HTTP/WS listen port | `3000` (`process.env.PORT \|\| 3000`) |

`backend/.env.example` (confirmed by reading it) matches exactly:

```
DATABASE_URL=postgres://smartswitch:smartswitch@localhost:5432/smartswitch
JWT_SECRET=change-me-to-a-long-random-string
PORT=3000
```

`.env` is loaded via `import 'dotenv/config'` at the top of both
`src/server.js` and `src/db/migrate.js` (each is a separate process entry
point, so each loads it independently).

`src/db/pool.js` also globally overrides `pg`'s BIGINT (`int8`, OID `20`)
type parser to return a plain JS `number` via `parseInt` instead of the
default string. The code comment explains this was done because ids (e.g.
`users.id`) are used as `Map` keys in `ws/registry.js` against real JS numbers
(`Number(jwt.sub)`) — a string `"1"` and a number `1` are different `Map`
keys, which the comment says "silently broke state-change broadcast routing
until caught by live end-to-end testing." This is safe only because ids in
this system are asserted to never approach `Number.MAX_SAFE_INTEGER`.

## 9. Running & developing

From `backend/package.json` (`"type": "module"`, `"engines": {"node": ">=18"}`):

| Script | Command | Purpose |
|---|---|---|
| `npm start` | `node src/server.js` | Production run |
| `npm run dev` | `node --watch src/server.js` | Local dev with auto-restart on file change |
| `npm run migrate` | `node src/db/migrate.js` | Apply pending SQL migrations |
| `npm test` | `node --test test/` | Run the unit test suite (Node's built-in test runner — no separate test framework in `devDependencies`, which is empty) |

Dependencies: `bcryptjs`, `dotenv`, `express`, `jsonwebtoken`, `pg`, `ws`,
`zod`.

**Local setup** (per `backend/README.md`, cross-checked against the code):
```sh
cp .env.example .env   # fill in DATABASE_URL + a real JWT_SECRET
npm install
npm run migrate
npm run dev
```
The README states the REST API serves `/auth/*` and `/devices/*` — this is
stale/incomplete: `/groups`, `/households`, `/activity`, and `/automations` are
all mounted in `src/app.js` and documented in §5 above, but not mentioned in
the README's route list.

**Migrations** (`src/db/migrate.js`): creates `schema_migrations` if absent,
reads already-applied filenames, reads `backend/migrations/*.sql` sorted
alphabetically (the `NNN_` prefix keeps this equal to numeric/chronological
order), and for each not-yet-applied file runs its entire contents as one
statement inside a transaction, recording the filename on success. A failure
rolls back that one migration and throws (halting the run; process exits `1`).
On full success the pool is closed and the process exits `0`.

**Tests** (`backend/test/*.test.js`, run via `node --test test/`):
- `deviceSecret.test.js` — `hashDeviceSecret` is deterministic, differs for
  different input, and returns a 64-char hex sha256 digest.
- `tokens.test.js` — sign/verify round-trips to the same `sub`; a tampered
  token is rejected; a token signed with a different `JWT_SECRET` is rejected.
- `registry.test.js` — covers `relayToDevice`/`resolveDeviceResponse`
  round-tripping (with distinct client vs. internal `reqId`s), offline-device
  relay returning `null`, unknown-`reqId` resolution being a no-op, connection
  supersession, and per-user broadcast isolation — using an in-file
  `FakeSocket` test double, no real network/WS involved.

All three suites are DB-free by design (per the README: "so it runs without
Postgres"). There are **no route-level or DB-backed tests** in the repo today
— confirmed by the directory listing (`ls backend/test/` shows only the three
files above) and stated explicitly in the README: "Route-level tests that
touch the database aren't included yet."

**Production** (per README, consistent with `server.js`'s shutdown code):
plain `node src/server.js` process, no Docker. `server.js` handles
`SIGTERM`/`SIGINT` itself (closes every device/client WS with code `1001`,
then the DB pool, before exiting) so a process manager's restart/stop is
clean; there's also a 10-second force-exit timer. A systemd unit is provided
at `backend/deploy/smart-switch-backend.service`
(`WorkingDirectory`/`EnvironmentFile=.env`/`ExecStart=node src/server.js`,
`Restart=always`, `RestartSec=2`, `TimeoutStopSec=15`, plus light sandboxing:
`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome`). The
README notes firmware's own `cloud_client` reconnects with backoff on its own,
so a backend restart/bounce is expected to self-heal from the device side. A
reverse proxy (Caddy/nginx) for TLS is explicitly left out of scope.

## 10. Known gaps / inconsistencies

Explicitly flagged in code comments:

- **No automation run-history**: a failed automation action (device offline)
  is only `console.error`'d — `engine.js`'s own comment calls this "no
  automation-run-history UI yet — flagged gap."
- **No DB-backed tests yet**: README states this outright; only pure-unit
  tests exist (§9).
- **Scenes are not synced**: `groups.js`'s comment notes Scenes are "still
  Hive-only/unsynced" on the app side — automations embed raw action arrays
  rather than referencing a Scene entity.
- **No email delivery**: household invites are in-app only; inviting an email
  with no existing account fails immediately rather than queuing (003
  migration comment + `households.js` route behavior).
- **`docs/plan.md` is stale for the backend**: it is titled a "Serverless"
  design ("No backend, no database, no broker") and predates this entire
  `backend/` directory; several route/module comments still cite it for
  historical rationale (naming conventions, the households/groups data model,
  loop-protection worked examples) even though its top-level premise no longer
  holds.

Observed while reading (not called out in code comments, listed here as
findings rather than confirmed intent):

- **Asymmetric online/offline broadcasts**: `device_online` is broadcast to
  household clients on device connect/re-auth, but there is no corresponding
  `device_offline` broadcast on WS close — clients must re-fetch `GET
  /devices` or infer offline state from a failed relay to notice.
- **Inconsistent JSON field casing**: `GET /devices/` returns snake_case
  top-level device fields (`device_id`, `friendly_name`, ...) while every
  other list endpoint (activity, automations, groups, households) aliases
  every column to camelCase.
- **Inconsistent "created" status codes**: `POST /automations/` returns `200`
  for both create and update, whereas `POST /auth/signup` and `POST
  /households/:id/invite` return `201` for creation.
- **Lazy `JWT_SECRET` validation**: a deployment missing `JWT_SECRET` starts
  and listens successfully; the failure only surfaces on the first
  sign/verify call (login, signup, or the first client WS upgrade attempt).
- **No multi-instance support**: `ws/registry.js` and `ws/attribution.js` hold
  all connection/relay/attribution state in-process with no shared store;
  running more than one backend process would split device and client
  connections unpredictably between instances. Nothing in the deployment
  docs (systemd unit, README) suggests this is intended to be addressed —
  the deployment model is single-process.
- **Attribution race window**: `attribution.js`'s pending-change map is keyed
  only by `(deviceId, channelIdx, state)` with an 8-second TTL; two different
  actors commanding the same channel to the same state inside that window
  could have the first device echo consume the wrong (or right, by luck)
  attribution entry.
- **No schedule catch-up**: the automation scheduler is a simple 60-second
  poll (`scheduler.js`); if the process is down (deploy, crash, restart) at
  the exact minute a schedule should fire, that occurrence is silently
  skipped — no backfill/catch-up logic exists.
- **README route list is incomplete**: it lists only `/auth/*` and
  `/devices/*`, omitting `/groups`, `/households`, `/activity`, and
  `/automations`, all of which are live routes per `src/app.js`.
