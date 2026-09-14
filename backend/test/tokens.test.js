import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';

const { signAccessToken, verifyAccessToken } = await import(
  '../src/auth/tokens.js'
);

test('signAccessToken produces a token verifyAccessToken can decode back to the same user', () => {
  const token = signAccessToken(42);
  const payload = verifyAccessToken(token);
  assert.equal(payload.sub, '42');
});

test('verifyAccessToken rejects a tampered token', () => {
  const token = signAccessToken(1);
  const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
  assert.throws(() => verifyAccessToken(tampered));
});

test('verifyAccessToken rejects a token signed with a different secret', () => {
  const token = signAccessToken(1);
  process.env.JWT_SECRET = 'a-different-secret';
  assert.throws(() => verifyAccessToken(token));
  process.env.JWT_SECRET = 'test-secret-only-used-in-this-suite';
});
