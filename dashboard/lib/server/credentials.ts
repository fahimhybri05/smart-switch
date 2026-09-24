import { NextResponse, type NextRequest } from 'next/server';

import { backendFetch, clientIp, readJson } from './backend';
import { COOKIE_RT } from './config';
import { checkCsrf } from './csrf';
import { readJsonBody } from './request';
import { guard, isTokenPair, setSessionCookies } from './session';

/** Shared POST handler for /api/auth/login and /api/auth/signup. */
export function credentialsHandler(backendPath: '/auth/login' | '/auth/signup') {
  return async function POST(req: NextRequest) {
    const csrf = checkCsrf(req);
    if (csrf) return csrf;

    return guard(async () => {
      const body = await readJsonBody(req);
      const ip = clientIp(req);
      const res = await backendFetch(backendPath, {
        method: 'POST',
        body: { email: body.email, password: body.password },
        ip,
      });
      const data = await readJson(res);
      if (!res.ok || !isTokenPair(data)) {
        const error = (data as { error?: unknown } | null)?.error ?? 'request failed';
        return NextResponse.json({ error }, { status: res.ok ? 502 : res.status });
      }

      // Best-effort revoke of a previous session's refresh token on this browser.
      const previous = req.cookies.get(COOKIE_RT)?.value;
      if (previous) {
        backendFetch('/auth/logout', { method: 'POST', body: { refreshToken: previous }, ip }).catch(
          () => undefined,
        );
      }

      const out = NextResponse.json({ ok: true }, { status: res.status === 201 ? 201 : 200 });
      setSessionCookies(out, data);
      return out;
    });
  };
}
