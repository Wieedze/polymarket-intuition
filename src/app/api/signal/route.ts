import { NextResponse, type NextRequest } from 'next/server'
import { classifyMarket } from '@/lib/classifier'
import { getExpertsByDomain, getTradesByDomain } from '@/lib/db'
import { calculateConvictionScore } from '@/lib/scorer'

type ExpertInfo = {
  address: string
  calibration: number
  convictionScore: number
  trades: number
  avgPosition: number
}

type SignalResponse = {
  question: string
  domain: string | null
  expertsFound: number
  aggregatedSignal: number
  signalStrength: 'strong' | 'moderate' | 'weak'
  experts: ExpertInfo[]
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function calculateStdDev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const question = request.nextUrl.searchParams.get('question')

  if (!question) {
    return NextResponse.json(
      { error: 'Missing required query param: question' },
      { status: 400 }
    )
  }

  const classification = await classifyMarket(question)

  if (!classification) {
    const response: SignalResponse = {
      question,
      domain: null,
      expertsFound: 0,
      aggregatedSignal: 0,
      signalStrength: 'weak',
      experts: [],
    }
    return NextResponse.json(response)
  }

  const domain = classification.domain

  // Find experts: calibration > 0.65, trades >= 5
  let expertRows: ReturnType<typeof getExpertsByDomain>
  try {
    expertRows = getExpertsByDomain(domain, 0.65, 5)
  } catch {
    // SQLite unavailable (e.g. webpack bundling issue) — return domain only
    return NextResponse.json({
      question,
      domain,
      expertsFound: 0,
      aggregatedSignal: 0,
      signalStrength: 'weak' as const,
      experts: [],
    })
  }

  const experts: ExpertInfo[] = []

  for (const row of expertRows) {
    const trades = getTradesByDomain(row.wallet, domain)
    const convictionScore = calculateConvictionScore(trades)

    // Filter: convictionScore > 0.15
    if (convictionScore <= 0.15) continue

    const avgPosition =
      trades.length > 0
        ? trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length
        : 0

    experts.push({
      address: truncateAddress(row.wallet),
      calibration: row.calibration,
      convictionScore,
      trades: trades.length,
      avgPosition,
    })
  }

  // Aggregated signal: weighted average of expert positions, weighted by convictionScore
  let aggregatedSignal = 0
  if (experts.length > 0) {
    const totalWeight = experts.reduce((s, e) => s + e.convictionScore, 0)
    aggregatedSignal = totalWeight > 0
      ? experts.reduce((s, e) => s + e.avgPosition * e.convictionScore, 0) / totalWeight
      : 0
  }

  // Signal strength
  const positions = experts.map((e) => e.avgPosition)
  const stdDev = calculateStdDev(positions)
  let signalStrength: 'strong' | 'moderate' | 'weak' = 'weak'
  if (experts.length >= 3 && stdDev < 0.15) {
    signalStrength = 'strong'
  } else if (experts.length >= 2) {
    signalStrength = 'moderate'
  }

  const response: SignalResponse = {
    question,
    domain,
    expertsFound: experts.length,
    aggregatedSignal,
    signalStrength,
    experts,
  }

  return NextResponse.json(response)
}
