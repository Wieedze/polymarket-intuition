import { fetchResolvedTrades } from './polymarket'
import { classifyMarket } from './classifier'
import {
  calculateWinRate,
  calculateCalibration,
  calculateConvictionScore,
  detectTradingStyle,
  calculateDecayFactor,
  MIN_TRADES_FOR_ATTESTATION,
} from './scorer'
import {
  saveTrade,
  tradeExists,
  getTradesByDomain,
  saveWalletStats,
  markAttestedOnChain,
} from './db'
import { upsertAggregatedAttestation } from './intuition'
import { DOMAIN_ATOMS } from './atoms'
import type { DomainAtomValue } from './atoms'
import type { AggregatedAttestation } from '../types/attestation'
import type { DomainAtom } from '../types/attestation'

// ── Types ─────────────────────────────────────────────────────────

export type IndexResult = {
  wallet: string
  tradesIndexed: number
  tradesSkipped: number
  domainsAttested: string[]
  errors: string[]
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Index a wallet's resolved Polymarket trades.
 *
 * @param address - Wallet address to index
 * @param writeOnChain - false = paper mode (SQLite only), true = write to Intuition
 */
export async function indexWallet(
  address: string,
  writeOnChain = false
): Promise<IndexResult> {
  const result: IndexResult = {
    wallet: address,
    tradesIndexed: 0,
    tradesSkipped: 0,
    domainsAttested: [],
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
      // Skip already-indexed trades (idempotent)
      if (tradeExists(trade.id)) {
        result.tradesSkipped++
        continue
      }

      // Classify market question into a domain
      const classification = await classifyMarket(trade.marketQuestion)

      // Save to SQLite (even if unclassified — domain will be null)
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
      // Continue — never crash on a single trade
    }
  }

  // Step 3: Compute stats and attest for each domain
  const allDomains = Object.values(DOMAIN_ATOMS) as DomainAtomValue[]

  for (const domain of allDomains) {
    try {
      const domainTrades = getTradesByDomain(address, domain)

      if (domainTrades.length === 0) continue

      const winRate = calculateWinRate(domainTrades)
      const calibration = calculateCalibration(domainTrades)
      const convictionScore = calculateConvictionScore(domainTrades)
      const _tradingStyle = detectTradingStyle(domainTrades)
      const lastTradeAt =
        domainTrades[0]?.resolvedAt ?? new Date().toISOString()
      const decayFactor = calculateDecayFactor(lastTradeAt)
      const avgConviction =
        domainTrades.reduce((sum, t) => {
          const prob = t.side === 'YES' ? t.entryPrice : 1 - t.entryPrice
          return sum + Math.abs(prob - 0.5) * 2 // 0 = no conviction, 1 = max
        }, 0) / domainTrades.length
      const totalPnl = domainTrades.reduce((sum, t) => sum + t.pnl, 0)

      // Save stats to SQLite
      saveWalletStats(address, domain, {
        winRate,
        calibration,
        tradesCount: domainTrades.length,
        avgConviction,
        totalPnl,
        decayFactor,
        lastTradeAt,
      })

      // Create on-chain attestation if enough trades
      if (
        writeOnChain &&
        domainTrades.length >= MIN_TRADES_FOR_ATTESTATION
      ) {
        const attestation: AggregatedAttestation = {
          subject: address as `0x${string}`,
          predicate: 'has-prediction-reputation-in',
          object: domain as DomainAtom,
          metadata: {
            winRate,
            trades: domainTrades.length,
            calibration,
            avgConviction,
            totalPnl,
            lastUpdated: new Date().toISOString(),
            source: 'polymarket-indexer-v1',
          },
        }

        await upsertAggregatedAttestation(attestation)
        markAttestedOnChain(address, domain)
        result.domainsAttested.push(domain)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Domain ${domain}: ${msg}`)
      // Continue — never crash on a single domain
    }
  }

  return result
}
