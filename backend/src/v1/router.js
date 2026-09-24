import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import { publicApiUrl } from '../config.js';
import { pool } from '../db/pool.js';
import { DEFAULT_CHANNEL_COUNT } from '../deviceApi/constants.js';
import { requireApiKey } from '../middleware/apiKey.js';
import { attachHouseholds } from '../middleware/household.js';
import {
  actuateSwitch,
  getSwitch,
  listSwitchesForHouseholds,
  parseSwitchId,
  toggleTarget,
} from '../switches.js';
import { isDeviceOnline } from '../ws/registry.js';
import { ApiError, sendError, v1NotFound, v1RateLimited } from './errors.js';
import { createHookRouter } from './hooks.js';
import { buildOpenApiSpec } from './openapi.js';

const householdIdsOf = (req) => [...req.householdRoles.keys()].map(Number);

async function loadSwitchOr404(req) {
  const parsed = parseSwitchId(req.params.id);
  const sw = parsed ? await getSwitch(householdIdsOf(req), parsed.deviceId, parsed.channelIdx) : null;
  if (!sw) {
    throw new ApiError(404, 'not_found', 'Switch not found.');
  }
  return sw;
}

function setState(req, sw, state) {
  return actuateSwitch(sw, state, { source: 'api', actorUserId: req.userId });
}

const patchSchema = z.object({ state: z.enum(['on', 'off']) });

/**
 * The public API (`/v1`). API keys only (see middleware/apiKey.js); one
 * error shape (`{error:{code,message}}`, see ./errors.js) including its
 * own 404/429 handling — pair with `v1ErrorHandler` mounted at `/v1`.
 * A fresh router (and fresh rate-limit counters) per createApp() call.
 */
export function createV1Router() {
  const router = Router();
  const common = { standardHeaders: true, legacyHeaders: false, handler: v1RateLimited };

  // Before auth: only failed authentications count, per IP.
  const failedAuthLimiter = rateLimit({
    ...common,
    windowMs: 15 * 60 * 1000,
    limit: 30,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode !== 401,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  });
  // After auth: per key.
  const perKeyLimiter = rateLimit({
    ...common,
    windowMs: 60 * 1000,
    limit: 120,
    keyGenerator: (req) => `key:${req.apiKey.id}`,
  });

  router.use('/hook', createHookRouter());
  router.get('/openapi.json', (req, res) => res.json(buildOpenApiSpec(publicApiUrl())));

  router.use(failedAuthLimiter, requireApiKey, attachHouseholds, perKeyLimiter);

  router.get('/me', async (req, res) => {
    const ids = householdIdsOf(req);
    const [{ rows: users }, { rows: households }] = await Promise.all([
      pool.query('SELECT id, email FROM users WHERE id = $1', [req.userId]),
      ids.length
        ? pool.query('SELECT id, name FROM households WHERE id = ANY($1::bigint[]) ORDER BY id', [ids])
        : Promise.resolve({ rows: [] }),
    ]);
    if (!users[0]) {
      throw new ApiError(401, 'invalid_api_key', 'Invalid or revoked API key.');
    }
    res.json({
      id: Number(users[0].id),
      email: users[0].email,
      households: households.map((h) => ({
        id: Number(h.id),
        name: h.name,
        role: req.householdRoles.get(String(h.id)),
      })),
      apiKey: req.apiKey,
    });
  });

  router.get('/devices', async (req, res) => {
    const ids = householdIdsOf(req);
    if (ids.length === 0) {
      return res.json({ devices: [] });
    }
    const { rows } = await pool.query(
      `SELECT device_id, friendly_name, household_id, last_seen_at
       FROM devices WHERE household_id = ANY($1::bigint[]) ORDER BY device_id`,
      [ids],
    );
    res.json({
      devices: rows.map((d) => ({
        id: d.device_id,
        name: d.friendly_name ?? d.device_id,
        householdId: Number(d.household_id),
        online: isDeviceOnline(d.device_id),
        lastSeenAt: d.last_seen_at ? new Date(d.last_seen_at).toISOString() : null,
        switchCount: DEFAULT_CHANNEL_COUNT,
      })),
    });
  });

  router.get('/switches', async (req, res) => {
    const deviceId = typeof req.query.deviceId === 'string' && req.query.deviceId !== '' ? req.query.deviceId : undefined;
    const switches = await listSwitchesForHouseholds(householdIdsOf(req), { deviceId });
    if (deviceId && switches.length === 0) {
      return sendError(res, 404, 'not_found', 'Device not found.');
    }
    res.json({ switches });
  });

  router.get('/switches/:id', async (req, res) => {
    res.json(await loadSwitchOr404(req));
  });

  router.post('/switches/:id/:action(on|off|toggle)', async (req, res) => {
    const sw = await loadSwitchOr404(req);
    const { action } = req.params;
    const target = action === 'toggle' ? toggleTarget(sw.state) : action;
    res.json(await setState(req, sw, target));
  });

  router.patch('/switches/:id', async (req, res) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'invalid_request', 'Body must be {"state":"on"} or {"state":"off"}.');
    }
    const sw = await loadSwitchOr404(req);
    res.json(await setState(req, sw, parsed.data.state));
  });

  router.use(v1NotFound);
  return router;
}

export { v1ErrorHandler } from './errors.js';
