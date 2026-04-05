#!/usr/bin/env bash
# start-tunnel.sh
# Starts the claude-connector HTTP server and exposes it publicly via ngrok.
# This is the recommended approach for using claude-connector with browser-based Claude
# without needing to deploy to a cloud host.
#
# Prerequisites:
#   1. ngrok installed: https://ngrok.com/download
#   2. ngrok account (free): https://dashboard.ngrok.com/signup
#   3. ngrok auth token configured: ngrok config add-authtoken <YOUR_TOKEN>
#   4. .env file configured with your API keys

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env
if [[ -f ".env" ]]; then
  export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi

PORT="${PORT:-3000}"

echo ""
echo "=============================================="
echo "  claude-connector  -  ngrok Tunnel Launcher"
echo "=============================================="
echo ""

# Check Node
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed."
  exit 1
fi

# Check ngrok
if ! command -v ngrok &>/dev/null; then
  echo "ERROR: ngrok is not installed."
  echo ""
  echo "Install ngrok:"
  echo "  macOS:   brew install ngrok/ngrok/ngrok"
  echo "  Windows: winget install ngrok  (or download from https://ngrok.com/download)"
  echo "  Linux:   snap install ngrok  (or download from https://ngrok.com/download)"
  echo ""
  echo "Then sign up for a free account and run:"
  echo "  ngrok config add-authtoken <YOUR_NGROK_AUTH_TOKEN>"
  exit 1
fi

# Check .env API keys
if [[ -z "$BRAVE_API_KEY" && -z "$TAVILY_API_KEY" ]]; then
  echo "WARNING: No search API key found in .env"
  echo "  Add BRAVE_API_KEY or TAVILY_API_KEY to .env before using web/news search tools."
  echo ""
fi

# Start the MCP HTTP server in the background
echo "Starting claude-connector HTTP server on port $PORT..."
node src/server-http.js &
SERVER_PID=$!

# Give it a moment to start
sleep 2

if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "ERROR: Server failed to start. Check your .env file and try again."
  exit 1
fi

echo "Server is running (PID: $SERVER_PID)"
echo ""
echo "Starting ngrok tunnel..."
echo ""

# Start ngrok and capture the public URL
ngrok http "$PORT" --log=stdout &
NGROK_PID=$!

sleep 3

# Fetch the public URL from ngrok's local API
NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tunnels'][0]['public_url'])" 2>/dev/null || echo "")

echo ""
echo "=============================================="
echo "  TUNNEL ACTIVE"
echo "=============================================="
echo ""

if [[ -n "$NGROK_URL" ]]; then
  MCP_URL="${NGROK_URL}/mcp"
  echo "  Your public MCP URL:"
  echo ""
  echo "    ${MCP_URL}"
  echo ""
  echo "  Copy this URL and add it to Claude.ai:"
  echo "    1. Go to https://claude.ai"
  echo "    2. Click your profile icon > Settings"
  echo "    3. Click 'Connectors' in the left sidebar"
  echo "    4. Click 'Add custom connector'"
  echo "    5. Paste: ${MCP_URL}"
  echo "    6. Click Add"
  echo ""
else
  echo "  Could not auto-detect ngrok URL."
  echo "  Check https://127.0.0.1:4040 for your tunnel URL."
  echo "  Your MCP endpoint is: <ngrok-url>/mcp"
  echo ""
fi

if [[ -n "$MCP_API_KEY" ]]; then
  echo "  Authentication: Bearer token required"
  echo "  (Add Authorization: Bearer \$MCP_API_KEY when testing manually)"
  echo ""
fi

echo "  ngrok dashboard: http://127.0.0.1:4040"
echo "  Press Ctrl+C to stop both the server and tunnel."
echo "=============================================="
echo ""

# Wait for either process to exit
trap "echo ''; echo 'Shutting down...'; kill $SERVER_PID $NGROK_PID 2>/dev/null; exit 0" SIGINT SIGTERM

wait
