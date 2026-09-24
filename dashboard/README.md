# Smart Control — web dashboard

Next.js 15 (App Router, TypeScript) dashboard for Smart Control: live switch
control, device/switch configuration, profile, household members, and API
keys / hook URLs for integrations. It runs next to the Express backend and
talks to it only server-side through a small BFF (backend-for-frontend).

- Runtime: **Node 18.18+** (pinned to Next 15 + Tailwind 3.4 for that reason)
- UI: Tailwind 3.4, shadcn/ui-style components on Radix, next-themes, lucide-react, sonner
- Data: TanStack Query, react-hook-form + zod

## How it works

```
browser ──(httpOnly cookies)──▶ dashboard (Next, 127.0.0.1:3001)
   │                              ├─ /api/auth/*      login/signup/logout/session/password/account/ws-token
   │                              └─ /api/bff/*       allowlisted proxy ─▶ backend (127.0.0.1:3000)
   └──────(wss, short-lived token)──────────────────────────────▶ backend /ws  (live state)
```

- **Tokens never reach JavaScript storage.** The refresh token lives in the
  `__Host-sc_rt` cookie (httpOnly, Secure, SameSite=Lax, 30 days) and the
  access token in `__Host-sc_at` (~14 min). In development (`NODE_ENV` ≠
  `production`) the cookies are named `sc_rt` / `sc_at` because the
  `__Host-` prefix requires HTTPS.
- **Single-flight refresh** (`lib/server/session.ts`): the backend's
  refresh tokens are single-use, so concurrent refreshes for the same token
  share one request and the result is cached for a 30 s grace window. This
  is in-process memory → **run exactly one instance**.
- **BFF proxy** (`app/api/bff/[...path]`): only `auth/me`, `auth/email`,
  `devices`, `households`, `activity`, `groups`, `automations`, `api-keys`
  and `hooks` are forwarded. A 401 caused by an expired access token
  triggers one refresh + retry. The real client IP (from
  `CF-Connecting-IP`) is forwarded as `X-Forwarded-For` so the backend's
  per-IP rate limits work (backend needs `TRUST_PROXY=loopback`).
- **CSRF**: every mutation must come from `DASHBOARD_ORIGIN` and carry
  `X-SC-Request: 1`; cross-site `Sec-Fetch-Site` requests are rejected.
- **Security headers / CSP** are set in `next.config.mjs`; `middleware.ts`
  redirects to `/login` when there is no session cookie.
- **Live updates** (`lib/live.tsx`): the browser fetches a short-lived access
  token from `POST /api/auth/ws-token` and connects to `PUBLIC_WS_URL`. It
  applies `snapshot`, `state_changed`, `device_online` and `device_offline`
  to the query cache, reconnects with jittered exponential backoff, and polls
  `GET /devices` every 10 s while disconnected. Toggles are optimistic and
  roll back on 503 (offline) / 504 (timeout).

Backend response shapes are declared in `lib/types.ts` and normalised in
`lib/api.ts` — adjust those two files if the backend contract changes.

## Configuration

Copy `.env.example`:

| Variable           | Example (production)                  | Purpose |
| ------------------ | ------------------------------------- | ------- |
| `BACKEND_URL`      | `http://127.0.0.1:3000`               | Backend as seen from the dashboard server |
| `DASHBOARD_ORIGIN` | `https://dashboard.smart-switch.shop` | Expected `Origin` for mutations (CSRF) |
| `PUBLIC_WS_URL`    | `wss://api.smart-switch.shop/ws`      | Backend client WebSocket used by the browser (also added to the CSP) |
| `PUBLIC_API_URL`   | `https://api.smart-switch.shop`       | Base URL shown in the API docs / examples |

The CSP is computed at **build** time, so create `.env.production` before
`npm run build` and rebuild after changing `PUBLIC_WS_URL`.

## Local development

```sh
cd dashboard
cp .env.example .env.local
# edit: DASHBOARD_ORIGIN=http://localhost:3001
#       PUBLIC_WS_URL=ws://localhost:3000/ws
#       PUBLIC_API_URL=http://localhost:3000
npm install
npm run dev            # http://localhost:3001 (backend must be running on :3000)
```

Checks:

```sh
npm run lint
npm run typecheck
npm run build
```

## Production deploy (same server as the backend)

### 1. Build

```sh
cd /var/www/html/smart-switch/dashboard
cp .env.example .env.production   # production values as in the table above
npm ci
npm run build
```

### 2. Run with pm2

`ecosystem.config.cjs` runs `next start -H 127.0.0.1 -p 3001` in **fork
mode with 1 instance** (required — see "Single-flight refresh" above).

```sh
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # once per server: prints a command to enable pm2 on boot
pm2 logs smart-control-dashboard
```

After pulling new code: `npm ci && npm run build && pm2 restart smart-control-dashboard`.

### 3. Cloudflare Tunnel

The dashboard listens on loopback only; Cloudflare Tunnel exposes it.

**Dashboard (Zero Trust → Networks → Tunnels → your tunnel → Public Hostname):**

- Subdomain `dashboard`, domain `smart-switch.shop`
- Service type `HTTP`, URL `localhost:3001`

**Or, for a locally-managed tunnel**, add an ingress rule to the
`cloudflared` config (above the final catch-all) and restart cloudflared:

```yaml
ingress:
  - hostname: api.smart-switch.shop          # existing backend rule
    service: http://localhost:3000
  - hostname: dashboard.smart-switch.shop
    service: http://localhost:3001
  - service: http_status:404
```

```sh
cloudflared tunnel route dns <tunnel-name> dashboard.smart-switch.shop
sudo systemctl restart cloudflared
```

Keep the Host header as-is (don't set `httpHostHeader`), and keep
`CF-Connecting-IP` — the dashboard trusts it because it is only reachable
through the tunnel. Never bind the dashboard to a public interface.

### 4. Backend settings

In `backend/.env`: `TRUST_PROXY=loopback` (so the forwarded client IP is
honoured from the dashboard) and `PUBLIC_API_URL=https://api.smart-switch.shop`,
then `npm run migrate` and restart the backend. No CORS change is needed —
the browser only talks to the backend over the WebSocket.

### 5. Verify

```sh
curl -I https://dashboard.smart-switch.shop/login   # 200
curl -I https://dashboard.smart-switch.shop/        # 307 → /login when signed out
```

## Project layout

```
app/
  (auth)/login, (auth)/signup       public pages
  (app)/…                           signed-in pages (overview, devices/[id], household,
                                    integrations, activity, profile)
  api/auth/*                        cookie-managing auth handlers
  api/bff/[...path]                 allowlisted backend proxy
components/                         UI (components/ui = shadcn-style primitives)
lib/
  api.ts, types.ts                  browser API client + wire types (single source of truth)
  cache.ts, queries.ts, live.tsx    React Query keys/hooks, live WebSocket
  server/*                          BFF internals (config, session, csrf, backend fetch)
middleware.ts                       redirect to /login without a session cookie
ecosystem.config.cjs                pm2
```
