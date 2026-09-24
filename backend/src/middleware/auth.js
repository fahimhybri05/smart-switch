import { verifyAccessToken } from '../auth/tokens.js';

/** Requires a valid `Authorization: Bearer <access token>` header, attaches `req.userId`. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing bearer token' });
  }
  const token = header.slice('Bearer '.length);
  // API keys only work on the public /v1 API — never on account/management
  // routes (a leaked key must not be able to change the password, mint
  // more keys, etc.). jwt.verify would reject one anyway; this just makes
  // the reason explicit.
  if (token.startsWith('sk_')) {
    return res.status(401).json({ error: 'API keys are only accepted on /v1' });
  }
  try {
    const payload = verifyAccessToken(token);
    req.userId = Number(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}
