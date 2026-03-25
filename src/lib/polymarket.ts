import type { ResolvedTrade, WalletTrades } from '../types/polymarket'

const POLYMARKET_DATA_URL =
  process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com'

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
    const totalBuyUsdc = buys.reduce((s, b) => s + b.usdcSize, 0)
    const totalBuyShares = buys.reduce((s, b) => s + b.size, 0)
    const avgEntryPrice =
      totalBuyShares > 0 ? totalBuyUsdc / totalBuyShares : 0.5
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
