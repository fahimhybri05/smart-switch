import { NextResponse, type NextRequest } from 'next/server';

import { backendFetch, clientIp, readJson } from '@/lib/server/backend';
import { checkCsrf } from '@/lib/server/csrf';
import { readJsonBody } from '@/lib/server/request';
import {
  applySession,
  guard,
  isTokenPair,
  relay,
  sessionExpiredResponse,
  setSessionCookies,
  withSession,
} from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * PATCH /auth/password revokes every refresh token of the user and returns
 * a fresh pair — which must replace this browser's cookies, or the very
 * next refresh would log the user out.
 */
export async function PATCH(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (csrf) return csrf;

  return guard(async () => {
    const body = await readJsonBody(req);
    const payload = { currentPassword: body.currentPassword, newPassword: body.newPassword };
    const ip = clientIp(req);
    const { res, session } = await withSession(req, (at) =>
      backendFetch('/auth/password', { method: 'PATCH', body: payload, accessToken: at, ip }),
    );
    if (!res) return sessionExpiredResponse();

    if (res.ok) {
      const data = await readJson(res);
      const out = NextResponse.json({ ok: true });
      if (isTokenPair(data)) {
        setSessionCookies(out, data);
      } else {
        applySession(out, session);
      }
      return out;
    }
    return applySession(await relay(res), session);
  });
}
