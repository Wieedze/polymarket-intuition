/**
 * Price Exit Strategy — Exit tiers by entry price for momentum trades
 *
 * Standalone module, no dependency on live-trader or existing exit-strategy.
 */

// ── Exit tiers by entry price ───────────────────────────────────

export type ExitTier = {
  partial1Pct: number
  partial1Sell: number   // fraction to sell (0-1)
  partial2Pct: number
  partial2Sell: number
  takeProfitPct: number
  stopLossPct: number    // negative
  staleHours: number
}

export const EXIT_TIERS: Record<'longshot' | 'sweet' | 'value', ExitTier> = {
  longshot: {  // < 15c — big payoff, wide stop
    partial1Pct: 1.00, partial1Sell: 0.30,   // +100% → sell 30%
    partial2Pct: 2.00, partial2Sell: 0.50,   // +200% → sell 50%
    takeProfitPct: 4.00,                      // +400% → sell all
    stopLossPct: -0.50,                       // -50%
    staleHours: 72,
  },
  sweet: {     // 15-25c — balanced
    partial1Pct: 0.50, partial1Sell: 0.30,   // +50% → sell 30%
    partial2Pct: 1.00, partial2Sell: 1.00,   // +100% → sell all
    takeProfitPct: 1.00,
    stopLossPct: -0.30,                       // -30%
    staleHours: 48,
  },
  value: {     // 25-30c — tight exits
    partial1Pct: 0.30, partial1Sell: 0.50,   // +30% → sell 50%
    partial2Pct: 0.60, partial2Sell: 1.00,   // +60% → sell all
    takeProfitPct: 0.60,
    stopLossPct: -0.25,                       // -25%
    staleHours: 48,
  },
}

export type TierName = keyof typeof EXIT_TIERS

export function getTier(entryPrice: number): TierName {
  if (entryPrice < 0.15) return 'longshot'
  if (entryPrice < 0.25) return 'sweet'
  return 'value'
}

// ── Exit decision ───────────────────────────────────────────────

export type ExitDecision = {
  action: 'hold' | 'partial' | 'close'
  reason: string
  sellFraction: number   // 0-1 (fraction of remaining shares)
}

export function evaluatePriceExit(
  entryPrice: number,
  curPrice: number,
  ageHours: number,
  tier: TierName,
  partial1Done: boolean,
  partial2Done: boolean,
): ExitDecision {
  const pnlPct = (curPrice - entryPrice) / entryPrice
  const config = EXIT_TIERS[tier]

  // Near-resolution: price >= 85c or <= 15c
  if (curPrice >= 0.85 || curPrice <= 0.15) {
    return { action: 'close', reason: 'near-resolution', sellFraction: 1 }
  }

  // Partial exit 1
  if (!partial1Done && pnlPct >= config.partial1Pct) {
    if (config.partial1Sell >= 1) {
      return { action: 'close', reason: `tp-${(config.partial1Pct * 100).toFixed(0)}%`, sellFraction: 1 }
    }
    return { action: 'partial', reason: `partial-${(config.partial1Pct * 100).toFixed(0)}%`, sellFraction: config.partial1Sell }
  }

  // Partial exit 2
  if (!partial2Done && pnlPct >= config.partial2Pct) {
    if (config.partial2Sell >= 1) {
      return { action: 'close', reason: `tp-${(config.partial2Pct * 100).toFixed(0)}%`, sellFraction: 1 }
    }
    return { action: 'partial', reason: `partial-${(config.partial2Pct * 100).toFixed(0)}%`, sellFraction: config.partial2Sell }
  }

  // Full take profit
  if (pnlPct >= config.takeProfitPct) {
    return { action: 'close', reason: `tp-${(config.takeProfitPct * 100).toFixed(0)}%`, sellFraction: 1 }
  }

  // Stop loss
  if (pnlPct <= config.stopLossPct) {
    return { action: 'close', reason: 'stop-loss', sellFraction: 1 }
  }

  // Stale exit
  if (ageHours >= config.staleHours) {
    return { action: 'close', reason: 'stale', sellFraction: 1 }
  }

  return { action: 'hold', reason: '', sellFraction: 0 }
}
