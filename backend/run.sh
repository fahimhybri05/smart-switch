#!/usr/bin/env bash
# Runs the backend bound to all interfaces so devices/app on the LAN can
# reach it (Node's default listen() already binds 0.0.0.0 — this script
# just loads .env and prints the LAN URL to hit).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -f .env ]; then
  echo ".env not found — copy .env.example to .env and fill in DATABASE_URL/JWT_SECRET first." >&2
  exit 1
fi

set -a
source .env
set +a

port="${PORT:-3000}"
lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo "smart-switch-backend starting on port ${port}"
if [ -n "${lan_ip:-}" ]; then
  echo "reachable on the LAN at: http://${lan_ip}:${port}"
fi

exec node src/server.js
