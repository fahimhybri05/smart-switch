import { readFileSync } from 'node:fs';

import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';

import { audit } from '../admin/audit.js';
import { lockActiveAdminIds } from '../admin/guards.js';
import { revokeApiKeyWithHooks } from '../auth/apiKeys.js';
import { deleteUserAccount } from '../auth/deleteAccount.js';
import { revokeAllRefreshTokens } from '../auth/tokens.js';
import { pool } from '../db/pool.js';
import { DEFAULT_CHANNEL_COUNT } from '../deviceApi/index.js';
import { requireAdmin } from '../middleware/admin.js';
import { requireAuth } from '../middleware/auth.js';
import {
  closeClientSockets,
  disconnectDevice,
  getClientSocketStats,
  getOnlineDeviceIds,
  isDeviceOnline,
} from '../ws/registry.js';

/**
 * Admin console API (dashboard /admin). Every route: requireAuth, then
 * requireAdmin (is_admin re-read from the DB per request). Scope is users,
 * devices and system overview — deliberately NO cross-account switch
 * control. Every mutation writes an admin_audit_log row, inside the same
 * transaction as the change.
 *
 * Disabling a user revokes their refresh tokens and closes their live
 * client WebSockets, but an access JWT already in hand stays valid until it
 * expires (≤15 min, auth/tokens.js) for the non-admin routes — accepted
 * trade-off to keep requireAuth DB-free.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Runs `fn(client)` in a transaction; any throw rolls back and propagates
 * (HttpError -> JSON error response via the handler at the bottom). */
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function parseUserId(raw) {
  const id = Number(raw);
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(404, 'user not found');
  }
  return id;
}

function parseQuery(schema, query) {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0].message);
  }
  return parsed.data;
}

function parseBody(schema, body) {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new HttpError(400, parsed.error.issues[0].message);
  }
  return parsed.data;
}

/** `%term%` for ILIKE with the user's own wildcards escaped. */
function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const pageSchema = z.object({
  q: z.string().trim().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const cursorSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
});

const LAST_ADMIN = 'this would leave no active admin; promote another admin first';

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

const BACKEND_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? null;
  } catch {
    return null;
  }
})();

/**
 * The richer half of GET /admin/stats: growth, engagement, trends, devices
 * needing attention and process health. Each query degrades to empty on
 * failure (logged) so one bad aggregate never takes down the whole overview.
 * Day/hour buckets are in the database server's timezone.
 */
async function loadStatsDetails() {
  const safe = (label, promise) =>
    promise.catch((err) => {
      console.error(`[admin/stats] ${label} failed:`, err.message);
      return { rows: [] };
    });
  const dbStart = process.hrtime.bigint();
  const [extra, daily, hourly, topDevices, claimedDevices, firmware, recentUsers] = await Promise.all([
    safe('extra', pool.query(
      `SELECT
         (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days') AS users_new_7d,
         (SELECT count(*) FROM users WHERE created_at > now() - interval '30 days') AS users_new_30d,
         (SELECT count(DISTINCT user_id) FROM refresh_tokens WHERE created_at > now() - interval '24 hours') AS users_active_24h,
         (SELECT count(DISTINCT user_id) FROM refresh_tokens WHERE created_at > now() - interval '7 days') AS users_active_7d,
         (SELECT count(*) FROM households) AS households_total,
         (SELECT count(*) FROM households h
           WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.household_id = h.id)) AS households_empty,
         (SELECT count(*) FROM household_invites WHERE status = 'pending') AS invites_pending,
         (SELECT count(*) FROM devices WHERE created_at > now() - interval '7 days') AS devices_new_7d,
         (SELECT count(*) FROM device_switches) AS switches_total,
         (SELECT count(*) FROM cached_channel_state c
            JOIN devices d ON d.device_id = c.device_id AND d.household_id IS NOT NULL
           WHERE c.state = 'ON') AS switches_on,
         (SELECT count(*) FROM device_switches WHERE locked_at IS NOT NULL) AS switches_locked,
         (SELECT count(*) FROM device_switches
           WHERE max_on_s IS NOT NULL OR min_off_s IS NOT NULL) AS switches_safety,
         (SELECT count(*) FROM device_switches WHERE watts IS NOT NULL) AS switches_metered,
         (SELECT count(*) FROM device_schedules) AS schedules_total,
         (SELECT count(*) FROM device_schedules WHERE enabled) AS schedules_enabled,
         (SELECT count(*) FROM automations) AS automations_total,
         (SELECT count(*) FROM automations WHERE enabled) AS automations_enabled,
         (SELECT count(*) FROM groups) AS groups_total,
         (SELECT count(*) FROM scenes) AS scenes_total,
         (SELECT count(*) FROM activity_log
           WHERE source = 'safety' AND created_at > now() - interval '24 hours') AS safety_24h,
         (SELECT count(*) FROM activity_log WHERE created_at > now() - interval '7 days') AS activity_7d,
         (SELECT count(*) FROM admin_audit_log WHERE created_at > now() - interval '7 days') AS audit_7d,
         pg_database_size(current_database()) AS db_bytes`,
    )),
    safe('daily', pool.query(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM activity_log a
                WHERE a.created_at >= d AND a.created_at < d + interval '1 day') AS activity,
              (SELECT count(*) FROM users u
                WHERE u.created_at >= d AND u.created_at < d + interval '1 day') AS signups
         FROM generate_series(date_trunc('day', now()) - interval '13 days',
                              date_trunc('day', now()), interval '1 day') AS d
        ORDER BY d`,
    )),
    safe('hourly', pool.query(
      `SELECT to_char(h, 'HH24') AS hour,
              (SELECT count(*) FROM activity_log a
                WHERE a.created_at >= h AND a.created_at < h + interval '1 hour') AS n
         FROM generate_series(date_trunc('hour', now()) - interval '23 hours',
                              date_trunc('hour', now()), interval '1 hour') AS h
        ORDER BY h`,
    )),
    safe('topDevices', pool.query(
      `SELECT a.device_id, d.friendly_name, count(*) AS n
         FROM activity_log a LEFT JOIN devices d ON d.device_id = a.device_id
        WHERE a.created_at > now() - interval '7 days'
        GROUP BY a.device_id, d.friendly_name
        ORDER BY n DESC LIMIT 5`,
    )),
    safe('claimedDevices', pool.query(
      `SELECT d.device_id, d.friendly_name, d.last_seen_at, d.last_connected_at, d.diagnostics,
              h.name AS household_name
         FROM devices d LEFT JOIN households h ON h.id = d.household_id
        WHERE d.household_id IS NOT NULL
        ORDER BY d.last_seen_at DESC NULLS LAST
        LIMIT 500`,
    )),
    safe('firmware', pool.query(
      `SELECT COALESCE(diagnostics->>'fw', 'unknown') AS fw, count(*) AS n
         FROM devices GROUP BY 1 ORDER BY n DESC LIMIT 8`,
    )),
    safe('recentUsers', pool.query(
      `SELECT id, email, created_at, is_admin FROM users ORDER BY created_at DESC LIMIT 5`,
    )),
  ]);
  const dbMs = Number(process.hrtime.bigint() - dbStart) / 1e6;
  const n = (v) => Number(v ?? 0);
  const e = extra.rows[0] ?? {};

  const offline = [];
  const weakSignal = [];
  for (const d of claimedDevices.rows) {
    const summary = {
      deviceId: d.device_id,
      name: d.friendly_name ?? null,
      household: d.household_name ?? null,
      lastSeenAt: d.last_seen_at ?? null,
      rssi: typeof d.diagnostics?.rssi === 'number' ? d.diagnostics.rssi : null,
    };
    if (!isDeviceOnline(d.device_id)) offline.push(summary);
    else if (summary.rssi != null && summary.rssi <= -80) weakSignal.push(summary);
  }

  const mem = process.memoryUsage();
  return {
    growth: {
      usersNew7d: n(e.users_new_7d),
      usersNew30d: n(e.users_new_30d),
      usersActive24h: n(e.users_active_24h),
      usersActive7d: n(e.users_active_7d),
      devicesNew7d: n(e.devices_new_7d),
    },
    households: {
      total: n(e.households_total),
      withoutDevices: n(e.households_empty),
      pendingInvites: n(e.invites_pending),
    },
    switches: {
      total: n(e.switches_total),
      on: n(e.switches_on),
      locked: n(e.switches_locked),
      withSafetyRules: n(e.switches_safety),
      metered: n(e.switches_metered),
    },
    automation: {
      schedules: n(e.schedules_total),
      schedulesEnabled: n(e.schedules_enabled),
      automations: n(e.automations_total),
      automationsEnabled: n(e.automations_enabled),
      groups: n(e.groups_total),
      scenes: n(e.scenes_total),
      safetyAutoOff24h: n(e.safety_24h),
    },
    trends: {
      activity7d: n(e.activity_7d),
      daily: daily.rows.map((r) => ({ day: r.day, activity: n(r.activity), signups: n(r.signups) })),
      hourly24h: hourly.rows.map((r) => ({ hour: r.hour, count: n(r.n) })),
      topDevices7d: topDevices.rows.map((r) => ({
        deviceId: r.device_id,
        name: r.friendly_name ?? null,
        count: n(r.n),
      })),
    },
    attention: {
      offlineClaimed: offline.length,
      offlineDevices: offline.slice(0, 8),
      weakSignal: weakSignal.slice(0, 8),
      firmware: firmware.rows.map((r) => ({ version: r.fw, count: n(r.n) })),
    },
    recentUsers: recentUsers.rows.map((r) => ({
      id: Number(r.id),
      email: r.email,
      createdAt: r.created_at,
      isAdmin: r.is_admin === true,
    })),
    system: {
      version: BACKEND_VERSION,
      node: process.version,
      uptimeS: Math.round(process.uptime()),
      memoryRssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      dbBytes: n(e.db_bytes),
      dbQueryMs: Math.round(dbMs),
      clients: getClientSocketStats(),
      serverTime: new Date().toISOString(),
    },
  };
}

adminRouter.get('/stats', async (req, res) => {
  const [{ rows: counts }, { rows: bySource }, details] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT count(*) FROM users) AS users_total,
         (SELECT count(*) FROM users WHERE is_admin AND disabled_at IS NULL) AS users_admins,
         (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL) AS users_disabled,
         (SELECT count(*) FROM devices) AS devices_total,
         (SELECT count(*) FROM devices WHERE household_id IS NOT NULL) AS devices_claimed,
         (SELECT count(*) FROM activity_log WHERE created_at > now() - interval '24 hours') AS activity_24h,
         (SELECT count(*) FROM api_keys k JOIN users u ON u.id = k.user_id
           WHERE k.revoked_at IS NULL AND u.disabled_at IS NULL) AS api_keys_active,
         (SELECT count(*) FROM switch_hooks h
           JOIN api_keys k ON k.id = h.api_key_id AND k.revoked_at IS NULL
           JOIN users u ON u.id = k.user_id AND u.disabled_at IS NULL
           WHERE h.revoked_at IS NULL) AS hooks_active`,
    ),
    pool.query(
      `SELECT source, count(*) AS n FROM activity_log
       WHERE created_at > now() - interval '24 hours'
       GROUP BY source ORDER BY n DESC`,
    ),
    loadStatsDetails(),
  ]);
  const c = counts[0] ?? {};
  const n = (v) => Number(v ?? 0);
  const devicesTotal = n(c.devices_total);
  const devicesClaimed = n(c.devices_claimed);
  res.json({
    users: { total: n(c.users_total), admins: n(c.users_admins), disabled: n(c.users_disabled) },
    devices: {
      total: devicesTotal,
      online: getOnlineDeviceIds().length,
      claimed: devicesClaimed,
      unclaimed: Math.max(0, devicesTotal - devicesClaimed),
    },
    activity: {
      last24h: n(c.activity_24h),
      bySource24h: Object.fromEntries(bySource.map((r) => [r.source, n(r.n)])),
    },
    apiKeys: { active: n(c.api_keys_active) },
    hooks: { active: n(c.hooks_active) },
    ...details,
  });
});

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

// deviceCount = distinct devices in every household the user belongs to
// (what they can see/control); lastActiveAt = newest refresh token, i.e.
// the last login or token refresh.
const USER_SUMMARY_SQL = `
  SELECT u.id, u.email, u.created_at, u.is_admin, u.disabled_at,
         (SELECT count(*) FROM household_members hm WHERE hm.user_id = u.id) AS household_count,
         (SELECT count(DISTINCT d.device_id) FROM devices d
            JOIN household_members hm ON hm.household_id = d.household_id
           WHERE hm.user_id = u.id) AS device_count,
         (SELECT count(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS api_key_count,
         (SELECT max(rt.created_at) FROM refresh_tokens rt WHERE rt.user_id = u.id) AS last_active_at
  FROM users u`;

function rowToUser(row) {
  return {
    id: Number(row.id),
    email: row.email,
    createdAt: row.created_at,
    isAdmin: row.is_admin === true,
    disabledAt: row.disabled_at ?? null,
    householdCount: Number(row.household_count ?? 0),
    deviceCount: Number(row.device_count ?? 0),
    apiKeyCount: Number(row.api_key_count ?? 0),
    lastActiveAt: row.last_active_at ?? null,
  };
}

async function getUserSummary(userId, db = pool) {
  const { rows } = await db.query(`${USER_SUMMARY_SQL} WHERE u.id = $1`, [userId]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

adminRouter.get('/users', async (req, res) => {
  const { q, limit, offset } = parseQuery(pageSchema, req.query);
  const where = q ? 'WHERE u.email ILIKE $1' : '';
  const params = q ? [likePattern(q)] : [];
  const [{ rows }, { rows: total }] = await Promise.all([
    pool.query(
      `${USER_SUMMARY_SQL} ${where} ORDER BY u.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    ),
    pool.query(`SELECT count(*) AS n FROM users u ${where}`, params),
  ]);
  res.json({ users: rows.map(rowToUser), total: Number(total[0]?.n ?? 0) });
});

adminRouter.get('/users/:id', async (req, res) => {
  const id = parseUserId(req.params.id);
  const user = await getUserSummary(id);
  if (!user) {
    throw new HttpError(404, 'user not found');
  }
  const [{ rows: households }, { rows: devices }, { rows: apiKeys }] = await Promise.all([
    pool.query(
      `SELECT h.id, h.name, hm.role
       FROM household_members hm JOIN households h ON h.id = hm.household_id
       WHERE hm.user_id = $1 ORDER BY h.id`,
      [id],
    ),
    pool.query(
      `SELECT DISTINCT d.device_id, d.friendly_name, d.household_id
       FROM devices d JOIN household_members hm ON hm.household_id = d.household_id
       WHERE hm.user_id = $1 ORDER BY d.device_id`,
      [id],
    ),
    pool.query(
      `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at,
              (SELECT count(*) FROM switch_hooks h WHERE h.api_key_id = k.id AND h.revoked_at IS NULL) AS hook_count
       FROM api_keys k
       WHERE k.user_id = $1 AND k.revoked_at IS NULL
       ORDER BY k.created_at DESC, k.id DESC`,
      [id],
    ),
  ]);
  res.json({
    ...user,
    households: households.map((h) => ({ id: Number(h.id), name: h.name, role: h.role })),
    devices: devices.map((d) => ({
      deviceId: d.device_id,
      friendlyName: d.friendly_name,
      householdId: d.household_id == null ? null : Number(d.household_id),
      online: isDeviceOnline(d.device_id),
    })),
    apiKeys: apiKeys.map((k) => ({
      id: Number(k.id),
      name: k.name,
      prefix: k.prefix,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      hookCount: Number(k.hook_count ?? 0),
    })),
  });
});

/** Locks and returns the target user row (never the password hash), or 404. */
async function lockUser(client, userId) {
  const { rows } = await client.query(
    'SELECT id, email, is_admin, disabled_at FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  if (!rows[0]) {
    throw new HttpError(404, 'user not found');
  }
  return rows[0];
}

adminRouter.post('/users/:id/disable', async (req, res) => {
  const id = parseUserId(req.params.id);
  if (id === req.userId) {
    throw new HttpError(400, 'you cannot disable your own account');
  }
  await inTransaction(async (client) => {
    // Admin rows first, then the target — one lock order for every
    // admin-affecting action, so two of them can't deadlock.
    const adminIds = await lockActiveAdminIds(client);
    const target = await lockUser(client, id);
    if (target.disabled_at) {
      return; // already disabled — idempotent, nothing to audit
    }
    if (adminIds.includes(id) && adminIds.length <= 1) {
      throw new HttpError(409, LAST_ADMIN);
    }
    await client.query('UPDATE users SET disabled_at = now() WHERE id = $1', [id]);
    await revokeAllRefreshTokens(id, client);
    await audit(client, req, 'user.disable', 'user', id, { email: target.email });
  });
  closeClientSockets(id, 4001, 'account disabled');
  res.json({ user: await getUserSummary(id) });
});

adminRouter.post('/users/:id/enable', async (req, res) => {
  const id = parseUserId(req.params.id);
  await inTransaction(async (client) => {
    const target = await lockUser(client, id);
    if (!target.disabled_at) {
      return;
    }
    await client.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [id]);
    await audit(client, req, 'user.enable', 'user', id, { email: target.email });
  });
  res.json({ user: await getUserSummary(id) });
});

/** Signs the user out everywhere: every refresh token revoked, live client
 * sockets closed. API keys are untouched (revoke those separately). */
adminRouter.post('/users/:id/logout', async (req, res) => {
  const id = parseUserId(req.params.id);
  await inTransaction(async (client) => {
    const target = await lockUser(client, id);
    await revokeAllRefreshTokens(id, client);
    await audit(client, req, 'user.logout', 'user', id, { email: target.email });
  });
  closeClientSockets(id, 4001, 'session revoked');
  res.status(204).end();
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8).max(128),
});

adminRouter.post('/users/:id/reset-password', async (req, res) => {
  const id = parseUserId(req.params.id);
  const { newPassword } = parseBody(resetPasswordSchema, req.body);
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await inTransaction(async (client) => {
    const target = await lockUser(client, id);
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, id]);
    await revokeAllRefreshTokens(id, client);
    // Never the password itself.
    await audit(client, req, 'user.reset_password', 'user', id, { email: target.email });
  });
  closeClientSockets(id, 4001, 'password reset');
  res.status(204).end();
});

const roleSchema = z.object({ isAdmin: z.boolean() });

adminRouter.patch('/users/:id', async (req, res) => {
  const id = parseUserId(req.params.id);
  const { isAdmin } = parseBody(roleSchema, req.body);
  if (id === req.userId && !isAdmin) {
    throw new HttpError(400, 'you cannot remove your own admin role');
  }
  await inTransaction(async (client) => {
    const adminIds = await lockActiveAdminIds(client);
    const target = await lockUser(client, id);
    if (target.is_admin === isAdmin) {
      return;
    }
    if (!isAdmin && adminIds.includes(id) && adminIds.length <= 1) {
      throw new HttpError(409, LAST_ADMIN);
    }
    await client.query('UPDATE users SET is_admin = $1 WHERE id = $2', [isAdmin, id]);
    await audit(client, req, isAdmin ? 'user.promote' : 'user.demote', 'user', id, { email: target.email });
  });
  res.json({ user: await getUserSummary(id) });
});

adminRouter.delete('/users/:id', async (req, res) => {
  const id = parseUserId(req.params.id);
  if (id === req.userId) {
    throw new HttpError(400, 'you cannot delete your own account here; use your profile page');
  }
  await inTransaction(async (client) => {
    const adminIds = await lockActiveAdminIds(client);
    const target = await lockUser(client, id);
    if (adminIds.includes(id) && adminIds.length <= 1) {
      throw new HttpError(409, LAST_ADMIN);
    }
    await deleteUserAccount(client, id);
    await audit(client, req, 'user.delete', 'user', id, {
      email: target.email,
      wasAdmin: target.is_admin === true,
    });
  });
  closeClientSockets(id, 4001, 'account deleted');
  res.status(204).end();
});

/* -------------------------------------------------------------------------- */
/* Households (lookup for the device reassign picker)                         */
/* -------------------------------------------------------------------------- */

adminRouter.get('/households', async (req, res) => {
  const { q, limit } = parseQuery(pageSchema, req.query);
  const params = [];
  let where = '';
  if (q) {
    params.push(likePattern(q));
    where = `WHERE h.name ILIKE $1 OR EXISTS (
      SELECT 1 FROM household_members m JOIN users mu ON mu.id = m.user_id
      WHERE m.household_id = h.id AND mu.email ILIKE $1)`;
    if (/^\d+$/.test(q)) {
      params.push(Number(q));
      where += ` OR h.id = $2`;
    }
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT h.id, h.name,
            (SELECT count(*) FROM household_members m WHERE m.household_id = h.id) AS member_count,
            (SELECT u.email FROM household_members m JOIN users u ON u.id = m.user_id
              WHERE m.household_id = h.id AND m.role = 'owner'
              ORDER BY m.joined_at, m.user_id LIMIT 1) AS owner_email
     FROM households h ${where}
     ORDER BY h.id LIMIT $${params.length}`,
    params,
  );
  res.json({
    households: rows.map((h) => ({
      id: Number(h.id),
      name: h.name,
      memberCount: Number(h.member_count ?? 0),
      ownerEmail: h.owner_email ?? null,
    })),
  });
});

/* -------------------------------------------------------------------------- */
/* Devices                                                                    */
/* -------------------------------------------------------------------------- */

const devicesQuerySchema = pageSchema.extend({
  status: z.enum(['online', 'offline', 'unclaimed']).optional(),
});

adminRouter.get('/devices', async (req, res) => {
  const { q, status, limit, offset } = parseQuery(devicesQuerySchema, req.query);
  const conditions = [];
  const params = [];
  if (q) {
    params.push(likePattern(q));
    const p = `$${params.length}`;
    conditions.push(
      `(d.device_id ILIKE ${p} OR d.friendly_name ILIKE ${p} OR h.name ILIKE ${p} OR ou.email ILIKE ${p})`,
    );
  }
  // "Online" is the live socket registry (the source of truth), not the
  // devices.is_online flag, which lags on crashes/restarts.
  if (status === 'online' || status === 'offline') {
    params.push(getOnlineDeviceIds());
    conditions.push(
      status === 'online'
        ? `d.device_id = ANY($${params.length}::text[])`
        : `NOT (d.device_id = ANY($${params.length}::text[]))`,
    );
  } else if (status === 'unclaimed') {
    conditions.push('d.household_id IS NULL');
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const from = `FROM devices d
     LEFT JOIN households h ON h.id = d.household_id
     LEFT JOIN users ou ON ou.id = d.owner_user_id`;

  const n = params.length;
  const [{ rows }, { rows: total }] = await Promise.all([
    pool.query(
      `SELECT d.device_id, d.friendly_name, d.household_id, h.name AS household_name,
              ou.email AS owner_email, d.is_online, d.last_seen_at, d.last_connected_at, d.diagnostics,
              (SELECT count(*) FROM device_switches s
                WHERE s.device_id = d.device_id AND s.channel_idx < $${n + 1}) AS switch_count
       ${from} ${where}
       ORDER BY d.device_id
       LIMIT $${n + 2} OFFSET $${n + 3}`,
      [...params, DEFAULT_CHANNEL_COUNT, limit, offset],
    ),
    pool.query(`SELECT count(*) AS n ${from} ${where}`, params),
  ]);
  res.json({
    devices: rows.map((d) => ({
      deviceId: d.device_id,
      friendlyName: d.friendly_name,
      householdId: d.household_id == null ? null : Number(d.household_id),
      householdName: d.household_name ?? null,
      ownerEmail: d.owner_email ?? null,
      online: isDeviceOnline(d.device_id),
      isOnlineFlag: d.is_online === true,
      lastSeenAt: d.last_seen_at,
      lastConnectedAt: d.last_connected_at ?? null,
      diagnostics: d.diagnostics ?? null,
      switchCount: Number(d.switch_count ?? 0),
    })),
    total: Number(total[0]?.n ?? 0),
  });
});

async function lockDevice(client, deviceId) {
  const { rows } = await client.query(
    'SELECT device_id, household_id, owner_user_id FROM devices WHERE device_id = $1 FOR UPDATE',
    [deviceId],
  );
  if (!rows[0]) {
    throw new HttpError(404, 'device not found');
  }
  return rows[0];
}

/** Removes the device from its household (same as an owner's unclaim),
 * disabling its schedules so they stop firing on an ownerless device. The
 * device's secret is kept: whoever claims it next still needs it. */
adminRouter.post('/devices/:id/unclaim', async (req, res) => {
  const deviceId = req.params.id;
  await inTransaction(async (client) => {
    const device = await lockDevice(client, deviceId);
    if (device.household_id == null) {
      throw new HttpError(409, 'device is not claimed');
    }
    await client.query('UPDATE device_schedules SET enabled = false WHERE device_id = $1', [deviceId]);
    await client.query(
      'UPDATE devices SET owner_user_id = NULL, household_id = NULL WHERE device_id = $1',
      [deviceId],
    );
    await audit(client, req, 'device.unclaim', 'device', deviceId, {
      previousHouseholdId: Number(device.household_id),
      previousOwnerUserId: device.owner_user_id == null ? null : Number(device.owner_user_id),
    });
  });
  res.json({ deviceId, householdId: null });
});

const reassignSchema = z.object({ householdId: z.number().int().positive() });

/** Moves the device to another household; owner_user_id becomes that
 * household's earliest-joined owner. Schedules made by the previous
 * household are disabled (not deleted) so they don't fire in someone
 * else's home. */
adminRouter.post('/devices/:id/reassign', async (req, res) => {
  const deviceId = req.params.id;
  const { householdId } = parseBody(reassignSchema, req.body);
  const result = await inTransaction(async (client) => {
    const device = await lockDevice(client, deviceId);
    const { rows: households } = await client.query('SELECT id, name FROM households WHERE id = $1', [
      householdId,
    ]);
    if (!households[0]) {
      throw new HttpError(404, 'household not found');
    }
    if (device.household_id != null && Number(device.household_id) === householdId) {
      throw new HttpError(409, 'device already belongs to that household');
    }
    const { rows: owners } = await client.query(
      `SELECT user_id FROM household_members
       WHERE household_id = $1 AND role = 'owner'
       ORDER BY joined_at, user_id LIMIT 1`,
      [householdId],
    );
    if (!owners[0]) {
      throw new HttpError(409, 'household has no owner');
    }
    const ownerUserId = Number(owners[0].user_id);
    await client.query('UPDATE device_schedules SET enabled = false WHERE device_id = $1', [deviceId]);
    await client.query('UPDATE devices SET household_id = $1, owner_user_id = $2 WHERE device_id = $3', [
      householdId,
      ownerUserId,
      deviceId,
    ]);
    await audit(client, req, 'device.reassign', 'device', deviceId, {
      fromHouseholdId: device.household_id == null ? null : Number(device.household_id),
      toHouseholdId: householdId,
      ownerUserId,
    });
    return { householdName: households[0].name, ownerUserId };
  });
  res.json({ deviceId, householdId, ...result });
});

/**
 * Clears the stored secret hash and drops the device's live socket. On its
 * next connect (seconds later — the firmware reconnects on any close) the
 * device re-pairs with whatever secret it presents (ws/deviceServer.js
 * authenticateDevice). This is the recovery for "device was factory-reset
 * and generated a new secret", which used to need manual SQL. Household and
 * owner are unchanged. Until it reconnects, the first connection presenting
 * this device id wins — same trust-on-first-use window as a brand-new device.
 */
adminRouter.post('/devices/:id/reset-secret', async (req, res) => {
  const deviceId = req.params.id;
  await inTransaction(async (client) => {
    await lockDevice(client, deviceId);
    await client.query('UPDATE devices SET cloud_secret_hash = NULL WHERE device_id = $1', [deviceId]);
    await audit(client, req, 'device.reset_secret', 'device', deviceId, null);
  });
  const disconnected = disconnectDevice(deviceId, 4000, 'secret reset');
  res.json({ deviceId, disconnected });
});

/* -------------------------------------------------------------------------- */
/* Activity (read-only, all households)                                       */
/* -------------------------------------------------------------------------- */

adminRouter.get('/activity', async (req, res) => {
  const { limit, before } = parseQuery(cursorSchema, req.query);
  const params = [];
  let where = '';
  if (before !== undefined) {
    params.push(before);
    where = 'WHERE a.id < $1';
  }
  params.push(limit);
  // Ordered by id (monotonic with insert time) so the id cursor is exact.
  const { rows } = await pool.query(
    `SELECT a.id, a.household_id AS "householdId", h.name AS "householdName",
            a.device_id AS "deviceId", d.friendly_name AS "deviceFriendlyName",
            a.channel_idx AS "channelIdx", a.state, a.source,
            u.email AS "actorEmail", a.automation_id AS "automationId", a.created_at AS "createdAt"
     FROM activity_log a
     LEFT JOIN households h ON h.id = a.household_id
     LEFT JOIN devices d ON d.device_id = a.device_id
     LEFT JOIN users u ON u.id = a.actor_user_id
     ${where}
     ORDER BY a.id DESC
     LIMIT $${params.length}`,
    params,
  );
  res.json({ entries: rows, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null });
});

/* -------------------------------------------------------------------------- */
/* API keys                                                                   */
/* -------------------------------------------------------------------------- */

adminRouter.get('/api-keys', async (req, res) => {
  const { q, limit, offset } = parseQuery(pageSchema, req.query);
  const params = [];
  let where = 'WHERE k.revoked_at IS NULL';
  if (q) {
    params.push(likePattern(q));
    where += ` AND (u.email ILIKE $1 OR k.name ILIKE $1 OR k.prefix ILIKE $1)`;
  }
  const from = 'FROM api_keys k JOIN users u ON u.id = k.user_id';
  const n = params.length;
  const [{ rows }, { rows: total }] = await Promise.all([
    pool.query(
      `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.user_id,
              u.email AS user_email, u.disabled_at AS user_disabled_at,
              (SELECT count(*) FROM switch_hooks h WHERE h.api_key_id = k.id AND h.revoked_at IS NULL) AS hook_count
       ${from} ${where}
       ORDER BY k.created_at DESC, k.id DESC
       LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...params, limit, offset],
    ),
    pool.query(`SELECT count(*) AS n ${from} ${where}`, params),
  ]);
  res.json({
    apiKeys: rows.map((k) => ({
      id: Number(k.id),
      name: k.name,
      prefix: k.prefix,
      userId: Number(k.user_id),
      userEmail: k.user_email,
      userDisabled: k.user_disabled_at != null,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      hookCount: Number(k.hook_count ?? 0),
    })),
    total: Number(total[0]?.n ?? 0),
  });
});

adminRouter.delete('/api-keys/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new HttpError(404, 'api key not found');
  }
  await inTransaction(async (client) => {
    const revoked = await revokeApiKeyWithHooks(client, id);
    if (!revoked) {
      throw new HttpError(404, 'api key not found');
    }
    await audit(client, req, 'api_key.revoke', 'api_key', id, {
      name: revoked.name,
      prefix: revoked.prefix,
      userId: Number(revoked.user_id),
    });
  });
  res.status(204).end();
});

/* -------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* -------------------------------------------------------------------------- */

adminRouter.get('/audit', async (req, res) => {
  const { limit, before } = parseQuery(cursorSchema, req.query);
  const params = [];
  let where = '';
  if (before !== undefined) {
    params.push(before);
    where = 'WHERE id < $1';
  }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT id, admin_user_id AS "adminUserId", admin_email AS "adminEmail", action,
            target_type AS "targetType", target_id AS "targetId", details, created_at AS "createdAt"
     FROM admin_audit_log
     ${where}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params,
  );
  res.json({ entries: rows, nextCursor: rows.length === limit ? rows[rows.length - 1].id : null });
});

// eslint-disable-next-line no-unused-vars
adminRouter.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  return next(err);
});
