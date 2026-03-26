import { NextResponse, type NextRequest } from 'next/server'
import { getDb } from '@/lib/db'

type WatchedWallet = {
  wallet: string
  label: string | null
  addedAt: string
  lastPolledAt: string | null
  active: boolean
}

function getWatchedWallets(): WatchedWallet[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT wallet, label, added_at, last_polled_at, active FROM watched_wallets ORDER BY added_at DESC'
  ).all() as Array<{
    wallet: string
    label: string | null
    added_at: string
    last_polled_at: string | null
    active: number
  }>
  return rows.map((r) => ({
    wallet: r.wallet,
    label: r.label,
    addedAt: r.added_at,
    lastPolledAt: r.last_polled_at,
    active: r.active === 1,
  }))
}

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(getWatchedWallets())
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { wallet?: string; label?: string }
    const wallet = body.wallet?.trim()
    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
      return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 })
    }

    const db = getDb()
    db.prepare(
      `INSERT OR REPLACE INTO watched_wallets (wallet, label, added_at, active)
       VALUES (?, ?, ?, 1)`
    ).run(wallet, body.label?.trim() ?? null, new Date().toISOString())

    return NextResponse.json({ ok: true, wallet })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const wallet = request.nextUrl.searchParams.get('wallet')
    if (!wallet) return NextResponse.json({ error: 'Missing wallet param' }, { status: 400 })

    const db = getDb()
    db.prepare('DELETE FROM watched_wallets WHERE wallet = ?').run(wallet)

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { wallet?: string; active?: boolean }
    if (!body.wallet) return NextResponse.json({ error: 'Missing wallet' }, { status: 400 })

    const db = getDb()
    db.prepare('UPDATE watched_wallets SET active = ? WHERE wallet = ?').run(
      body.active ? 1 : 0,
      body.wallet
    )

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
