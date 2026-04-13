import { NextResponse } from 'next/server'
import { fetchWalletEquity } from '@/lib/on-chain'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const data = await fetchWalletEquity()
  return NextResponse.json(data)
}
