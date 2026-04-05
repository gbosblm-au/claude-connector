#!/usr/bin/env bash
# start-cloudflare-tunnel.sh
# Alternative to ngrok: uses Cloudflare Tunnel (cloudflared) to expose the server.
# Cloudflare Tunnel is free, has no bandwidth limits, and does not require an account
# for one-off quick tunnels (though a free Cloudflare account gives you a stable URL).
#
# Prerequisites:
#   macOS:   brew install cloudflare/cloudflare/cloudflared
#   Windows: winget install --id Cloudflare.cloudflared
#   Linux:   https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f ".env" ]]; then
  export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi

PORT="${PORT:-3000}"

echo ""
echo "=================================================="
echo "  claude-connector  -  Cloudflare Tunnel Launcher"
echo "=================================================="
echo ""

if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed."; exit 1
fi

if ! command -v cloudflared &>/dev/null; then
  echo "ERROR: cloudflared is not installed."
  echo ""
  echo "Install cloudflared:"
  echo "  macOS:   brew install cloudflare/cloudflare/cloudflared"
  echo "  Windows: winget install --id Cloudflare.cloudflared"
  echo "  Linux:   See https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
  exit 1
fi

echo "Starting claude-connector HTTP server on port $PORT..."
node src/server-http.js &
SERVER_PID=$!
sleep 2

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "ERROR: Server failed to start."; exit 1
fi

echo "Server running (PID: $SERVER_PID)"
echo ""
echo "Starting Cloudflare Tunnel (quick tunnel - temporary URL)..."
echo ""

cloudflared tunnel --url "http://localhost:$PORT" 2>&1 &
CF_PID=$!

sleep 5

echo ""
echo "=================================================="
echo "  Look above for a line like:"
echo "    Your quick Tunnel has been created! Visit it at (it may take some time to be reachable)"
echo "    https://xxxx-xxxx-xxxx.trycloudflare.com"
echo ""
echo "  Your MCP endpoint will be: https://xxxx-xxxx-xxxx.trycloudflare.com/mcp"
echo ""
echo "  Add that URL to Claude.ai:"
echo "    Settings > Connectors > Add custom connector"
echo ""
echo "  Press Ctrl+C to stop."
echo "=================================================="
echo ""

trap "kill $SERVER_PID $CF_PID 2>/dev/null; exit 0" SIGINT SIGTERM
wait
