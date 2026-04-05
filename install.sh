#!/usr/bin/env bash
# install.sh - Sets up claude-connector for first use

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "=============================================="
echo "  claude-connector  -  Installation Script"
echo "=============================================="
echo ""

# Check Node version
NODE_VERSION=$(node --version 2>/dev/null || echo "not found")
if [[ "$NODE_VERSION" == "not found" ]]; then
  echo "ERROR: Node.js is not installed."
  echo "Please install Node.js 18 or later from https://nodejs.org"
  exit 1
fi

MAJOR=$(echo "$NODE_VERSION" | sed 's/v\([0-9]*\).*/\1/')
if [[ "$MAJOR" -lt 18 ]]; then
  echo "ERROR: Node.js $NODE_VERSION is too old. Node.js 18+ is required."
  exit 1
fi

echo "Node.js $NODE_VERSION detected."

# Install dependencies
echo ""
echo "Installing npm dependencies..."
npm install

# Set up .env
if [[ ! -f ".env" ]]; then
  cp .env.example .env
  echo ""
  echo "Created .env from .env.example."
  echo "IMPORTANT: Open .env and fill in your API keys before using the connector."
else
  echo ".env already exists, skipping."
fi

echo ""
echo "=============================================="
echo "  Installation complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo ""
echo "  1. Edit .env and add your API keys:"
echo "       BRAVE_API_KEY  - https://brave.com/search/api/"
echo "       (or TAVILY_API_KEY - https://app.tavily.com)"
echo ""
echo "  2. Export your LinkedIn connections:"
echo "       LinkedIn > Me > Settings & Privacy > Data Privacy"
echo "       > Get a copy of your data > Connections"
echo "       Copy Connections.csv to: $(pwd)/data/connections.csv"
echo ""
echo "  3. Edit data/profile.json with your LinkedIn profile details"
echo ""
echo "  4. Configure Claude Desktop (see README.md for the config snippet)"
echo ""
echo "  5. Restart Claude Desktop"
echo ""
