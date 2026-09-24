import type { NextRequest } from 'next/server';

import { backendUrl } from './config';

/** Relay commands wait up to 10 s on the backend; leave headroom. */
const BACKEND_TIMEOUT_MS = 20_000;

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The real client IP, so the backend's per-IP rate limits don't lump every
 * dashboard user into the single 127.0.0.1 bucket. In production the
 * dashboard listens on 127.0.0.1 only and is reached exclusively through
 * cloudflared, which sets `CF-Connecting-IP` — so that header is trusted
 * first. The backend must run with TRUST_PROXY=loopback to honour it.
 */
export function clientIp(req: NextRequest): string | undefined {
  const candidates = [
    req.headers.get('cf-connecting-ip'),
    req.headers.get('x-forwarded-for')?.split(',')[0],
    req.headers.get('x-real-ip'),
  ];
  for (const c of candidates) {
    const ip = c?.trim();
    if (ip && IP_RE.test(ip)) return ip;
  }
  return undefined;
}

export interface BackendInit {
  method?: string;
  /** Raw JSON string or a value to JSON-encode. */
  body?: unknown;
  accessToken?: string | null;
  ip?: string;
  /** Query string including the leading "?", or "". */
  search?: string;
}

export async function backendFetch(path: string, init: BackendInit = {}): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: string | undefined;
  if (init.body !== undefined && init.body !== null && init.body !== '') {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['Content-Type'] = 'application/json';
  }
  if (init.accessToken) headers.Authorization = `Bearer ${init.accessToken}`;
  if (init.ip) headers['X-Forwarded-For'] = init.ip;

  return fetch(`${backendUrl()}${path}${init.search ?? ''}`, {
    method: init.method ?? 'GET',
    headers,
    body,
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
  });
}

/** Parses a backend response body as JSON, tolerating empty/non-JSON bodies. */
export async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}
