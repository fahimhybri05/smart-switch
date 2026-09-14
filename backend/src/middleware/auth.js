import { verifyAccessToken } from '../auth/tokens.js';

/** Requires a valid `Authorization: Bearer <access token>` header, attaches `req.userId`. */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing bearer token' });
  }
  try {
    const payload = verifyAccessToken(header.slice('Bearer '.length));
    req.userId = Number(payload.sub);
    next();
  } catch {
    res.status(401).json({ error: 'invalid or expired token' });
  }
}
