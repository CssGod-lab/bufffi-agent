#!/bin/bash
# BuffFi Trading Agent launcher
# Reads private key from wallet, exports config, runs agent

set -e
cd "$(dirname "$0")"

WALLET_FILE="../.wallet/key.json"
AGENT_ID="cssgod-9b1cff8b-8d69-42a7-b0f6-d4570dceadf1"
SERVER_URL="https://alpha.cssgod.io"

if [ ! -f "$WALLET_FILE" ]; then
  echo "[ERROR] No wallet found at $WALLET_FILE"
  exit 1
fi

# Extract private key
PRIVATE_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WALLET_FILE','utf8')).privateKey)")

# Fetch latest policy config from server
echo "[INIT] Fetching latest policy config..."
COOKIE=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('../.wallet/bufffi-session.json','utf8'));console.log(d.cookie||'')}catch{console.log('')}")

curl -s -H "X-Agent-ID: $AGENT_ID" \
  -H "Cookie: $COOKIE" \
  "$SERVER_URL/agents/policies/52/export" > agent-config.json

echo "[INIT] Config saved. Starting agent..."

# Run the standalone agent
exec env \
  PRIVATE_KEY="$PRIVATE_KEY" \
  SERVER_URL="$SERVER_URL" \
  CONFIG_PATH="$(pwd)/agent-config.json" \
  CONTROL_PORT=18802 \
  node standalone-agent.js
