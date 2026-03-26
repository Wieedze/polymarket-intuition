import { NextResponse, type NextRequest } from 'next/server'
import { getLeaderboard } from '@/lib/db'
import { fetchResolvedTrades } from '@/lib/polymarket'
import { classifyMarket } from '@/lib/classifier'
import {
  calculateWinRate,
  calculateCalibration,
  calculateConvictionScore,
  detectTradingStyle,
  calculateProfitFactor,
  calculateAvgPnlPerTrade,
  calculateMaxConsecutiveLosses,
  calculateCopyabilityScore,
} from '@/lib/scorer'
import type { DomainAtomValue } from '@/lib/atoms'
import type { ResolvedTrade } from '@/types/polymarket'

// ── Types ─────────────────────────────────────────────────────────

type DomainStats = {
  domain: string
  trades: number
  winRate: number
  calibration: number
  profitFactor: number
  avgPnlPerTrade: number
  maxConsecutiveLosses: number
  copyabilityScore: number
  convictionScore: number
  tradingStyle: string
  totalPnl: number
}

type LeaderboardWallet = {
  rank: number
  address: string
  userName: string
  pnl: number
  volume: number
  resolvedTrades: number
  classifiedTrades: number
  bestDomain: DomainStats | null
  topCopyability: number
  domains: DomainStats[]
}

// ── Helpers ───────────────────────────────────────────────────────

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function buildFromCache(period: string): LeaderboardWallet[] | null {
  try {
    const cached = getLeaderboard(period)
    if (cached.length === 0) return null

    return cached.map((entry) => {
      const domains: DomainStats[] = entry.stats.map((s) => {
        // Compute real copyabilityScore from available data
        // We don't have profitFactor or maxConsecLosses in cache, so estimate conservatively
        const winRateScore = Math.min(Math.max(s.winRate / 0.7, 0), 1)
        const calibrationScore = Math.min(Math.max((s.calibration - 0.5) / 0.5, 0), 1)
        // Estimate profitFactor from totalPnl: if positive → some edge, if negative → no edge
        const pnlPerTrade = s.totalPnl / Math.max(s.tradesCount, 1)
        const profitEstimate = s.totalPnl > 0 ? Math.min(pnlPerTrade / 50, 1) : 0
        // No streak data in cache — use neutral 0.5
        const streakEstimate = 0.5

        return {
          domain: s.domain,
          trades: s.tradesCount,
          winRate: s.winRate,
          calibration: s.calibration,
          profitFactor: 0,
          avgPnlPerTrade: pnlPerTrade,
          maxConsecutiveLosses: 0,
          copyabilityScore:
            winRateScore * 0.25 +
            calibrationScore * 0.25 +
            profitEstimate * 0.30 +
            streakEstimate * 0.20,
          convictionScore: s.avgConviction,
          tradingStyle: 'mixed',
          totalPnl: s.totalPnl,
        }
      })

      domains.sort((a, b) => b.copyabilityScore - a.copyabilityScore)
      const bestDomain = domains[0] ?? null

      return {
        rank: entry.rank,
        address: entry.wallet,
        userName: entry.userName || truncateAddress(entry.wallet),
        pnl: entry.pnl,
        volume: entry.volume,
        resolvedTrades: domains.reduce((s, d) => s + d.trades, 0),
        classifiedTrades: domains.reduce((s, d) => s + d.trades, 0),
        bestDomain,
        topCopyability: bestDomain?.copyabilityScore ?? 0,
        domains,
      }
    })
  } catch {
    return null
  }
}

async function computeLive(
  address: string
): Promise<{ resolvedTrades: number; classifiedTrades: number; domains: DomainStats[] }> {
  const walletTrades = await fetchResolvedTrades(address)

  if (walletTrades.trades.length === 0) {
    return { resolvedTrades: 0, classifiedTrades: 0, domains: [] }
  }

  const tradesByDomain = new Map<DomainAtomValue, ResolvedTrade[]>()

  for (const trade of walletTrades.trades) {
    const result = await classifyMarket(trade.marketQuestion)
    if (result) {
      const existing = tradesByDomain.get(result.domain) ?? []
      existing.push(trade)
      tradesByDomain.set(result.domain, existing)
    }
  }

  const domains: DomainStats[] = []

  for (const [domain, trades] of tradesByDomain) {
    domains.push({
      domain,
      trades: trades.length,
      winRate: calculateWinRate(trades),
      calibration: calculateCalibration(trades),
      profitFactor: calculateProfitFactor(trades),
      avgPnlPerTrade: calculateAvgPnlPerTrade(trades),
      maxConsecutiveLosses: calculateMaxConsecutiveLosses(trades),
      copyabilityScore: calculateCopyabilityScore(trades),
      convictionScore: calculateConvictionScore(trades),
      tradingStyle: detectTradingStyle(trades),
      totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
    })
  }

  domains.sort((a, b) => b.copyabilityScore - a.copyabilityScore)

  return {
    resolvedTrades: walletTrades.totalTrades,
    classifiedTrades: domains.reduce((s, d) => s + d.trades, 0),
    domains,
  }
}

// ── Route ─────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const timePeriod = request.nextUrl.searchParams.get('period') ?? 'MONTH'
  const limitParam = request.nextUrl.searchParams.get('limit') ?? '10'
  const limit = Math.min(Math.max(parseInt(limitParam, 10) || 10, 1), 20)
  const refresh = request.nextUrl.searchParams.get('refresh') === 'true'

  // Always compute live for consistent data with profile pages
  // Cache was producing inconsistent scores (missing profitFactor, maxConsecLosses)
  type LeaderboardEntry = {
    rank: string
    proxyWallet: string
    userName: string
    vol: number
    pnl: number
  }

  let leaderboard: LeaderboardEntry[]
  try {
    const res = await fetch(
      `https://data-api.polymarket.com/v1/leaderboard?limit=${limit}&timePeriod=${timePeriod}&orderBy=PNL`
    )
    if (!res.ok) throw new Error(`Leaderboard API: ${res.status}`)
    leaderboard = (await res.json()) as LeaderboardEntry[]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Leaderboard error: ${msg}` }, { status: 502 })
  }

  const results: LeaderboardWallet[] = []

  for (let i = 0; i < leaderboard.length; i += 3) {
    const batch = leaderboard.slice(i, i + 3)
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        try {
          const stats = await computeLive(entry.proxyWallet)
          const bestDomain = stats.domains[0] ?? null

          return {
            rank: parseInt(entry.rank, 10),
            address: entry.proxyWallet,
            userName: entry.userName || truncateAddress(entry.proxyWallet),
            pnl: entry.pnl,
            volume: entry.vol,
            resolvedTrades: stats.resolvedTrades,
            classifiedTrades: stats.classifiedTrades,
            bestDomain,
            topCopyability: bestDomain?.copyabilityScore ?? 0,
            domains: stats.domains,
          }
        } catch {
          return {
            rank: parseInt(entry.rank, 10),
            address: entry.proxyWallet,
            userName: entry.userName || truncateAddress(entry.proxyWallet),
            pnl: entry.pnl,
            volume: entry.vol,
            resolvedTrades: 0,
            classifiedTrades: 0,
            bestDomain: null,
            topCopyability: 0,
            domains: [],
          }
        }
      })
    )
    results.push(...batchResults)
  }

  results.sort((a, b) => b.topCopyability - a.topCopyability)

  return NextResponse.json({
    period: timePeriod,
    wallets: results,
    source: 'live',
    computedAt: new Date().toISOString(),
  })
}
