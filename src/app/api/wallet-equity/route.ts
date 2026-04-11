import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const WALLET_ADDRESS = process.env.WALLET_ADDRESS ?? '0x1acC2880Cca00f61C41eb2b436C4f7D2d09a2fEC'
const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'

// Minimal ABI for balanceOf — no external deps needed
const BALANCE_OF_SELECTOR = '0x70a08231'

type PolymarketPosition = {
  conditionId: string
  asset: string
  outcomeIndex: number
  title: string
  size: number
  avgPrice: number
  curPrice: number
  cashPnl: number
}

async function getUsdcBalance(address: string): Promise<number> {
  try {
    // Encode balanceOf(address) call
    const paddedAddress = address.slice(2).toLowerCase().padStart(64, '0')
    const data = `${BALANCE_OF_SELECTOR}${paddedAddress}`

    const res = await fetch(POLYGON_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: USDC_ADDRESS, data }, 'latest'],
        id: 1,
      }),
    })

    const json = await res.json() as { result?: string }
    if (!json.result) return 0
    return parseInt(json.result, 16) / 1e6  // USDC.e has 6 decimals
  } catch {
    return 0
  }
}

async function getPolymarketPositions(address: string): Promise<PolymarketPosition[]> {
  try {
    const res = await fetch(
      `https://data-api.polymarket.com/positions?user=${address.toLowerCase()}&sizeThreshold=0`
    )
    if (!res.ok) return []
    return await res.json() as PolymarketPosition[]
  } catch {
    return []
  }
}

export async function GET(): Promise<NextResponse> {
  const address = WALLET_ADDRESS.toLowerCase()

  const [usdc, positions] = await Promise.all([
    getUsdcBalance(address),
    getPolymarketPositions(address),
  ])

  const activePositions = positions
    .filter((p) => p.size > 0)
    .map((p) => ({
      conditionId: p.conditionId,
      title: p.title,
      side: p.outcomeIndex === 0 ? 'YES' : 'NO',
      size: p.size,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      value: p.size * p.curPrice,
      pnl: p.cashPnl,
    }))

  const positionsValue = activePositions.reduce((s, p) => s + p.value, 0)
  const totalEquity = usdc + positionsValue

  return NextResponse.json({
    wallet: WALLET_ADDRESS,
    usdc: Math.round(usdc * 100) / 100,
    positionsValue: Math.round(positionsValue * 100) / 100,
    totalEquity: Math.round(totalEquity * 100) / 100,
    positions: activePositions,
    fetchedAt: new Date().toISOString(),
  })
}
