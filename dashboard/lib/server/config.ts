/**
 * Server-side runtime configuration. Edge-safe (no Node built-ins) because
 * middleware.ts imports the cookie names from here.
 */

export const isProd = process.env.NODE_ENV === 'production';

/**
 * `__Host-` cookies must be `Secure`, which browsers refuse to set over
 * plain http (except on localhost in some browsers). Dev builds therefore
 * use unprefixed names so http://localhost works everywhere.
 */
export const COOKIE_RT = isProd ? '__Host-sc_rt' : 'sc_rt';
export const COOKIE_AT = isProd ? '__Host-sc_at' : 'sc_at';

/** Refresh-token cookie lifetime — matches the backend's REFRESH_TOKEN_TTL_MS (30 days). */
export const RT_MAX_AGE_S = 30 * 24 * 60 * 60;
/** Upper bound for the access-token cookie — the backend's JWT lives 15 min. */
export const AT_MAX_AGE_S = 14 * 60;

/** Response header the BFF sets when the session is definitively gone (client then redirects to /login). */
export const SESSION_HEADER = 'x-sc-session';
/** Request header every browser → BFF mutation must carry (CSRF defence in depth). */
export const CSRF_HEADER = 'x-sc-request';

export function backendUrl(): string {
  return (process.env.BACKEND_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
}

/** The dashboard's public origin, e.g. https://dashboard.smart-switch.shop. */
export function dashboardOrigin(): string | undefined {
  const raw = process.env.DASHBOARD_ORIGIN?.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

/** Backend client WebSocket URL the browser connects to directly. */
export function publicWsUrl(): string {
  const explicit = process.env.PUBLIC_WS_URL?.trim();
  if (explicit) return explicit;
  const u = new URL(backendUrl());
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

/** Public base URL of the backend for the external API docs (no trailing slash). */
export function publicApiUrl(): string {
  return (process.env.PUBLIC_API_URL?.trim() || backendUrl()).replace(/\/+$/, '');
}
