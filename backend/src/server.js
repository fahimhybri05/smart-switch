import 'dotenv/config';
import http from 'node:http';

import { WebSocketServer } from 'ws';

import { createApp } from './app.js';
import { startAutomationScheduler } from './automations/scheduler.js';
import { pool } from './db/pool.js';
import {
  authenticateClientUpgrade,
  handleClientConnection,
} from './ws/clientServer.js';
import { handleDeviceConnection, startDeviceHeartbeat } from './ws/deviceServer.js';

const app = createApp();
const server = http.createServer(app);

// Two independent WebSocket servers sharing one HTTP server, dispatched by
// URL path on upgrade — see docs/plan.md's two connection classes (device
// tunnels vs. app/dashboard clients).
const deviceWss = new WebSocketServer({ noServer: true });
deviceWss.on('connection', handleDeviceConnection);

const clientWss = new WebSocketServer({ noServer: true });
clientWss.on('connection', (ws, req, userId) =>
  handleClientConnection(ws, userId),
);

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://internal');

  if (pathname === '/device') {
    deviceWss.handleUpgrade(req, socket, head, (ws) =>
      deviceWss.emit('connection', ws, req),
    );
    return;
  }

  if (pathname === '/ws') {
    const userId = authenticateClientUpgrade(req.url);
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    clientWss.handleUpgrade(req, socket, head, (ws) =>
      clientWss.emit('connection', ws, req, userId),
    );
    return;
  }

  socket.destroy();
});

// Safe at cold start only: the in-memory registry (ws/registry.js) is
// guaranteed empty right here — this process hasn't accepted any
// connections yet, so no device can genuinely be online yet. Closes the
// "stale is_online=true after an ungraceful crash" gap without racing a
// real device's own reconnect.
try {
  await pool.query('UPDATE devices SET is_online = false WHERE is_online = true');
} catch (err) {
  console.error('startup reconciliation failed: could not reset stale is_online flags', err);
}

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`smart-switch-backend listening on :${port}`);
});

const stopAutomationScheduler = startAutomationScheduler();
const deviceHeartbeatInterval = startDeviceHeartbeat();

// Lets `systemctl restart`/`stop` (or a plain Ctrl-C) close cleanly instead
// of yanking the DB pool and every open device/client WS out from under
// in-flight requests — device firmware just reconnects on its own
// (cloud_client's reconnect-with-backoff), same as any other disconnect.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  stopAutomationScheduler();
  clearInterval(deviceHeartbeatInterval);

  const forceExitTimer = setTimeout(() => {
    console.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);

  for (const ws of deviceWss.clients) ws.close(1001, 'server shutting down');
  for (const ws of clientWss.clients) ws.close(1001, 'server shutting down');

  server.close(async () => {
    try {
      await pool.end();
    } catch (err) {
      console.error('error closing db pool', err);
    }
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
