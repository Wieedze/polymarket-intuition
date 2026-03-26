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
}

export const DEFAULT_CONFIG: ExitConfig = {
  takeProfitPct: 999,           // disabled — use nearResolutionThreshold instead
  stopLossPct: 0.40,            // -40% → cut losses
  trailingActivatePct: 999,     // disabled — bad for binary markets
  trailingStopPct: 0.10,        // (unused when trailing disabled)
  nearResolutionThreshold: 0.85, // exit YES at 85¢+, exit NO at 15¢-
  staleDays: 7,                  // 7 days without movement
  staleThreshold: 0.03,          // 3¢ minimum move
  followExpertExit: true,
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
    | 'hold'
  pnlPct: number
  peakPnlPct: number
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
  const peakPnlPct = trade.side === 'YES'
    ? calcPnlPct('YES', trade.entryPrice, peakPrice)
    : pnlPct // For NO, peak tracking is complex — use current

  // 1. NEAR-RESOLUTION early exit — capture ~85% of max value without waiting
  //    YES: exit when price >= 0.85 (e.g. 85¢ → already near certain YES)
  //    NO:  exit when price <= 0.15 (e.g. 15¢ → near certain YES means NO lost)
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
  if (trade.side === 'NO' && trade.curPrice <= (1 - threshold)) {
    return {
      shouldExit: true,
      reason: 'near-resolution',
      pnlPct,
      peakPnlPct,
      message: `Near-resolution exit: NO at ${(trade.curPrice * 100).toFixed(0)}¢ (threshold: ${((1 - threshold) * 100).toFixed(0)}¢)`,
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

function calcPnlPct(side: string, entryPrice: number, curPrice: number): number {
  if (entryPrice === 0) return 0
  if (side === 'YES') {
    return (curPrice - entryPrice) / entryPrice
  }
  // NO side: profit when price drops
  return (entryPrice - curPrice) / entryPrice
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
    case 'hold': return '⏳'
  }
}
