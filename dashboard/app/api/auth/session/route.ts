import { NextResponse, type NextRequest } from 'next/server';

import { backendFetch, clientIp, readJson } from '@/lib/server/backend';
import { applySession, guard, withSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** `{authenticated, user}` — user is the raw GET /auth/me body (normalised client-side). */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const ip = clientIp(req);
    const { res, session } = await withSession(req, (at) =>
      backendFetch('/auth/me', { accessToken: at, ip }),
    );
    if (!res || session.expired) {
      return applySession(NextResponse.json({ authenticated: false, user: null }), session);
    }
    if (res.status === 401) {
      return applySession(NextResponse.json({ authenticated: false, user: null }), {
        ...session,
        expired: true,
      });
    }
    // 404 = backend without /auth/me yet: the session itself is still valid.
    const user = res.ok ? await readJson(res) : null;
    return applySession(NextResponse.json({ authenticated: true, user }), session);
  });
}
