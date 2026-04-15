/**
 * Price Paper Trader — Simulates momentum trades in memory
 *
 * Standalone module. Manages paper positions, partial exits, PnL tracking.
 * No DB dependency, no real orders. Pure simulation.
 */

import { evaluatePriceExit, getTier, type TierName } from './price-exit'

// ── Types ────────────────────────────────────────────────────────

export type PaperTrade = {
  conditionId: string
  title: string
  side: 'YES' | 'NO'
  entryPrice: number
  curPrice: number
  sizeUsdc: number
  shares: number
  sharesRemaining: number
  score: number
  openedAt: number
  tier: TierName
  partial1Done: boolean
  partial2Done: boolean
  status: 'open' | 'won' | 'lost'
  closedAt: number | null
  exitReason: string | null
  realizedPnl: number
}

export type PaperSignal = {
  conditionId: string
  title: string
  side: 'YES' | 'NO'
  price: number      // bid price (what we'd sell at)
  askPrice: number    // ask price (what we'd buy at) — realistic entry
  score: number
}

export type PaperStats = {
  openCount: number
  totalWins: number
  totalLosses: number
  totalPnl: number
  winRate: string
}

// ── State ────────────────────────────────────────────────────────

const trades: PaperTrade[] = []
const cooldowns = new Map<string, number>()

let totalPnl = 0
let totalWins = 0
let totalLosses = 0

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000

// ── Open trades ─────────────────────────────────────────────────

export function openPaperTrade(
  signal: PaperSignal,
  betSize: number,
  maxPositions: number,
): boolean {
  const now = Date.now()
  const openCount = trades.filter(t => t.status === 'open').length

  if (openCount >= maxPositions) return false
  if (trades.some(t => t.status === 'open' && t.conditionId === signal.conditionId)) return false

  const cd = cooldowns.get(signal.conditionId) ?? 0
  if (now < cd) return false

  // Entry at ask price (realistic — you pay the spread to get in)
  const entryPrice = signal.askPrice
  const shares = betSize / entryPrice
  const tier = getTier(entryPrice)

  trades.push({
    conditionId: signal.conditionId,
    title: signal.title,
    side: signal.side,
    entryPrice,
    curPrice: signal.price,  // current value = bid (what we'd sell at)
    sizeUsdc: betSize,
    shares,
    sharesRemaining: shares,
    score: signal.score,
    openedAt: now,
    tier,
    partial1Done: false,
    partial2Done: false,
    status: 'open',
    closedAt: null,
    exitReason: null,
    realizedPnl: 0,
  })

  return true
}

// ── Update prices ───────────────────────────────────────────────

export function updatePrice(conditionId: string, yesPrice: number): void {
  for (const trade of trades) {
    if (trade.status !== 'open' || trade.conditionId !== conditionId) continue
    trade.curPrice = trade.side === 'YES' ? yesPrice : 1 - yesPrice
  }
}

// ── Run exits ───────────────────────────────────────────────────

export type ExitEvent = {
  trade: PaperTrade
  action: 'partial' | 'close'
  reason: string
  pnlPct: number
  pnlUsdc: number
  sellFraction: number
}

export function runExits(): ExitEvent[] {
  const now = Date.now()
  const events: ExitEvent[] = []

  for (const trade of trades) {
    if (trade.status !== 'open') continue

    const ageHours = (now - trade.openedAt) / (1000 * 60 * 60)
    const decision = evaluatePriceExit(
      trade.entryPrice, trade.curPrice, ageHours,
      trade.tier, trade.partial1Done, trade.partial2Done,
    )

    if (decision.action === 'hold') continue

    const pnlPct = (trade.curPrice - trade.entryPrice) / trade.entryPrice

    if (decision.action === 'partial') {
      const sellShares = trade.sharesRemaining * decision.sellFraction
      const sellPnl = sellShares * (trade.curPrice - trade.entryPrice)
      trade.sharesRemaining -= sellShares
      trade.realizedPnl += sellPnl

      if (decision.reason.includes(String(trade.tier === 'longshot' ? 100 : trade.tier === 'sweet' ? 50 : 30))) {
        trade.partial1Done = true
      } else {
        trade.partial2Done = true
      }

      // Mark partial1 or partial2 based on which triggered
      if (!trade.partial1Done) trade.partial1Done = true
      else trade.partial2Done = true

      events.push({ trade, action: 'partial', reason: decision.reason, pnlPct, pnlUsdc: sellPnl, sellFraction: decision.sellFraction })
    }

    if (decision.action === 'close') {
      const remainingPnl = trade.sharesRemaining * (trade.curPrice - trade.entryPrice)
      trade.realizedPnl += remainingPnl
      trade.sharesRemaining = 0
      trade.status = trade.realizedPnl >= 0 ? 'won' : 'lost'
      trade.closedAt = now
      trade.exitReason = decision.reason

      totalPnl += trade.realizedPnl
      if (trade.status === 'won') totalWins++
      else totalLosses++

      cooldowns.set(trade.conditionId, now + DEFAULT_COOLDOWN_MS)

      events.push({ trade, action: 'close', reason: decision.reason, pnlPct, pnlUsdc: trade.realizedPnl, sellFraction: 1 })
    }
  }

  return events
}

// ── Getters ─────────────────────────────────────────────────────

export function getOpenTrades(): PaperTrade[] {
  return trades.filter(t => t.status === 'open')
}

export function getAllTrades(): PaperTrade[] {
  return trades
}

export function getStats(): PaperStats {
  const total = totalWins + totalLosses
  return {
    openCount: trades.filter(t => t.status === 'open').length,
    totalWins,
    totalLosses,
    totalPnl,
    winRate: total > 0 ? `${((totalWins / total) * 100).toFixed(0)}%` : '-',
  }
}
