import { NextResponse, type NextRequest } from 'next/server';

import { backendFetch, clientIp } from '@/lib/server/backend';
import { COOKIE_RT } from '@/lib/server/config';
import { checkCsrf } from '@/lib/server/csrf';
import { clearSessionCookies } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (csrf) return csrf;

  const refreshToken = req.cookies.get(COOKIE_RT)?.value;
  if (refreshToken) {
    try {
      await backendFetch('/auth/logout', {
        method: 'POST',
        body: { refreshToken },
        ip: clientIp(req),
      });
    } catch (err) {
      // Still clear the cookies locally; the token expires on its own.
      console.error('[bff] logout revoke failed', err);
    }
  }
  const res = new NextResponse(null, { status: 204 });
  clearSessionCookies(res);
  return res;
}
