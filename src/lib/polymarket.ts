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

// ── Helpers ───────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Polymarket API error: ${response.status}`)
  }
  return response.json() as Promise<T>
}

/** Paginate through Polymarket /positions endpoint (max 500 per page) */
async function fetchAllPositions(
  baseUrl: string
): Promise<PositionRecord[]> {
  const PAGE_SIZE = 500
  const all: PositionRecord[] = []
  let offset = 0

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await fetchJson<PositionRecord[]>(
      `${baseUrl}&limit=${PAGE_SIZE}&offset=${offset}`
    )
    all.push(...page)
    if (page.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return all
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Fetch all resolved trades for a wallet address.
 *
 * Uses /positions?closed=true then filters to curPrice < 0.05 or > 0.95
 * (resolved or quasi-resolved markets only).
 *
 * Won/lost determined by cashPnl:
 * - cashPnl > 0 → won
 * - cashPnl <= 0 → lost
 */
export async function fetchResolvedTrades(
  address: string
): Promise<WalletTrades> {
  const [closedPositions, allPositions] = await Promise.all([
    fetchAllPositions(
      `${POLYMARKET_DATA_URL}/positions?user=${address}&sizeThreshold=0&closed=true`
    ),
    fetchAllPositions(
      `${POLYMARKET_DATA_URL}/positions?user=${address}&sizeThreshold=0`
    ),
  ])

  // Keep only resolved/quasi-resolved: curPrice < 0.05 or > 0.95
  const resolved = closedPositions.filter(
    (p) => p.curPrice < 0.05 || p.curPrice > 0.95
  )

  const trades: ResolvedTrade[] = resolved.map((pos) => ({
    id: `${pos.conditionId}-${pos.outcomeIndex}`,
    marketId: pos.conditionId,
    marketQuestion: pos.title,
    side: pos.outcomeIndex === 0 ? 'YES' : 'NO',
    entryPrice: pos.avgPrice,
    size: pos.initialValue,
    outcome: pos.cashPnl > 0 ? 'won' : 'lost',
    pnl: pos.cashPnl,
    resolvedAt: new Date().toISOString(),
    transactionHash: '',
  }))

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0)

  return {
    address,
    trades,
    totalTrades: trades.length,
    totalPositions: allPositions.length,
    totalPnl,
  }
}
