import { NextResponse } from 'next/server'
import { getRecentSignals } from '../../../lib/db'

export const dynamic = 'force-dynamic'

export function GET(): NextResponse {
  try {
    const signals = getRecentSignals(50)

    // Stats
    const last24h = signals.filter(
      (s) => Date.now() - new Date(s.createdAt).getTime() < 24 * 60 * 60 * 1000
    )
    const pending = last24h.filter((s) => s.status === 'pending').length
    const taken = last24h.filter((s) => s.status === 'taken').length
    const rejected = last24h.filter((s) => s.status === 'rejected').length
    const expired = last24h.filter((s) => s.status === 'expired').length

    const bySource: Record<string, number> = {}
    for (const s of last24h) {
      bySource[s.source] = (bySource[s.source] ?? 0) + 1
    }

    return NextResponse.json({
      signals: signals.map((s) => ({
        id: s.id,
        source: s.source,
        title: s.title,
        side: s.side,
        score: s.signalScore,
        entryPrice: s.entryPrice,
        status: s.status,
        rejectReason: s.rejectReason,
        expertLabel: s.expertLabel,
        sportKey: s.sportKey,
        edge: s.edge,
        createdAt: s.createdAt,
      })),
      stats: { pending, taken, rejected, expired, total: last24h.length, bySource },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
