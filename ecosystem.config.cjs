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
        WALLET_ADDRESS: '0x1acC2880Cca00f61C41eb2b436C4f7D2d09a2fEC',
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
        POLL_INTERVAL_MS: '15000',       // 15s — fast expert position detection
        MIN_SIGNAL_SCORE_LIVE: '65',     // raised from 50 — 20% WR on longshot YES forced tightening
        MAX_ENTRY_PRICE: '0.35',        // YES cap — only emit YES signals <= 35¢ (2:1+ payoff)
        NO_MAX_ENTRY_PRICE: '0.80',     // NO cap — widened from 0.70 to capture high-WR fade-favorite plays (e.g. swisstony 87% WR @ 70¢+ NO)
        NO_HIGH_PRICE_MIN_SCORE: '65',  // lowered from 70 — catch more 50-70¢ NO signals from calibrated experts
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
        MIN_SIGNAL_SCORE_LIVE: '65',     // raised from 50 — filter longshot YES losers
        MAX_ENTRY_PRICE: '0.35',        // YES cap — force 2:1+ payoff ratio
        NO_MAX_ENTRY_PRICE: '0.80',     // NO cap — widened from 0.70 to match scanner
        BET_PCT: '0.05',                // 5% of cash per bet (enables 15-share min at 35c)
        STOP_LOSS: '0.50',              // -50% stop-loss (was -40%)
        FOLLOW_EXPERT_EXIT: 'false',    // don't force-sell when expert exits (they market-make too fast)
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
