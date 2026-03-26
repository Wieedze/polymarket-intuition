import { fetchResolvedTrades } from './polymarket'
import { classifyMarket } from './classifier'
import {
  calculateWinRate,
  calculateCalibration,
  calculateConvictionScore,
  detectTradingStyle,
  calculateDecayFactor,
  calculateImplicitEdge,
} from './scorer'
import {
  saveTrade,
  tradeExists,
  getTradesByDomain,
  saveWalletStats,
} from './db'
import { DOMAIN_ATOMS } from './atoms'
import type { DomainAtomValue } from './atoms'

// ── Types ─────────────────────────────────────────────────────────

export type IndexResult = {
  wallet       : string
  tradesIndexed: number
  tradesSkipped: number
  errors       : string[]
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Index a wallet's resolved Polymarket trades into SQLite.
 */
export async function indexWallet(address: string): Promise<IndexResult> {
  const result: IndexResult = {
    wallet: address,
    tradesIndexed: 0,
    tradesSkipped: 0,
    errors: [],
  }

  // Step 1: Fetch trades from Polymarket
  let walletTrades
  try {
    walletTrades = await fetchResolvedTrades(address)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    result.errors.push(`Failed to fetch trades: ${msg}`)
    return result
  }

  // Step 2: Classify and save each trade
  for (const trade of walletTrades.trades) {
    try {
      if (tradeExists(trade.id)) {
        result.tradesSkipped++
        continue
      }

      const classification = await classifyMarket(trade.marketQuestion)

      saveTrade({
        ...trade,
        wallet: address,
        domain: classification?.domain ?? null,
        confidence: classification?.confidence ?? 0,
      })

      if (classification) {
        result.tradesIndexed++
      } else {
        result.tradesSkipped++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Trade ${trade.id}: ${msg}`)
    }
  }

  // Step 3: Compute and save stats per domain
  const allDomains = Object.values(DOMAIN_ATOMS) as DomainAtomValue[]

  for (const domain of allDomains) {
    try {
      const domainTrades = getTradesByDomain(address, domain)
      if (domainTrades.length === 0) continue

      const winRate = calculateWinRate(domainTrades)
      const calibration = calculateCalibration(domainTrades)
      const convictionScore = calculateConvictionScore(domainTrades)
      const implicitEdge = calculateImplicitEdge(domainTrades)
      detectTradingStyle(domainTrades)
      const lastTradeAt = domainTrades[0]?.resolvedAt ?? new Date().toISOString()
      const decayFactor = calculateDecayFactor(lastTradeAt)
      const avgConviction =
        domainTrades.reduce((sum, t) => {
          const prob = t.side === 'YES' ? t.entryPrice : 1 - t.entryPrice
          return sum + Math.abs(prob - 0.5) * 2
        }, 0) / domainTrades.length
      const totalPnl = domainTrades.reduce((sum, t) => sum + t.pnl, 0)

      saveWalletStats(address, domain, {
        winRate,
        calibration,
        tradesCount: domainTrades.length,
        avgConviction,
        totalPnl,
        implicitEdge,
        decayFactor,
        lastTradeAt,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Domain ${domain}: ${msg}`)
    }
  }

  return result
}
