module.exports = {
  apps: [
    // ── Dashboard ────────────────────────────────────────────────
    {
      name: 'nextjs',
      script: 'node_modules/.bin/next',
      args: 'start -p 3000',
      cwd: '/opt/polymarket-intuition',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },

    // ── Signal Producers (scanners) ─────────────────────────────
    // These poll for signals and write to the `signals` table.
    // They do NOT place orders.

    {
      name: 'expert-scanner',
      interpreter: '/bin/bash',
      script: 'scripts/run-live-bot.sh',
      cwd: '/opt/polymarket-intuition',
      env: {
        DB_PATH: '/opt/polymarket-intuition/data/live.db',
        SHARED_DB_PATH: '/opt/polymarket-intuition/data/polymarket.db',
        POLL_INTERVAL_MS: '60000',       // 1 min — detect new expert positions
        MIN_SIGNAL_SCORE_LIVE: '50',     // emit signals >= 50 (aligned with paper trading)
        BOT_SCRIPT: 'scripts/expert-scanner.ts',
      },
      restart_delay: 10000,
      max_restarts: 50,
      autorestart: true,
    },
    {
      name: 'sports-scanner',
      interpreter: '/bin/bash',
      script: 'scripts/run-live-bot.sh',
      cwd: '/opt/polymarket-intuition',
      env: {
        DB_PATH: '/opt/polymarket-intuition/data/live.db',
        SHARED_DB_PATH: '/opt/polymarket-intuition/data/polymarket.db',
        POLL_INTERVAL_MS: '900000',      // 15 min signal cycle (budget: 480 req/day < 666 limit)
        SCAN_INTERVAL_MS: '3600000',     // 1h market rescan on Gamma
        ODDS_CACHE_TTL_MS: '1800000',    // 30 min cache (20k req/month budget)
        MAX_SPORTS: '5',
        ALLOWED_SPORTS: 'baseball_mlb,icehockey_nhl,basketball_nba,soccer_epl,mma_mixed_martial_arts',
        MIN_SIGNAL_SCORE_SPORTS: '50',
        BOT_SCRIPT: 'scripts/sports-scanner.ts',
      },
      restart_delay: 15000,
      max_restarts: 50,
      autorestart: true,
    },

    // ── Signal Consumer (buyer + exit manager) ──────────────────
    // Reads signals from DB, places orders, manages exits.
    // ONLY process that touches the on-chain wallet (nonce constraint).

    {
      name: 'live-trader',
      interpreter: '/bin/bash',
      script: 'scripts/run-live-bot.sh',
      cwd: '/opt/polymarket-intuition',
      env: {
        DB_PATH: '/opt/polymarket-intuition/data/live.db',
        SHARED_DB_PATH: '/opt/polymarket-intuition/data/polymarket.db',
        POLL_INTERVAL_MS: '15000',       // 15s — fast signal pickup + exit checks
        MIN_SIGNAL_SCORE_LIVE: '50',     // aligned with paper trading
        DRY_RUN: 'false',               // REAL orders
        BOT_SCRIPT: 'scripts/live-trader.ts',
      },
      restart_delay: 15000,
      max_restarts: 50,
      autorestart: true,
    },

    // ── Paper Trader (manual test tool, NOT in PM2 by default) ──
    // Uncomment to run paper trading for rule testing:
    // {
    //   name: 'auto-trader',
    //   script: 'node_modules/.bin/tsx',
    //   args: 'scripts/auto-trader.ts',
    //   cwd: '/opt/polymarket-intuition',
    //   env: {
    //     POLL_INTERVAL_MS: '300000',
    //     BET_SIZE_USDC: '100',
    //     MAX_OPEN_TRADES: '50',
    //   },
    // },
  ],
}
