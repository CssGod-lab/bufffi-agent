#!/bin/bash
# BuffFi Trading Agent launcher
# Reads private key from wallet, exports config, runs agent

set -e
cd "$(dirname "$0")"

WALLET_FILE="../.wallet/key.json"
SESSION_FILE="../.wallet/bufffi-session.json"
AGENT_ID="cssgod-9b1cff8b-8d69-42a7-b0f6-d4570dceadf1"
SERVER_URL="https://alpha.cssgod.io"
CONTROL_PORT=18803
PIDFILE="$(pwd)/agent.pid"

if [ ! -f "$WALLET_FILE" ]; then
  echo "[ERROR] No wallet found at $WALLET_FILE"
  exit 1
fi

# Kill any stale agent processes before starting
STALE_PIDS=$(pgrep -f "node standalone-agent.js" 2>/dev/null || true)
if [ -n "$STALE_PIDS" ]; then
  echo "[INIT] Killing stale agent process(es): $STALE_PIDS"
  echo "$STALE_PIDS" | xargs kill 2>/dev/null || true
  sleep 2
fi

# Clean stale pidfile (JS handles singleton guard itself)
rm -f "$PIDFILE"

# Extract private key
PRIVATE_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$WALLET_FILE','utf8')).privateKey)")

# Re-auth if needed, then fetch latest policy config
echo "[INIT] Fetching latest policy config..."
COOKIE=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('$SESSION_FILE','utf8'));console.log(d.cookie||'')}catch{console.log('')}")

POLICY_ID=${POLICY_ID:-75}
echo "[INIT] Using policy P${POLICY_ID}"
CONFIG=$(curl -s -H "X-Agent-ID: $AGENT_ID" -H "Cookie: $COOKIE" "$SERVER_URL/agents/policies/${POLICY_ID}/export")

# Check if we got valid JSON
if echo "$CONFIG" | node -e "process.stdin.on('data',d=>{try{JSON.parse(d);process.exit(0)}catch{process.exit(1)}})" 2>/dev/null; then
  echo "$CONFIG" > agent-config.json
  echo "[INIT] Config saved."
else
  echo "[WARN] Config export failed (auth expired?). Re-authenticating..."
  cd .. && node scripts/bufffi_auth.mjs 2>&1 | tail -1
  # Re-read new cookie
  cd bufffi-agent
  COOKIE=$(node -e "try{const d=JSON.parse(require('fs').readFileSync('$SESSION_FILE','utf8'));console.log(d.cookie||'')}catch{console.log('')}")
  CONFIG=$(curl -s -H "X-Agent-ID: $AGENT_ID" -H "Cookie: $COOKIE" "$SERVER_URL/agents/policies/${POLICY_ID}/export")
  echo "$CONFIG" > agent-config.json
  echo "[INIT] Config saved after re-auth."
fi

echo "[INIT] Starting agent..."

# Run the standalone agent
# exec replaces this shell, inheriting the PID written to pidfile
exec env \
  PRIVATE_KEY="$PRIVATE_KEY" \
  SERVER_URL="$SERVER_URL" \
  CONFIG_PATH="$(pwd)/agent-config.json" \
  CONTROL_PORT=$CONTROL_PORT \
  PIDFILE="$PIDFILE" \
  node standalone-agent.js
