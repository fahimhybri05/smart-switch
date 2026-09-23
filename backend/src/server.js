import 'dotenv/config';
import http from 'node:http';

import { WebSocketServer } from 'ws';

import { createApp } from './app.js';
import { startAutomationScheduler, waitForCurrentTick } from './automations/scheduler.js';
import { pool } from './db/pool.js';
import {
  startDeviceScheduler,
  waitForCurrentDeviceScheduleTick,
} from './deviceSchedules/scheduler.js';
import {
  authenticateClientUpgrade,
  handleClientConnection,
} from './ws/clientServer.js';
import { handleDeviceConnection, startDeviceHeartbeat } from './ws/deviceServer.js';

// Last-resort safety net: express-async-errors (wired in app.js) forwards
// rejected Express route-handler promises to the error-handling middleware,
// but that doesn't cover everything (e.g. a rejection inside a setInterval
// callback nothing awaits). Without a handler here, Node terminates this
// entire single-instance process on any such rejection — every customer's
// connection dropped over one bad request. Log and keep running instead;
// the process may be left in a slightly inconsistent state, but that beats
// crashing the whole service.
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaught exception', err);
});

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

// No express-rate-limit equivalent applies to raw WS upgrades (that
// package is Express-request-shaped only), and unlimited concurrent
// connections from one source is a cheap denial-of-service vector against
// both WS servers. Simple in-memory per-IP cap, matching this codebase's
// existing style of small in-memory Maps (ws/registry.js) rather than
// pulling in a new dependency.
const MAX_CONNECTIONS_PER_IP = 20;
const connectionCountsByIp = new Map();

function incrementIpConnections(ip) {
  connectionCountsByIp.set(ip, (connectionCountsByIp.get(ip) ?? 0) + 1);
}

function decrementIpConnections(ip) {
  const count = connectionCountsByIp.get(ip);
  if (count === undefined) return;
  if (count <= 1) {
    connectionCountsByIp.delete(ip);
  } else {
    connectionCountsByIp.set(ip, count - 1);
  }
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://internal');
  const ip = req.socket.remoteAddress ?? 'unknown';

  if (pathname !== '/device' && pathname !== '/ws') {
    socket.destroy();
    return;
  }

  if ((connectionCountsByIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  if (pathname === '/device') {
    deviceWss.handleUpgrade(req, socket, head, (ws) => {
      incrementIpConnections(ip);
      ws.on('close', () => decrementIpConnections(ip));
      deviceWss.emit('connection', ws, req);
    });
    return;
  }

  // pathname === '/ws'
  const userId = authenticateClientUpgrade(req.url);
  if (!userId) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  clientWss.handleUpgrade(req, socket, head, (ws) => {
    incrementIpConnections(ip);
    ws.on('close', () => decrementIpConnections(ip));
    clientWss.emit('connection', ws, req, userId);
  });
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
const stopDeviceScheduler = startDeviceScheduler();
const deviceHeartbeatInterval = startDeviceHeartbeat();

// Lets `systemctl restart`/`stop` (or a plain Ctrl-C) close cleanly instead
// of yanking the DB pool and every open device/client WS out from under
// in-flight requests — device firmware just reconnects on its own
// (cloud_client's reconnect-with-backoff), same as any other disconnect.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  stopAutomationScheduler();
  stopDeviceScheduler();
  clearInterval(deviceHeartbeatInterval);

  const forceExitTimer = setTimeout(() => {
    console.error('shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);

  // Give an in-flight scheduler tick (which may be mid RELAY_RETRY_DELAY_MS
  // sleep inside fireAutomation/fireDeviceSchedule) a bounded chance to
  // actually relay its commands before the device sockets it needs go away
  // — otherwise a just-fired automation/device-schedule action is silently
  // dropped on every deploy. The existing 10s forceExitTimer above remains
  // the ultimate backstop.
  await Promise.race([
    Promise.all([waitForCurrentTick(), waitForCurrentDeviceScheduleTick()]),
    sleep(5000),
  ]);

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
