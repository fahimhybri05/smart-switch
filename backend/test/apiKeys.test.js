import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { pool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/app.js');
const { generateApiKey, generateHookToken, hashSecret, looksLikeApiKey } = await import(
  '../src/auth/apiKeys.js'
);
const { signAccessToken } = await import('../src/auth/tokens.js');

const USER_ID = 7;
const JWT = signAccessToken(USER_ID);

function mockDb({ capReached = false, keyExists = true } = {}) {
  const calls = [];
  const handlers = [
    ['INSERT INTO api_keys', (p) =>
      capReached ? [] : [{ id: 11, name: p[1], prefix: p[2], created_at: new Date(), last_used_at: null }]],
    ['FROM api_keys k', () => [
      { id: 11, name: 'HA', prefix: 'sk_abcdefgh', created_at: new Date(), last_used_at: null, hook_count: '2' },
    ]],
    ['UPDATE api_keys SET revoked_at', () => (keyExists ? [{ id: 11 }] : [])],
  ];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    for (const [needle, fn] of handlers) {
      if (sql.includes(needle)) {
        const r = await fn(params, sql);
        return Array.isArray(r) ? { rows: r, rowCount: r.length } : r;
      }
    }
    return { rows: [], rowCount: 0 };
  };
  mock.method(pool, 'query', query);
  mock.method(pool, 'connect', async () => ({ query, release() {} }));
  return calls;
}

async function start(t) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    mock.restoreAll();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, { token = JWT, body, ...init } = {}) =>
    fetch(base + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
}

test('generated secrets are prefixed base64url(32 bytes) and unique', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.match(a, /^sk_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.ok(looksLikeApiKey(a));
  assert.match(generateHookToken(), /^wh_[A-Za-z0-9_-]{43}$/);
  assert.match(hashSecret(a), /^[0-9a-f]{64}$/);
});

test('POST /api-keys returns the secret once and stores only its hash + prefix', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  const res = await call('/api-keys', { method: 'POST', body: { name: 'Home Assistant' } });
  assert.equal(res.status, 201);
  const key = await res.json();
  assert.ok(looksLikeApiKey(key.secret));
  assert.equal(key.name, 'Home Assistant');
  assert.equal(key.prefix, key.secret.slice(0, 11));
  const insert = calls.find((c) => c.sql.includes('INSERT INTO api_keys'));
  assert.deepEqual(insert.params, [USER_ID, 'Home Assistant', key.prefix, hashSecret(key.secret), 25]);
});

test('POST /api-keys validates the name and enforces the cap of 25', async (t) => {
  mockDb({ capReached: true });
  const call = await start(t);
  assert.equal((await call('/api-keys', { method: 'POST', body: { name: '' } })).status, 400);
  const res = await call('/api-keys', { method: 'POST', body: { name: 'one too many' } });
  assert.equal(res.status, 409);
});

test('GET /api-keys lists keys without any secret material', async (t) => {
  mockDb();
  const call = await start(t);
  const { apiKeys } = await (await call('/api-keys')).json();
  assert.equal(apiKeys.length, 1);
  assert.deepEqual(Object.keys(apiKeys[0]).sort(), ['createdAt', 'hookCount', 'id', 'lastUsedAt', 'name', 'prefix']);
  assert.equal(apiKeys[0].hookCount, 2);
});

test('DELETE /api-keys/:id revokes the key and its hooks in one transaction', async (t) => {
  const calls = mockDb();
  const call = await start(t);
  const res = await call('/api-keys/11', { method: 'DELETE' });
  assert.equal(res.status, 204);
  const seq = calls.map((c) => c.sql.trim().split(/\s+/).slice(0, 2).join(' '));
  assert.deepEqual(seq, ['BEGIN', 'UPDATE api_keys', 'UPDATE switch_hooks', 'COMMIT']);
  const revoke = calls.find((c) => c.sql.includes('UPDATE api_keys'));
  assert.deepEqual(revoke.params, [11, USER_ID]);
});

test('DELETE /api-keys/:id 404s (and rolls back) for an unknown or foreign key', async (t) => {
  const calls = mockDb({ keyExists: false });
  const call = await start(t);
  const res = await call('/api-keys/99', { method: 'DELETE' });
  assert.equal(res.status, 404);
  assert.ok(calls.some((c) => c.sql === 'ROLLBACK'));
  assert.ok(!calls.some((c) => c.sql.includes('UPDATE switch_hooks')));
});

test('API keys are rejected on internal (JWT) routes', async (t) => {
  mockDb();
  const call = await start(t);
  const res = await call('/api-keys', { token: generateApiKey() });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'API keys are only accepted on /v1');
});
