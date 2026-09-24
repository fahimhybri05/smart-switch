import { SwitchError } from '../switches.js';

/**
 * The one error shape of the public API: `{ error: { code, message } }`.
 * Internal routes keep their existing `{ error: '...' }` shape.
 */
export function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function v1NotFound(req, res) {
  sendError(res, 404, 'not_found', 'Not found.');
}

/** Rate-limit handler for express-rate-limit (headers are already set). */
export function v1RateLimited(req, res) {
  sendError(res, 429, 'rate_limited', 'Too many requests. Slow down and retry later.');
}

/**
 * Mounted at `/v1` (app-level, after the v1 router) so it also catches
 * errors raised before the router runs, e.g. express.json()'s parse errors.
 */
// eslint-disable-next-line no-unused-vars
export function v1ErrorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  if (err instanceof ApiError || err instanceof SwitchError) {
    return sendError(res, err.status, err.code, err.message);
  }
  if (err?.type === 'entity.parse.failed') {
    return sendError(res, 400, 'invalid_json', 'Request body is not valid JSON.');
  }
  if (err?.type === 'entity.too.large') {
    return sendError(res, 413, 'payload_too_large', 'Request body is too large.');
  }
  console.error(err);
  return sendError(res, 500, 'internal_error', 'Internal server error.');
}
