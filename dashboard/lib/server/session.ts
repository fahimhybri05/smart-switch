import { createHash } from 'node:crypto';

import { NextResponse, type NextRequest } from 'next/server';

import { backendFetch, clientIp, readJson } from './backend';
import {
  AT_MAX_AGE_S,
  COOKIE_AT,
  COOKIE_RT,
  RT_MAX_AGE_S,
  SESSION_HEADER,
  isProd,
} from './config';
import { bodyErrorResponse } from './request';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export function isTokenPair(v: unknown): v is TokenPair {
  const o = v as Partial<TokenPair> | null;
  return !!o && typeof o.accessToken === 'string' && typeof o.refreshToken === 'string';
}

/* ------------------------------------------------------------------ */
/* Single-flight refresh with a 30 s grace cache                      */
/* ------------------------------------------------------------------ */

/**
 * The backend's refresh tokens are single-use and rotate on every call. If
 * two tabs (or two parallel requests from one tab) notice an expired access
 * token at the same time, both would send the same refresh token and the
 * second one would be rejected — logging the user out. So concurrent
 * refreshes for the same token share one in-flight request, and the result
 * stays cached for GRACE_MS so stragglers still carrying the old cookie get
 * the new pair too. Keyed by sha256(refresh token) so raw tokens aren't map
 * keys. This is per-process state: the dashboard must run as ONE instance.
 */
const GRACE_MS = 30_000;

interface RefreshFlight {
  promise: Promise<TokenPair | null>;
  settledAt: number | null;
}

const g = globalThis as typeof globalThis & { __scRefreshFlights?: Map<string, RefreshFlight> };
const flights: Map<string, RefreshFlight> = (g.__scRefreshFlights ??= new Map());

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sweep(now: number) {
  for (const [key, flight] of flights) {
    if (flight.settledAt !== null && now - flight.settledAt >= GRACE_MS) flights.delete(key);
  }
}

async function doRefresh(refreshToken: string, ip?: string): Promise<TokenPair | null> {
  const res = await backendFetch('/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
    ip,
  });
  if (res.ok) {
    const data = await readJson(res);
    if (isTokenPair(data)) return data;
    throw new Error('refresh returned an unexpected body');
  }
  // 403 = account disabled by an admin: the session is over, same as 401.
  if (res.status === 400 || res.status === 401 || res.status === 403) return null;
  throw new Error(`refresh failed with HTTP ${res.status}`);
}

/**
 * Returns the new token pair, `null` if the refresh token is invalid /
 * expired / already used (outside the grace window), or throws when the
 * backend is unreachable (callers must NOT clear cookies in that case).
 */
export function refreshSession(refreshToken: string, ip?: string): Promise<TokenPair | null> {
  const now = Date.now();
  sweep(now);
  const key = sha256(refreshToken);
  const existing = flights.get(key);
  if (existing && (existing.settledAt === null || now - existing.settledAt < GRACE_MS)) {
    return existing.promise;
  }
  const flight: RefreshFlight = { promise: doRefresh(refreshToken, ip), settledAt: null };
  flights.set(key, flight);
  flight.promise.then(
    () => {
      flight.settledAt = Date.now();
    },
    () => {
      // Don't cache transport errors — the next request should retry.
      if (flights.get(key) === flight) flights.delete(key);
    },
  );
  return flight.promise;
}

/* ------------------------------------------------------------------ */
/* Access-token helpers                                               */
/* ------------------------------------------------------------------ */

/** Unverified read of a JWT's `exp` (ms since epoch). The backend verifies; this only schedules refreshes. */
export function tokenExpiry(token: string): number | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isFresh(token: string | null | undefined, marginMs = 30_000): token is string {
  if (!token) return false;
  const exp = tokenExpiry(token);
  return exp === null ? true : exp - Date.now() > marginMs;
}

/* ------------------------------------------------------------------ */
/* Cookies                                                            */
/* ------------------------------------------------------------------ */

const baseCookie = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax' as const,
  path: '/',
};

export function setSessionCookies(res: NextResponse, pair: TokenPair) {
  const exp = tokenExpiry(pair.accessToken);
  const atMaxAge = exp
    ? Math.max(30, Math.min(AT_MAX_AGE_S, Math.floor((exp - Date.now()) / 1000) - 60))
    : AT_MAX_AGE_S;
  res.cookies.set(COOKIE_AT, pair.accessToken, { ...baseCookie, maxAge: atMaxAge });
  res.cookies.set(COOKIE_RT, pair.refreshToken, { ...baseCookie, maxAge: RT_MAX_AGE_S });
}

export function clearSessionCookies(res: NextResponse) {
  res.cookies.set(COOKIE_AT, '', { ...baseCookie, maxAge: 0 });
  res.cookies.set(COOKIE_RT, '', { ...baseCookie, maxAge: 0 });
}

/* ------------------------------------------------------------------ */
/* Session resolution + one-retry backend calls                       */
/* ------------------------------------------------------------------ */

export interface Session {
  accessToken: string | null;
  refreshToken: string | null;
  /** Set when this request rotated the tokens — must be written back as cookies. */
  rotated: TokenPair | null;
  /** True when the session is definitively gone — cookies must be cleared. */
  expired: boolean;
}

export async function resolveSession(
  req: NextRequest,
  opts: { forceRefresh?: boolean } = {},
): Promise<Session> {
  const at = req.cookies.get(COOKIE_AT)?.value || null;
  const rt = req.cookies.get(COOKIE_RT)?.value || null;

  if (!opts.forceRefresh && isFresh(at)) {
    return { accessToken: at, refreshToken: rt, rotated: null, expired: false };
  }
  if (!rt) {
    return { accessToken: null, refreshToken: null, rotated: null, expired: true };
  }
  const pair = await refreshSession(rt, clientIp(req));
  if (!pair) {
    return { accessToken: null, refreshToken: null, rotated: null, expired: true };
  }
  return { accessToken: pair.accessToken, refreshToken: pair.refreshToken, rotated: pair, expired: false };
}

/**
 * Backend messages that mean "your access token is bad" (requireAuth in
 * backend/src/middleware/auth.js), as opposed to e.g. "wrong current
 * password" on the sensitive profile routes. Only the former triggers the
 * refresh-and-retry, so a mistyped password never burns a second attempt
 * against the backend's strict rate limit, and never logs the user out.
 */
const AUTH_FAILURE_RE = /bearer|expired token|invalid token|jwt|unauthori[sz]ed/i;

async function isAccessTokenFailure(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = (await readJson(res.clone())) as { error?: unknown } | null;
  const err = body?.error;
  const text =
    typeof err === 'string'
      ? err
      : err && typeof err === 'object'
        ? `${(err as { code?: string }).code ?? ''} ${(err as { message?: string }).message ?? ''}`
        : '';
  return text === '' || AUTH_FAILURE_RE.test(text);
}

/**
 * Runs `call` with a valid access token, refreshing first when the cookie
 * is missing/expiring, and retrying exactly once after a refresh when the
 * backend still answers 401 for an auth reason. `res === null` means no
 * session could be established.
 */
export async function withSession(
  req: NextRequest,
  call: (accessToken: string) => Promise<Response>,
): Promise<{ res: Response | null; session: Session }> {
  let session = await resolveSession(req);
  if (!session.accessToken) return { res: null, session: { ...session, expired: true } };

  let res = await call(session.accessToken);
  if (!session.rotated && (await isAccessTokenFailure(res))) {
    // A rejected access token with no refresh token to fall back on: session is gone.
    if (!session.refreshToken) return { res: null, session: { ...session, expired: true } };
    const retry = await resolveSession(req, { forceRefresh: true });
    if (!retry.accessToken) return { res: null, session: { ...retry, expired: true } };
    session = retry;
    res = await call(retry.accessToken);
  }
  return { res, session };
}

/** Writes rotated cookies / clears dead ones onto the outgoing response. */
export function applySession(res: NextResponse, session: Session): NextResponse {
  if (session.expired) {
    clearSessionCookies(res);
    res.headers.set(SESSION_HEADER, 'expired');
  } else if (session.rotated) {
    setSessionCookies(res, session.rotated);
  }
  return res;
}

export function sessionExpiredResponse(): NextResponse {
  const res = NextResponse.json({ error: 'session_expired' }, { status: 401 });
  clearSessionCookies(res);
  res.headers.set(SESSION_HEADER, 'expired');
  return res;
}

/** Wraps a handler so an unreachable backend yields 502 instead of an unhandled error. */
export async function guard(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (err) {
    const bodyErr = bodyErrorResponse(err);
    if (bodyErr) return bodyErr;
    console.error('[bff] backend call failed', err);
    return NextResponse.json({ error: 'backend_unavailable' }, { status: 502 });
  }
}

/** Converts a backend Response into a NextResponse, preserving status and JSON body. */
export async function relay(res: Response): Promise<NextResponse> {
  if (res.status === 204 || res.status === 304) return new NextResponse(null, { status: res.status });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/json' },
  });
}
