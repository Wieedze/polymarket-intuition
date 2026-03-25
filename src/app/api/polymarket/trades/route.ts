import { NextResponse, type NextRequest } from 'next/server'
import { fetchResolvedTrades } from '@/lib/polymarket'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const address = request.nextUrl.searchParams.get('address')

  if (!address) {
    return NextResponse.json(
      { error: 'Missing required query param: address' },
      { status: 400 }
    )
  }

  try {
    const walletTrades = await fetchResolvedTrades(address)
    return NextResponse.json(walletTrades)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
