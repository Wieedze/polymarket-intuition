#!/bin/bash
# run-live-bot.sh — loads secrets then runs live-trader
set -euo pipefail

cd /opt/polymarket-intuition

# Load bot credentials
if [ -f "secrets/bot-1.env" ]; then
  set -a
  source secrets/bot-1.env
  set +a
  echo "✅ Loaded secrets/bot-1.env"
else
  echo "❌ secrets/bot-1.env not found"
  exit 1
fi

# Run live trader
exec node_modules/.bin/tsx scripts/live-trader.ts
