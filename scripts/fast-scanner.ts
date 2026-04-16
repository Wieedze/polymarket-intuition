/**
 * Fast Scanner — Real-time expert trade detection + paper trading simulation
 *
 * Listens to on-chain TransferSingle events on the CTF contract (Polygon).
 * When an expert wallet receives conditional tokens, detects it in <10s
 * instead of 60s+ with data API polling.
 *
 * Paper trading mode: simulates trades without touching the live-trader.
 *
 * Usage:
 *   export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/fast-scanner.ts
 */

import {
  startChainListener,
  addWatchedAddresses,
  getWatchedCount,
  isChainListening,
  type ExpertTrade,
} from '../src/lib/chain-listener'
import {
  connectOrderbookWS,
  subscribeToken,
  getWsBestBid,
  getWsSpread,
  isWsConnected,
} from '../src/lib/orderbook-ws'
import { keywordClassify } from '../src/lib/classifier'

// ── Config ───────────────────────────────────────────────────────

const MIN_ENTRY = 0.05
const MAX_ENTRY = 0.35
const MIN_SHARES = 15           // ignore tiny trades (dust)
const PAPER_BET_SIZE = 5        // $5 per paper trade
const MAX_PAPER_POSITIONS = 20
const STATS_INTERVAL_MS = 60_000  // print stats every minute
const COOLDOWN_MS = 30 * 60_000  // 30 min cooldown per conditionId

const BLOCKED_DOMAINS = new Set([
  'pm-domain/crypto',
  'pm-domain/weather',
])

// ── Types ────────────────────────────────────────────────────────

type PaperTrade = {
  conditionId: string
  title: string
  side: 'YES' | 'NO'
  entryPrice: number       // ask price (realistic entry)
  curPrice: number         // bid price (what we'd sell at)
  shares: number
  sizeUsdc: number
  expertWallet: string
  tokenId: string
  openedAt: number
  status: 'open' | 'won' | 'lost'
  closedAt: number | null
  exitReason: string | null
  pnl: number
}

// Token ID → conditionId + side mapping (cached from metadata lookups)
type TokenMapping = {
  conditionId: string
  side: 'YES' | 'NO'
  title: string
  yesTokenId: string
  noTokenId: string
  negRisk: boolean
}

// ── State ────────────────────────────────────────────────────────

const paperTrades: PaperTrade[] = []
const tokenMap = new Map<string, TokenMapping>()       // tokenId → market info
const pendingLookups = new Set<string>()               // tokenIds being looked up
const cooldowns = new Map<string, number>()            // conditionId → cooldown until
const seenTxs = new Set<string>()                      // dedup

let totalPnl = 0
let totalWins = 0
let totalLosses = 0
let tradesDetected = 0
let tradesSkipped = 0

// ── Expert wallets ──────────────────────────────────────────────

async function loadExperts(): Promise<string[]> {
  // Load from shared DB (polymarket.db)
  const dbPath = process.env.SHARED_DB_PATH ?? 'data/polymarket.db'
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare('SELECT wallet FROM watched_wallets WHERE active = 1').all() as Array<{ wallet: string }>
  db.close()
  return rows.map(r => r.wallet)
}

// ── Token ID resolution ─────────────────────────────────────────

async function resolveTokenId(tokenId: string): Promise<TokenMapping | null> {
  // Check cache
  const cached = tokenMap.get(tokenId)
  if (cached) return cached

  // Avoid duplicate lookups
  if (pendingLookups.has(tokenId)) return null
  pendingLookups.add(tokenId)

  try {
    // Try CLOB API to find which market this token belongs to
    const res = await fetch(`https://clob.polymarket.com/markets?token_id=${tokenId}`)
    if (!res.ok) return null

    const data = await res.json() as Array<{
      condition_id: string
      question: string
      tokens: Array<{ token_id: string; outcome: string }>
      neg_risk: boolean
      active: boolean
    }>

    if (!data || data.length === 0) return null
    const market = data[0]!
    if (!market.active) return null

    const yesToken = market.tokens.find(t => t.outcome === 'Yes')
    const noToken = market.tokens.find(t => t.outcome === 'No')
    if (!yesToken || !noToken) return null

    const side = tokenId === yesToken.token_id ? 'YES' : 'NO'

    const mapping: TokenMapping = {
      conditionId: market.condition_id,
      side,
      title: market.question,
      yesTokenId: yesToken.token_id,
      noTokenId: noToken.token_id,
      negRisk: market.neg_risk,
    }

    // Cache both token IDs
    tokenMap.set(yesToken.token_id, { ...mapping, side: 'YES' })
    tokenMap.set(noToken.token_id, { ...mapping, side: 'NO' })

    // Subscribe to WS for real-time prices
    subscribeToken(yesToken.token_id)
    subscribeToken(noToken.token_id)

    return mapping
  } catch {
    return null
  } finally {
    pendingLookups.delete(tokenId)
  }
}

// ── Trade handler ───────────────────────────────────────────────

async function handleExpertTrade(trade: ExpertTrade): Promise<void> {
  // Dedup
  if (seenTxs.has(trade.transactionHash)) return
  seenTxs.add(trade.transactionHash)
  // Cap dedup set
  if (seenTxs.size > 10000) {
    const arr = [...seenTxs]
    for (let i = 0; i < 5000; i++) seenTxs.delete(arr[i]!)
  }

  tradesDetected++

  // Ignore tiny trades
  const shares = Number(trade.amount) / 1e6  // CTF uses 6 decimals
  if (shares < MIN_SHARES) {
    tradesSkipped++
    return
  }

  // Resolve token → market
  const mapping = await resolveTokenId(trade.tokenId)
  if (!mapping) {
    tradesSkipped++
    return
  }

  // Domain filter
  const classification = keywordClassify(mapping.title)
  if (classification && BLOCKED_DOMAINS.has(classification.domain)) {
    tradesSkipped++
    return
  }

  // Get current price from WS
  const bid = getWsBestBid(mapping.yesTokenId)
  if (bid == null) {
    tradesSkipped++
    return
  }

  const curPrice = mapping.side === 'YES' ? bid : 1 - bid

  // Price filter
  if (curPrice < MIN_ENTRY || curPrice > MAX_ENTRY) {
    console.log(`  [FAST] SKIP ${(curPrice * 100).toFixed(0)}c > ${(MAX_ENTRY * 100).toFixed(0)}c | ${mapping.title.slice(0, 45)}`)
    tradesSkipped++
    return
  }

  // Spread check
  const wsData = getWsSpread(mapping.yesTokenId)
  const spread = wsData?.spread ?? null
  if (spread != null && spread > 0.03) {
    console.log(`  [FAST] SKIP spread ${(spread * 100).toFixed(1)}c > 3c | ${mapping.title.slice(0, 45)}`)
    tradesSkipped++
    return
  }

  // Cooldown check
  const cd = cooldowns.get(mapping.conditionId) ?? 0
  if (Date.now() < cd) return

  // Already have position
  if (paperTrades.some(t => t.status === 'open' && t.conditionId === mapping.conditionId)) return

  // Max positions
  if (paperTrades.filter(t => t.status === 'open').length >= MAX_PAPER_POSITIONS) return

  // Calculate realistic entry price (ask)
  const askPrice = spread != null ? curPrice + spread : curPrice * 1.02
  if (askPrice > MAX_ENTRY) return

  // ── PAPER BUY ──
  const paperShares = PAPER_BET_SIZE / askPrice

  paperTrades.push({
    conditionId: mapping.conditionId,
    title: mapping.title,
    side: mapping.side,
    entryPrice: askPrice,
    curPrice,
    shares: paperShares,
    sizeUsdc: PAPER_BET_SIZE,
    expertWallet: trade.wallet,
    tokenId: trade.tokenId,
    openedAt: Date.now(),
    status: 'open',
    closedAt: null,
    exitReason: null,
    pnl: 0,
  })

  const latency = Date.now() - trade.detectedAt
  console.log(
    `  📥 PAPER BUY | ${mapping.side} @ ${(askPrice * 100).toFixed(1)}c (ask) | bid:${(curPrice * 100).toFixed(0)}c | ` +
    `$${PAPER_BET_SIZE} | ${shares.toFixed(0)} expert shares | ${latency}ms | ${mapping.title.slice(0, 40)}`
  )
}

// ── Price updates + exits ───────────────────────────────────────

function updatePricesAndExits(): void {
  const now = Date.now()

  for (const trade of paperTrades) {
    if (trade.status !== 'open') continue

    // Update price
    const mapping = tokenMap.get(trade.tokenId)
    if (!mapping) continue
    const bid = getWsBestBid(mapping.yesTokenId)
    if (bid != null) {
      trade.curPrice = trade.side === 'YES' ? bid : 1 - bid
    }

    const pnlPct = (trade.curPrice - trade.entryPrice) / trade.entryPrice
    const ageHours = (now - trade.openedAt) / 3_600_000

    // Exit conditions
    let exitReason: string | null = null

    // Near resolution (price near 0 or 1)
    if (trade.curPrice >= 0.90 || trade.curPrice <= 0.03) {
      exitReason = 'near-resolution'
    }
    // Take profit +50%
    else if (pnlPct >= 0.50) {
      exitReason = `tp-${(pnlPct * 100).toFixed(0)}%`
    }
    // Stop loss -30%
    else if (pnlPct <= -0.30) {
      exitReason = 'stop-loss'
    }
    // Stale (48h)
    else if (ageHours >= 48) {
      exitReason = 'stale'
    }

    if (exitReason) {
      trade.pnl = trade.shares * (trade.curPrice - trade.entryPrice)
      trade.status = trade.pnl >= 0 ? 'won' : 'lost'
      trade.closedAt = now
      trade.exitReason = exitReason

      totalPnl += trade.pnl
      if (trade.status === 'won') totalWins++
      else totalLosses++

      cooldowns.set(trade.conditionId, now + COOLDOWN_MS)

      const emoji = trade.status === 'won' ? '💰' : '💀'
      console.log(
        `  ${emoji} PAPER ${trade.status.toUpperCase()} | ${exitReason} | ${(pnlPct * 100).toFixed(0)}% | ` +
        `${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} | ` +
        `${(trade.entryPrice * 100).toFixed(0)}c→${(trade.curPrice * 100).toFixed(0)}c | ${trade.title.slice(0, 35)}`
      )
    }
  }
}

// ── Display ─────────────────────────────────────────────────────

function printStats(): void {
  const now = new Date().toLocaleTimeString()
  const chain = isChainListening() ? '🟢' : '🔴'
  const ws = isWsConnected() ? '🟢' : '🔴'
  const open = paperTrades.filter(t => t.status === 'open')
  const total = totalWins + totalLosses
  const winRate = total > 0 ? `${((totalWins / total) * 100).toFixed(0)}%` : '-'

  console.log(
    `\n[${now}] Chain ${chain} | WS ${ws} | ${getWatchedCount()} experts | ` +
    `${tradesDetected} detected | ${tradesSkipped} skipped | ` +
    `${open.length} open | ${totalWins}W/${totalLosses}L (${winRate}) | PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`
  )

  if (open.length > 0) {
    console.log('  ── positions ──')
    for (const t of open) {
      const pnl = (t.curPrice - t.entryPrice) / t.entryPrice
      const unreal = t.shares * (t.curPrice - t.entryPrice)
      const age = ((Date.now() - t.openedAt) / 60000).toFixed(0)
      console.log(
        `  ${pnl >= 0 ? '📈' : '📉'} ${(pnl * 100).toFixed(1)}% | ${t.side} ${(t.entryPrice * 100).toFixed(0)}c→${(t.curPrice * 100).toFixed(0)}c | ` +
        `$${unreal.toFixed(2)} | ${age}m | ${t.title.slice(0, 40)}`
      )
    }
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════')
  console.log('  ⚡ FAST SCANNER — Real-time Chain Listener')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Entry range:  ${(MIN_ENTRY * 100).toFixed(0)}c - ${(MAX_ENTRY * 100).toFixed(0)}c`)
  console.log(`  Max spread:   3c`)
  console.log(`  Paper bet:    $${PAPER_BET_SIZE}`)
  console.log(`  Max pos:      ${MAX_PAPER_POSITIONS}`)
  console.log(`  Min shares:   ${MIN_SHARES} (expert trade size)`)
  console.log(`  Exit:         TP +50% | SL -30% | Stale 48h`)
  console.log(`  Blocked:      ${[...BLOCKED_DOMAINS].map(d => d.split('/')[1]).join(', ')}`)
  console.log('═══════════════════════════════════════════════')

  // Load expert wallets
  const experts = await loadExperts()
  if (experts.length === 0) {
    console.log('\n❌ No active expert wallets found in polymarket.db!')
    console.log('   Run bulk-index first or add wallets manually.')
    process.exit(1)
  }

  addWatchedAddresses(experts)
  console.log(`\n  📋 Loaded ${experts.length} expert wallets`)

  // Start WS for real-time prices
  connectOrderbookWS()

  // Start chain listener
  startChainListener(handleExpertTrade)

  console.log('  Waiting for expert trades...\n')

  // Periodic: update prices, check exits, print stats
  setInterval(() => {
    updatePricesAndExits()
    printStats()
  }, STATS_INTERVAL_MS)
}

main().catch(console.error)
