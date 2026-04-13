import { NextResponse } from 'next/server'
import { fetchWalletEquity } from '@/lib/on-chain'
import { classifyMarket } from '@/lib/classifier'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  try {
    const w = await fetchWalletEquity()

    const startingBalance = parseFloat(process.env.STARTING_BALANCE ?? '9')

    // ── Domain breakdown from closed trades (classify titles) ────
    const domainMap = new Map<string, { pnl: number; trades: number; won: number }>()
    for (const t of w.closedTrades) {
      const cls = await classifyMarket(t.title)
      const domain = cls?.domain?.replace('pm-domain/', '') ?? 'unknown'
      const existing = domainMap.get(domain) ?? { pnl: 0, trades: 0, won: 0 }
      existing.pnl += t.pnl
      existing.trades++
      if (t.result === 'won') existing.won++
      domainMap.set(domain, existing)
    }
    const domains = [...domainMap.entries()]
      .map(([domain, stats]) => ({
        domain,
        ...stats,
        winRate: stats.trades > 0 ? stats.won / stats.trades : 0,
        avgPnl: stats.trades > 0 ? stats.pnl / stats.trades : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl)

    // ── Side breakdown ──────────────────────────────────────────
    const bySide = {
      yes: { trades: 0, won: 0, winRate: 0, pnl: 0 },
      no: { trades: 0, won: 0, winRate: 0, pnl: 0 },
    }
    for (const t of w.closedTrades) {
      const s = t.side === 'YES' ? bySide.yes : bySide.no
      s.trades++
      s.pnl += t.pnl
      if (t.result === 'won') s.won++
    }
    bySide.yes.winRate = bySide.yes.trades > 0 ? bySide.yes.won / bySide.yes.trades : 0
    bySide.no.winRate = bySide.no.trades > 0 ? bySide.no.won / bySide.no.trades : 0

    // ── Best / Worst trades ─────────────────────────────────────
    const sorted = [...w.closedTrades].sort((a, b) => b.pnl - a.pnl)
    const bestTrades = sorted.slice(0, 5)
    const worstTrades = sorted.slice(-5).reverse()

    // ── Risk metrics (from current state) ───────────────────────
    const topPos = w.openPositions.length > 0
      ? Math.max(...w.openPositions.map(p => p.value)) / (w.totalEquity || 1)
      : 0
    const top3 = w.openPositions.length >= 3
      ? w.openPositions.map(p => p.value).sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0) / (w.totalEquity || 1)
      : topPos
    const cashPct = w.totalEquity > 0 ? w.usdc / w.totalEquity : 1

    return NextResponse.json({
      // Core metrics (on-chain)
      totalEquity: w.totalEquity,
      usdc: w.usdc,
      positionsValue: w.positionsValue,
      realizedPnl: w.realizedPnl,
      unrealizedPnl: w.unrealizedPnl,
      wins: w.wins,
      losses: w.losses,
      winRate: w.winRate,
      totalTrades: w.totalTrades,
      startingBalance,
      roi: startingBalance > 0 ? (w.totalEquity - startingBalance) / startingBalance : 0,

      // Positions
      openPositions: w.openPositions,
      pendingRedeem: w.pendingRedeem,
      pendingRedeemValue: w.pendingRedeemValue,
      closedTrades: w.closedTrades,

      // Analytics (computed from on-chain data)
      domains,
      bySide,
      bestTrades,
      worstTrades,
      risk: {
        topConcentration: topPos,
        top3Concentration: top3,
        openCount: w.openPositions.length,
        cashPct,
      },

      fetchedAt: w.fetchedAt,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
