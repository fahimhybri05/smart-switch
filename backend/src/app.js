import express from 'express';
import 'express-async-errors';

import { activityRouter } from './routes/activity.js';
import { adminRouter } from './routes/admin.js';
import { apiKeysRouter } from './routes/apiKeys.js';
import { authRouter } from './routes/auth.js';
import { automationsRouter } from './routes/automations.js';
import { devicesRouter } from './routes/devices.js';
import { groupsRouter } from './routes/groups.js';
import { hooksRouter } from './routes/hooks.js';
import { householdsRouter } from './routes/households.js';
import { createV1Router, v1ErrorHandler } from './v1/router.js';

export function createApp() {
  const app = express();

  // Behind a reverse proxy, req.ip (and so the auth rate limiter's per-IP
  // bucket) must come from X-Forwarded-For. Opt-in: trusting it when the
  // server is reachable directly would let clients spoof their IP.
  // TRUST_PROXY = number of proxy hops (e.g. 1 for a single nginx), or any
  // Express trust-proxy string — `loopback` in production, where every
  // request arrives via cloudflared or the dashboard BFF on 127.0.0.1.
  if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
  }

  // Clients (Flutter web, React dashboard) are served from a different
  // origin/port than this API, and can run from anywhere — no cookies are
  // involved (auth is a Bearer token / WS query param), so a wildcard
  // origin is safe and avoids per-deployment allowlist config.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  app.use(express.json());

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/auth', authRouter);
  app.use('/devices', devicesRouter);
  app.use('/groups', groupsRouter);
  app.use('/households', householdsRouter);
  app.use('/activity', activityRouter);
  app.use('/automations', automationsRouter);
  app.use('/api-keys', apiKeysRouter);
  app.use('/hooks', hooksRouter);
  app.use('/admin', adminRouter);

  // Public API — own auth (API keys), own error shape, own 404/500; must
  // stay ahead of the global 404/error handlers below.
  app.use('/v1', createV1Router());
  app.use('/v1', v1ErrorHandler);

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
