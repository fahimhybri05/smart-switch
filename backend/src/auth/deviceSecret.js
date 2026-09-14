import crypto from 'node:crypto';

// Machine-generated random secrets (not user passwords) — a fast
// deterministic hash is appropriate here, same reasoning as the
// firmware's own auth_password_hash (plain SHA-256, not bcrypt).
export function hashDeviceSecret(rawSecret) {
  return crypto.createHash('sha256').update(rawSecret).digest('hex');
}
