#!/bin/bash
# Deploy Polymarket Paper Trader on a fresh Ubuntu VPS
# Usage: ssh root@YOUR_IP 'bash -s' < deploy.sh

set -e

echo "═══════════════════════════════════════════════"
echo "  POLYMARKET PAPER TRADER — DEPLOY"
echo "═══════════════════════════════════════════════"

# 1. System deps
echo "[1/6] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git build-essential python3

# 2. Node.js 22
echo "[2/6] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

# 3. PM2
echo "[3/6] Installing PM2..."
npm install -g pm2

# 4. Clone repo
echo "[4/6] Cloning repo..."
cd /opt
if [ -d "polymarket-intuition" ]; then
  cd polymarket-intuition
  git pull
else
  git clone https://github.com/YOUR_USERNAME/polymarket-intuition.git
  cd polymarket-intuition
fi

# 5. Install deps
echo "[5/6] Installing npm dependencies..."
npm install
npm rebuild better-sqlite3

# 6. Create data dir
mkdir -p data
chmod 777 data

echo ""
echo "═══════════════════════════════════════════════"
echo "  INSTALL COMPLETE"
echo "═══════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo ""
echo "  1. Copy your .env.local:"
echo "     scp .env.local root@YOUR_IP:/opt/polymarket-intuition/"
echo ""
echo "  2. Bulk index wallets:"
echo "     cd /opt/polymarket-intuition"
echo "     npx tsx scripts/bulk-index.ts 20 MONTH --watch"
echo "     npx tsx scripts/bulk-index-all.ts 10 MONTH --watch"
echo ""
echo "  3. Start services with PM2:"
echo "     pm2 start ecosystem.config.cjs"
echo "     pm2 save"
echo "     pm2 startup"
echo ""
echo "  4. Check status:"
echo "     pm2 status"
echo "     pm2 logs auto-trader"
echo "     pm2 logs nextjs"
echo ""
