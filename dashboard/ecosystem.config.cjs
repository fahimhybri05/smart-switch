/**
 * pm2 process file for the Smart Control dashboard.
 *
 *   cd dashboard && npm ci && npm run build
 *   pm2 start ecosystem.config.cjs && pm2 save
 *
 * MUST stay a single instance in fork mode: the BFF's refresh single-flight
 * + 30 s grace cache (lib/server/session.ts) is per-process memory. With
 * several instances, parallel refreshes could hit different processes and
 * the backend's single-use refresh tokens would log users out.
 */
module.exports = {
  apps: [
    {
      name: 'smart-control-dashboard',
      cwd: __dirname,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -H 127.0.0.1 -p 3001',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
};
