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
    const realizedPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const unrealizedPnl = open.reduce((s, t) => {
      if (t.curPrice == null) return s
      return s + t.shares * (t.curPrice - t.entryPrice)
    }, 0)
    const totalInvested = open.reduce((s, t) => s + t.simulatedUsdc, 0)

    // PnL over time (daily cumulative)
    const resolvedByDate = new Map<string, number>()
    for (const t of closed) {
      if (!t.resolvedAt) continue
      const date = t.resolvedAt.slice(0, 10)
      resolvedByDate.set(date, (resolvedByDate.get(date) ?? 0) + (t.pnl ?? 0))
    }
    const sortedDates = [...resolvedByDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    let cumPnl = 0
    const pnlHistory = sortedDates.map(([date, pnl]) => {
      cumPnl += pnl
      return { date, pnl: cumPnl }
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
        return s + t.shares * t.curPrice
      }, 0),
      winRate: closed.length > 0 ? won.length / closed.length : 0,
      wins: won.length,
      losses: lost.length,
      openTrades: open.length,
      totalTrades: all.length,
      roi: startBal > 0 ? realizedPnl / startBal : 0,
      pnlHistory,
      events,
      domains,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
