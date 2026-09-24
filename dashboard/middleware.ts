import { NextResponse, type NextRequest } from 'next/server';

import { COOKIE_AT, COOKIE_RT } from '@/lib/server/config';

const PUBLIC_PATHS = new Set(['/login', '/signup']);

/**
 * Cheap presence check only (edge runtime, no backend call): pages without
 * any session cookie redirect to /login. Real validation happens in the BFF,
 * which clears dead cookies and makes the client bounce to /login.
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const hasSession = req.cookies.has(COOKIE_RT) || req.cookies.has(COOKIE_AT);
  if (hasSession) return NextResponse.next();

  // Build the absolute Location from the forwarded/Host headers: behind the
  // tunnel, the URL Next sees carries the internal host (127.0.0.1 → localhost).
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto =
    req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.nextUrl.protocol.replace(':', '');
  const url = new URL('/login', host ? `${proto}://${host}` : req.nextUrl.origin);
  if (pathname !== '/') url.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|logo.png|logo-mark.png|robots.txt).*)',
  ],
};
