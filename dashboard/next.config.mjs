// @ts-check
/**
 * Security headers + CSP.
 *
 * NOTE: Next.js bakes `headers()` into the build manifest, so the env vars
 * read here (PUBLIC_WS_URL, DASHBOARD_ORIGIN, NODE_ENV) must be present when `npm run build`
 * runs — keep them in `.env.production` next to this file.
 */

const isDev = process.env.NODE_ENV !== 'production';
const httpsOrigin = (process.env.DASHBOARD_ORIGIN ?? '').startsWith('https://');

if (!isDev && !process.env.PUBLIC_WS_URL) {
  console.warn(
    '[next.config] PUBLIC_WS_URL is not set: the CSP will block the live WebSocket. ' +
      'Create .env.production before `npm run build`.',
  );
}

/** Origin (scheme://host[:port]) of the backend WebSocket the browser connects to directly. */
function wsOrigin() {
  const raw = process.env.PUBLIC_WS_URL;
  if (!raw) return isDev ? 'ws://localhost:3000 ws://127.0.0.1:3000' : '';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

const csp = [
  "default-src 'self'",
  // App Router emits inline bootstrap scripts, and next-themes injects a
  // tiny inline script to avoid a theme flash — hence 'unsafe-inline'
  // (a nonce-based CSP would force dynamic rendering of every page).
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${wsOrigin()}${isDev ? ' ws: wss:' : ''}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "manifest-src 'self'",
  ...(httpsOrigin ? ['upgrade-insecure-requests'] : []),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  ...(isDev
    ? []
    : [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // These pages moved under /settings — keep old links and bookmarks working.
  async redirects() {
    return [
      { source: '/profile', destination: '/settings/profile', permanent: false },
      { source: '/household', destination: '/settings/household', permanent: false },
      { source: '/integrations', destination: '/settings/integrations', permanent: false },
    ];
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // Browsers must re-check the service worker on every load so fixes ship.
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache, max-age=0' }],
      },
      {
        // Never cache BFF/auth responses anywhere (they carry user data / tokens).
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },
};

export default nextConfig;
