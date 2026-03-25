import { NextResponse, type NextRequest } from 'next/server'
import {
  getOpenPaperTrades,
  getAllPaperTrades,
  openPaperTrade,
  resolvePaperTrade,
  updatePaperTradePrice,
  paperTradeExistsForCondition,
  getPortfolioSetting,
  setPortfolioSetting,
  type PaperTrade,
} from '@/lib/db'
import { keywordClassify } from '@/lib/classifier'
import { fetchAllPages } from '@/lib/polymarket'

const POLYMARKET_DATA_URL =
  process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com'

type PositionRecord = {
  conditionId: string
  curPrice: number
}

// ── GET: portfolio overview ──────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const action = request.nextUrl.searchParams.get('action') ?? 'overview'

  try {
    if (action === 'refresh') {
      // Refresh prices for open trades by checking Polymarket
      return await refreshPrices()
    }

    if (action === 'resolve') {
      // Check and resolve trades where market has resolved
      return await checkResolutions()
    }

    // Default: return portfolio overview
    const allTrades = getAllPaperTrades()
    const openTrades = allTrades.filter((t) => t.status === 'open')
    const closedTrades = allTrades.filter((t) => t.status !== 'open')

    const startingBalance = parseFloat(getPortfolioSetting('starting_balance', '10000'))
    const betSizeUsdc = parseFloat(getPortfolioSetting('bet_size_usdc', '100'))

    const realizedPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const unrealizedPnl = openTrades.reduce((s, t) => {
      if (t.curPrice == null) return s
      return s + t.shares * (t.curPrice - t.entryPrice)
    }, 0)

    const totalInvested = openTrades.reduce((s, t) => s + t.simulatedUsdc, 0)
    const currentBalance = startingBalance + realizedPnl
    const wins = closedTrades.filter((t) => t.status === 'won').length
    const losses = closedTrades.filter((t) => t.status === 'lost').length
    const winRate = closedTrades.length > 0 ? wins / closedTrades.length : 0

    return NextResponse.json({
      portfolio: {
        startingBalance,
        currentBalance,
        realizedPnl,
        unrealizedPnl,
        totalInvested,
        betSizeUsdc,
        totalTrades: allTrades.length,
        openTrades: openTrades.length,
        closedTrades: closedTrades.length,
        wins,
        losses,
        winRate,
        roi: startingBalance > 0 ? realizedPnl / startingBalance : 0,
      },
      trades: allTrades,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ── POST: open a paper trade or configure settings ───────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const action = body.action as string

    if (action === 'configure') {
      const balance = body.startingBalance as number | undefined
      const betSize = body.betSizeUsdc as number | undefined
      if (balance != null) setPortfolioSetting('starting_balance', balance.toString())
      if (betSize != null) setPortfolioSetting('bet_size_usdc', betSize.toString())
      return NextResponse.json({ ok: true })
    }

    if (action === 'copy') {
      const conditionId = body.conditionId as string
      const title = body.title as string
      const side = body.side as string
      const entryPrice = body.entryPrice as number
      const copiedFrom = body.copiedFrom as string
      const copiedLabel = (body.copiedLabel as string) ?? null

      if (!conditionId || !title || !side || !entryPrice || !copiedFrom) {
        return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
      }

      // Don't duplicate
      if (paperTradeExistsForCondition(conditionId)) {
        return NextResponse.json({ error: 'Already have open paper trade for this market' }, { status: 409 })
      }

      const betSize = parseFloat(getPortfolioSetting('bet_size_usdc', '100'))
      const domain = keywordClassify(title)

      const trade = openPaperTrade({
        conditionId,
        title,
        domain: domain?.domain ?? null,
        side,
        entryPrice,
        simulatedUsdc: betSize,
        copiedFrom,
        copiedLabel,
      })

      return NextResponse.json({ trade })
    }

    if (action === 'resolve') {
      const conditionId = body.conditionId as string
      const exitPrice = body.exitPrice as number
      if (!conditionId || exitPrice == null) {
        return NextResponse.json({ error: 'Missing conditionId or exitPrice' }, { status: 400 })
      }
      resolvePaperTrade(conditionId, exitPrice)
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// ── Helpers ───────────────────────────────────────────────────────

async function refreshPrices(): Promise<NextResponse> {
  const openTrades = getOpenPaperTrades()
  if (openTrades.length === 0) {
    return NextResponse.json({ refreshed: 0 })
  }

  // Get unique wallets that we copied from
  const wallets = [...new Set(openTrades.map((t) => t.copiedFrom))]
  let updated = 0

  for (const wallet of wallets) {
    try {
      const positions = await fetchAllPages<PositionRecord>(
        `${POLYMARKET_DATA_URL}/positions?user=${wallet}&sizeThreshold=0`,
        2
      )
      for (const pos of positions) {
        const matching = openTrades.filter((t) => t.conditionId === pos.conditionId)
        for (const trade of matching) {
          updatePaperTradePrice(trade.conditionId, pos.curPrice)
          updated++
        }
      }
    } catch {
      // Skip failed wallet
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  return NextResponse.json({ refreshed: updated })
}

async function checkResolutions(): Promise<NextResponse> {
  const openTrades = getOpenPaperTrades()
  let resolved = 0

  const wallets = [...new Set(openTrades.map((t) => t.copiedFrom))]

  for (const wallet of wallets) {
    try {
      const positions = await fetchAllPages<PositionRecord & { redeemable: boolean }>(
        `${POLYMARKET_DATA_URL}/positions?user=${wallet}&sizeThreshold=0&closed=true`,
        2
      )
      for (const pos of positions) {
        if (pos.curPrice < 0.05 || pos.curPrice > 0.95) {
          const matching = openTrades.filter((t) => t.conditionId === pos.conditionId)
          if (matching.length > 0) {
            resolvePaperTrade(pos.conditionId, pos.curPrice)
            resolved++
          }
        }
      }
    } catch {
      // Skip
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  return NextResponse.json({ resolved })
}
