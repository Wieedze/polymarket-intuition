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
    const realizedPnl = pnlOf(closed)
    const unrealizedPnl = open.reduce((s, t) => {
      if (t.curPrice == null) return s
      return s + t.shares * (t.curPrice - t.entryPrice)
    }, 0)
    const totalInvested = open.reduce((s, t) => s + t.simulatedUsdc, 0)
    const availableCash = startBal + realizedPnl - totalInvested
    const totalRedeemable = open.reduce((s, t) => {
      if (t.curPrice == null) return s
      return s + t.shares * t.curPrice
    }, 0)

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

    // Entry price buckets
    const buckets = [
      { label: '15-30¢ longshot', min: 0.15, max: 0.30 },
      { label: '30-50¢ value', min: 0.30, max: 0.50 },
      { label: '50-70¢ mid', min: 0.50, max: 0.70 },
      { label: '70-90¢ favorite', min: 0.70, max: 0.90 },
    ]
    const byEntry: EntryBucket[] = buckets
      .map((b) => {
        const trades = closed.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max)
        const w = trades.filter((t) => t.status === 'won').length
        return {
          label: b.label,
          trades: trades.length,
          won: w,
          winRate: trades.length > 0 ? w / trades.length : 0,
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

    // Trading costs (fees + estimated slippage)
    const POLYMARKET_FEE = 0.02
    const totalEntryFees = all.reduce((s, t) => s + t.simulatedUsdc * POLYMARKET_FEE, 0)
    const totalExitFees = closed.reduce((s, t) => {
      if (t.exitPrice == null) return s
      return s + t.shares * t.exitPrice * POLYMARKET_FEE
    }, 0)
    const totalFees = totalEntryFees + totalExitFees

    // Slippage estimate based on entry price range (mirrors auto-trader logic)
    function estimateSlippage(entryPrice: number, betAmount: number): number {
      const base = entryPrice < 0.20 ? 0.06 : entryPrice < 0.30 ? 0.05 : entryPrice < 0.50 ? 0.03 : 0.02
      const sizeImpact = (betAmount / 100) * 0.005
      return base + sizeImpact
    }
    const totalSlippage = all.reduce((s, t) => s + estimateSlippage(t.entryPrice, t.simulatedUsdc) * t.simulatedUsdc, 0)
    const totalCost = totalFees + totalSlippage
    const totalDeployed = all.reduce((s, t) => s + t.simulatedUsdc, 0)

    // Pre-cost alpha = what we would have made without fees or slippage
    // Since fees and slippage are already baked into pnl, we add them back to get the gross
    const preCostPnl = realizedPnl + totalFees + totalSlippage

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
        unrealizedPnl,
        totalInvested,
        availableCash,
        totalRedeemable,
        roi: startBal > 0 ? realizedPnl / startBal : 0,
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
