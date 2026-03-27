import type { PaperTrade } from './db'

// ── Exit Strategy Config ────────────────────────────────────────

export type ExitConfig = {
  // Take profit: sell when up this much (0.80 = +80%)
  takeProfitPct: number

  // Stop loss: sell when down this much (0.40 = -40%)
  stopLossPct: number

  // Trailing stop: activate when up this much
  trailingActivatePct: number
  // Trailing stop: sell when drops back to this level
  trailingStopPct: number

  // Near-resolution early exit: exit when price reaches near-certainty
  // Captures ~85% of max value without waiting for full resolution
  // YES exit when curPrice >= nearResolutionThreshold
  // NO exit when curPrice <= (1 - nearResolutionThreshold)
  nearResolutionThreshold: number

  // Stale position: sell if no price movement > threshold for N days
  staleDays: number
  staleThreshold: number  // minimum price change to be "active" (e.g. 0.03 = 3¢)

  // Expert exit: if the expert we copied closes their position, we close too
  followExpertExit: boolean

  // Partial exits: sell a fraction of the position at profit milestones
  // to free capital for new signals without closing the full position
  partialExitAt100Pct: number   // fraction to sell at +100% (default 0.5 = 50%)
  partialExitAt150Pct: number   // fraction to sell at +150% (default 0.3 = 30%)
}

export const DEFAULT_CONFIG: ExitConfig = {
  takeProfitPct: 999,           // disabled — use nearResolutionThreshold instead
  stopLossPct: 0.25,            // -25% → cut losses (was 0.40 — too generous on fast-resolving markets)
  trailingActivatePct: 999,     // disabled — bad for binary markets
  trailingStopPct: 0.10,        // (unused when trailing disabled)
  nearResolutionThreshold: 0.85, // exit YES at 85¢+, exit NO at 15¢-
  staleDays: 7,                  // 7 days without movement
  staleThreshold: 0.03,          // 3¢ minimum move
  followExpertExit: true,
  partialExitAt100Pct: 0.50,    // sell 50% at +100% — frees capital, keeps upside
  partialExitAt150Pct: 0.30,    // sell 30% more at +150% — 20% rides free to resolution
}

// ── Exit Decision ───────────────────────────────────────────────

export type ExitDecision = {
  shouldExit: boolean
  reason:
    | 'take-profit'
    | 'near-resolution'
    | 'stop-loss'
    | 'trailing-stop'
    | 'stale-position'
    | 'expert-exit'
    | 'partial-exit-100'
    | 'partial-exit-150'
    | 'hold'
  pnlPct: number
  peakPnlPct: number
  partialFraction?: number  // fraction to sell (only for partial-exit reasons)
  message: string
}

/**
 * Evaluate whether a paper trade should be exited.
 *
 * @param trade - The open paper trade
 * @param config - Exit strategy configuration
 * @param expertStillHolding - Whether the expert still has this position (null = unknown)
 */
export function evaluateExit(
  trade: PaperTrade,
  config: ExitConfig = DEFAULT_CONFIG,
  expertStillHolding: boolean | null = null
): ExitDecision {
  if (trade.curPrice == null) {
    return { shouldExit: false, reason: 'hold', pnlPct: 0, peakPnlPct: 0, message: 'No price data' }
  }

  // Calculate PnL percentage based on side
  const pnlPct = calcPnlPct(trade.side, trade.entryPrice, trade.curPrice)
  const peakPrice = trade.peakPrice ?? trade.curPrice
  const peakPnlPct = calcPnlPct(trade.side, trade.entryPrice, peakPrice)

  // 0. PARTIAL EXITS — free capital at profit milestones without closing position
  //    Check how many partial exits already done to avoid re-triggering
  const partialExits = trade.partialExits ?? []
  const done100 = partialExits.some((e) => e.pct === config.partialExitAt100Pct && e.price >= trade.entryPrice * 2)
  const done150 = partialExits.some((e) => e.pct === config.partialExitAt150Pct && e.price >= trade.entryPrice * 2.5)

  if (!done150 && pnlPct >= 1.50 && config.partialExitAt150Pct > 0) {
    return {
      shouldExit: true,
      reason: 'partial-exit-150',
      pnlPct,
      peakPnlPct,
      partialFraction: config.partialExitAt150Pct,
      message: `Partial exit 150%: selling ${(config.partialExitAt150Pct * 100).toFixed(0)}% at +${(pnlPct * 100).toFixed(0)}% — freeing capital`,
    }
  }

  if (!done100 && pnlPct >= 1.00 && config.partialExitAt100Pct > 0) {
    return {
      shouldExit: true,
      reason: 'partial-exit-100',
      pnlPct,
      peakPnlPct,
      partialFraction: config.partialExitAt100Pct,
      message: `Partial exit 100%: selling ${(config.partialExitAt100Pct * 100).toFixed(0)}% at +${(pnlPct * 100).toFixed(0)}% — freeing capital`,
    }
  }

  // 1. NEAR-RESOLUTION early exit — capture ~85% of max value without waiting
  //    YES: exit when YES token >= 0.85 (near certain YES win)
  //    NO:  exit when NO token >= 0.85 (near certain NO win)
  //         OR when NO token <= 0.15 (near certain YES = cut losses early)
  const threshold = config.nearResolutionThreshold
  if (trade.side === 'YES' && trade.curPrice >= threshold) {
    return {
      shouldExit: true,
      reason: 'near-resolution',
      pnlPct,
      peakPnlPct,
      message: `Near-resolution exit: YES at ${(trade.curPrice * 100).toFixed(0)}¢ (threshold: ${(threshold * 100).toFixed(0)}¢)`,
    }
  }
  if (trade.side === 'NO' && trade.curPrice >= threshold) {
    return {
      shouldExit: true,
      reason: 'near-resolution',
      pnlPct,
      peakPnlPct,
      message: `Near-resolution exit: NO token at ${(trade.curPrice * 100).toFixed(0)}¢ — capturing gains`,
    }
  }
  if (trade.side === 'NO' && trade.curPrice <= (1 - threshold)) {
    return {
      shouldExit: true,
      reason: 'near-resolution',
      pnlPct,
      peakPnlPct,
      message: `Near-resolution cut: NO token at ${(trade.curPrice * 100).toFixed(0)}¢ — YES near certain`,
    }
  }

  // 2. TAKE PROFIT — percentage-based (kept for custom configs)
  if (pnlPct >= config.takeProfitPct) {
    return {
      shouldExit: true,
      reason: 'take-profit',
      pnlPct,
      peakPnlPct,
      message: `Take profit at +${(pnlPct * 100).toFixed(0)}% (threshold: +${(config.takeProfitPct * 100).toFixed(0)}%)`,
    }
  }

  // 3. STOP LOSS — cut the bleeding
  if (pnlPct <= -config.stopLossPct) {
    return {
      shouldExit: true,
      reason: 'stop-loss',
      pnlPct,
      peakPnlPct,
      message: `Stop loss at ${(pnlPct * 100).toFixed(0)}% (threshold: -${(config.stopLossPct * 100).toFixed(0)}%)`,
    }
  }

  // 4. TRAILING STOP — protect gains (YES side only, NO is complex)
  if (trade.side === 'YES' && peakPnlPct >= config.trailingActivatePct && pnlPct <= config.trailingStopPct) {
    return {
      shouldExit: true,
      reason: 'trailing-stop',
      pnlPct,
      peakPnlPct,
      message: `Trailing stop: was +${(peakPnlPct * 100).toFixed(0)}%, now +${(pnlPct * 100).toFixed(0)}%`,
    }
  }

  // 5. STALE POSITION — capital is sitting dead
  const openedAt = new Date(trade.openedAt).getTime()
  const daysSinceOpen = (Date.now() - openedAt) / (1000 * 60 * 60 * 24)
  if (daysSinceOpen >= config.staleDays) {
    const priceChange = Math.abs(trade.curPrice - trade.entryPrice)
    if (priceChange < config.staleThreshold) {
      return {
        shouldExit: true,
        reason: 'stale-position',
        pnlPct,
        peakPnlPct,
        message: `Stale ${daysSinceOpen.toFixed(0)}d, only ${(priceChange * 100).toFixed(1)}¢ moved`,
      }
    }
  }

  // 6. EXPERT EXIT — they know something we don't
  if (config.followExpertExit && expertStillHolding === false) {
    return {
      shouldExit: true,
      reason: 'expert-exit',
      pnlPct,
      peakPnlPct,
      message: `Expert closed their position`,
    }
  }

  // HOLD
  return {
    shouldExit: false,
    reason: 'hold',
    pnlPct,
    peakPnlPct,
    message: `Holding at ${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(0)}%`,
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function calcPnlPct(_side: string, entryPrice: number, curPrice: number): number {
  if (entryPrice === 0) return 0
  // Both YES and NO: entryPrice and curPrice are the token's own price.
  // Profit when the token price rises above entry (for YES: YES token rises; for NO: NO token rises).
  return (curPrice - entryPrice) / entryPrice
}

/**
 * Format exit reason for console/UI display
 */
export function exitEmoji(reason: ExitDecision['reason']): string {
  switch (reason) {
    case 'take-profit': return '💰'
    case 'near-resolution': return '🎯'
    case 'stop-loss': return '🛑'
    case 'trailing-stop': return '📈'
    case 'stale-position': return '💤'
    case 'expert-exit': return '👋'
    case 'partial-exit-100': return '💸'
    case 'partial-exit-150': return '💸'
    default: return '🚪'
  }
}
