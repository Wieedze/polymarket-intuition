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

# Run bot (defaults to live-trader, override with BOT_SCRIPT env)
SCRIPT="${BOT_SCRIPT:-scripts/live-trader.ts}"
echo "🚀 Starting: $SCRIPT"
exec node_modules/.bin/tsx "$SCRIPT"
