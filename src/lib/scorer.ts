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
