/**
 * Price Scanner — Momentum signal detector + paper trading simulator
 *
 * Independent loop. Scans Gamma API, tracks WS prices, detects momentum,
 * simulates paper trades with tiered exits. No DB, no real orders.
 *
 * Usage:
 *   npx tsx scripts/price-scanner.ts
 */

import { classifyMarket } from '../src/lib/classifier'
import {
  connectOrderbookWS,
  subscribeToken,
  getWsBestBid,
  getWsSpread,
  isWsConnected,
} from '../src/lib/orderbook-ws'
import {
  openPaperTrade,
  updatePrice,
  runExits,
  getOpenTrades,
  getStats,
  type ExitEvent,
} from '../src/lib/price-paper'

// ── Config ───────────────────────────────────────────────────────

const SCAN_INTERVAL_MS = 5 * 60 * 1000
const EVAL_INTERVAL_MS = 60 * 1000
const GAMMA_API = 'https://gamma-api.polymarket.com'

const MIN_PRICE = 0.05
const MAX_PRICE = 0.30
const MIN_LIQUIDITY = 2000
const MIN_SIGNAL_SCORE = 50
const HISTORY_WINDOW_MS = 60 * 60 * 1000

const PAPER_BET_SIZE = 5
const MAX_PAPER_POSITIONS = 15

const BLOCKED_DOMAINS = new Set([
  'pm-domain/crypto',
  'pm-domain/weather',
])

// ── Types ────────────────────────────────────────────────────────

type GammaMarket = {
  conditionId: string
  question: string
  clobTokenIds: string | string[]
  outcomePrices: string | string[]
  liquidity: string
  endDate?: string
  active: boolean
  closed: boolean
}

type TrackedMarket = {
  conditionId: string
  title: string
  domain: string | null
  yesTokenId: string
  noTokenId: string
  liquidity: number
  endDate: string | null
}

type PriceSnapshot = { price: number; timestamp: number }

type PriceSignal = {
  conditionId: string
  title: string
  domain: string | null
  side: 'YES' | 'NO'
  price: number
  momentumPct: number
  spread: number | null
  liquidity: number
  hoursToResolution: number | null
  score: number
  reasons: string[]
}

// ── State ────────────────────────────────────────────────────────

const trackedMarkets = new Map<string, TrackedMarket>()
const priceHistory = new Map<string, PriceSnapshot[]>()

// ── Gamma API scan ──────────────────────────────────────────────

function parseJson<T>(raw: string | T): T | null {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T } catch { return null }
  }
  return raw
}

async function scanMarkets(): Promise<number> {
  let added = 0
  let offset = 0

  for (let page = 0; page < 10; page++) {
    const url = `${GAMMA_API}/markets?active=true&closed=false&limit=100&offset=${offset}`
    let batch: GammaMarket[]
    try {
      const res = await fetch(url)
      if (!res.ok) break
      batch = await res.json() as GammaMarket[]
    } catch { break }
    if (batch.length === 0) break

    for (const m of batch) {
      if (trackedMarkets.has(m.conditionId)) continue

      const tokenIds = parseJson<string[]>(m.clobTokenIds) ?? []
      if (tokenIds.length < 2) continue

      const prices = (parseJson<string[]>(m.outcomePrices) ?? []).map(Number)
      const yesPrice = prices[0] ?? 0
      const noPrice = 1 - yesPrice

      if (!(yesPrice >= MIN_PRICE && yesPrice <= MAX_PRICE) &&
          !(noPrice >= MIN_PRICE && noPrice <= MAX_PRICE)) continue

      const liquidity = parseFloat(m.liquidity ?? '0')
      if (liquidity < MIN_LIQUIDITY) continue

      if (m.endDate) {
        const hoursLeft = (new Date(m.endDate).getTime() - Date.now()) / 3_600_000
        if (hoursLeft < 2) continue
      }

      const classification = await classifyMarket(m.question)
      const domain = classification?.domain ?? null
      if (domain && BLOCKED_DOMAINS.has(domain)) continue

      trackedMarkets.set(m.conditionId, {
        conditionId: m.conditionId, title: m.question, domain,
        yesTokenId: tokenIds[0] ?? '', noTokenId: tokenIds[1] ?? '',
        liquidity, endDate: m.endDate ?? null,
      })

      subscribeToken(tokenIds[0] ?? '')
      subscribeToken(tokenIds[1] ?? '')
      added++
    }
    offset += 100
  }
  return added
}

// ── Price tracking ──────────────────────────────────────────────

function recordPrices(): number {
  const now = Date.now()
  const cutoff = now - HISTORY_WINDOW_MS
  let recorded = 0

  for (const [condId, market] of trackedMarkets) {
    const bid = getWsBestBid(market.yesTokenId)
    if (bid == null || bid <= 0) continue

    const history = priceHistory.get(condId) ?? []
    history.push({ price: bid, timestamp: now })
    priceHistory.set(condId, history.filter(s => s.timestamp >= cutoff))
    recorded++

    // Update paper positions with live price
    updatePrice(condId, bid)
  }
  return recorded
}

// ── Signal evaluation ───────────────────────────────────────────

function evaluateSignals(): PriceSignal[] {
  const signals: PriceSignal[] = []
  const now = Date.now()

  for (const [condId, market] of trackedMarkets) {
    const history = priceHistory.get(condId)
    if (!history || history.length < 3) continue

    const currentYes = history[history.length - 1]!.price
    const spread = getWsSpread(market.yesTokenId)?.spread ?? null

    const candidates: Array<{ side: 'YES' | 'NO'; price: number }> = []
    if (currentYes >= MIN_PRICE && currentYes <= MAX_PRICE) candidates.push({ side: 'YES', price: currentYes })
    const currentNo = 1 - currentYes
    if (currentNo >= MIN_PRICE && currentNo <= MAX_PRICE) candidates.push({ side: 'NO', price: currentNo })

    for (const { side, price } of candidates) {
      const oldest = history[0]!
      const priceOld = side === 'YES' ? oldest.price : 1 - oldest.price
      const priceNow = side === 'YES' ? currentYes : 1 - currentYes

      if (now - oldest.timestamp < 10 * 60 * 1000) continue
      const momentumPct = priceOld > 0 ? (priceNow - priceOld) / priceOld : 0
      if (momentumPct < 0) continue

      const highPrice = Math.max(...history.map(s => side === 'YES' ? s.price : 1 - s.price))
      if (highPrice > priceNow * 1.3) continue

      const minMom = (spread != null && spread < 0.02) ? 0.05 : 0.08
      if (momentumPct < minMom) continue

      const reasons: string[] = []
      let score = 0

      // Entry price (15 pts)
      if (price < 0.15) { score += 15; reasons.push(`longshot ${(price * 100).toFixed(0)}c (+15)`) }
      else if (price < 0.25) { score += 12; reasons.push(`sweet ${(price * 100).toFixed(0)}c (+12)`) }
      else { score += 8; reasons.push(`value ${(price * 100).toFixed(0)}c (+8)`) }

      // Momentum (25 pts)
      if (momentumPct >= 0.30) { score += 25; reasons.push(`mom +${(momentumPct * 100).toFixed(0)}% (+25)`) }
      else if (momentumPct >= 0.15) { score += 18; reasons.push(`mom +${(momentumPct * 100).toFixed(0)}% (+18)`) }
      else if (momentumPct >= 0.08) { score += 10; reasons.push(`mom +${(momentumPct * 100).toFixed(0)}% (+10)`) }
      else if (momentumPct >= 0.05) { score += 6; reasons.push(`mom +${(momentumPct * 100).toFixed(0)}% (+6)`) }

      // Spread (15 pts) — eliminatory if > 3c
      if (spread != null && spread > 0.03) continue  // too wide, skip entirely
      if (spread != null) {
        if (spread < 0.01) { score += 15; reasons.push(`sp ${(spread * 100).toFixed(1)}c (+15)`) }
        else if (spread < 0.02) { score += 12; reasons.push(`sp ${(spread * 100).toFixed(1)}c (+12)`) }
        else { score += 8; reasons.push(`sp ${(spread * 100).toFixed(1)}c (+8)`) }
      }

      // Liquidity (15 pts)
      if (market.liquidity >= 5000) { score += 15; reasons.push(`liq $${market.liquidity.toFixed(0)} (+15)`) }
      else if (market.liquidity >= 2500) { score += 10; reasons.push(`liq $${market.liquidity.toFixed(0)} (+10)`) }
      else if (market.liquidity >= 1000) { score += 5; reasons.push(`liq $${market.liquidity.toFixed(0)} (+5)`) }

      // Resolution timing (10 pts)
      let hoursToResolution: number | null = null
      if (market.endDate) {
        hoursToResolution = (new Date(market.endDate).getTime() - now) / 3_600_000
        if (hoursToResolution >= 2 && hoursToResolution <= 48) { score += 10; reasons.push(`${hoursToResolution.toFixed(0)}h (+10)`) }
        else if (hoursToResolution <= 168) { score += 7; reasons.push(`${(hoursToResolution / 24).toFixed(1)}d (+7)`) }
        else { score += 3; reasons.push(`far (+3)`) }
      }

      if (score >= MIN_SIGNAL_SCORE) {
        signals.push({ conditionId: condId, title: market.title, domain: market.domain, side, price, momentumPct, spread, liquidity: market.liquidity, hoursToResolution, score, reasons })
      }
    }
  }
  return signals.sort((a, b) => b.score - a.score)
}

// ── Display ─────────────────────────────────────────────────────

function logExitEvents(events: ExitEvent[]): void {
  for (const ev of events) {
    const t = ev.trade
    if (ev.action === 'partial') {
      console.log(`  📤 PARTIAL | ${ev.reason} | +${(ev.pnlPct * 100).toFixed(0)}% | $${ev.pnlUsdc.toFixed(2)} | ${t.title.slice(0, 40)}`)
    } else {
      const emoji = t.status === 'won' ? '💰' : '💀'
      console.log(`  ${emoji} ${t.status!.toUpperCase()} | ${ev.reason} | ${(ev.pnlPct * 100).toFixed(0)}% | ${ev.pnlUsdc >= 0 ? '+' : ''}$${ev.pnlUsdc.toFixed(2)} | ${(t.entryPrice * 100).toFixed(0)}c→${(t.curPrice * 100).toFixed(0)}c | ${t.title.slice(0, 35)}`)
    }
  }
}

function printStatus(recorded: number, signals: PriceSignal[]): void {
  const now = new Date().toLocaleTimeString()
  const ws = isWsConnected() ? '🟢' : '🔴'
  const hist = [...priceHistory.values()].filter(h => h.length >= 3).length
  const stats = getStats()
  const open = getOpenTrades()

  console.log(
    `\n[${now}] ${trackedMarkets.size} mkts | ${hist} hist | ${recorded} px | WS ${ws} | ` +
    `${stats.openCount} open | ${stats.totalWins}W/${stats.totalLosses}L (${stats.winRate}) | PnL: ${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}`
  )

  // Signals
  for (const sig of signals.slice(0, 5)) {
    const sp = sig.spread != null ? `${(sig.spread * 100).toFixed(1)}c` : '?'
    console.log(`  🔔 ${sig.score}/100 | ${sig.side} @ ${(sig.price * 100).toFixed(0)}c | +${(sig.momentumPct * 100).toFixed(0)}% | sp:${sp} | ${sig.title.slice(0, 50)}`)
  }

  // Open positions
  if (open.length > 0) {
    console.log('  ── positions ──')
    for (const t of open) {
      const pnl = (t.curPrice - t.entryPrice) / t.entryPrice
      const unreal = t.sharesRemaining * (t.curPrice - t.entryPrice) + t.realizedPnl
      const age = ((Date.now() - t.openedAt) / 60000).toFixed(0)
      console.log(`  ${pnl >= 0 ? '📈' : '📉'} ${(pnl * 100).toFixed(1)}% | ${t.side} ${(t.entryPrice * 100).toFixed(0)}c→${(t.curPrice * 100).toFixed(0)}c | $${unreal.toFixed(2)} | ${age}m | ${t.tier} | ${t.title.slice(0, 35)}`)
    }
  }

  // Top movers (when quiet)
  if (signals.length === 0 && open.length === 0) printTopMovers()
}

function printTopMovers(): void {
  const now = Date.now()
  const movers: Array<{ title: string; side: string; price: number; mom: number; spread: number | null; pts: number }> = []

  for (const [, m] of trackedMarkets) {
    const h = priceHistory.get(m.conditionId)
    if (!h || h.length < 2 || now - h[0]!.timestamp < 60_000) continue

    const cur = h[h.length - 1]!.price
    const old = h[0]!.price
    const sp = getWsSpread(m.yesTokenId)?.spread ?? null

    if (cur >= MIN_PRICE && cur <= MAX_PRICE) {
      movers.push({ title: m.title, side: 'YES', price: cur, mom: old > 0 ? (cur - old) / old : 0, spread: sp, pts: h.length })
    }
    const noNow = 1 - cur; const noOld = 1 - old
    if (noNow >= MIN_PRICE && noNow <= MAX_PRICE) {
      movers.push({ title: m.title, side: 'NO', price: noNow, mom: noOld > 0 ? (noNow - noOld) / noOld : 0, spread: sp, pts: h.length })
    }
  }

  movers.sort((a, b) => Math.abs(b.mom) - Math.abs(a.mom))
  if (movers.length === 0) return

  console.log('  ── top movers ──')
  for (const m of movers.slice(0, 5)) {
    const sp = m.spread != null ? `${(m.spread * 100).toFixed(1)}c` : '?'
    console.log(`  ${m.mom >= 0 ? '+' : ''}${(m.mom * 100).toFixed(1)}% | ${m.side} @ ${(m.price * 100).toFixed(0)}c | sp:${sp} | ${m.pts}pts | ${m.title.slice(0, 45)}`)
  }
}

// ── Main loop ───────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════')
  console.log('  📊 PRICE SCANNER — Paper Trading Mode')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Range: ${(MIN_PRICE * 100).toFixed(0)}c-${(MAX_PRICE * 100).toFixed(0)}c | Liq: $${MIN_LIQUIDITY}+ | Score: ${MIN_SIGNAL_SCORE}+`)
  console.log(`  Paper: $${PAPER_BET_SIZE}/trade | Max: ${MAX_PAPER_POSITIONS} positions`)
  console.log(`  Exits: <15c TP+100/200/400% SL-50% | 15-25c TP+50/100% SL-30% | 25-30c TP+30/60% SL-25%`)
  console.log(`  Blocked: ${[...BLOCKED_DOMAINS].map(d => d.split('/')[1]).join(', ')}`)
  console.log('═══════════════════════════════════════════════')

  connectOrderbookWS()

  console.log('\nScanning Gamma API...')
  const added = await scanMarkets()
  console.log(`  ${added} markets tracked`)
  console.log('  Waiting for WS...\n')
  await new Promise(r => setTimeout(r, 5000))
  recordPrices()

  setInterval(async () => {
    const n = await scanMarkets()
    if (n > 0) console.log(`  📥 +${n} markets (${trackedMarkets.size} total)`)
  }, SCAN_INTERVAL_MS)

  setInterval(() => {
    const recorded = recordPrices()
    const signals = evaluateSignals()

    // Paper trade: open on signals
    for (const sig of signals) {
      // Ask = bid + spread (realistic entry price)
      const askPrice = sig.spread != null ? sig.price + sig.spread : sig.price * 1.02
      const opened = openPaperTrade(
        { conditionId: sig.conditionId, title: sig.title, side: sig.side, price: sig.price, askPrice, score: sig.score },
        PAPER_BET_SIZE, MAX_PAPER_POSITIONS,
      )
      if (opened) {
        console.log(`  📥 PAPER BUY | ${sig.side} @ ${(askPrice * 100).toFixed(1)}c (ask) | bid:${(sig.price * 100).toFixed(0)}c | $${PAPER_BET_SIZE} | score:${sig.score} | ${sig.title.slice(0, 40)}`)
      }
    }

    // Paper trade: run exits
    const events = runExits()
    logExitEvents(events)

    printStatus(recorded, signals)
  }, EVAL_INTERVAL_MS)
}

main().catch(console.error)
