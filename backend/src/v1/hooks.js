import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { hashSecret, looksLikeHookToken, touchLastUsed } from '../auth/apiKeys.js';
import { pool } from '../db/pool.js';
import { actuateSwitch, getSwitch, toggleTarget } from '../switches.js';
import { sendError, v1RateLimited } from './errors.js';

const ACTIONS = new Set(['on', 'off', 'toggle', 'status']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST']);

/** Every failure (bad format, unknown/revoked token, revoked key, user no
 * longer in the household, device unclaimed) looks exactly the same, so a
 * hook URL can't be probed for "exists but revoked". */
function hookNotFound(res) {
  return sendError(res, 404, 'not_found', 'Not found.');
}

function hookHeaders(req, res, next) {
  // The token is the credential and lives in the URL: never cache it,
  // never leak it in a Referer, never index it.
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  next();
}

/** Token -> active hook under an active key whose owner is still a member
 * of the device's household and not disabled. Null on any mismatch. */
async function lookupHook(token) {
  const { rows } = await pool.query(
    `SELECT h.id, h.device_id, h.channel_idx, k.user_id, d.household_id
     FROM switch_hooks h
     JOIN api_keys k ON k.id = h.api_key_id AND k.revoked_at IS NULL
     JOIN users u ON u.id = k.user_id AND u.disabled_at IS NULL
     JOIN devices d ON d.device_id = h.device_id
     JOIN household_members hm ON hm.household_id = d.household_id AND hm.user_id = k.user_id
     WHERE h.token_hash = $1 AND h.revoked_at IS NULL`,
    [hashSecret(token)],
  );
  return rows[0] ?? null;
}

function respond(req, res, sw) {
  if (req.query.format === 'text') {
    return res.type('text/plain').send(sw.state);
  }
  return res.json(sw);
}

async function handleHook(req, res) {
  const { token, action } = req.params;
  if (!ALLOWED_METHODS.has(req.method) || !ACTIONS.has(action) || !looksLikeHookToken(token)) {
    return hookNotFound(res);
  }
  // HEAD (e.g. `curl -I`, some link checkers) must never actuate.
  if (req.method === 'HEAD' && action !== 'status') {
    res.set('Allow', 'GET, POST');
    return sendError(res, 405, 'method_not_allowed', 'Use GET or POST.');
  }

  const hook = await lookupHook(token);
  if (!hook) {
    return hookNotFound(res);
  }
  const sw = await getSwitch([Number(hook.household_id)], hook.device_id, Number(hook.channel_idx));
  if (!sw) {
    return hookNotFound(res);
  }
  touchLastUsed('switch_hooks', Number(hook.id));

  if (action === 'status') {
    return respond(req, res, sw);
  }
  const target = action === 'toggle' ? toggleTarget(sw.state) : action;
  const updated = await actuateSwitch(sw, target, {
    source: 'hook',
    actorUserId: Number(hook.user_id),
  });
  return respond(req, res, updated);
}

/**
 * `GET|POST /v1/hook/:token/(on|off|toggle|status)` — per-switch secret
 * URLs, no headers needed (bookmarks, IFTTT, Home Assistant rest_command).
 * Not behind requireApiKey: the token itself is the credential.
 */
export function createHookRouter() {
  const router = Router();
  const common = { standardHeaders: true, legacyHeaders: false, handler: v1RateLimited };

  const ipLimiter = rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: 60,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  });
  // Only failed lookups (404s) count — brute-forcing tokens gets an IP
  // shut out for the window.
  const failedLookupLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 20,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode !== 404,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  });
  const tokenLimiter = rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: 30,
    // Keyed on the hash so raw tokens never sit in the limiter's memory.
    keyGenerator: (req) => `hook:${hashSecret(String(req.params.token))}`,
  });

  router.use(hookHeaders);
  router.all('/:token/:action', ipLimiter, failedLookupLimiter, tokenLimiter, handleHook);
  router.use((req, res) => hookNotFound(res));
  return router;
}
