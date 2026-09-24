import { NextResponse, type NextRequest } from 'next/server';

import { CSRF_HEADER, dashboardOrigin, isProd } from './config';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let warned = false;

/** The origin browser requests must come from. Falls back to the Host header when DASHBOARD_ORIGIN is unset. */
function expectedOrigin(req: NextRequest): string {
  const configured = dashboardOrigin();
  if (configured) return configured;
  if (isProd && !warned) {
    warned = true;
    console.warn('[bff] DASHBOARD_ORIGIN is not set; deriving the expected origin from the Host header');
  }
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ?? req.nextUrl.protocol.replace(':', '');
  return `${proto}://${host}`;
}

/**
 * CSRF defence: cookies are SameSite=Lax already; on top of that every
 * mutation must (1) come from our own Origin and (2) carry the custom
 * `X-SC-Request: 1` header, which a cross-site <form> cannot set and a
 * cross-site fetch cannot send without a CORS preflight we never approve.
 * Returns an error response to send, or null when the request passes.
 */
export function checkCsrf(req: NextRequest, opts: { requireHeaderOnSafe?: boolean } = {}) {
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const safe = SAFE_METHODS.has(req.method);
  if (safe && !opts.requireHeaderOnSafe) return null;

  if (req.headers.get(CSRF_HEADER) !== '1') {
    return NextResponse.json({ error: 'missing request header' }, { status: 403 });
  }
  if (!safe) {
    const origin = req.headers.get('origin');
    if (!origin || origin !== expectedOrigin(req)) {
      return NextResponse.json({ error: 'bad origin' }, { status: 403 });
    }
  }
  return null;
}
