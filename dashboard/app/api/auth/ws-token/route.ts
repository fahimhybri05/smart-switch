import { NextResponse, type NextRequest } from 'next/server';

import { publicWsUrl } from '@/lib/server/config';
import { checkCsrf } from '@/lib/server/csrf';
import { applySession, guard, resolveSession, sessionExpiredResponse } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * Hands the browser a short-lived (≤15 min) access token for the backend's
 * client WebSocket, which authenticates only at upgrade time via `?token=`.
 * POST + CSRF checks so a cross-site page can't make the browser mint one.
 * The long-lived refresh token never leaves the httpOnly cookie.
 */
export async function POST(req: NextRequest) {
  const csrf = checkCsrf(req);
  if (csrf) return csrf;

  return guard(async () => {
    const session = await resolveSession(req);
    if (!session.accessToken) return sessionExpiredResponse();
    return applySession(
      NextResponse.json({ token: session.accessToken, wsUrl: publicWsUrl() }),
      session,
    );
  });
}
