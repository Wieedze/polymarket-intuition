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
      // Build first: npx next build
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
  ],
}
