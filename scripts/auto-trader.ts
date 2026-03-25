/**
 * Auto Paper Trader
 *
 * Polls watched wallets, auto-copies new positions as paper trades,
 * and resolves completed markets. Runs in a loop.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/auto-trader.ts
 *
 * Env vars:
 *   POLL_INTERVAL_MS  — polling interval (default: 300000 = 5min)
 *   BET_SIZE_USDC     — simulated bet size (default: 100)
 *   MIN_ENTRY_PRICE   — skip longshots below this (default: 0.15)
 *   MAX_ENTRY_PRICE   — skip near-resolved above this (default: 0.90)
 *   MAX_OPEN_TRADES   — max simultaneous open paper trades (default: 50)
 */

import { getActiveWatchedWallets, getOpenPaperTrades, openPaperTrade, paperTradeExistsForCondition, getPortfolioSetting, setPortfolioSetting, getAllPaperTrades } from '../src/lib/db'
import { pollWallet, type PositionAlert, fetchOpenPositions } from '../src/lib/position-tracker'
import { keywordClassify } from '../src/lib/classifier'
import { fetchAllPages } from '../src/lib/polymarket'
import { resolvePaperTrade, updatePaperTradePrice } from '../src/lib/db'

const POLYMARKET_DATA_URL = process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com'

// ── Config ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '300000', 10)
const BET_SIZE = parseFloat(process.env.BET_SIZE_USDC ?? getPortfolioSetting('bet_size_usdc', '100'))
const MIN_ENTRY = parseFloat(process.env.MIN_ENTRY_PRICE ?? '0.15')
const MAX_ENTRY = parseFloat(process.env.MAX_ENTRY_PRICE ?? '0.90')
const MAX_OPEN = parseInt(process.env.MAX_OPEN_TRADES ?? '50', 10)
const STOP_LOSS = parseFloat(process.env.STOP_LOSS ?? '0.40')       // cut at -40%
const TRAILING_ACTIVATE = parseFloat(process.env.TRAILING_ACTIVATE ?? '0.30') // activate trailing at +30%
const TRAILING_STOP = parseFloat(process.env.TRAILING_STOP ?? '0.10')  // take profit if drops to +10% after peak
const MAX_CAPITAL_PCT = parseFloat(process.env.MAX_CAPITAL_PCT ?? '0.60') // max 60% of balance invested

// ── Auto-copy logic ──────────────────────────────────────────────

function shouldCopy(alert: PositionAlert): boolean {
  if (alert.type !== 'NEW_POSITION') return false

  const price = alert.position.curPrice
  // Skip longshots and near-resolved
  if (price < MIN_ENTRY || price > MAX_ENTRY) return false

  // Skip if already have paper trade for this market
  if (paperTradeExistsForCondition(alert.position.conditionId)) return false

  // Skip if too many open trades
  const openTrades = getOpenPaperTrades()
  if (openTrades.length >= MAX_OPEN) return false

  // Capital guard: don't invest more than MAX_CAPITAL_PCT of balance
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '10000'))
  const closedTrades = getAllPaperTrades().filter((t) => t.status !== 'open')
  const realizedPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const currentBalance = startBal + realizedPnl
  const totalInvested = openTrades.reduce((s, t) => s + t.simulatedUsdc, 0)

  if (totalInvested + BET_SIZE > currentBalance * MAX_CAPITAL_PCT) return false

  return true
}

function autoCopy(alert: PositionAlert): void {
  const domain = keywordClassify(alert.position.title)
  const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'

  const trade = openPaperTrade({
    conditionId: alert.position.conditionId,
    title: alert.position.title,
    domain: domain?.domain ?? null,
    side,
    entryPrice: alert.position.curPrice,
    simulatedUsdc: BET_SIZE,
    copiedFrom: alert.wallet,
    copiedLabel: alert.walletLabel,
  })

  const domainTag = domain ? `[${domain.domain.replace('pm-domain/', '')}]` : ''
  console.log(`  📋 COPIED | ${side} @ ${(alert.position.curPrice * 100).toFixed(0)}¢ | $${BET_SIZE} | ${alert.position.title} ${domainTag}`)
}

// ── Resolve logic ────────────────────────────────────────────────

type PositionRecord = {
  conditionId: string
  curPrice: number
  redeemable: boolean
}

async function resolveCompletedTrades(): Promise<number> {
  const openTrades = getOpenPaperTrades()
  if (openTrades.length === 0) return 0

  const wallets = [...new Set(openTrades.map((t) => t.copiedFrom))]
  let resolved = 0

  for (const wallet of wallets) {
    try {
      const positions = await fetchAllPages<PositionRecord>(
        `${POLYMARKET_DATA_URL}/positions?user=${wallet}&sizeThreshold=0&closed=true`,
        2
      )

      for (const pos of positions) {
        if (pos.curPrice < 0.05 || pos.curPrice > 0.95) {
          const matching = openTrades.filter((t) => t.conditionId === pos.conditionId)
          for (const trade of matching) {
            resolvePaperTrade(pos.conditionId, pos.curPrice)
            const result = pos.curPrice > 0.95
              ? (trade.side === 'YES' ? 'WON' : 'LOST')
              : (trade.side === 'NO' ? 'WON' : 'LOST')
            const pnl = trade.shares * (pos.curPrice > 0.95
              ? (trade.side === 'YES' ? 1 - trade.entryPrice : -trade.entryPrice)
              : (trade.side === 'NO' ? 1 - trade.entryPrice : -trade.entryPrice))
            console.log(`  ✅ RESOLVED | ${result} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | ${trade.title}`)
            resolved++
          }
        }
      }
    } catch {
      // Skip
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  return resolved
}

// ── Price update ─────────────────────────────────────────────────

async function refreshOpenPrices(): Promise<number> {
  const openTrades = getOpenPaperTrades()
  if (openTrades.length === 0) return 0

  const wallets = [...new Set(openTrades.map((t) => t.copiedFrom))]
  let updated = 0

  for (const wallet of wallets) {
    try {
      const positions = await fetchAllPages<{ conditionId: string; curPrice: number }>(
        `${POLYMARKET_DATA_URL}/positions?user=${wallet}&sizeThreshold=0`,
        2
      )
      for (const pos of positions) {
        const matching = openTrades.filter((t) => t.conditionId === pos.conditionId)
        for (const _t of matching) {
          updatePaperTradePrice(pos.conditionId, pos.curPrice)
          updated++
        }
      }
    } catch {
      // Skip
    }
    await new Promise((r) => setTimeout(r, 500))
  }

  return updated
}

// ── Risk management ──────────────────────────────────────────────

function runRiskManagement(): { stopped: number; trailed: number } {
  const openTrades = getOpenPaperTrades()
  let stopped = 0
  let trailed = 0

  for (const trade of openTrades) {
    if (trade.curPrice == null) continue

    // Current PnL % (relative to entry)
    let pnlPct: number
    if (trade.side === 'YES') {
      pnlPct = (trade.curPrice - trade.entryPrice) / trade.entryPrice
    } else {
      pnlPct = (trade.entryPrice - trade.curPrice) / trade.entryPrice
    }

    // Peak PnL % (best the position has been)
    const peakPrice = trade.peakPrice ?? trade.curPrice
    let peakPnlPct: number
    if (trade.side === 'YES') {
      peakPnlPct = (peakPrice - trade.entryPrice) / trade.entryPrice
    } else {
      peakPnlPct = (trade.entryPrice - peakPrice) / trade.entryPrice
      // For NO side, peak is actually the LOWEST price (most profitable)
      // We need to reconsider: peakPrice tracks highest curPrice
      // For NO side, the lowest curPrice is the most profitable
      // So we need to check if peak was profitable differently
    }

    // STOP-LOSS: cut if losing more than threshold
    if (pnlPct < -STOP_LOSS) {
      resolvePaperTrade(trade.conditionId, trade.curPrice)
      const pnl = trade.shares * (trade.curPrice - trade.entryPrice)
      console.log(`  🛑 STOP | -${(Math.abs(pnlPct) * 100).toFixed(0)}% | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${trade.title}`)
      stopped++
      continue
    }

    // TRAILING STOP: if position WAS up +30% and now dropped below +10%, take profit
    // For YES: peak was high, now dropped. peakPnlPct > 30%, current < 10%
    // For NO: more complex — skip trailing for NO side for simplicity
    if (trade.side === 'YES' && peakPnlPct >= TRAILING_ACTIVATE && pnlPct <= TRAILING_STOP) {
      resolvePaperTrade(trade.conditionId, trade.curPrice)
      const pnl = trade.shares * (trade.curPrice - trade.entryPrice)
      console.log(`  📈 TRAIL | was +${(peakPnlPct * 100).toFixed(0)}% → now +${(pnlPct * 100).toFixed(0)}% | +$${pnl.toFixed(2)} | ${trade.title}`)
      trailed++
      continue
    }

    // For NO side trailing: peakPrice is highest seen, but for NO we want LOWEST
    // Since we track peak_price as MAX(curPrice), for NO side the best was the MIN
    // We can approximate: if NO side is profitable (curPrice < entryPrice) and was very profitable
    // but now less so, trail it. Use a simpler heuristic:
    if (trade.side === 'NO' && pnlPct > 0) {
      // Currently profitable. Check if it was much more profitable before
      // Entry was high, curPrice dropped = profit. If curPrice bounces back up = losing profit
      const entryToNow = trade.entryPrice - trade.curPrice
      const entryToPeak = trade.entryPrice - peakPrice  // negative if peak > entry = loss direction
      // If peak was above entry (bad for NO), that means position went against us then recovered
      // Only trail if we've been at +30%+ and now at +10%
      if (pnlPct >= 0 && entryToNow > 0) {
        // We're profitable now. Was the profit ever higher?
        // Hard to track with peak=MAX. Skip complex NO trailing for now.
      }
    }
  }

  return { stopped, trailed }
}

// ── Stats ────────────────────────────────────────────────────────

function printStats(): void {
  const all = getAllPaperTrades()
  const open = all.filter((t) => t.status === 'open')
  const won = all.filter((t) => t.status === 'won')
  const lost = all.filter((t) => t.status === 'lost')
  const realizedPnl = [...won, ...lost].reduce((s, t) => s + (t.pnl ?? 0), 0)
  const unrealizedPnl = open.reduce((s, t) => {
    if (t.curPrice == null) return s
    return s + t.shares * (t.curPrice - t.entryPrice)
  }, 0)
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '10000'))
  const balance = startBal + realizedPnl
  const winRate = (won.length + lost.length) > 0
    ? won.length / (won.length + lost.length)
    : 0

  console.log(`\n  ┌─────────────────────────────────────┐`)
  console.log(`  │ Balance:  $${balance.toFixed(2).padStart(10)}  (start: $${startBal.toFixed(0)})`)
  console.log(`  │ Realized: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2).padStart(10)}`)
  console.log(`  │ Unreal:   ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2).padStart(10)}`)
  console.log(`  │ Open:     ${open.length.toString().padStart(10)}  trades`)
  console.log(`  │ Win Rate: ${(winRate * 100).toFixed(0).padStart(9)}%  (${won.length}W / ${lost.length}L)`)
  console.log(`  └─────────────────────────────────────┘\n`)
}

// ── Main loop ────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const wallets = getActiveWatchedWallets()
  const time = new Date().toISOString().slice(11, 19)

  console.log(`[${time}] Polling ${wallets.length} wallets...`)

  let newPositions = 0
  let copied = 0

  for (const { wallet, label } of wallets) {
    try {
      const alerts = await pollWallet(wallet, label)

      for (const alert of alerts) {
        if (alert.type === 'NEW_POSITION') {
          newPositions++
          const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
          console.log(`  🔔 NEW | ${label ?? wallet.slice(0, 10)} | ${side} @ ${(alert.position.curPrice * 100).toFixed(0)}¢ | ${alert.position.title}`)

          if (shouldCopy(alert)) {
            autoCopy(alert)
            copied++
          }
        }
      }
    } catch {
      // Skip
    }
    await new Promise((r) => setTimeout(r, 800))
  }

  // Refresh prices first (needed for stop-loss)
  const pricesUpdated = await refreshOpenPrices()

  // Risk management (stop-loss + trailing stop)
  const { stopped, trailed } = runRiskManagement()

  // Resolve completed markets
  const resolved = await resolveCompletedTrades()

  console.log(`  → ${newPositions} new | ${copied} copied | ${stopped} stopped | ${trailed} trailed | ${resolved} resolved | ${pricesUpdated} prices`)

  printStats()
}

async function main(): Promise<void> {
  const wallets = getActiveWatchedWallets()

  if (wallets.length === 0) {
    console.log('No watched wallets. Run bulk-index first:')
    console.log('  node_modules/.bin/tsx scripts/bulk-index.ts 20 MONTH --watch')
    process.exit(1)
  }

  // Init portfolio settings if not set
  if (getPortfolioSetting('starting_balance', '') === '') {
    setPortfolioSetting('starting_balance', '10000')
  }
  if (getPortfolioSetting('bet_size_usdc', '') === '') {
    setPortfolioSetting('bet_size_usdc', BET_SIZE.toString())
  }

  console.log('═══════════════════════════════════════════════')
  console.log('  AUTO PAPER TRADER')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Wallets:    ${wallets.length}`)
  console.log(`  Bet size:   $${BET_SIZE}`)
  console.log(`  Entry range: ${(MIN_ENTRY * 100).toFixed(0)}¢ - ${(MAX_ENTRY * 100).toFixed(0)}¢`)
  console.log(`  Max open:   ${MAX_OPEN}`)
  console.log(`  Stop-loss:  -${(STOP_LOSS * 100).toFixed(0)}%`)
  console.log(`  Trail:      activate +${(TRAILING_ACTIVATE * 100).toFixed(0)}%, stop +${(TRAILING_STOP * 100).toFixed(0)}%`)
  console.log(`  Max capital: ${(MAX_CAPITAL_PCT * 100).toFixed(0)}%`)
  console.log(`  Poll every: ${POLL_INTERVAL_MS / 1000}s`)
  console.log('═══════════════════════════════════════════════')

  printStats()

  console.log('Starting first poll...\n')
  await pollOnce()

  setInterval(() => {
    pollOnce().catch((err) => {
      console.error(`Poll error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, POLL_INTERVAL_MS)
}

main().catch(console.error)
