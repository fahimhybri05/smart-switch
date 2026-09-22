import express from 'express';
import 'express-async-errors';

import { activityRouter } from './routes/activity.js';
import { authRouter } from './routes/auth.js';
import { automationsRouter } from './routes/automations.js';
import { devicesRouter } from './routes/devices.js';
import { groupsRouter } from './routes/groups.js';
import { householdsRouter } from './routes/households.js';

export function createApp() {
  const app = express();

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

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}
