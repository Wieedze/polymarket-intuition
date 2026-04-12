import { NextResponse } from 'next/server'
import { createPublicClient, http, parseAbi } from 'viem'
import { polygon } from 'viem/chains'

export const dynamic = 'force-dynamic'

const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? '0x1acC2880Cca00f61C41eb2b436C4f7D2d09a2fEC'
const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const DATA_API = 'https://data-api.polymarket.com'

const publicClient = createPublicClient({
  chain: polygon,
  transport: http(POLYGON_RPC),
})

// ── Types ────────────────────────────────────────────────────────

type RawPosition = {
  conditionId: string
  asset: string
  outcomeIndex: number
  title: string
  size: number
  avgPrice: number
  curPrice: number
  cashPnl: number
  initialValue: number
  currentValue: number
  percentPnl: number
  outcome: string
  market: string
}

type Position = {
  title: string
  side: string
  size: number
  avgPrice: number
  curPrice: number
  value: number
  cost: number
  pnl: number
  pnlPct: number
  resolved: boolean
}

type ClosedTrade = {
  title: string
  side: string
  result: 'won' | 'lost'
  totalTraded: number
  amountWon: number
  pnl: number
}

// ── Data fetchers (all from Polymarket/on-chain, zero DB) ────────

async function getUsdcBalance(address: string): Promise<number> {
  try {
    const balance = await publicClient.readContract({
      address: USDC_ADDRESS as `0x${string}`,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
    })
    return Number(balance) / 1e6
  } catch {
    return 0
  }
}

async function getPositions(address: string): Promise<RawPosition[]> {
  try {
    const res = await fetch(`${DATA_API}/positions?user=${address}&sizeThreshold=0`)
    if (!res.ok) return []
    return await res.json() as RawPosition[]
  } catch {
    return []
  }
}

async function getActivity(address: string): Promise<ClosedTrade[]> {
  try {
    // Fetch trade history from Polymarket
    const res = await fetch(`${DATA_API}/activity?user=${address}&limit=100&offset=0`)
    if (!res.ok) return []
    const data = await res.json()
    if (!Array.isArray(data)) return []

    // Group by market and determine won/lost
    const trades: ClosedTrade[] = []
    for (const item of data) {
      const pnl = parseFloat(item.cashPnl ?? item.pnl ?? '0')
      trades.push({
        title: item.title ?? item.market ?? 'Unknown',
        side: item.outcome ?? item.side ?? '?',
        result: pnl >= 0 ? 'won' : 'lost',
        totalTraded: parseFloat(item.totalTraded ?? item.size ?? '0'),
        amountWon: parseFloat(item.amountWon ?? '0'),
        pnl,
      })
    }
    return trades
  } catch {
    return []
  }
}

// ── Main handler ────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const address = WALLET_ADDRESS.toLowerCase()

  const [usdc, rawPositions, closedTrades] = await Promise.all([
    getUsdcBalance(address),
    getPositions(address),
    getActivity(address),
  ])

  // Active positions (size > 0)
  const active: Position[] = rawPositions
    .filter((p) => p.size > 0)
    .map((p) => {
      const value = p.size * p.curPrice
      const cost = p.size * p.avgPrice
      return {
        title: p.title,
        side: p.outcomeIndex === 0 ? 'YES' : 'NO',
        size: p.size,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        value,
        cost,
        pnl: value - cost,
        pnlPct: cost > 0 ? ((value - cost) / cost) * 100 : 0,
        resolved: p.curPrice > 0.95 || p.curPrice < 0.05,
      }
    })

  const positionsValue = active.reduce((s, p) => s + p.value, 0)
  const unrealizedPnl = active.reduce((s, p) => s + p.pnl, 0)
  const totalEquity = usdc + positionsValue

  // W/L from closed trades
  const wins = closedTrades.filter(t => t.result === 'won').length
  const losses = closedTrades.filter(t => t.result === 'lost').length
  const realizedPnl = closedTrades.reduce((s, t) => s + t.pnl, 0)

  // Positions waiting for redemption (resolved but still held)
  const pendingRedeem = active.filter(p => p.resolved)
  const pendingRedeemValue = pendingRedeem.reduce((s, p) => s + p.value, 0)

  return NextResponse.json({
    // Core equity — single source of truth
    wallet: WALLET_ADDRESS,
    usdc: Math.round(usdc * 100) / 100,
    positionsValue: Math.round(positionsValue * 100) / 100,
    totalEquity: Math.round(totalEquity * 100) / 100,

    // P&L
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,

    // Stats
    wins,
    losses,
    winRate: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0,
    totalTrades: wins + losses,

    // Positions
    openPositions: active.filter(p => !p.resolved),
    pendingRedeem,
    pendingRedeemValue: Math.round(pendingRedeemValue * 100) / 100,

    // Closed history
    closedTrades,

    fetchedAt: new Date().toISOString(),
  })
}
