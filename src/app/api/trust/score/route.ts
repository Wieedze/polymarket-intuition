import { NextResponse, type NextRequest } from 'next/server'
import { getCompositeScore } from '@/lib/trust-mcp'
import { DOMAIN_ATOMS } from '@/lib/atoms'
import type { DomainAtomValue } from '@/lib/atoms'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const address = request.nextUrl.searchParams.get('address')
  const domain = request.nextUrl.searchParams.get('domain')

  if (!address || !domain) {
    return NextResponse.json(
      { error: 'Missing required query params: address, domain' },
      { status: 400 }
    )
  }

  // Validate domain
  const validDomains = Object.values(DOMAIN_ATOMS) as string[]
  if (!validDomains.includes(domain)) {
    return NextResponse.json(
      { error: `Invalid domain. Must be one of: ${validDomains.join(', ')}` },
      { status: 400 }
    )
  }

  const score = await getCompositeScore(address, domain as DomainAtomValue)

  if (!score) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  return NextResponse.json(score)
}
