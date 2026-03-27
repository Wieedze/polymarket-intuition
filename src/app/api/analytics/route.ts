import { NextResponse } from 'next/server'
import { getAllPaperTrades, getPortfolioSetting, type PaperTrade } from '@/lib/db'
import { getAllExpertTrust } from '@/lib/expert-trust'

function pnlOf(trades: PaperTrade[]): number {
  return trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
}

function groupBy(trades: PaperTrade[], key: (t: PaperTrade) => string): Record<string, PaperTrade[]> {
  const map: Record<string, PaperTrade[]> = {}
  for (const t of trades) {
    const k = key(t)
    if (!map[k]) map[k] = []
    map[k].push(t)
  }
  return map
}

// ── Statistical helpers ───────────────────────────────────────────

function profitFactor(trades: PaperTrade[]): number {
  let wins = 0
  let losses = 0
  for (const t of trades) {
    if ((t.pnl ?? 0) > 0) wins += t.pnl ?? 0
    else losses += Math.abs(t.pnl ?? 0)
  }
  if (losses === 0) return wins > 0 ? 999 : 0
  return wins / losses
}

function maxConsecutiveLosses(trades: PaperTrade[]): number {
  const sorted = [...trades].sort((a, b) =>
    (a.resolvedAt ?? a.openedAt).localeCompare(b.resolvedAt ?? b.openedAt)
  )
  let max = 0
  let current = 0
  for (const t of sorted) {
    if (t.status === 'lost') { current++; if (current > max) max = current }
    else current = 0
  }
  return max
}

function wilsonCI(wins: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 }
  const z = 1.96
  const p = wins / n
  const center = (p + z * z / (2 * n)) / (1 + z * z / n)
  const margin = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)
  return {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  }
}

function buildEquityCurve(closed: PaperTrade[], startBal: number) {
  const byDay = new Map<string, PaperTrade[]>()
  for (const t of closed) {
    const day = (t.resolvedAt ?? t.openedAt).slice(0, 10)
    const existing = byDay.get(day) ?? []
    existing.push(t)
    byDay.set(day, existing)
  }
  const days = [...byDay.keys()].sort()
  let cumulative = startBal
  let peak = startBal
  let maxDrawdown = 0

  const curve = days.map((day) => {
    const trades = byDay.get(day)!
    const dailyPnl = pnlOf(trades)
    cumulative += dailyPnl
    if (cumulative > peak) peak = cumulative
    const dd = peak > 0 ? (peak - cumulative) / peak : 0
    if (dd > maxDrawdown) maxDrawdown = dd
    return { day, balance: cumulative, dailyPnl, trades: trades.length }
  })

  return { curve, maxDrawdown }
}

type DomainStat = {
  domain: string
  trades: number
  won: number
  lost: number
  winRate: number
  pnl: number
  avgPnl: number
}

type ExpertStat = {
  expert: string
  trades: number
  won: number
  lost: number
  winRate: number
  pnl: number
  avgPnl: number
}

type EntryBucket = {
  label: string
  trades: number
  won: number
  winRate: number
  pnl: number
}

export async function GET(): Promise<NextResponse> {
  try {
    const all = getAllPaperTrades()
    const open = all.filter((t) => t.status === 'open')
    const closed = all.filter((t) => t.status !== 'open')
    const won = closed.filter((t) => t.status === 'won')
    const lost = closed.filter((t) => t.status === 'lost')

    const startBal = parseFloat(getPortfolioSetting('starting_balance', '10000'))
    const POLYMARKET_FEE_RATE = 0.02

    // Partial exit PnL from still-open trades (booked profit not yet in closed trades)
    const partialExitsPnl = open.reduce((s, t) =>
      s + t.partialExits.reduce((ps, e) => ps + e.pnl, 0), 0)
    const realizedPnl = pnlOf(closed) + partialExitsPnl

    // Remaining cost basis for open positions (accounts for partial exits returning capital)
    const totalInvested = open.reduce((s, t) => {
      const fraction = t.sharesRemaining != null && t.shares > 0 ? t.sharesRemaining / t.shares : 1
      return s + t.simulatedUsdc * fraction
    }, 0)

    // What you'd actually get if you sold all open positions right now (after 2% exit fee)
    const totalRedeemable = open.reduce((s, t) => {
      if (t.curPrice == null) return s
      const sharesNow = t.sharesRemaining ?? t.shares
      return s + sharesNow * t.curPrice * (1 - POLYMARKET_FEE_RATE)
    }, 0)

    // True unrealized: proceeds if sold now minus remaining cost basis
    const unrealizedPnl = open.reduce((s, t) => {
      if (t.curPrice == null) return s
      const sharesNow = t.sharesRemaining ?? t.shares
      const fraction = t.shares > 0 ? sharesNow / t.shares : 1
      const costBasis = t.simulatedUsdc * fraction
      return s + sharesNow * t.curPrice * (1 - POLYMARKET_FEE_RATE) - costBasis
    }, 0)

    const availableCash = startBal + realizedPnl - totalInvested

    // Trading duration
    const allDates = all.map((t) => new Date(t.openedAt).getTime())
    const firstTradeAt = allDates.length > 0 ? Math.min(...allDates) : Date.now()
    const tradingDays = Math.max((Date.now() - firstTradeAt) / (1000 * 60 * 60 * 24), 1)

    // Average hold time for closed trades
    const tradesWithHold = closed.filter((t) => t.resolvedAt != null)
    const avgHoldDays = tradesWithHold.length > 0
      ? tradesWithHold.reduce((s, t) => {
          const ms = new Date(t.resolvedAt!).getTime() - new Date(t.openedAt).getTime()
          return s + ms / (1000 * 60 * 60 * 24)
        }, 0) / tradesWithHold.length
      : 0

    // By domain
    const byDomainMap = groupBy(closed, (t) => t.domain ?? 'unknown')
    const byDomain: DomainStat[] = Object.entries(byDomainMap)
      .map(([domain, trades]) => {
        const w = trades.filter((t) => t.status === 'won').length
        const l = trades.filter((t) => t.status === 'lost').length
        const pnl = pnlOf(trades)
        return {
          domain: domain.replace('pm-domain/', ''),
          trades: trades.length,
          won: w,
          lost: l,
          winRate: trades.length > 0 ? w / trades.length : 0,
          pnl,
          avgPnl: trades.length > 0 ? pnl / trades.length : 0,
        }
      })
      .sort((a, b) => b.pnl - a.pnl)

    // By expert
    const byExpertMap = groupBy(closed, (t) => t.copiedLabel ?? t.copiedFrom.slice(0, 12))
    const byExpert: ExpertStat[] = Object.entries(byExpertMap)
      .map(([expert, trades]) => {
        const w = trades.filter((t) => t.status === 'won').length
        const l = trades.filter((t) => t.status === 'lost').length
        const pnl = pnlOf(trades)
        return {
          expert: expert.length > 25 ? expert.slice(0, 22) + '...' : expert,
          trades: trades.length,
          won: w,
          lost: l,
          winRate: trades.length > 0 ? w / trades.length : 0,
          pnl,
          avgPnl: trades.length > 0 ? pnl / trades.length : 0,
        }
      })
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 20)

    // By side
    const yesTrades = closed.filter((t) => t.side === 'YES')
    const noTrades = closed.filter((t) => t.side === 'NO')
    const bySide = {
      yes: {
        trades: yesTrades.length,
        won: yesTrades.filter((t) => t.status === 'won').length,
        winRate: yesTrades.length > 0 ? yesTrades.filter((t) => t.status === 'won').length / yesTrades.length : 0,
        pnl: pnlOf(yesTrades),
      },
      no: {
        trades: noTrades.length,
        won: noTrades.filter((t) => t.status === 'won').length,
        winRate: noTrades.length > 0 ? noTrades.filter((t) => t.status === 'won').length / noTrades.length : 0,
        pnl: pnlOf(noTrades),
      },
    }

    // Entry price buckets — with expected WR (market implied) vs actual WR (our edge)
    const buckets = [
      { label: '15-30¢ longshot', min: 0.15, max: 0.30, expectedWR: 0.225 },
      { label: '30-50¢ value',    min: 0.30, max: 0.50, expectedWR: 0.40  },
      { label: '50-65¢ mid',      min: 0.50, max: 0.65, expectedWR: 0.575 },
    ]
    const byEntry: EntryBucket[] = buckets
      .map((b) => {
        const trades = closed.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max)
        const w = trades.filter((t) => t.status === 'won').length
        const actualWR = trades.length > 0 ? w / trades.length : 0
        // True expected WR = average entry price in this bucket (market's implied probability)
        const avgEntry = trades.length > 0
          ? trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length
          : b.expectedWR
        return {
          label: b.label,
          trades: trades.length,
          won: w,
          winRate: actualWR,
          expectedWinRate: avgEntry,  // market's implied probability at entry
          implicitEdge: actualWR - avgEntry,  // our actual edge vs market
          pnl: pnlOf(trades),
        }
      })
      .filter((b) => b.trades > 0)

    // Bet size analysis (consensus proxy)
    const smallBets = closed.filter((t) => t.simulatedUsdc <= 100)
    const bigBets = closed.filter((t) => t.simulatedUsdc > 100)
    const byBetSize = {
      standard: {
        trades: smallBets.length,
        won: smallBets.filter((t) => t.status === 'won').length,
        winRate: smallBets.length > 0 ? smallBets.filter((t) => t.status === 'won').length / smallBets.length : 0,
        pnl: pnlOf(smallBets),
      },
      consensus: {
        trades: bigBets.length,
        won: bigBets.filter((t) => t.status === 'won').length,
        winRate: bigBets.length > 0 ? bigBets.filter((t) => t.status === 'won').length / bigBets.length : 0,
        pnl: pnlOf(bigBets),
      },
    }

    // Trading costs — scoped to CLOSED trades only so preCostPnl is consistent with realizedPnl
    // (open trade fees are not yet realized so must not be mixed with realized P&L)
    function estimateSlippage(entryPrice: number, betAmount: number): number {
      const base = entryPrice < 0.20 ? 0.06 : entryPrice < 0.30 ? 0.05 : entryPrice < 0.50 ? 0.03 : 0.02
      const sizeImpact = (betAmount / 100) * 0.005
      return base + sizeImpact
    }

    const closedEntryFees = closed.reduce((s, t) => s + t.simulatedUsdc * POLYMARKET_FEE_RATE, 0)
    const closedExitFees = closed.reduce((s, t) => {
      if (t.exitPrice == null) return s
      return s + t.shares * t.exitPrice * POLYMARKET_FEE_RATE
    }, 0)
    const closedSlippage = closed.reduce((s, t) => s + estimateSlippage(t.entryPrice, t.simulatedUsdc) * t.simulatedUsdc, 0)

    // For display: show all-trades fees (what the bot has spent total including open positions)
    const totalEntryFees = all.reduce((s, t) => s + t.simulatedUsdc * POLYMARKET_FEE_RATE, 0)
    const totalExitFees = closedExitFees
    const totalFees = totalEntryFees + totalExitFees
    const totalSlippage = all.reduce((s, t) => s + estimateSlippage(t.entryPrice, t.simulatedUsdc) * t.simulatedUsdc, 0)
    const totalCost = totalFees + totalSlippage
    const totalDeployed = all.reduce((s, t) => s + t.simulatedUsdc, 0)

    // Pre-cost alpha: same scope as Net — closed trades + partial exits from open trades
    // Partial exit fees: estimate from the partial exits themselves (2% on proceeds)
    const partialFees = open.reduce((s, t) =>
      s + t.partialExits.reduce((ps, e) => ps + Math.abs(e.pnl) * POLYMARKET_FEE_RATE, 0), 0)
    const partialSlippage = open.reduce((s, t) =>
      s + t.partialExits.reduce((ps, e) => ps + estimateSlippage(t.entryPrice, t.simulatedUsdc) * t.simulatedUsdc * e.pct, 0), 0)
    const preCostPnl = realizedPnl + closedEntryFees + closedExitFees + closedSlippage + partialFees + partialSlippage

    const costs = {
      totalEntryFees,
      totalExitFees,
      totalFees,
      totalSlippage,
      totalCost,
      preCostPnl,
      costPct: totalDeployed > 0 ? totalCost / totalDeployed : 0,
      feePct: totalDeployed > 0 ? totalFees / totalDeployed : 0,
      slippagePct: totalDeployed > 0 ? totalSlippage / totalDeployed : 0,
      totalDeployed,
    }

    // Best and worst trades
    const bestTrades = [...closed].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)).slice(0, 5).map((t) => ({
      title: t.title, side: t.side, entryPrice: t.entryPrice, pnl: t.pnl ?? 0,
      expert: t.copiedLabel ?? t.copiedFrom.slice(0, 10), domain: t.domain?.replace('pm-domain/', '') ?? '?',
    }))
    const worstTrades = [...closed].sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0)).slice(0, 5).map((t) => ({
      title: t.title, side: t.side, entryPrice: t.entryPrice, pnl: t.pnl ?? 0,
      expert: t.copiedLabel ?? t.copiedFrom.slice(0, 10), domain: t.domain?.replace('pm-domain/', '') ?? '?',
    }))

    // Open positions
    const topOpen = [...open]
      .map((t) => ({
        title: t.title,
        side: t.side,
        entryPrice: t.entryPrice,
        curPrice: t.curPrice ?? t.entryPrice,
        unrealized: t.curPrice != null ? t.shares * (t.curPrice - t.entryPrice) : 0,
        expert: t.copiedLabel ?? t.copiedFrom.slice(0, 10),
        domain: t.domain?.replace('pm-domain/', '') ?? '?',
      }))
      .sort((a, b) => b.unrealized - a.unrealized)
      .slice(0, 10)

    // ── Validation gates ─────────────────────────────────────────
    const pf = profitFactor(closed)
    const mcl = maxConsecutiveLosses(closed)
    const avgPnl = closed.length > 0 ? pnlOf(closed) / closed.length : 0
    const wrCI = wilsonCI(won.length, closed.length)
    const { curve: equityCurve, maxDrawdown } = buildEquityCurve(closed, startBal)

    const gates = {
      profitFactor: { value: pf, threshold: 1.3, ok: pf >= 1.3 },
      maxConsecutiveLosses: { value: mcl, threshold: 15, ok: mcl <= 15 },
      avgPnlPerTrade: { value: avgPnl, threshold: 5, ok: avgPnl >= 5 },
      minResolvedTrades: { value: closed.length, threshold: 4000, ok: closed.length >= 4000 },
      allOk: pf >= 1.3 && mcl <= 15 && avgPnl >= 5 && closed.length >= 4000,
    }

    const significance =
      closed.length < 100 ? 'not_significant' :
      closed.length < 1000 ? 'low' :
      closed.length < 4000 ? 'medium' : 'high'

    return NextResponse.json({
      portfolio: {
        startingBalance: startBal,
        currentBalance: startBal + realizedPnl,
        realizedPnl,
        partialExitsPnl,
        unrealizedPnl,
        totalInvested,
        availableCash,
        totalRedeemable,
        roi: startBal > 0 ? realizedPnl / startBal : 0,
        tradingDays: Math.round(tradingDays * 10) / 10,
        avgHoldDays: Math.round(avgHoldDays * 10) / 10,
        totalTrades: all.length,
        openTrades: open.length,
        closedTrades: closed.length,
        wins: won.length,
        losses: lost.length,
        winRate: closed.length > 0 ? won.length / closed.length : 0,
      },
      gates,
      stats: {
        profitFactor: pf,
        maxConsecutiveLosses: mcl,
        avgPnlPerTrade: avgPnl,
        maxDrawdown,
        significance,
        winRateCI: wrCI,
        grossWins: closed.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0),
        grossLosses: closed.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0),
      },
      equityCurve,
      byDomain,
      byExpert,
      bySide,
      byEntry,
      byBetSize,
      costs,
      bestTrades,
      worstTrades,
      topOpen,
      expertTrust: getAllExpertTrust().map((t) => ({
        expert: t.label ?? t.wallet.slice(0, 12),
        phase: t.phase,
        status: t.status,
        trustLevel: t.trustLevel,
        resolvedTrades: t.resolvedTrades,
        winRate: t.winRate,
        pnl: t.pnl,
        reason: t.reason,
      })),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
