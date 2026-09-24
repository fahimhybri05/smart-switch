import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';

const { pool } = await import('../src/db/pool.js');
const { hashDeviceSecret } = await import('../src/auth/deviceSecret.js');
const { authenticateDevice } = await import('../src/ws/deviceServer.js');

/** One-row devices table keyed by device_id, driven by SQL substring. */
function mockDevice(row) {
  const calls = [];
  mock.method(pool, 'query', async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT household_id, cloud_secret_hash FROM devices')) {
      return { rows: row ? [{ ...row }] : [] };
    }
    if (sql.includes('WHERE device_id = $1 AND household_id IS NULL')) {
      if (!row || row.household_id !== null) return { rows: [] };
      row.cloud_secret_hash = params[1];
      return { rows: [{ household_id: null }] };
    }
    if (sql.startsWith('UPDATE devices SET is_online = true')) {
      return { rows: [] };
    }
    return { rows: [] };
  });
  return calls;
}

test('unclaimed device re-flashed with a new secret is re-paired', async (t) => {
  t.after(() => mock.restoreAll());
  const row = { household_id: null, cloud_secret_hash: hashDeviceSecret('old-secret-from-before-erase') };
  const calls = mockDevice(row);

  assert.deepEqual(await authenticateDevice('esp-unclaimed', 'new-secret-after-erase'), {
    householdId: null,
  });
  const repair = calls.find((c) => c.sql.includes('household_id IS NULL'));
  assert.ok(repair, 'expected the guarded re-pair UPDATE');
  assert.equal(repair.params[1], hashDeviceSecret('new-secret-after-erase'));
  assert.equal(row.cloud_secret_hash, hashDeviceSecret('new-secret-after-erase'));
});

test('claimed device with a mismatched secret is still rejected', async (t) => {
  t.after(() => mock.restoreAll());
  const calls = mockDevice({ household_id: 17, cloud_secret_hash: hashDeviceSecret('real-secret') });

  assert.equal(await authenticateDevice('esp-claimed', 'attacker-secret'), null);
  assert.equal(
    calls.some((c) => c.sql.includes('household_id IS NULL')),
    false,
    'claimed devices must never be re-paired',
  );
});

test('re-pair loses to a concurrent claim and then validates against the stored secret', async (t) => {
  t.after(() => mock.restoreAll());
  // Row looks unclaimed on the first read, but a claim lands before the
  // guarded UPDATE runs: the UPDATE matches nothing and revalidate() sees
  // the claimed row with the old hash, so the new secret is rejected.
  let reads = 0;
  mock.method(pool, 'query', async (sql) => {
    if (sql.includes('SELECT household_id, cloud_secret_hash FROM devices')) {
      reads += 1;
      return {
        rows: [
          reads === 1
            ? { household_id: null, cloud_secret_hash: hashDeviceSecret('old') }
            : { household_id: 18, cloud_secret_hash: hashDeviceSecret('old') },
        ],
      };
    }
    return { rows: [] };
  });
  assert.equal(await authenticateDevice('esp-race', 'new'), null);
});
