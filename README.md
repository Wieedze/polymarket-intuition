Indexes expert wallets, scores every signal, executes real orders via CLOB, and manages risk with Kelly sizing, partial exits, and expert trust phases.

**Two modes:**

---

## Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 14 App Router + TypeScript strict (no `any`) |
| Database | SQLite (better-sqlite3, WAL mode) — dual-DB in live mode |
| Process manager | PM2 (`auto-trader` + `live-trader` + `nextjs`) |
| Real trading | `@polymarket/clob-client` + `viem` (Polygon) |
| WebSocket | CLOB orderbook (market prices) + User WS (fill notifications) |
| Tests | Vitest |
| Deploy | VPS (Hetzner) + PM2 |

---

## Architecture

```
                    Polymarket API
                   /              \
          positions/               gamma-api/
              |                        |
     [position-tracker]          [indexer.ts]
       detect new positions      fetch resolved trades
              |                  classify by domain
              |                  compute wallet_stats
              v                        |
     [signal-scorer.ts]                |
       score 0-100                     v
       domain match             [watched_wallets]
       calibration              [wallet_stats]
       implicit edge            [copyability_score]
       entry price
              |
              v
     [expert-trust.ts]
       observation / eval / proven
       trust level 0-1.5x
              |
              v
     [Kelly sizing]
       quarter-Kelly * signal * consensus * trust
              |
     +--------+---------+
     |                   |
  [auto-trader]       [live-trader]
  paper trades        real CLOB orders (GTC)
  slippage sim        WebSocket fills
     |                   |
     v                   v
  [exit-strategy.ts]
    partial exits (100%, 150%)
    stop-loss, stale, near-resolution
    expert exit follow
              |
              v
         SQLite DB
    paper_trades, bot_events
              |
              v
      Next.js Dashboard
    equity curve, analytics
    leaderboard, settings
```

---

## Live Trading System

### Order Flow

1. **Poll** watched wallets every 60s (PM2 config) for new positions
2. **Score** each signal 0-100 via `scoreSignal()`
3. **Filter** by `MIN_SIGNAL_SCORE` (50 in code, PM2 overrides to 65 in prod)
4. **Size** bet via quarter-Kelly * multiplier stack
5. **Place GTC order** on Polymarket CLOB (5c buffer above expert price)
6. **Track fill** via User WebSocket (instant) or poll-based check (5min timeout)
7. **Manage position** via exit strategy on each poll cycle

### Safety Mechanisms

| Mechanism | Threshold | Description |
|-----------|-----------|-------------|
| Daily loss limit | 50% of starting balance | Stops all trading for the day |
| Drawdown breaker | 20% from high-water mark | Only activates after 10% growth |
| Single trade cap | 30% of available cash | `liveBetAmount = min(betAmount, cash * 0.30)` |
| Max capital deployed | 60-70% of equity | Leaves cash buffer for exits |
| Max open trades | 100 | Fixed cap, no dynamic scaling |
| Min order size | 15 shares (CLOB minimum) | Below this, order is rejected |
| GTC timeout | 5 minutes | Cancel unfilled orders automatically |

### Dual-DB Architecture

| DB | Path | Purpose |
|----|------|---------|
| Instance DB | `data/live.db` | Live trades, portfolio, pending orders |
| Shared DB | `data/polymarket.db` | Expert intelligence (wallet_stats, watched_wallets, position_snapshots) |

The paper trader (`auto-trader`) writes to both. The live trader reads expert data from shared DB, writes trades to instance DB. This prevents live trade data from contaminating paper analytics.

### WebSocket Connections

**Market WS** (`wss://ws-subscriptions-clob.polymarket.com/ws/market`)
- Subscribes per token as trades open
- Provides real-time best-bid for exit pricing
- Auto-reconnects with exponential backoff (1s to 30s)
- Data stale after 2 minutes

**User WS** (`wss://ws-subscriptions-clob.polymarket.com/ws/user`)
- Authenticated with API key/secret/passphrase
- Subscribes per conditionId
- Instant fill notifications (faster than polling)
- Cancel notifications for rejected orders

### GTC Order Lifecycle

```
placeOrder(GTC) → result
  |
  +--[filledPrice present]→ openPaperTrade() → done
  |
  +--[orderId only]→ savePendingOrder() → subscribeUserMarket()
                        |
         +--------------+--------------+
         |                             |
   [User WS: fill event]      [poll: checkPendingOrders]
   instant callback            every 60s, checks status
         |                             |
         v                             v
   openPaperTrade()            if filled → openPaperTrade()
   removePendingOrder()        if age > 5min → cancelOrder()
```

---

## Signal Scoring (0-100)

Before copying any trade, every signal is scored. Only signals with **score >= 50** are copied (65 in production via PM2 env).

### Score Components

| Component | Max pts | Thresholds |
|-----------|---------|------------|
| Domain match | 30 | Expert's #1 domain=30, >=10 trades=20, >=5=10, no match=0 |
| Calibration | 20 | >=0.80=20, >=0.70=14, >=0.60=8, else=0 |
| Implicit edge | 15 | >=0.15=15, >=0.08=11, >=0.03=7, >=-0.03=3, else=0 |
| Win rate | 10 | >=60%=10, >=50%=7, >=40%=4 |
| Entry price | 15 | 15-30c=15 (sweet spot), 30-50c=10, <15c=0 |
| Bet size signal | 10 | >50K shares=10, >10K=7, >1K=4, else=1 |

Raw score is multiplied by a **domain performance multiplier** (0.5x to 1.5x).

### Hard Blocks (score = 0)

- Entry price > 65c (favorites have negative edge historically)
- Entry price > 50c (MAX_ENTRY in auto-trader)
- Noise markets (5-min crypto windows, narrow price ranges)
- Blocked domains: `crypto`, `weather` (negative edge from data)
- Unknown domain (classifier returned null)
- No historical data for expert

### Domain Performance Multiplier

| Expert profile | Multiplier |
|---------------|-----------|
| Calibration >= 75% AND WR >= 55% | 1.5x |
| Calibration >= 65% AND WR >= 50% | 1.2x |
| First time in this domain | 0.7x |
| Calibration < 55% OR WR < 35% | 0.5x |
| Unknown domain | 0 (blocked) |

---

## Expert Trust System

Trust is re-evaluated on **every poll**. Trust level is a multiplier (0 to 1.5) applied to bet size.

All dollar thresholds scale with bankroll: `scaledDollar(base) = base * (starting_balance / 10000)`.

### Phase 1 - Observation (< 20 resolved trades)

Default trust: **0.7x** (cautious). Too few trades to judge.

| Condition | Trust | Status |
|-----------|-------|--------|
| >= 5 trades, PnL < -$300 scaled | 0 | Paused |
| >= 3 trades, PnL < -$100 scaled | 0.3 | Reduced |
| default | 0.7 | Active |

### Phase 2 - Evaluation (20-59 resolved trades)

Uses **last 15 trades** as rolling window:

| Condition | Trust | Status |
|-----------|-------|--------|
| >= 30 trades, recentPnl < -$200 AND WR < 30% | 0 | Paused |
| recentPnl < -$100 OR (WR < 35% AND overall PnL < 0) | 0.3 | Reduced |
| default | `min(0.5 + (WR - 0.35) * 2, 1.2)` | Active |

### Phase 3 - Proven (60+ resolved trades)

Uses **composite risk score** (0-100) from full history:

```
pfScore    = min(profitFactor / 2.0, 1) * 40      // max 40 pts
ddScore    = max(1 - maxDD / (totalPnl + maxDD), 0) * 25  // max 25 pts
momentum   = recentMomentum based, +/-              // max 20 pts
wlRatio    = min(avgWin / avgLoss / 3.0, 1) * 15   // max 15 pts
```

| Score | Condition | Trust | Status |
|-------|-----------|-------|--------|
| < 10 | + momentum < -$200 | 0 | Paused |
| < 20 | - | 0.15 | Reduced |
| < 40 | - | 0.30 | Reduced |
| >= 40 | - | `0.6 + (score-35) * (0.9/65)`, max 1.5 | Active |

---

## Kelly Criterion Sizing

Bet size is determined by **quarter-Kelly**:

```
b = (1 / entryPrice) - 1          # net odds
f* = (winRate * b - (1-winRate)) / b  # full Kelly
betFraction = min(f* * 0.25, 0.25)    # quarter Kelly, capped at 25%
```

### Multiplier Stack

Final bet = `baseBet * signalMulti * consensusMulti * trustMulti`

| Factor | Values |
|--------|--------|
| baseBet | `bankroll * kellyFraction`, clamped to [minBet, maxBet] |
| signalMulti | score >= 80 = 1.5x, else 1.0x |
| consensusMulti | 1 expert = 1.0x, 2 = 0.7x, 3+ = 0.5x, 5+ = 0.3x |
| trustMulti | expert trust level (0 to 1.5) |

**Consensus is inverted**: more experts on same trade = less unique edge = smaller bet.

### Bet Limits

| Limit | Paper | Live |
|-------|-------|------|
| Min bet | `max(equity * 0.002, $20 * scale)` | same |
| Max bet | `max(equity * 0.003, $500 * scale)` | capped at 30% of cash |
| Max capital | 60-70% of equity | same |

---

## Exit Strategy

Priority order (first match wins):

### Partial Exits (checked first)

| Trigger | PnL threshold | Action |
|---------|--------------|--------|
| Partial 150% | pnlPct >= 1.50 | Sell 30% of remaining |
| Partial 100% | pnlPct >= 1.00 | Sell 50% of remaining |

Guards prevent re-triggering: each partial exit is recorded in `partial_exits` JSON array.

### Full Exits

| Priority | Trigger | Condition |
|----------|---------|-----------|
| 1 | Near-resolution | YES >= 85c or NO <= 15c |
| 2 | Take profit | Disabled (999%) |
| 3 | Stop loss | PnL <= -40% |
| 4 | Trailing stop | Disabled (999%) |
| 5 | Stale position | > 7 days, < 3c price movement |
| 6 | Expert exit | Expert closed their position |

### PnL Calculation

```
pnlPct = (curPrice - entryPrice) / entryPrice
```

For partial exits: `shares_remaining` tracks what's left. On full close, PnL uses the remaining fraction of the original investment.

### Live Exit Execution

- Partial exits: `closePosition(tokenId, sharesToSell, exitPrice, negRisk)` as GTC sell
- Full exits: same, then `resolvePaperTrade()` + `unsubscribeToken()`
- Min sell size: 5 shares (CLOB minimum). Below this, position is marked resolved but tokens stay on-chain.

---

## Domain Classification

Pure keyword scoring, no LLM. Deterministic and instant.

### 9 Domains

| Domain | High-confidence keywords (weight 3) |
|--------|--------------------------------------|
| `ai-tech` | gpt, llm, claude, openai, anthropic, gemini |
| `politics` | election, president, congress, senate, impeach |
| `crypto` | bitcoin, btc, ethereum, eth, solana, binance |
| `sports` | nba, nfl, mlb, nhl, ufc, world cup, premier league |
| `economics` | cpi, inflation, fed, gdp, fomc, nfp, interest rate |
| `science` | fda, vaccine, nasa, spacex, earthquake |
| `culture` | oscar, grammy, emmy, box office, netflix |
| `weather` | temperature, hurricane, tornado, wildfire, drought |
| `geopolitics` | war, invasion, ceasefire, nato, sanctions, nuclear |

**Confidence**: `min(totalScore / 3, 1.0)`. A single weight-3 keyword = 100% confidence.

**Tie-breaking priority**: geopolitics > politics > science > economics > crypto > ai-tech > sports > culture > weather

---

## Wallet Indexing

Runs every 24h automatically. For each watched wallet:

1. `fetchResolvedTrades(wallet)` from Polymarket API
2. `classifyMarket(question)` for each trade
3. `saveTrade()` to `trades` table
4. Per domain: compute `winRate`, `calibration`, `implicitEdge`, `decayFactor`, `avgConviction`, `totalPnl`
5. `saveWalletStats()` to `wallet_stats` table
6. `calculateCopyabilityFromStats()` and `updateWalletCopyability()` to refresh the score

### Copyability Score

Stored in `watched_wallets.copyability_score`, updated on every reindex.

```
winRateScore     = clamp(winRate / 0.70, 0, 1) * 0.25
calibrationScore = clamp((calibration - 0.5) / 0.5, 0, 1) * 0.25
profitScore      = 0.5 * 0.30   (neutral default from stats)
streakScore      = 0.5 * 0.20   (neutral default from stats)
```

Full `calculateCopyabilityScore` (from raw trades) also factors in actual profit factor and max consecutive losses.

---

## Trading Costs

### Fees
Polymarket charges **2% taker fee**:
- Entry: `shares = (betAmount * 0.98) / entryPrice`
- Early exit: `netProceeds = shares * exitPrice * 0.98`
- Resolution payout: no fee

### Slippage (paper trading only)

| Entry price | Base slippage |
|-------------|--------------|
| < 20c | 6% |
| 20-30c | 5% |
| 30-50c | 3% |
| >= 50c | 2% |

Size impact: `(betAmount / $100) * 0.5%` additional per $100 bet.

### Live Trading Price Buffer
Instead of simulated slippage, live orders use: `price = min(rawPrice + 0.05, MAX_ENTRY)` -- 5c above expert's observed price, placed as GTC.

---

## PM2 Configuration

### auto-trader (paper)
```
POLL_INTERVAL_MS:  300000   (5 min)
STOP_LOSS:         0.40
MAX_OPEN_TRADES:   50
STALE_DAYS:        7
```

### live-trader (real money)
```
DB_PATH:              data/live.db
SHARED_DB_PATH:       data/polymarket.db
STARTING_BALANCE:     9
POLL_INTERVAL_MS:     60000   (1 min)
MIN_SIGNAL_SCORE_LIVE: 65     (stricter than paper's 50)
DRY_RUN:              false
```

### nextjs (dashboard)
```
PORT: 3000
NODE_ENV: production
```

---

## Validation Gates

Before going live, these gates must pass on 4000+ resolved trades:

| Gate | Threshold |
|------|-----------|
| Profit Factor | >= 1.30 |
| Max consecutive losses | <= 15 |
| Avg PnL per trade | >= +$5 |
| Resolved trades | >= 4000 |

---

## Key Metrics

| Metric | Formula | Good value |
|--------|---------|-----------|
| Win rate | won / total | > 50% |
| Calibration | 1 - brier score | > 0.75 (random = 0.75) |
| Implicit edge | avg(outcome - marketProb) | > +0.03 |
| Profit factor | gross wins / gross losses | > 1.5 |
| Decay factor | recency weighting | 1.0 (< 90d), 0.75 (90-180d), 0.5 (180d+) |

---

## Directory Structure

```
polymarket-intuition/
+-- scripts/
|   +-- auto-trader.ts          Paper trading bot (PM2)
|   +-- live-trader.ts          Live trading bot (PM2)
|   +-- bulk-index.ts           Index wallets from leaderboard
|   +-- bulk-index-all.ts       Index all categories
|   +-- monitor.ts              Console monitoring
|   +-- analytics.ts            CLI analytics
+-- src/
|   +-- app/
|   |   +-- page.tsx             Dashboard
|   |   +-- analytics/           Performance analytics
|   |   +-- paper-trading/       Trades table
|   |   +-- leaderboard/         Expert discovery
|   |   +-- settings/            Wallet management
|   |   +-- api/                 API routes
|   +-- lib/
|   |   +-- db.ts                SQLite ops + paper trade lifecycle
|   |   +-- signal-scorer.ts     Signal scoring (0-100)
|   |   +-- exit-strategy.ts     Exit decision engine
|   |   +-- expert-trust.ts      3-phase expert trust
|   |   +-- scorer.ts            Stats calculations
|   |   +-- classifier.ts        Keyword domain classifier
|   |   +-- indexer.ts           Wallet indexing pipeline
|   |   +-- real-trader.ts       CLOB order execution
|   |   +-- orderbook-ws.ts      WebSocket (market + user)
|   |   +-- position-tracker.ts  Expert position detection
|   |   +-- polymarket.ts        API client
|   |   +-- atoms.ts             Domain constants
+-- tests/                       Vitest tests
+-- data/
|   +-- polymarket.db            Shared DB (experts + paper)
|   +-- live.db                  Live trading DB
+-- ecosystem.config.cjs         PM2 configuration
```

---

## Running

```bash
npm install
npm run dev              # Dashboard on :3000

# Paper trading (dev)
npx tsx scripts/auto-trader.ts

# Live trading (dev, dry-run)
DRY_RUN=true npx tsx scripts/live-trader.ts

# Production
pm2 start ecosystem.config.cjs
pm2 logs live-trader --lines 50
```

---

## Deploy

```bash
# On VPS
cd /opt/polymarket-intuition
git pull origin main
pm2 restart all
pm2 logs live-trader --lines 50   # verify
```
