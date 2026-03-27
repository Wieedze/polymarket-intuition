import { NextResponse } from 'next/server'
import { getAllPaperTrades, getPortfolioSetting, getRecentBotEvents } from '@/lib/db'

export async function GET(): Promise<NextResponse> {
  try {
    const all = getAllPaperTrades()
    const open = all.filter((t) => t.status === 'open')
    const closed = all.filter((t) => t.status !== 'open')
    const won = closed.filter((t) => t.status === 'won')
    const lost = closed.filter((t) => t.status === 'lost')

    const startBal = parseFloat(getPortfolioSetting('starting_balance', '10000'))
    const POLYMARKET_FEE_RATE = 0.02

    const partialExitsPnl = open.reduce((s, t) =>
      s + t.partialExits.reduce((ps, e) => ps + e.pnl, 0), 0)
    const realizedPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0) + partialExitsPnl

    // Remaining cost basis — partial exits return capital so reduce proportionally
    const totalInvested = open.reduce((s, t) => {
      const fraction = t.sharesRemaining != null && t.shares > 0 ? t.sharesRemaining / t.shares : 1
      return s + t.simulatedUsdc * fraction
    }, 0)

    // True unrealized: proceeds if sold now (after 2% exit fee) minus remaining cost basis
    const unrealizedPnl = open.reduce((s, t) => {
      if (t.curPrice == null) return s
      const sharesNow = t.sharesRemaining ?? t.shares
      const fraction = t.shares > 0 ? sharesNow / t.shares : 1
      return s + sharesNow * t.curPrice * (1 - POLYMARKET_FEE_RATE) - t.simulatedUsdc * fraction
    }, 0)

    // ── Chart data: daily metrics ────────────────────────────────
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

    // Build chart data: equity curve + daily PnL + rolling win rate
    let cumPnl = 0
    let rollingWins = 0
    let rollingTotal = 0
    const chartData = sortedDays.map(([date, day], i) => {
      cumPnl += day.pnl
      rollingWins += day.wins
      rollingTotal += day.trades

      // Rolling win rate (all trades up to this point, or last 20 days)
      const lookback = sortedDays.slice(Math.max(0, i - 19), i + 1)
      const lbWins = lookback.reduce((s, [, d]) => s + d.wins, 0)
      const lbTotal = lookback.reduce((s, [, d]) => s + d.trades, 0)

      return {
        date,
        equity: startBal + cumPnl,      // equity curve
        dailyPnl: day.pnl,              // daily P&L (bars)
        cumPnl,                          // cumulative P&L
        trades: day.trades,              // trades resolved that day
        winRate: lbTotal > 0 ? Math.round((lbWins / lbTotal) * 100) : 0,  // rolling WR %
      }
    })

    // Recent events
    const events = getRecentBotEvents(20)

    // Top domains
    const domainPnl = new Map<string, { pnl: number; trades: number; won: number }>()
    for (const t of closed) {
      const d = t.domain ?? 'unknown'
      const existing = domainPnl.get(d) ?? { pnl: 0, trades: 0, won: 0 }
      existing.pnl += t.pnl ?? 0
      existing.trades++
      if (t.status === 'won') existing.won++
      domainPnl.set(d, existing)
    }
    const domains = [...domainPnl.entries()]
      .map(([domain, stats]) => ({
        domain: domain.replace('pm-domain/', ''),
        ...stats,
        winRate: stats.trades > 0 ? stats.won / stats.trades : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl)

    return NextResponse.json({
      balance: startBal + realizedPnl,
      startingBalance: startBal,
      realizedPnl,
      unrealizedPnl,
      totalInvested,
      totalEquity: startBal + realizedPnl - totalInvested + open.reduce((s, t) => {
        if (t.curPrice == null) return s
        const sharesNow = t.sharesRemaining ?? t.shares
        return s + sharesNow * t.curPrice * (1 - POLYMARKET_FEE_RATE)
      }, 0),
      winRate: closed.length > 0 ? won.length / closed.length : 0,
      wins: won.length,
      losses: lost.length,
      openTrades: open.length,
      totalTrades: all.length,
      roi: startBal > 0 ? realizedPnl / startBal : 0,
      chartData,
      events,
      domains,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
