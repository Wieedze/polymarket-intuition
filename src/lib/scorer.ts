import type { ResolvedTrade } from '../types/polymarket'

/** Minimum trades in a domain before creating an on-chain attestation */
export const MIN_TRADES_FOR_ATTESTATION = 5

/**
 * Simple win rate: won / total.
 * Returns 0 for empty array.
 */
export function calculateWinRate(trades: ResolvedTrade[]): number {
  if (trades.length === 0) return 0
  const won = trades.filter((t) => t.outcome === 'won').length
  return won / trades.length
}

/**
 * Inverted Brier Score — measures calibration quality.
 *
 * predictedProb = entryPrice if YES, (1 - entryPrice) if NO
 * outcome = 1 if won, 0 if lost
 * brierScore = mean((predictedProb - outcome)²)
 * calibration = 1 - brierScore
 *
 * 1.0 = perfect | 0.75 = random | <0.75 = worse than chance
 */
export function calculateCalibration(trades: ResolvedTrade[]): number {
  if (trades.length === 0) return 0

  let sumSquaredError = 0

  for (const trade of trades) {
    const predictedProb =
      trade.side === 'YES' ? trade.entryPrice : 1 - trade.entryPrice
    const outcome = trade.outcome === 'won' ? 1 : 0
    sumSquaredError += (predictedProb - outcome) ** 2
  }

  const brierScore = sumSquaredError / trades.length
  return 1 - brierScore
}

/**
 * Conviction Score — win rate weighted by entryPrice.
 * Filters longshots (entryPrice < 0.25) automatically.
 * A buy at 0.70 that wins is worth more than a buy at 0.03 that loses.
 *
 * Formula: mean(entryPrice × isWon) over trades with entryPrice >= 0.25
 * Returns 0 if no qualifying trades.
 */
export function calculateConvictionScore(trades: ResolvedTrade[]): number {
  const qualified = trades.filter((t) => t.entryPrice >= 0.25)
  if (qualified.length === 0) return 0

  const sum = qualified.reduce((s, t) => {
    const isWon = t.outcome === 'won' ? 1 : 0
    return s + t.entryPrice * isWon
  }, 0)

  return sum / qualified.length
}

/**
 * Detects trading style based on average entry price.
 */
export type TradingStyle = 'longshot-hunter' | 'value-trader' | 'directional' | 'mixed'

export function detectTradingStyle(trades: ResolvedTrade[]): TradingStyle {
  if (trades.length === 0) return 'mixed'

  const avgEntryPrice =
    trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length
  const convictionScore = calculateConvictionScore(trades)

  if (avgEntryPrice < 0.15) return 'longshot-hunter'
  if (avgEntryPrice < 0.40 && convictionScore > 0.3) return 'value-trader'
  if (avgEntryPrice >= 0.40) return 'directional'
  return 'mixed'
}

// ── Copy Trading Metrics ──────────────────────────────────────────

/**
 * Profit Factor = gross wins / gross losses.
 * >1 = profitable, >1.5 = good edge, >2.0 = excellent.
 * Returns 0 if no losses (division by zero) or no trades.
 */
export function calculateProfitFactor(trades: ResolvedTrade[]): number {
  if (trades.length === 0) return 0

  let grossWins = 0
  let grossLosses = 0

  for (const t of trades) {
    if (t.pnl > 0) grossWins += t.pnl
    else if (t.pnl < 0) grossLosses += Math.abs(t.pnl)
  }

  if (grossLosses === 0) return grossWins > 0 ? Infinity : 0
  return grossWins / grossLosses
}

/**
 * Average PnL per trade in USDC.
 * Positive = expected profit per copied trade.
 */
export function calculateAvgPnlPerTrade(trades: ResolvedTrade[]): number {
  if (trades.length === 0) return 0
  const total = trades.reduce((s, t) => s + t.pnl, 0)
  return total / trades.length
}

/**
 * Maximum consecutive losses.
 * Critical for small accounts — tells you the worst drawdown streak.
 */
export function calculateMaxConsecutiveLosses(trades: ResolvedTrade[]): number {
  let max = 0
  let current = 0

  for (const t of trades) {
    if (t.outcome === 'lost') {
      current++
      if (current > max) max = current
    } else {
      current = 0
    }
  }

  return max
}

/**
 * Copyability Score — composite metric for copy trading viability.
 *
 * Designed for small accounts: penalizes longshot hunters,
 * rewards consistent edge with survivable drawdowns.
 *
 * Components (0-1 each, weighted):
 *   winRateScore    (25%) — winRate, clamped to [0, 0.7] then normalized
 *   calibrationScore(25%) — calibration, clamped to [0.5, 1.0] then normalized
 *   profitScore     (30%) — profitFactor, clamped to [0, 3.0] then normalized
 *   streakScore     (20%) — 1 - (maxConsecLosses / 20), clamped to [0, 1]
 *
 * Returns 0 if < 5 trades (not enough data).
 */
export function calculateCopyabilityScore(trades: ResolvedTrade[]): number {
  if (trades.length < 5) return 0

  const winRate = calculateWinRate(trades)
  const calibration = calculateCalibration(trades)
  const profitFactor = calculateProfitFactor(trades)
  const maxConsecLosses = calculateMaxConsecutiveLosses(trades)

  const winRateScore = Math.min(Math.max(winRate / 0.7, 0), 1)
  const calibrationScore = Math.min(Math.max((calibration - 0.5) / 0.5, 0), 1)
  const profitScore = profitFactor === Infinity
    ? 1
    : Math.min(Math.max(profitFactor / 3, 0), 1)
  const streakScore = Math.min(Math.max(1 - maxConsecLosses / 20, 0), 1)

  return (
    winRateScore * 0.25 +
    calibrationScore * 0.25 +
    profitScore * 0.30 +
    streakScore * 0.20
  )
}

/**
 * Decay factor based on inactivity.
 * > 180 days → 0.5
 * > 90 days  → 0.75
 * Otherwise  → 1.0
 */
export function calculateDecayFactor(lastTradeAt: string): number {
  const lastDate = new Date(lastTradeAt).getTime()
  const now = Date.now()
  const daysSince = (now - lastDate) / (1000 * 60 * 60 * 24)

  if (daysSince > 180) return 0.5
  if (daysSince > 90) return 0.75
  return 1.0
}
