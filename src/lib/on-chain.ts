/**
 * Shared on-chain data fetchers for wallet equity.
 * Zero DB usage — reads from Polygon RPC + Polymarket Data API only.
 */

import { createPublicClient, http, parseAbi } from 'viem'
import { polygon } from 'viem/chains'

// ── Config ──────────────────────────────────────────────────────

const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? ''
const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const DATA_API = 'https://data-api.polymarket.com'

const publicClient = createPublicClient({
  chain: polygon,
  transport: http(POLYGON_RPC),
})

// ── Types ────────────────────────────────────────────────────────

export type RawPosition = {
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

export type OnChainPosition = {
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

export type ClosedTrade = {
  title: string
  side: string
  result: 'won' | 'lost'
  totalTraded: number
  amountWon: number
  pnl: number
}

export type ActivityResult = {
  trades: ClosedTrade[]
  totalBoughtUsdc: number
  totalSoldUsdc: number
}

export type WalletEquity = {
  wallet: string
  usdc: number
  positionsValue: number
  totalEquity: number
  realizedPnl: number
  unrealizedPnl: number
  wins: number
  losses: number
  winRate: number
  totalTrades: number
  openPositions: OnChainPosition[]
  pendingRedeem: OnChainPosition[]
  pendingRedeemValue: number
  closedTrades: ClosedTrade[]
  totalBoughtUsdc: number
  totalSoldUsdc: number
  fetchedAt: string
}

// ── Data fetchers ───────────────────────────────────────────────

export function getWalletAddress(): string {
  return WALLET_ADDRESS
}

export async function getUsdcBalance(address: string): Promise<number> {
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

export async function getPositions(address: string): Promise<RawPosition[]> {
  try {
    const res = await fetch(`${DATA_API}/positions?user=${address}&sizeThreshold=0`, { cache: 'no-store' })
    if (!res.ok) return []
    return await res.json() as RawPosition[]
  } catch {
    return []
  }
}

export async function getActivity(address: string): Promise<ActivityResult> {
  try {
    const res = await fetch(`${DATA_API}/activity?user=${address}&limit=500&offset=0`, { cache: 'no-store' })
    const empty: ActivityResult = { trades: [], totalBoughtUsdc: 0, totalSoldUsdc: 0 }
    if (!res.ok) return empty
    const data = await res.json()
    if (!Array.isArray(data)) return empty

    const positionMap = new Map<string, {
      title: string
      side: string
      totalBought: number
      totalSold: number
      sharesBought: number
      sharesSold: number
    }>()

    for (const item of data) {
      const condId = item.conditionId as string
      const usdcSize = parseFloat(item.usdcSize ?? '0')
      const size = parseFloat(item.size ?? '0')
      const tradeType = item.side as string
      const title = (item.title as string) ?? 'Unknown'
      const outcomeIdx = item.outcomeIndex as number

      if (!positionMap.has(condId)) {
        positionMap.set(condId, {
          title,
          side: outcomeIdx === 0 ? 'YES' : 'NO',
          totalBought: 0,
          totalSold: 0,
          sharesBought: 0,
          sharesSold: 0,
        })
      }
      const pos = positionMap.get(condId)!
      if (tradeType === 'BUY') {
        pos.totalBought += usdcSize
        pos.sharesBought += size
      } else {
        pos.totalSold += usdcSize
        pos.sharesSold += size
      }
    }

    const trades: ClosedTrade[] = []
    for (const [, pos] of positionMap) {
      if (pos.totalSold === 0) continue  // no sells at all, skip
      const remaining = pos.sharesBought - pos.sharesSold
      if (remaining > 0.5) {
        // Still open — compute realized PnL from partial sells only
        const costOfSold = pos.sharesBought > 0
          ? (pos.sharesSold / pos.sharesBought) * pos.totalBought
          : 0
        const partialPnl = pos.totalSold - costOfSold
        if (Math.abs(partialPnl) < 0.001) continue  // negligible
        trades.push({
          title: pos.title,
          side: pos.side,
          result: partialPnl >= 0 ? 'won' : 'lost',
          totalTraded: pos.totalBought + pos.totalSold,
          amountWon: partialPnl > 0 ? pos.totalSold : 0,
          pnl: partialPnl,
        })
      } else {
        // Fully closed
        const pnl = pos.totalSold - pos.totalBought
        trades.push({
          title: pos.title,
          side: pos.side,
          result: pnl >= 0 ? 'won' : 'lost',
          totalTraded: pos.totalBought + pos.totalSold,
          amountWon: pnl > 0 ? pos.totalSold : 0,
          pnl,
        })
      }
    }
    // Sum all buys and sells across all positions
    let totalBoughtUsdc = 0
    let totalSoldUsdc = 0
    for (const [, pos] of positionMap) {
      totalBoughtUsdc += pos.totalBought
      totalSoldUsdc += pos.totalSold
    }

    return { trades, totalBoughtUsdc, totalSoldUsdc }
  } catch {
    return { trades: [], totalBoughtUsdc: 0, totalSoldUsdc: 0 }
  }
}

// ── Aggregate wallet equity ─────────────────────────────────────

export async function fetchWalletEquity(): Promise<WalletEquity> {
  const address = WALLET_ADDRESS.toLowerCase()

  const [usdc, rawPositions, activity] = await Promise.all([
    getUsdcBalance(address),
    getPositions(address),
    getActivity(address),
  ])
  const { trades: closedTrades, totalBoughtUsdc, totalSoldUsdc } = activity

  const active: OnChainPosition[] = rawPositions
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

  const wins = closedTrades.filter(t => t.result === 'won').length
  const losses = closedTrades.filter(t => t.result === 'lost').length
  const realizedPnl = closedTrades.reduce((s, t) => s + t.pnl, 0)

  const pendingRedeem = active.filter(p => p.resolved)
  const pendingRedeemValue = pendingRedeem.reduce((s, p) => s + p.value, 0)

  return {
    wallet: WALLET_ADDRESS,
    usdc: Math.round(usdc * 100) / 100,
    positionsValue: Math.round(positionsValue * 100) / 100,
    totalEquity: Math.round(totalEquity * 100) / 100,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    wins,
    losses,
    winRate: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 100) : 0,
    totalTrades: wins + losses,
    openPositions: active.filter(p => !p.resolved),
    pendingRedeem,
    pendingRedeemValue: Math.round(pendingRedeemValue * 100) / 100,
    closedTrades,
    totalBoughtUsdc: Math.round(totalBoughtUsdc * 100) / 100,
    totalSoldUsdc: Math.round(totalSoldUsdc * 100) / 100,
    fetchedAt: new Date().toISOString(),
  }
}
