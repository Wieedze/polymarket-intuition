import { NextResponse, type NextRequest } from 'next/server'
import { getActiveWatchedWallets, getPositionSnapshot } from '@/lib/db'
import { pollWallet, type PositionAlert } from '@/lib/position-tracker'
import { keywordClassify } from '@/lib/classifier'

type MonitorWallet = {
  address: string
  label: string | null
  openPositions: Array<{
    title: string
    side: string
    avgPrice: number
    curPrice: number
    size: number
    domain: string | null
  }>
}

type MonitorResponse = {
  wallets: MonitorWallet[]
  alerts: PositionAlert[]
  totalWatched: number
  totalOpenPositions: number
  polledAt: string
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const poll = request.nextUrl.searchParams.get('poll') === 'true'

  try {
    const watched = getActiveWatchedWallets()

    if (watched.length === 0) {
      return NextResponse.json({
        wallets: [],
        alerts: [],
        totalWatched: 0,
        totalOpenPositions: 0,
        polledAt: new Date().toISOString(),
      })
    }

    const allAlerts: PositionAlert[] = []
    const wallets: MonitorWallet[] = []

    for (const { wallet, label } of watched.slice(0, 20)) {
      // Poll if requested (fetches new data), otherwise just read snapshot
      if (poll) {
        try {
          const alerts = await pollWallet(wallet, label)
          allAlerts.push(...alerts)
        } catch {
          // Skip failed wallets
        }
        // Rate limit
        await new Promise((r) => setTimeout(r, 500))
      }

      // Read current snapshot
      const snapshot = getPositionSnapshot(wallet)
      const positions = Array.from(snapshot.values()).map((p) => {
        const domain = keywordClassify(p.title)
        return {
          conditionId: p.conditionId,
          title: p.title,
          side: p.outcomeIndex === 0 ? 'YES' : 'NO',
          avgPrice: p.avgPrice,
          curPrice: p.curPrice,
          size: p.size,
          domain: domain?.domain ?? null,
        }
      })

      // Sort by size descending
      positions.sort((a, b) => b.size - a.size)

      wallets.push({
        address: wallet,
        label,
        openPositions: positions,
      })
    }

    // Sort wallets by number of open positions
    wallets.sort((a, b) => b.openPositions.length - a.openPositions.length)

    const response: MonitorResponse = {
      wallets,
      alerts: allAlerts,
      totalWatched: watched.length,
      totalOpenPositions: wallets.reduce((s, w) => s + w.openPositions.length, 0),
      polledAt: new Date().toISOString(),
    }

    return NextResponse.json(response)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
