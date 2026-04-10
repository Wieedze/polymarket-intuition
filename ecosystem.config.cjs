module.exports = {
  apps: [
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
    {
      name: 'auto-trader',
      script: 'node_modules/.bin/tsx',
      args: 'scripts/auto-trader.ts',
      cwd: '/opt/polymarket-intuition',
      env: {
        POLL_INTERVAL_MS: '300000',  // 5 min
        BET_SIZE_USDC: '100',
        MAX_OPEN_TRADES: '50',
        STOP_LOSS: '0.40',
        STALE_DAYS: '7',
      },
      restart_delay: 10000,
      max_restarts: 50,
      autorestart: true,
    },
    {
      name: 'live-trader',
      interpreter: '/bin/bash',
      script: 'scripts/run-live-bot.sh',
      cwd: '/opt/polymarket-intuition',
      env: {
        DB_PATH: '/opt/polymarket-intuition/data/live.db',
        SHARED_DB_PATH: '/opt/polymarket-intuition/data/polymarket.db',
        STARTING_BALANCE: '9',
        POLL_INTERVAL_MS: '60000',     // 1 min — faster than paper for live
        MIN_SIGNAL_SCORE_LIVE: '65',   // stricter than paper
        DRY_RUN: 'false',             // REAL orders
      },
      restart_delay: 15000,
      max_restarts: 50,
      autorestart: true,
    },
  ],
}
