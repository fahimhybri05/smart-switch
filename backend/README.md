# Smart Switch backend

Relay + accounts service — see `/home/fahim/.claude/plans/docs-plan-md-compiled-wind.md`
(or `docs/plan.md` in the repo root once copied there) for the full design.
The device stays authoritative for its own config/schedules; this service
only handles user accounts, device ownership/claiming, and relaying
commands between app/dashboard clients and each device's persistent
WebSocket tunnel.

## Local development

Needs a Postgres instance already running somewhere (local install, an
existing server, whatever you point `DATABASE_URL` at — nothing here
provisions one for you).

```sh
cp .env.example .env   # fill in DATABASE_URL + a real JWT_SECRET
npm install
npm run migrate
npm run dev             # node --watch src/server.js
```

- REST API on `http://localhost:3000` (`/auth/*`, `/devices/*`).
- Device WebSocket tunnel: `ws://localhost:3000/device`.
- App/dashboard WebSocket: `ws://localhost:3000/ws?token=<access token>`.

## Tests

```sh
npm test
```

Runs on Node's built-in test runner (`node --test`). The suite under
`test/` is DB-free (pure unit tests for JWT signing, device-secret
hashing, and the in-memory relay registry) so it runs without Postgres.
Route-level tests that touch the database aren't included yet — bring up
your own Postgres instance and run `npm run migrate` first if you add any.

## Production

Runs as a plain `node src/server.js` process against a Postgres instance
you manage yourself — no Docker. `server.js` handles `SIGTERM`/`SIGINT`
itself (closes every open device/client WebSocket, then the DB pool,
before exiting), so a process manager's restart/stop is clean.

### systemd (recommended)

A ready-to-use unit is in `deploy/smart-switch-backend.service` — edit its
`WorkingDirectory`/`EnvironmentFile`/`User` if this isn't deployed at
`/var/www/html/smart-switch/backend` under this same user, then:

```sh
sudo cp deploy/smart-switch-backend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now smart-switch-backend
```

- Logs: `journalctl -u smart-switch-backend -f`
- Restart after a deploy: `sudo systemctl restart smart-switch-backend`
- It restarts automatically on crash (`Restart=always`) and on boot
  (`enable`) — device firmware already reconnects on its own
  (`cloud_client`'s reconnect-with-backoff) whenever the backend bounces.

Put a reverse proxy (e.g. Caddy or nginx) in front of port 3000 for
automatic HTTPS once a real domain points at this host — not included
here, since it depends on your actual domain/DNS setup.
