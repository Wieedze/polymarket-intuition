# Polymarket Copy Trader

A paper-trading copy bot for Polymarket. Watches expert wallets, scores every signal, simulates positions with full risk management, and tracks performance across market domains.

---

## Stack

| Layer | Tech |
|-------|------|
| Framework | Next.js 14 App Router + TypeScript strict (no `any`) |
| Database | SQLite (better-sqlite3, WAL mode) — all local, no cloud |
| Process manager | PM2 (`auto-trader` + `nextjs` processes) |
| Tests | Vitest (177 passing) |
| Deploy | VPS (Hetzner) + PM2 |

---

## Architecture Overview

```
Polymarket API (positions)
      ↓
  [auto-trader.ts]  ← polls every 30s
      ↓
  Signal scoring → open / skip paper trade
      ↓
  Exit strategy → close / partial exit paper trade
      ↓
  SQLite (paper_trades, bot_events, watched_wallets, wallet_stats)
      ↓
  Next.js dashboard (live metrics, analytics, leaderboard)
```

The bot (`scripts/auto-trader.ts`) runs in a PM2 process. Every 30 seconds it:
1. Fetches open positions for all watched wallets
2. Scores each signal
3. Opens/closes paper trades based on rules
4. Logs all decisions to `bot_events`

Every 24 hours it re-indexes all watched wallets to keep `wallet_stats` fresh.

---

## Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard — live portfolio, open positions, recent events |
| `/analytics` | Full performance breakdown (domain, expert, entry price, costs) |
| `/paper-trading` | All trades table with filters and status |
| `/leaderboard` | Polymarket top-profit wallets (source for experts) |
| `/settings` | Manage watched wallets, bot config |

All pages auto-refresh every 30 seconds.

---

## Signal Scoring (0–100)

Before copying any trade, every signal is scored. Only signals with **score ≥ 40** are copied.

### Score components

| Component | Max points | Logic |
|-----------|-----------|-------|
| Domain match | 30 | Is this the expert's best domain? |
| Calibration | 20 | Brier-score accuracy in this domain |
| Implicit edge | 15 | Beats market implied probability by X pts |
| Win rate | 10 | Historical win rate in domain |
| Entry price | 15 | Longshot 15–30¢ = best historical P&L |
| Bet size signal | 10 | Expert conviction (whale = high signal) |

Raw score (0–80) is then multiplied by a **domain performance multiplier** (0.5×–1.5×) based on the expert's own calibration and win rate in that specific domain.

### Hard blocks

- **Score = 0** if entry price > 65¢ (favorites have negative edge)
- **Score = 0** for noise markets: 5-min crypto windows, narrow price ranges
- **Score = 0** for blocked domains (currently: `pm-domain/crypto` — negative edge from data)
- **Score = 0** if no historical data for this expert

### Domain multipliers

| Expert calibration | Win rate | Multiplier |
|-------------------|---------|-----------|
| ≥ 75% + WR ≥ 55% | Excellent | 1.5× boost |
| ≥ 65% + WR ≥ 50% | Good | 1.2× boost |
| No history in domain | Unknown | 0.7× caution |
| < 55% or WR < 35% | Poor | 0.5× penalty |
| Unknown domain | — | Skip (0) |

---

## Expert Trust System (3 phases)

Trust is evaluated on every poll, not on a fixed schedule. Trust level is a multiplier on bet size.

### Phase 1 — Observation (< 20 resolved trades)
- Trust: **0.7×** (cautious default)
- Logic: too few trades to judge, but still copy with reduced size

### Phase 2 — Evaluation (20–60 resolved trades)
Uses a rolling window of the **last 15 trades**:

| Recent performance | Trust | Status |
|-------------------|-------|--------|
| PnL < −$200 AND WR < 30% | 0× | Paused |
| PnL < −$100 OR WR < 35% | 0.3× | Reduced |
| OK | 0.3–1.2× | Active (scales with WR) |

### Phase 3 — Proven (60+ resolved trades)
Uses last **20 trades** + full history combined:

| Performance | Trust | Status |
|------------|-------|--------|
| PnL < −$300 AND WR < 25% | 0× | Paused |
| PnL < −$100 OR WR < 35% | 0.4× | Reduced |
| Good | 0.6–1.5× | Active (overall × 30% + recent × 70%) |

Trust score formula for proven experts:
```
overallFactor = min(winRate / 0.5, 1)
recentFactor  = min(recentWR / 0.5, 1)
trust = min(0.6 + (overallFactor × 0.3 + recentFactor × 0.7) × 0.6, 1.5)
```

---

## Kelly Criterion Sizing

Bet size is determined by a **quarter-Kelly** formula:

```
b = (1 / entryPrice) - 1      # net odds
f* = (winRate × b - (1 - winRate)) / b
betFraction = min(f* × 0.25, 0.25)   # quarter Kelly, capped at 25%
```

Quarter Kelly is used instead of full Kelly to reduce variance. Capped at 25% of bankroll to prevent catastrophic sizing.

Final bet size also scales with:
- Signal score: score 40–59 → 0.5× | score 60–79 → 1.0× | score 80+ → 1.5×
- Expert trust level (0.3×–1.5×)
- Inverted consensus multiplier (see below)
- Min/max: **$20–$500** per trade

---

## Inverted Consensus Multiplier

When multiple watched wallets all have the same open position, that's a signal that many people are already in — less unique edge. The bet is scaled **down** when consensus is high:

| Experts holding same position | Multiplier |
|------------------------------|-----------|
| 1 | 1.0× |
| 2 | 0.7× |
| 3 | 0.5× |
| 5+ | 0.3× |

This rewards early/unique signals and penalizes crowded trades.

---

## Exit Strategy

### Full exits (close the position entirely)

| Trigger | Condition |
|---------|-----------|
| Near-resolution | YES ≥ 85¢, or NO ≤ 15¢ — capture ~85% of max value without waiting for resolution |
| Stop loss | PnL ≤ −25% |
| Take profit | Disabled (999%) — use near-resolution instead |
| Trailing stop | Disabled — bad for binary markets |
| Stale position | > 7 days with < 3¢ price change — dead capital |
| Expert exit | If the expert closes their position, we close too |

### Partial exits (free capital, keep upside)

| Trigger | Condition | Action |
|---------|-----------|--------|
| Partial 100% | PnL ≥ +100% | Sell 50% — free half the capital |
| Partial 150% | PnL ≥ +150% | Sell 30% more — 20% rides free |

After partial exits, `shares_remaining` tracks what's left. The position stays open until a full exit trigger fires.

---

## Trading Costs Simulation

The bot simulates Polymarket's actual costs for realistic paper trading.

### Fees
Polymarket charges a **2% taker fee** on every buy and early sell (not on resolution payouts):

```
Entry: shares = (betAmount × 0.98) / entryPrice
Exit (early): netProceeds = shares × exitPrice × 0.98
Resolution: no fee (full payout)
```

### Slippage (dynamic, size-aware)

```
baseSlippage:
  entryPrice < 20¢ → 6%    (low-liquidity longshots)
  entryPrice 20–30¢ → 5%
  entryPrice 30–50¢ → 3%
  entryPrice > 50¢ → 2%

sizeImpact = (betAmount / $100) × 0.5%   # each $100 adds 0.5% slippage
totalSlippage = baseSlippage + sizeImpact
```

A $200 bet on a 25¢ longshot: 5% + 1% = 6% slippage on top of 2% fee → ~8% total cost.

The analytics page shows total fees paid, estimated slippage, and total cost as % of deployed capital.

---

## Wallet Indexing & Stats

Watched wallets are indexed daily (every 24h in the scheduler). Per domain, we compute:

| Metric | Description |
|--------|-------------|
| `winRate` | % of trades that resolved correctly |
| `calibration` | Brier score accuracy (1.0 = perfect, 0.75 = random) |
| `implicitEdge` | Average of `(outcome - marketProb)` per trade — positive = finds underpriced bets |
| `tradesCount` | Resolved trades in domain |
| `decayFactor` | Recency weighting (recent trades matter more) |

These stats power the signal scorer's domain match and multiplier logic.

---

## Implicit Edge (Key Metric)

For binary (YES/NO) markets, we track whether the expert systematically finds bets where the market *underestimates* the real probability:

```
implicitEdge = avg(outcome - entryPrice)   # for YES trades
             # outcome = 1 if won, 0 if lost
             # entryPrice = market's implied probability at entry

Positive edge = expert finds bets where real probability > market price
```

An expert with +15 implicit edge means: on average, when they bet at 40¢, the real probability was ~55¢. This is the core alpha indicator.

---

## Domain Classification

Markets are classified by keyword matching. If confidence < 85%, an LLM fallback is used.

| Domain | Key signals |
|--------|------------|
| `pm-domain/ai-tech` | ai, gpt, claude, openai, llm, nvidia, chip |
| `pm-domain/politics` | election, president, congress, vote, trump |
| `pm-domain/crypto` | bitcoin, btc, ethereum, eth, defi, nft, token |
| `pm-domain/sports` | nba, nfl, world cup, super bowl, tournament |
| `pm-domain/economics` | fed, cpi, inflation, gdp, interest rate, fomc |
| `pm-domain/science` | fda, vaccine, nasa, spacex, rocket, mars |
| `pm-domain/culture` | oscar, grammy, movie, album, netflix, celebrity |
| `pm-domain/weather` | temperature, rain, hurricane, storm, forecast |
| `pm-domain/geopolitics` | war, nato, russia, ukraine, china, taiwan |

Minimum confidence to use classification: **70%**.

---

## Validation Gates (Live Trading Readiness)

Before going live, these gates must all pass on 4000+ resolved trades:

| Gate | Threshold | Meaning |
|------|-----------|---------|
| Profit Factor | ≥ 1.30 | Gross wins / gross losses |
| Max consecutive losses | ≤ 15 | Drawdown resilience |
| Avg P&L per trade | ≥ +$5 | Real edge after costs |
| Resolved trades | ≥ 4000 | Statistical significance |

Win rate confidence interval (Wilson 95% CI) shown with significance labels:
- < 100 trades: ⚠️ Not significant
- 100–1000: 🟡 Low
- 1000–4000: 🟠 Medium
- 4000+: 🟢 High

---

## Defense Mechanisms Summary

| Mechanism | Protects against |
|-----------|-----------------|
| Score threshold (≥ 40) | Low-quality signals |
| Entry price block (> 65¢) | Favorite bias / negative edge |
| Domain block (crypto) | Domains with proven negative edge |
| Noise market filter | 5-min crypto windows, price range bets |
| Inverted consensus | Crowded, low-alpha trades |
| Expert trust phases | Copying wallets in a slump |
| Stop loss (−25%) | Single position blowups |
| Stale position exit (7d) | Dead capital opportunity cost |
| Expert exit follow | Expert knows something we don't |
| Partial exits | Locks in gains, frees capital for new signals |
| Min bet $20 | Avoids micro-positions with high relative cost |
| Max bet $500 | Caps single-position exposure |
| Kelly quarter-sizing | Prevents overbetting on volatile signals |

---

## Directory Structure

```
polymarket-intuition/
├── scripts/
│   └── auto-trader.ts          ← PM2 bot process (polls every 30s)
├── src/
│   ├── app/
│   │   ├── page.tsx             ← Dashboard
│   │   ├── analytics/           ← Performance analytics
│   │   ├── paper-trading/       ← Trades table
│   │   ├── leaderboard/         ← Expert discovery
│   │   ├── settings/            ← Watched wallets management
│   │   └── api/                 ← API routes
│   └── lib/
│       ├── db.ts                ← SQLite operations + paper trade logic
│       ├── signal-scorer.ts     ← Signal scoring (0-100)
│       ├── exit-strategy.ts     ← Exit decision logic
│       ├── expert-trust.ts      ← Expert trust phases
│       ├── classifier.ts        ← Market → domain classification
│       ├── indexer.ts           ← Wallet indexing + stats
│       └── polymarket.ts        ← Polymarket API client
├── tests/                       ← Vitest tests (177 passing)
└── data/
    └── polymarket.db            ← SQLite database
```

---

## PM2 Process Management

```bash
# View all processes
pm2 list

# Watch logs (bot activity)
pm2 logs auto-trader

# Restart after deploy
pm2 restart all

# Pull + restart (deploy flow)
git pull && npm run build && pm2 restart all
```

---

## Environment Variables

```bash
POLYMARKET_API_URL=https://gamma-api.polymarket.com
POLYMARKET_DATA_URL=https://data-api.polymarket.com
ANTHROPIC_API_KEY=                    # LLM fallback for classifier
DB_PATH=./data/polymarket.db          # optional, defaults to ./data/
```

---

## Running Locally

```bash
npm install
npm run dev          # Next.js dashboard on :3000

# Run bot in dev
npx tsx scripts/auto-trader.ts

# Run tests
npm test
```
