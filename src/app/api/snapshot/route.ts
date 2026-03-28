import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { getAllPaperTrades, getPortfolioSetting, getRecentBotEvents, type PaperTrade } from '@/lib/db'
import { getAllExpertTrustFromTrades } from '@/lib/expert-trust'

// ── Helpers (pure functions, no DB) ─────────────────────────────────

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

function profitFactor(trades: PaperTrade[]): number {
  let wins = 0, losses = 0
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
  let max = 0, current = 0
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
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) }
}

function estimateSlippage(entryPrice: number, betAmount: number): number {
  const base = entryPrice < 0.20 ? 0.06 : entryPrice < 0.30 ? 0.05 : entryPrice < 0.50 ? 0.03 : 0.02
  const sizeImpact = (betAmount / 100) * 0.005
  return base + sizeImpact
}

// ── GET: unified snapshot ──────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  try {
    // ONE DB call for all trades
    const all = getAllPaperTrades()
    const open = all.filter((t) => t.status === 'open')
    const closed = all.filter((t) => t.status !== 'open')
    const won = closed.filter((t) => t.status === 'won')
    const lost = closed.filter((t) => t.status === 'lost')

    const startBal = parseFloat(getPortfolioSetting('starting_balance', '10000'))
    const betSizeUsdc = parseFloat(getPortfolioSetting('bet_size_usdc', '100'))
    const FEE = 0.02

    // ── Shared portfolio metrics ────────────────────────────────────

    const partialExitsPnl = open.reduce((s, t) =>
      s + t.partialExits.reduce((ps, e) => ps + e.pnl, 0), 0)
    const realizedPnl = pnlOf(closed) + partialExitsPnl

    const totalInvested = open.reduce((s, t) => {
      const fraction = t.sharesRemaining != null && t.shares > 0 ? t.sharesRemaining / t.shares : 1
      return s + t.simulatedUsdc * fraction
    }, 0)

    const totalRedeemable = open.reduce((s, t) => {
      if (t.curPrice == null) return s
      const sharesNow = t.sharesRemaining ?? t.shares
      return s + sharesNow * t.curPrice * (1 - FEE)
    }, 0)

    const unrealizedPnl = open.reduce((s, t) => {
      if (t.curPrice == null) return s
      const sharesNow = t.sharesRemaining ?? t.shares
      const fraction = t.shares > 0 ? sharesNow / t.shares : 1
      return s + sharesNow * t.curPrice * (1 - FEE) - t.simulatedUsdc * fraction
    }, 0)

    const availableCash = startBal + realizedPnl - totalInvested
    const totalEquity = availableCash + totalRedeemable

    // Trading duration
    const allDates = all.map((t) => new Date(t.openedAt).getTime())
    const firstTradeAt = allDates.length > 0 ? Math.min(...allDates) : Date.now()
    const tradingDays = Math.max((Date.now() - firstTradeAt) / (1000 * 60 * 60 * 24), 1)

    const tradesWithHold = closed.filter((t) => t.resolvedAt != null)
    const avgHoldDays = tradesWithHold.length > 0
      ? tradesWithHold.reduce((s, t) =>
          s + (new Date(t.resolvedAt!).getTime() - new Date(t.openedAt).getTime()) / (1000 * 60 * 60 * 24), 0
        ) / tradesWithHold.length
      : 0

    const portfolio = {
      startingBalance: startBal,
      currentBalance: startBal + realizedPnl,
      realizedPnl,
      partialExitsPnl,
      unrealizedPnl,
      totalInvested,
      availableCash,
      totalRedeemable,
      totalEquity,
      betSizeUsdc,
      roi: startBal > 0 ? realizedPnl / startBal : 0,
      tradingDays: Math.round(tradingDays * 10) / 10,
      avgHoldDays: Math.round(avgHoldDays * 10) / 10,
      totalTrades: all.length,
      openTrades: open.length,
      closedTrades: closed.length,
      wins: won.length,
      losses: lost.length,
      winRate: closed.length > 0 ? won.length / closed.length : 0,
    }

    // ── Dashboard chart data ────────────────────────────────────────

    const dailyMap = new Map<string, { pnl: number; trades: number; wins: number }>()
    for (const t of closed) {
      if (!t.resolvedAt) continue
      const date = t.resolvedAt.slice(0, 10)
      const existing = dailyMap.get(date) ?? { pnl: 0, trades: 0, wins: 0 }
      existing.pnl += t.pnl ?? 0
      existing.trades++
      if (t.status === 'won') existing.wins++
      dailyMap.set(date, existing)
    }

    const sortedDays = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    let cumPnl = 0
    const chartData = sortedDays.map(([date, day], i) => {
      cumPnl += day.pnl
      const lookback = sortedDays.slice(Math.max(0, i - 19), i + 1)
      const lbWins = lookback.reduce((s, [, d]) => s + d.wins, 0)
      const lbTotal = lookback.reduce((s, [, d]) => s + d.trades, 0)
      return {
        date,
        equity: startBal + cumPnl,
        dailyPnl: day.pnl,
        cumPnl,
        trades: day.trades,
        winRate: lbTotal > 0 ? Math.round((lbWins / lbTotal) * 100) : 0,
      }
    })

    // Events
    const events = getRecentBotEvents(20)

    // ── By domain ───────────────────────────────────────────────────

    const byDomainMap = groupBy(closed, (t) => t.domain ?? 'unknown')
    const byDomain = Object.entries(byDomainMap)
      .map(([domain, trades]) => {
        const w = trades.filter((t) => t.status === 'won').length
        const l = trades.filter((t) => t.status === 'lost').length
        const pnl = pnlOf(trades)
        return {
          domain: domain.replace('pm-domain/', ''),
          trades: trades.length, won: w, lost: l,
          winRate: trades.length > 0 ? w / trades.length : 0,
          pnl, avgPnl: trades.length > 0 ? pnl / trades.length : 0,
        }
      })
      .sort((a, b) => b.pnl - a.pnl)

    // ── By expert ───────────────────────────────────────────────────

    const byExpertMap = groupBy(closed, (t) => t.copiedLabel ?? t.copiedFrom.slice(0, 12))
    const byExpert = Object.entries(byExpertMap)
      .map(([expert, trades]) => {
        const w = trades.filter((t) => t.status === 'won').length
        const l = trades.filter((t) => t.status === 'lost').length
        const pnl = pnlOf(trades)
        return {
          expert: expert.length > 25 ? expert.slice(0, 22) + '...' : expert,
          trades: trades.length, won: w, lost: l,
          winRate: trades.length > 0 ? w / trades.length : 0,
          pnl, avgPnl: trades.length > 0 ? pnl / trades.length : 0,
        }
      })
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 20)

    // ── By side ─────────────────────────────────────────────────────

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

    // ── By entry price ──────────────────────────────────────────────

    const buckets = [
      { label: '15-30¢ longshot', min: 0.15, max: 0.30, expectedWR: 0.225 },
      { label: '30-50¢ value',    min: 0.30, max: 0.50, expectedWR: 0.40  },
      { label: '50-65¢ mid',      min: 0.50, max: 0.65, expectedWR: 0.575 },
    ]
    const byEntry = buckets
      .map((b) => {
        const trades = closed.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max)
        const w = trades.filter((t) => t.status === 'won').length
        const actualWR = trades.length > 0 ? w / trades.length : 0
        const avgEntry = trades.length > 0
          ? trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length
          : b.expectedWR
        return {
          label: b.label, trades: trades.length, won: w,
          winRate: actualWR, expectedWinRate: avgEntry,
          implicitEdge: actualWR - avgEntry, pnl: pnlOf(trades),
        }
      })
      .filter((b) => b.trades > 0)

    // ── By bet size ─────────────────────────────────────────────────

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

    // ── Trading costs ───────────────────────────────────────────────

    const closedEntryFees = closed.reduce((s, t) => s + t.simulatedUsdc * FEE, 0)
    const closedExitFees = closed.reduce((s, t) => {
      if (t.exitPrice == null) return s
      return s + t.shares * t.exitPrice * FEE
    }, 0)
    const closedSlippage = closed.reduce((s, t) => s + estimateSlippage(t.entryPrice, t.simulatedUsdc) * t.simulatedUsdc, 0)
    const totalEntryFees = all.reduce((s, t) => s + t.simulatedUsdc * FEE, 0)
    const totalExitFees = closedExitFees
    const totalFees = totalEntryFees + totalExitFees
    const totalSlippage = all.reduce((s, t) => s + estimateSlippage(t.entryPrice, t.simulatedUsdc) * t.simulatedUsdc, 0)
    const totalCost = totalFees + totalSlippage
    const totalDeployed = all.reduce((s, t) => s + t.simulatedUsdc, 0)

    const partialFees = open.reduce((s, t) =>
      s + t.partialExits.reduce((ps, e) => ps + Math.abs(e.pnl) * FEE, 0), 0)
    const partialSlippage = open.reduce((s, t) =>
      s + t.partialExits.reduce((ps, e) => ps + estimateSlippage(t.entryPrice, t.simulatedUsdc) * t.simulatedUsdc * e.pct, 0), 0)
    const preCostPnl = realizedPnl + closedEntryFees + closedExitFees + closedSlippage + partialFees + partialSlippage

    const costs = {
      totalEntryFees, totalExitFees, totalFees, totalSlippage, totalCost,
      preCostPnl,
      costPct: totalDeployed > 0 ? totalCost / totalDeployed : 0,
      feePct: totalDeployed > 0 ? totalFees / totalDeployed : 0,
      slippagePct: totalDeployed > 0 ? totalSlippage / totalDeployed : 0,
      totalDeployed,
    }

    // ── Best / worst / top open ─────────────────────────────────────

    const mapTradeSummary = (t: PaperTrade): { title: string; side: string; entryPrice: number; pnl: number; expert: string; domain: string } => ({
      title: t.title, side: t.side, entryPrice: t.entryPrice, pnl: t.pnl ?? 0,
      expert: t.copiedLabel ?? t.copiedFrom.slice(0, 10), domain: t.domain?.replace('pm-domain/', '') ?? '?',
    })
    const bestTrades = [...closed].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)).slice(0, 5).map(mapTradeSummary)
    const worstTrades = [...closed].sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0)).slice(0, 5).map(mapTradeSummary)

    const topOpen = [...open]
      .map((t) => {
        const sharesNow = t.sharesRemaining ?? t.shares
        const fraction = t.shares > 0 ? sharesNow / t.shares : 1
        const unrealized = t.curPrice != null
          ? sharesNow * t.curPrice * (1 - FEE) - t.simulatedUsdc * fraction
          : 0
        return {
          title: t.title, side: t.side, entryPrice: t.entryPrice,
          curPrice: t.curPrice ?? t.entryPrice, unrealized,
          expert: t.copiedLabel ?? t.copiedFrom.slice(0, 10),
          domain: t.domain?.replace('pm-domain/', '') ?? '?',
        }
      })
      .sort((a, b) => b.unrealized - a.unrealized)
      .slice(0, 10)

    // ── Validation gates ────────────────────────────────────────────

    const pf = profitFactor(closed)
    const mcl = maxConsecutiveLosses(closed)
    const avgPnl = closed.length > 0 ? pnlOf(closed) / closed.length : 0
    const wrCI = wilsonCI(won.length, closed.length)

    // Analytics equity curve (with drawdown)
    const ecByDay = new Map<string, PaperTrade[]>()
    for (const t of closed) {
      const day = (t.resolvedAt ?? t.openedAt).slice(0, 10)
      const arr = ecByDay.get(day) ?? []
      arr.push(t)
      ecByDay.set(day, arr)
    }
    const ecDays = [...ecByDay.keys()].sort()
    let ecCum = startBal, ecPeak = startBal, maxDrawdown = 0
    const equityCurve = ecDays.map((day) => {
      const trades = ecByDay.get(day)!
      const dailyPnl = pnlOf(trades)
      ecCum += dailyPnl
      if (ecCum > ecPeak) ecPeak = ecCum
      const dd = ecPeak > 0 ? (ecPeak - ecCum) / ecPeak : 0
      if (dd > maxDrawdown) maxDrawdown = dd
      return { day, balance: ecCum, dailyPnl, trades: trades.length }
    })

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

    const stats = {
      profitFactor: pf,
      maxConsecutiveLosses: mcl,
      avgPnlPerTrade: avgPnl,
      maxDrawdown,
      significance,
      winRateCI: wrCI,
      grossWins: closed.filter(t => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0),
      grossLosses: closed.filter(t => (t.pnl ?? 0) < 0).reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0),
    }

    // ── Expert trust (no extra DB calls) ────────────────────────────

    const expertTrust = getAllExpertTrustFromTrades(all).map((t) => ({
      expert: t.label ?? t.wallet.slice(0, 12),
      phase: t.phase,
      status: t.status,
      trustLevel: t.trustLevel,
      resolvedTrades: t.resolvedTrades,
      winRate: t.winRate,
      pnl: t.pnl,
      reason: t.reason,
    }))

    // ── Return everything ───────────────────────────────────────────

    return NextResponse.json({
      portfolio,
      chartData,
      events,
      byDomain,
      byExpert,
      bySide,
      byEntry,
      byBetSize,
      costs,
      bestTrades,
      worstTrades,
      topOpen,
      gates,
      stats,
      equityCurve,
      expertTrust,
      trades: all,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
