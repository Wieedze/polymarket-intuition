/**
 * Webhook Handler — Processes Alchemy Address Activity webhooks
 *
 * Receives token transfer notifications for expert wallets,
 * resolves market info, checks eligibility, and inserts signals.
 *
 * Standalone module. Used by the Next.js API route.
 */

import { keywordClassify } from './classifier'
import {
  insertSignal,
  positionExistsForCondition,
  getPendingOrders,
  getWalletStats,
} from './db'
import { scoreSignal, kellyBetFraction } from './signal-scorer'
import { evaluateExpertTrust } from './expert-trust'
import { fetchMarketMetadata } from './polymarket'

// ── Config ───────────────────────────────────────────────────────

const MIN_ENTRY = 0.05
const MAX_ENTRY = 0.35
const MIN_SIGNAL_SCORE = 50
const MIN_SHARES = 15

const BLOCKED_DOMAINS = new Set([
  'pm-domain/crypto',
  'pm-domain/weather',
])

// ── Types ────────────────────────────────────────────────────────

// Alchemy Address Activity webhook payload
export type AlchemyWebhookPayload = {
  webhookId: string
  id: string
  createdAt: string
  type: string
  event: {
    network: string
    activity: AlchemyActivity[]
  }
}

type AlchemyActivity = {
  fromAddress: string
  toAddress: string
  blockNum: string
  hash: string
  value: number
  asset: string
  category: string      // 'erc1155' | 'erc20' | 'erc721' | 'external'
  erc1155Metadata?: Array<{
    tokenId: string
    value: string       // hex amount
  }>
  rawContract?: {
    rawValue: string
    address: string
    decimals: number
  }
}

export type WebhookResult = {
  processed: number
  signals: number
  skipped: number
  errors: number
  details: string[]
}

// Token ID → market cache
const tokenCache = new Map<string, {
  conditionId: string
  title: string
  side: 'YES' | 'NO'
  yesTokenId: string
  noTokenId: string
  negRisk: boolean
} | null>()

// ── Expert wallet set (loaded once) ─────────────────────────────

let expertWallets: Map<string, string> = new Map()  // address → label

export function setExpertWallets(wallets: Array<{ wallet: string; label: string | null }>): void {
  expertWallets = new Map(wallets.map(w => [w.wallet.toLowerCase(), w.label ?? w.wallet.slice(0, 10)]))
}

export function getExpertCount(): number {
  return expertWallets.size
}

// ── Token resolution ────────────────────────────────────────────

async function resolveToken(tokenId: string): Promise<typeof tokenCache extends Map<string, infer V> ? V : never> {
  const cached = tokenCache.get(tokenId)
  if (cached !== undefined) return cached

  try {
    const res = await fetch(`https://clob.polymarket.com/markets?token_id=${tokenId}`)
    if (!res.ok) {
      tokenCache.set(tokenId, null)
      return null
    }

    const raw = await res.json()
    const data = Array.isArray(raw) ? raw : (raw ? [raw] : [])

    if (data.length === 0) {
      tokenCache.set(tokenId, null)
      return null
    }

    const market = data[0] as {
      condition_id: string
      question: string
      tokens: Array<{ token_id: string; outcome: string }>
      neg_risk: boolean
      active: boolean
    }

    if (!market.active) {
      tokenCache.set(tokenId, null)
      return null
    }

    const yesToken = market.tokens.find(t => t.outcome === 'Yes')
    const noToken = market.tokens.find(t => t.outcome === 'No')
    if (!yesToken || !noToken) {
      tokenCache.set(tokenId, null)
      return null
    }

    const side = tokenId === yesToken.token_id ? 'YES' as const : 'NO' as const
    const result = {
      conditionId: market.condition_id,
      title: market.question,
      side,
      yesTokenId: yesToken.token_id,
      noTokenId: noToken.token_id,
      negRisk: market.neg_risk,
    }

    tokenCache.set(yesToken.token_id, { ...result, side: 'YES' })
    tokenCache.set(noToken.token_id, { ...result, side: 'NO' })
    return result
  } catch {
    tokenCache.set(tokenId, null)
    return null
  }
}

// ── Process webhook ─────────────────────────────────────────────

export async function processWebhook(payload: AlchemyWebhookPayload): Promise<WebhookResult> {
  const result: WebhookResult = { processed: 0, signals: 0, skipped: 0, errors: 0, details: [] }

  if (!payload.event?.activity) return result

  for (const activity of payload.event.activity) {
    result.processed++

    try {
      // Only ERC1155 transfers
      if (activity.category !== 'erc1155') {
        result.skipped++
        continue
      }

      // Only transfers TO expert wallets (they're receiving = buying)
      const to = activity.toAddress.toLowerCase()
      const label = expertWallets.get(to)
      if (!label) {
        result.skipped++
        continue
      }

      // Process each ERC1155 token in the transfer
      if (!activity.erc1155Metadata || activity.erc1155Metadata.length === 0) {
        result.skipped++
        continue
      }

      for (const meta of activity.erc1155Metadata) {
        const shares = parseInt(meta.value, 16) / 1e6
        if (shares < MIN_SHARES) {
          result.skipped++
          continue
        }

        // Resolve token → market
        const mapping = await resolveToken(meta.tokenId)
        if (!mapping) {
          result.skipped++
          continue
        }

        // Domain filter
        const classification = keywordClassify(mapping.title)
        if (classification && BLOCKED_DOMAINS.has(classification.domain)) {
          result.skipped++
          result.details.push(`blocked:${classification.domain.split('/')[1]} | ${mapping.title.slice(0, 30)}`)
          continue
        }

        // Already have position
        if (positionExistsForCondition(mapping.conditionId)) {
          result.skipped++
          continue
        }

        // Already have pending order
        const pending = getPendingOrders()
        if (pending.some(po => po.conditionId === mapping.conditionId)) {
          result.skipped++
          continue
        }

        // Get current price from CLOB
        let curPrice: number | null = null
        try {
          const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${mapping.yesTokenId}`)
          if (bookRes.ok) {
            const book = await bookRes.json() as { bids: Array<{ price: string }>; asks: Array<{ price: string }> }
            if (book.bids?.length > 0) {
              const yesBid = parseFloat(book.bids[0]!.price)
              curPrice = mapping.side === 'YES' ? yesBid : 1 - yesBid
            }
          }
        } catch { /* fallback below */ }

        if (curPrice == null || curPrice < MIN_ENTRY || curPrice > MAX_ENTRY) {
          result.skipped++
          result.details.push(`price:${curPrice != null ? (curPrice * 100).toFixed(0) + 'c' : '?'} | ${mapping.title.slice(0, 30)}`)
          continue
        }

        // Check expert trust
        const trust = evaluateExpertTrust(to, label)
        if (trust.status === 'paused') {
          result.skipped++
          result.details.push(`paused:${label} | ${mapping.title.slice(0, 30)}`)
          continue
        }

        // Score signal
        const signal = scoreSignal({
          expertWallet: to,
          marketTitle: mapping.title,
          entryPrice: curPrice,
          positionSize: shares,
        })

        if (signal.score < MIN_SIGNAL_SCORE) {
          result.skipped++
          result.details.push(`low:${signal.score}/100 | ${mapping.title.slice(0, 30)}`)
          continue
        }

        // Fetch metadata for token IDs
        const metadata = await fetchMarketMetadata(mapping.conditionId)
        if (!metadata || !metadata.active) {
          result.skipped++
          continue
        }

        const kelly = kellyBetFraction(trust.winRate, curPrice)

        // Insert signal
        insertSignal({
          id: `sig-webhook-${mapping.conditionId}-${Date.now()}`,
          source: 'expert-copy',
          conditionId: mapping.conditionId,
          title: mapping.title,
          domain: classification?.domain ?? null,
          side: mapping.side,
          entryPrice: curPrice,
          signalScore: signal.score,
          kellyFraction: kelly,
          expertWallet: to,
          expertLabel: label,
          expertTrustLevel: trust.trustLevel,
          consensusCount: 1,
          positionSize: shares,
          sportKey: null,
          bookmakerProb: null,
          edge: null,
          yesTokenId: metadata.yesTokenId,
          noTokenId: metadata.noTokenId,
          negRisk: metadata.negRisk,
          reasons: signal.reasons,
          createdAt: new Date().toISOString(),
        })

        result.signals++
        result.details.push(`✅ SIGNAL ${signal.score}/100 | ${mapping.side} @ ${(curPrice * 100).toFixed(0)}c | ${label} | ${mapping.title.slice(0, 30)}`)
      }
    } catch (err) {
      result.errors++
      result.details.push(`error: ${err instanceof Error ? err.message.slice(0, 50) : 'unknown'}`)
    }
  }

  return result
}
