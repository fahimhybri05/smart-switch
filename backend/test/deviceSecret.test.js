import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashDeviceSecret } from '../src/auth/deviceSecret.js';

test('hashDeviceSecret is deterministic for the same input', () => {
  assert.equal(hashDeviceSecret('abc123'), hashDeviceSecret('abc123'));
});

test('hashDeviceSecret differs for different input', () => {
  assert.notEqual(hashDeviceSecret('abc123'), hashDeviceSecret('abc124'));
});

test('hashDeviceSecret returns a 64-char hex sha256 digest', () => {
  const hash = hashDeviceSecret('anything');
  assert.match(hash, /^[0-9a-f]{64}$/);
});
