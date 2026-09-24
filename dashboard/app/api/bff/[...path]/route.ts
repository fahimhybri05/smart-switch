import { NextResponse, type NextRequest } from 'next/server';

import { backendFetch, clientIp } from '@/lib/server/backend';
import { checkCsrf } from '@/lib/server/csrf';
import { readBodyText } from '@/lib/server/request';
import { applySession, guard, relay, sessionExpiredResponse, withSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * Allowlisted backend paths (joined segments, no leading slash). Auth
 * endpoints that touch tokens (login/refresh/password/account/…) are NOT
 * here — they have dedicated handlers under /api/auth that manage cookies.
 */
const ALLOWED: RegExp[] = [
  /^auth\/(me|email)$/,
  /^devices(\/.*)?$/,
  /^households(\/.*)?$/,
  /^activity$/,
  /^groups(\/.*)?$/,
  /^automations(\/.*)?$/,
  /^scenes(\/.*)?$/,
  /^usage$/,
  /^api-keys(\/.*)?$/,
  /^hooks(\/.*)?$/,
  // Admin console — the backend re-checks is_admin on every request.
  /^admin(\/.*)?$/,
];

const SEGMENT_RE = /^[A-Za-z0-9._~:@-]+$/;

function resolvePath(segments: string[] | undefined): string | null {
  if (!segments?.length || segments.length > 8) return null;
  for (const s of segments) {
    if (!SEGMENT_RE.test(s) || s === '.' || s === '..') return null;
  }
  const joined = segments.join('/');
  return ALLOWED.some((re) => re.test(joined)) ? joined : null;
}

type Ctx = { params: Promise<{ path: string[] }> };

async function handle(req: NextRequest, ctx: Ctx) {
  const csrf = checkCsrf(req, { requireHeaderOnSafe: true });
  if (csrf) return csrf;

  const { path } = await ctx.params;
  const target = resolvePath(path);
  if (!target) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return guard(async () => {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const body = hasBody ? await readBodyText(req) : undefined;
    const ip = clientIp(req);
    const search = req.nextUrl.search;

    const { res, session } = await withSession(req, (at) =>
      backendFetch(`/${target}`, { method: req.method, body, accessToken: at, ip, search }),
    );
    if (!res) return sessionExpiredResponse();
    return applySession(await relay(res), session);
  });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
