import { NextResponse, type NextRequest } from 'next/server'
import { classifyMarket } from '@/lib/classifier'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { question?: string; category?: string }
  try {
    body = (await request.json()) as { question?: string; category?: string }
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    )
  }

  const { question, category } = body

  if (!question || typeof question !== 'string') {
    return NextResponse.json(
      { error: 'Missing required field: question' },
      { status: 400 }
    )
  }

  const result = await classifyMarket(question, category)

  if (!result) {
    return NextResponse.json({ domain: null, confidence: 0 })
  }

  return NextResponse.json({
    domain: result.domain,
    confidence: result.confidence,
  })
}
