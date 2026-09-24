import { NextResponse, type NextRequest } from 'next/server';

import { backendFetch, clientIp } from '@/lib/server/backend';
import { checkCsrf } from '@/lib/server/csrf';
import { readJsonBody } from '@/lib/server/request';
import {
  applySession,
  clearSessionCookies,
  guard,
  relay,
  sessionExpiredResponse,
  withSession,
} from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** DELETE /auth/account {password} — on success the session cookies are cleared. */
export async function DELETE(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (csrf) return csrf;

  return guard(async () => {
    const body = await readJsonBody(req);
    const ip = clientIp(req);
    const { res, session } = await withSession(req, (at) =>
      backendFetch('/auth/account', {
        method: 'DELETE',
        body: { password: body.password },
        accessToken: at,
        ip,
      }),
    );
    if (!res) return sessionExpiredResponse();

    if (res.ok) {
      const out = new NextResponse(null, { status: 204 });
      clearSessionCookies(out);
      return out;
    }
    return applySession(await relay(res), session);
  });
}
