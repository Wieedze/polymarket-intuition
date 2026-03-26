import { NextResponse } from 'next/server'
import { getAllPaperTrades, getPortfolioSetting, type PaperTrade } from '@/lib/db'

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
      byDomain,
      byExpert,
      bySide,
      byEntry,
      byBetSize,
      bestTrades,
      worstTrades,
      topOpen,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
