import { NextResponse, type NextRequest } from 'next/server'
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
import { DOMAIN_ATOMS, type DomainAtomValue } from '@/lib/atoms'
import type { WalletReputation, DomainReputation } from '@/types/reputation'
import type { DomainAtom } from '@/types/attestation'
import type { ResolvedTrade } from '@/types/polymarket'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const address = request.nextUrl.searchParams.get('address')

  if (!address) {
    return NextResponse.json(
      { error: 'Missing required query param: address' },
      { status: 400 }
    )
  }

  // Step 1: Fetch trades live from Polymarket
  let walletTrades
  try {
    walletTrades = await fetchResolvedTrades(address)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: `Polymarket error: ${msg}` }, { status: 502 })
  }

  if (walletTrades.trades.length === 0) {
    return NextResponse.json({
      address,
      domains: [],
      totalTrades: 0,
      totalPnl: 0,
      totalAttestations: 0,
      computedAt: new Date().toISOString(),
    })
  }

  // Step 2: Classify each trade into a domain
  const tradesByDomain = new Map<DomainAtomValue, ResolvedTrade[]>()

  for (const trade of walletTrades.trades) {
    const result = await classifyMarket(trade.marketQuestion)
    if (result) {
      const existing = tradesByDomain.get(result.domain) ?? []
      existing.push(trade)
      tradesByDomain.set(result.domain, existing)
    }
  }

  // Step 3: Compute stats per domain
  const domains: DomainReputation[] = []

  for (const [domain, trades] of tradesByDomain) {
    const winRate = calculateWinRate(trades)
    const calibration = calculateCalibration(trades)
    const convictionScore = calculateConvictionScore(trades)
    const tradingStyle = detectTradingStyle(trades)
    const avgConviction =
      trades.reduce((sum, t) => {
        const prob = t.side === 'YES' ? t.entryPrice : 1 - t.entryPrice
        return sum + Math.abs(prob - 0.5) * 2
      }, 0) / trades.length
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0)

    domains.push({
      domain: domain as DomainAtom,
      winRate,
      trades: trades.length,
      calibration,
      avgConviction,
      convictionScore,
      tradingStyle,
      profitFactor: calculateProfitFactor(trades),
      avgPnlPerTrade: calculateAvgPnlPerTrade(trades),
      maxConsecutiveLosses: calculateMaxConsecutiveLosses(trades),
      copyabilityScore: calculateCopyabilityScore(trades),
      totalPnl,
      lastUpdated: new Date().toISOString(),
    })
  }

  // Sort by number of trades descending
  domains.sort((a, b) => b.trades - a.trades)

  const reputation: WalletReputation & {
    totalPositions: number
    resolvedTrades: number
    classifiedTrades: number
  } = {
    address,
    domains,
    totalAttestations: 0,
    computedAt: new Date().toISOString(),
    totalPositions: walletTrades.totalPositions,
    resolvedTrades: walletTrades.totalTrades,
    classifiedTrades: [...tradesByDomain.values()].reduce((s, t) => s + t.length, 0),
  }

  return NextResponse.json(reputation)
}
