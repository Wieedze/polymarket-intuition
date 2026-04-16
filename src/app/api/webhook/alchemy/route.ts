/**
 * Alchemy Address Activity Webhook endpoint
 *
 * Receives real-time notifications when expert wallets receive ERC1155 tokens.
 * Processes the transfer, scores it, and inserts a signal for the live-trader.
 *
 * URL: POST /api/webhook/alchemy
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  processWebhook,
  setExpertWallets,
  getExpertCount,
  type AlchemyWebhookPayload,
} from '../../../../lib/webhook-handler'
import { getActiveWatchedWallets } from '../../../../lib/db'

export const dynamic = 'force-dynamic'

// Load expert wallets on first request
let loaded = false
function ensureLoaded(): void {
  if (loaded) return
  try {
    const wallets = getActiveWatchedWallets()
    setExpertWallets(wallets)
    loaded = true
    console.log(`[WEBHOOK] Loaded ${wallets.length} expert wallets`)
  } catch (err) {
    console.error('[WEBHOOK] Failed to load wallets:', err)
  }
}

// GET — health check
export function GET(): NextResponse {
  ensureLoaded()
  return NextResponse.json({
    status: 'ok',
    experts: getExpertCount(),
    endpoint: '/api/webhook/alchemy',
  })
}

// POST — Alchemy webhook payload
export async function POST(req: NextRequest): Promise<NextResponse> {
  ensureLoaded()

  try {
    const payload = await req.json() as AlchemyWebhookPayload

    // Alchemy sends a test payload on webhook creation
    if (payload.type === 'ADDRESS_ACTIVITY') {
      const result = await processWebhook(payload)

      if (result.signals > 0 || result.details.length > 0) {
        const time = new Date().toISOString().slice(11, 19)
        console.log(`[WEBHOOK] ${time} | ${result.processed} activities | ${result.signals} signals | ${result.skipped} skipped | ${result.errors} errors`)
        for (const d of result.details.slice(0, 5)) {
          console.log(`  ${d}`)
        }
      }

      return NextResponse.json({
        ok: true,
        processed: result.processed,
        signals: result.signals,
        skipped: result.skipped,
      })
    }

    // Test/validation webhook
    return NextResponse.json({ ok: true, type: payload.type })
  } catch (err) {
    console.error('[WEBHOOK] Error:', err)
    return NextResponse.json({ ok: false, error: 'internal' }, { status: 500 })
  }
}
