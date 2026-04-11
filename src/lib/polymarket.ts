import type { ResolvedTrade, WalletTrades } from '../types/polymarket'
import { getMarketMetadata, saveMarketMetadata, type MarketMetadata } from './db'

const POLYMARKET_DATA_URL =
  process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com'
// Gamma API removed — unreliable (returns unrelated markets for any conditionId)
// Token IDs are now resolved via CLOB API: /markets/{conditionId}

// ── Raw API response types ────────────────────────────────────────

type PositionRecord = {
  conditionId: string
  asset: string
  title: string
  outcome: string
  outcomeIndex: number
  size: number
  avgPrice: number
  initialValue: number
  currentValue: number
  cashPnl: number
  percentPnl: number
  curPrice: number
  redeemable: boolean
}

type ActivityRecord = {
  type: string
  conditionId: string
  title: string
  outcome: string
  outcomeIndex: number
  side: string
  price: number
  size: number
  usdcSize: number
  transactionHash: string
  timestamp: number
  asset: string
}

// ── Helpers ───────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Polymarket API error: ${response.status}`)
  }
  return response.json() as Promise<T>
}

/** Paginate through a Polymarket endpoint (max 500 per page, max 5 pages) */
export async function fetchAllPages<T>(baseUrl: string, maxPages: number = 5): Promise<T[]> {
  const PAGE_SIZE = 500
  const all: T[] = []
  let offset = 0

  for (let page = 0; page < maxPages; page++) {
    const sep = baseUrl.includes('?') ? '&' : '?'
    const results = await fetchJson<T[]>(
      `${baseUrl}${sep}limit=${PAGE_SIZE}&offset=${offset}`
    )
    all.push(...results)
    if (results.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return all
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Fetch all resolved trades for a wallet address.
 *
 * Dual-source strategy:
 * 1. /positions?closed=true → resolved losses (curPrice < 0.05) AND wins (curPrice > 0.95 or cashPnl > 0)
 * 2. /activity REDEEM events → verified wins that disappeared from positions
 * 3. /activity BUY trades → entry price for REDEEM matches
 *
 * Deduplicates by conditionId.
 */
export async function fetchResolvedTrades(
  address: string
): Promise<WalletTrades> {
  const [closedPositions, allPositions, activity] = await Promise.all([
    fetchAllPages<PositionRecord>(
      `${POLYMARKET_DATA_URL}/positions?user=${address}&sizeThreshold=0&closed=true`
    ),
    fetchAllPages<PositionRecord>(
      `${POLYMARKET_DATA_URL}/positions?user=${address}&sizeThreshold=0`
    ),
    fetchAllPages<ActivityRecord>(
      `${POLYMARKET_DATA_URL}/activity?user=${address}`
    ),
  ])

  const trades: ResolvedTrade[] = []
  const seenConditionIds = new Set<string>()

  // ── Source 1: Resolved positions (curPrice < 0.05 or > 0.95) ──
  const resolved = closedPositions.filter(
    (p) => p.curPrice < 0.05 || p.curPrice > 0.95
  )

  for (const pos of resolved) {
    const key = `${pos.conditionId}-${pos.outcomeIndex}`
    seenConditionIds.add(pos.conditionId)

    trades.push({
      id: key,
      marketId: pos.conditionId,
      marketQuestion: pos.title,
      side: pos.outcomeIndex === 0 ? 'YES' : 'NO',
      entryPrice: pos.avgPrice,
      size: pos.initialValue,
      outcome: pos.cashPnl > 0 ? 'won' : 'lost',
      pnl: pos.cashPnl,
      resolvedAt: new Date().toISOString(),
      transactionHash: '',
    })
  }

  // ── Source 2: REDEEM events from activity (wins that left positions) ──
  const redeemEvents = activity.filter((a) => a.type === 'REDEEM')

  // Build BUY trade map by conditionId for entry price
  const buysByCondition = new Map<
    string,
    Array<{ price: number; size: number; usdcSize: number; outcomeIndex: number; title: string }>
  >()
  for (const record of activity) {
    if (record.type === 'TRADE' && record.side === 'BUY') {
      const existing = buysByCondition.get(record.conditionId) ?? []
      existing.push({
        price: record.price,
        size: record.size,
        usdcSize: record.usdcSize,
        outcomeIndex: record.outcomeIndex,
        title: record.title,
      })
      buysByCondition.set(record.conditionId, existing)
    }
  }

  for (const redeem of redeemEvents) {
    if (seenConditionIds.has(redeem.conditionId)) continue
    seenConditionIds.add(redeem.conditionId)

    const buys = buysByCondition.get(redeem.conditionId) ?? []
    // Skip REDEEMs without matching BUY data — can't compute reliable entry price
    if (buys.length === 0) continue
    const totalBuyUsdc = buys.reduce((s, b) => s + b.usdcSize, 0)
    const totalBuyShares = buys.reduce((s, b) => s + b.size, 0)
    if (totalBuyShares === 0) continue
    const avgEntryPrice = totalBuyUsdc / totalBuyShares
    const outcomeIndex = buys[0]?.outcomeIndex ?? 0
    const pnl = redeem.usdcSize - totalBuyUsdc

    trades.push({
      id: `${redeem.conditionId}-redeem`,
      marketId: redeem.conditionId,
      marketQuestion: redeem.title || buys[0]?.title || 'Unknown market',
      side: outcomeIndex === 0 ? 'YES' : 'NO',
      entryPrice: avgEntryPrice,
      size: totalBuyUsdc,
      outcome: 'won',
      pnl,
      resolvedAt: new Date(redeem.timestamp * 1000).toISOString(),
      transactionHash: redeem.transactionHash,
    })
  }

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0)

  return {
    address,
    trades,
    totalTrades: trades.length,
    totalPositions: allPositions.length,
    totalPnl,
  }
}

// ── Market metadata (CLOB API) ──────────────────────────────────

/**
 * Fetch market metadata (token IDs, end date, liquidity) for a conditionId.
 * Uses SQLite cache with 24h TTL to avoid hammering Gamma API.
 *
 * Returns null if the market is not found or API fails.
 */
export async function fetchMarketMetadata(conditionId: string): Promise<MarketMetadata | null> {
  // Check cache first
  const cached = getMarketMetadata(conditionId)
  if (cached) return cached

  // Strategy: try CLOB API first (exact match), then Gamma API (filtered)
  // Gamma API's condition_id param doesn't filter properly — always returns GTA VI markets.

  try {
    // ── CLOB API: exact conditionId match ──────────────────────────
    const clobRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`)
    if (!clobRes.ok) return null

    const clobMarket = await clobRes.json() as {
      condition_id?: string
      question?: string
      tokens?: Array<{ token_id: string; outcome: string }>
      end_date_iso?: string
      active?: boolean
      closed?: boolean
      neg_risk?: boolean
      error?: string
    }

    if (clobMarket.error || !clobMarket.tokens || clobMarket.tokens.length < 2) return null

    const yesToken = clobMarket.tokens.find(t => t.outcome === 'Yes')
    const noToken = clobMarket.tokens.find(t => t.outcome === 'No')
    if (!yesToken || !noToken) return null

    const meta: MarketMetadata = {
      conditionId: clobMarket.condition_id ?? conditionId,
      yesTokenId: yesToken.token_id,
      noTokenId: noToken.token_id,
      endDate: clobMarket.end_date_iso ?? null,
      title: clobMarket.question ?? null,
      liquidity: null,
      active: (clobMarket.active ?? true) && !(clobMarket.closed ?? false),
      negRisk: clobMarket.neg_risk ?? false,
      fetchedAt: new Date().toISOString(),
    }
    saveMarketMetadata(meta)
    return meta
  } catch {
    return null
  }
}
