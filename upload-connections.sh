#!/usr/bin/env bash
# upload-connections.sh
# Uploads your local LinkedIn Connections.csv to a remotely deployed claude-connector.
# Use this when you've deployed to Railway, Render, Fly.io, etc. and need to push your CSV.
#
# Usage:
#   bash upload-connections.sh https://your-app.railway.app YOUR_UPLOAD_API_KEY [path/to/Connections.csv]
#
# Example:
#   bash upload-connections.sh https://my-connector.up.railway.app supersecretkey123

set -e

SERVER_URL="${1:-}"
UPLOAD_KEY="${2:-}"
CSV_PATH="${3:-$(dirname "$0")/data/connections.csv}"

if [[ -z "$SERVER_URL" || -z "$UPLOAD_KEY" ]]; then
  echo ""
  echo "Usage: bash upload-connections.sh <server-url> <upload-api-key> [csv-path]"
  echo ""
  echo "Examples:"
  echo "  bash upload-connections.sh https://my-app.railway.app mysecretkey123"
  echo "  bash upload-connections.sh https://my-app.railway.app mysecretkey123 ~/Downloads/Connections.csv"
  echo ""
  echo "The UPLOAD_API_KEY must match the UPLOAD_API_KEY env variable on your server."
  exit 1
fi

if [[ ! -f "$CSV_PATH" ]]; then
  echo "ERROR: CSV file not found at: $CSV_PATH"
  echo "Export your connections from LinkedIn first (see README.md)."
  exit 1
fi

# Strip trailing slash from URL
SERVER_URL="${SERVER_URL%/}"
UPLOAD_ENDPOINT="${SERVER_URL}/upload/connections"

CSV_SIZE=$(wc -c < "$CSV_PATH")
CSV_LINES=$(wc -l < "$CSV_PATH")

echo ""
echo "================================="
echo "  Uploading LinkedIn Connections"
echo "================================="
echo "  File:     $CSV_PATH"
echo "  Size:     $CSV_SIZE bytes"
echo "  Lines:    $CSV_LINES"
echo "  Endpoint: $UPLOAD_ENDPOINT"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$UPLOAD_ENDPOINT" \
  -H "Content-Type: text/csv" \
  -H "X-Upload-Key: $UPLOAD_KEY" \
  --data-binary "@$CSV_PATH")

HTTP_STATUS=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "  SUCCESS: $BODY"
  echo ""
  echo "  Your connections are now available on the remote server."
  echo "  In Claude, ask: 'Load my LinkedIn connections and search for...'"
else
  echo "  FAILED (HTTP $HTTP_STATUS): $BODY"
  echo ""
  echo "  Troubleshooting:"
  echo "  - Verify the server URL is correct"
  echo "  - Verify UPLOAD_API_KEY matches the server's UPLOAD_API_KEY env variable"
  echo "  - Check the server logs for more details"
  exit 1
fi
