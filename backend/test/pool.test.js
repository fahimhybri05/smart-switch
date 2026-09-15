import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

test('pool has explicit sizing/timeout tuning and a default max of 20', async () => {
  delete process.env.DB_POOL_MAX;
  const { pool } = await import(`../src/db/pool.js?case=default`);
  assert.equal(pool.options.max, 20);
  assert.equal(pool.options.idleTimeoutMillis, 30_000);
  assert.equal(pool.options.connectionTimeoutMillis, 5_000);
  await pool.end();
});

test('pool respects DB_POOL_MAX when set', async () => {
  process.env.DB_POOL_MAX = '7';
  const { pool } = await import(`../src/db/pool.js?case=custom`);
  assert.equal(pool.options.max, 7);
  delete process.env.DB_POOL_MAX;
  await pool.end();
});

test('pool has an error listener so an idle-client error cannot crash the process', async () => {
  const { pool } = await import(`../src/db/pool.js?case=error-listener`);
  assert.ok(pool.listenerCount('error') > 0);
  await pool.end();
});
