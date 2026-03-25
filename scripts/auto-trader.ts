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

import { getActiveWatchedWallets, getOpenPaperTrades, openPaperTrade, paperTradeExistsForCondition, getPortfolioSetting, setPortfolioSetting, getAllPaperTrades, getPositionSnapshot } from '../src/lib/db'
import { pollWallet, type PositionAlert, fetchOpenPositions } from '../src/lib/position-tracker'
import { keywordClassify } from '../src/lib/classifier'
import { fetchAllPages } from '../src/lib/polymarket'
import { resolvePaperTrade, updatePaperTradePrice } from '../src/lib/db'
import { evaluateExit, exitEmoji, DEFAULT_CONFIG, type ExitConfig } from '../src/lib/exit-strategy'

const POLYMARKET_DATA_URL = process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com'

// ── Config ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '300000', 10)
const BET_SIZE = parseFloat(process.env.BET_SIZE_USDC ?? getPortfolioSetting('bet_size_usdc', '100'))
const MIN_ENTRY = parseFloat(process.env.MIN_ENTRY_PRICE ?? '0.15')
const MAX_ENTRY = parseFloat(process.env.MAX_ENTRY_PRICE ?? '0.90')
const MAX_OPEN = parseInt(process.env.MAX_OPEN_TRADES ?? '50', 10)
const MAX_CAPITAL_PCT = parseFloat(process.env.MAX_CAPITAL_PCT ?? '0.60')

// Exit strategy config (override via env vars)
const EXIT_CONFIG: ExitConfig = {
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT ?? '0.80'),
  stopLossPct: parseFloat(process.env.STOP_LOSS ?? '0.40'),
  trailingActivatePct: parseFloat(process.env.TRAILING_ACTIVATE ?? '0.30'),
  trailingStopPct: parseFloat(process.env.TRAILING_STOP ?? '0.10'),
  staleDays: parseInt(process.env.STALE_DAYS ?? '7', 10),
  staleThreshold: parseFloat(process.env.STALE_THRESHOLD ?? '0.03'),
  followExpertExit: process.env.FOLLOW_EXPERT_EXIT !== 'false',
}

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

function runExitStrategy(): Record<string, number> {
  const openTrades = getOpenPaperTrades()
  const counts: Record<string, number> = {}

  // Check if experts still hold their positions
  const expertPositions = new Map<string, Set<string>>()
  if (EXIT_CONFIG.followExpertExit) {
    const wallets = [...new Set(openTrades.map((t) => t.copiedFrom))]
    for (const w of wallets) {
      const snapshot = getPositionSnapshot(w)
      expertPositions.set(w, new Set(snapshot.keys()))
    }
  }

  for (const trade of openTrades) {
    // Check if expert still holds
    let expertStillHolding: boolean | null = null
    if (EXIT_CONFIG.followExpertExit) {
      const expertKeys = expertPositions.get(trade.copiedFrom)
      if (expertKeys) {
        // Check both outcomeIndex 0 and 1
        const key0 = `${trade.conditionId}-0`
        const key1 = `${trade.conditionId}-1`
        expertStillHolding = expertKeys.has(key0) || expertKeys.has(key1)
      }
    }

    const decision = evaluateExit(trade, EXIT_CONFIG, expertStillHolding)

    if (decision.shouldExit) {
      const exitPrice = trade.curPrice ?? trade.entryPrice
      try {
        resolvePaperTrade(trade.conditionId, exitPrice)
        const pnl = trade.shares * (exitPrice - trade.entryPrice)
        console.log(`  ${exitEmoji(decision.reason)} ${decision.reason.toUpperCase()} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${decision.message} | ${trade.title}`)
        counts[decision.reason] = (counts[decision.reason] ?? 0) + 1
      } catch (err) {
        console.error(`  ⚠ Exit failed for ${trade.conditionId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  return counts
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

  // Exit strategy (take-profit, stop-loss, trailing, stale, expert-exit)
  const exits = runExitStrategy()
  const totalExits = Object.values(exits).reduce((s, n) => s + n, 0)
  const exitSummary = Object.entries(exits).map(([k, v]) => `${v} ${k}`).join(', ')

  // Resolve completed markets (price went to 0 or 1)
  const resolved = await resolveCompletedTrades()

  const parts = [`${newPositions} new`, `${copied} copied`]
  if (totalExits > 0) parts.push(`${totalExits} exits (${exitSummary})`)
  if (resolved > 0) parts.push(`${resolved} resolved`)
  parts.push(`${pricesUpdated} prices`)
  console.log(`  → ${parts.join(' | ')}`)

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
  console.log(`  Take profit: +${(EXIT_CONFIG.takeProfitPct * 100).toFixed(0)}%`)
  console.log(`  Stop-loss:   -${(EXIT_CONFIG.stopLossPct * 100).toFixed(0)}%`)
  console.log(`  Trailing:    +${(EXIT_CONFIG.trailingActivatePct * 100).toFixed(0)}% → +${(EXIT_CONFIG.trailingStopPct * 100).toFixed(0)}%`)
  console.log(`  Stale exit:  ${EXIT_CONFIG.staleDays}d < ${(EXIT_CONFIG.staleThreshold * 100).toFixed(0)}¢ move`)
  console.log(`  Expert exit: ${EXIT_CONFIG.followExpertExit ? 'ON' : 'OFF'}`)
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
