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
 *   BET_PCT           — % of available cash per trade (default: 0.02 = 2%)
 *   MIN_ENTRY_PRICE   — skip longshots below this (default: 0.15)
 *   MAX_ENTRY_PRICE   — skip near-resolved above this (default: 0.90)
 *   MAX_OPEN_TRADES   — max simultaneous open paper trades (default: 50)
 */

import { getActiveWatchedWallets, getOpenPaperTrades, openPaperTrade, paperTradeExistsForCondition, getPortfolioSetting, setPortfolioSetting, getAllPaperTrades, getPositionSnapshot } from '../src/lib/db'
import { pollWallet, type PositionAlert } from '../src/lib/position-tracker'
import { keywordClassify } from '../src/lib/classifier'
import { fetchAllPages } from '../src/lib/polymarket'
import { resolvePaperTrade, updatePaperTradePrice, logBotEvent } from '../src/lib/db'
import { evaluateExit, exitEmoji, type ExitConfig } from '../src/lib/exit-strategy'
import { scoreSignal, shouldCopySignal, signalBetMultiplier, isContradictory, kellyBetFraction } from '../src/lib/signal-scorer'
import { evaluateExpertTrust, getAllExpertTrust } from '../src/lib/expert-trust'

const POLYMARKET_DATA_URL = process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com'

// ── Config ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '300000', 10)
const BET_PCT = parseFloat(process.env.BET_PCT ?? '0.02')  // 2% of available cash per trade
const MIN_BET = 20    // never bet less than $20
const MAX_BET = 500   // never bet more than $500
const MIN_ENTRY = parseFloat(process.env.MIN_ENTRY_PRICE ?? '0.15')
const MAX_ENTRY = parseFloat(process.env.MAX_ENTRY_PRICE ?? '0.60')  // data shows 70-90¢ loses $3K
const MAX_OPEN = parseInt(process.env.MAX_OPEN_TRADES ?? '50', 10)
const MAX_CAPITAL_PCT = parseFloat(process.env.MAX_CAPITAL_PCT ?? '0.60')

function getAvailableCash(): number {
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '10000'))
  const allTrades = getAllPaperTrades()
  const realizedPnl = allTrades
    .filter((t) => t.status !== 'open')
    .reduce((s, t) => s + (t.pnl ?? 0), 0)
  const totalInvested = allTrades
    .filter((t) => t.status === 'open')
    .reduce((s, t) => s + t.simulatedUsdc, 0)
  return startBal + realizedPnl - totalInvested
}

function getDynamicBetSize(): number {
  const cash = getAvailableCash()
  const bet = cash * BET_PCT
  return Math.min(Math.max(bet, MIN_BET), MAX_BET)
}

// Exit strategy config (override via env vars)
const EXIT_CONFIG: ExitConfig = {
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT ?? '999'),
  stopLossPct: parseFloat(process.env.STOP_LOSS ?? '0.25'),
  trailingActivatePct: parseFloat(process.env.TRAILING_ACTIVATE ?? '999'),
  trailingStopPct: parseFloat(process.env.TRAILING_STOP ?? '0.10'),
  nearResolutionThreshold: parseFloat(process.env.NEAR_RESOLUTION ?? '0.85'),
  staleDays: parseInt(process.env.STALE_DAYS ?? '7', 10),
  staleThreshold: parseFloat(process.env.STALE_THRESHOLD ?? '0.03'),
  followExpertExit: process.env.FOLLOW_EXPERT_EXIT !== 'false',
}

// ── Consensus tracking ───────────────────────────────────────────
// Track which experts entered which markets this poll cycle
// Key: conditionId → list of experts who entered

type ConsensusEntry = {
  conditionId: string
  title: string
  side: string
  price: number
  experts: Array<{ wallet: string; label: string | null; size: number }>
}

const consensusMap = new Map<string, ConsensusEntry>()

function trackConsensus(alert: PositionAlert): void {
  if (alert.type !== 'NEW_POSITION') return

  const key = alert.position.conditionId
  const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'

  const existing = consensusMap.get(key)
  if (existing) {
    // Only count if same side
    if (existing.side === side) {
      existing.experts.push({
        wallet: alert.wallet,
        label: alert.walletLabel,
        size: alert.position.size,
      })
    }
  } else {
    consensusMap.set(key, {
      conditionId: key,
      title: alert.position.title,
      side,
      price: alert.position.curPrice,
      experts: [{
        wallet: alert.wallet,
        label: alert.walletLabel,
        size: alert.position.size,
      }],
    })
  }
}

function getConsensusMultiplier(conditionId: string): number {
  const entry = consensusMap.get(conditionId)
  if (!entry) return 1
  const n = entry.experts.length
  // INVERTED: consensus = late entry signal → reduce sizing
  // 1 expert = 1x (fresh signal, full size)
  // 2 experts = 0.7x (cote already moved, reduce)
  // 3+ experts = 0.5x (crowded trade, likely late)
  // 5+ experts = 0.3x (everyone piled in, edge gone)
  if (n >= 5) return 0.3
  if (n >= 3) return 0.5
  if (n >= 2) return 0.7
  return 1
}

// ── Auto-copy logic (signal-based) ───────────────────────────────

function canCopy(alert: PositionAlert): boolean {
  if (alert.type !== 'NEW_POSITION') return false

  const price = alert.position.curPrice
  if (price < MIN_ENTRY || price > MAX_ENTRY) return false
  if (paperTradeExistsForCondition(alert.position.conditionId)) return false

  const openTrades = getOpenPaperTrades()
  if (openTrades.length >= MAX_OPEN) return false

  // Capital guard
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '10000'))
  const closedTrades = getAllPaperTrades().filter((t) => t.status !== 'open')
  const realizedPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const currentBalance = startBal + realizedPnl
  const totalInvested = openTrades.reduce((s, t) => s + t.simulatedUsdc, 0)

  const betSize = getDynamicBetSize()
  if (totalInvested + betSize > currentBalance * MAX_CAPITAL_PCT) return false

  return true
}

function tryCopyWithSignal(alert: PositionAlert): boolean {
  // Check expert trust level first — paused experts are skipped
  const trust = evaluateExpertTrust(alert.wallet, alert.walletLabel)
  if (trust.status === 'paused') {
    console.log(`  ⛔ PAUSED | ${alert.walletLabel ?? alert.wallet.slice(0, 10)} | ${trust.reason}`)
    return false
  }

  // Score the signal — is this a good trade to copy?
  const signal = scoreSignal({
    expertWallet: alert.wallet,
    marketTitle: alert.position.title,
    entryPrice: alert.position.curPrice,
    positionSize: alert.position.size,
  })

  if (!shouldCopySignal(signal)) {
    if (signal.score > 20) {
      console.log(`  ⏭️  SKIP (${signal.score}/100) | ${signal.reasons[0]} | ${alert.position.title}`)
    }
    return false
  }

  const domain = keywordClassify(alert.position.title)
  const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'

  // ── Slippage simulation ─────────────────────────────────────────
  // In reality we enter AFTER the sharp — price has already moved.
  // Longshots (15-30¢) have wide spreads → bigger slippage.
  // Value zone (30-55¢) has better liquidity → smaller slippage.
  const rawPrice = alert.position.curPrice
  const slippage = rawPrice < 0.30 ? 0.05 : 0.03
  const entryPrice = Math.min(rawPrice + slippage, 0.95)

  // ── Kelly-based sizing ──────────────────────────────────────────
  // Kelly tells us how much to bet given our edge at this entry price.
  // Use expert's win rate as our probability estimate.
  // Quarter-Kelly already applied inside kellyBetFraction().
  const kellyFraction = kellyBetFraction(trust.winRate, entryPrice)
  const bankroll = parseFloat(getPortfolioSetting('starting_balance', '10000'))
  const allTrades = getAllPaperTrades()
  const realizedPnl = allTrades.filter(t => t.status !== 'open').reduce((s, t) => s + (t.pnl ?? 0), 0)
  const currentBankroll = bankroll + realizedPnl

  // Dynamic sizing: Kelly × bankroll × signal × consensus(inverted) × trust
  // If Kelly is 0 (no edge), fall back to minimum bet
  const baseBet = kellyFraction > 0
    ? Math.min(Math.max(currentBankroll * kellyFraction, MIN_BET), MAX_BET)
    : MIN_BET

  const signalMulti = signalBetMultiplier(signal)
  const consensusMulti = getConsensusMultiplier(alert.position.conditionId)
  const trustMulti = trust.trustLevel
  const betAmount = Math.min(baseBet * signalMulti * consensusMulti * trustMulti, MAX_BET)

  // Dynamic stop loss: tighter on longshots (they resolve fast, no need for wide stop)
  // 15-30¢ → -20% stop | 30-55¢ → -25% stop
  const dynamicStopLoss = entryPrice < 0.30 ? 0.20 : 0.25

  const consensusEntry = consensusMap.get(alert.position.conditionId)
  const expertCount = consensusEntry?.experts.length ?? 1

  openPaperTrade({
    conditionId: alert.position.conditionId,
    title: alert.position.title,
    domain: domain?.domain ?? null,
    side,
    entryPrice,           // slippage-adjusted
    simulatedUsdc: betAmount,
    copiedFrom: alert.wallet,
    copiedLabel: alert.walletLabel,
  })

  const domainTag = domain ? `[${domain.domain.replace('pm-domain/', '')}]` : ''
  const consensusTag = expertCount > 1 ? ` 🤝${expertCount}x(${consensusMulti}x)` : ''
  const slippageTag = `+${(slippage * 100).toFixed(0)}¢slip`
  const kellyTag = kellyFraction > 0 ? `kelly:${(kellyFraction * 100).toFixed(1)}%` : 'kelly:0→min'
  const trustTag = trust.status === 'reduced' ? ' ⚡reduced' : ''
  const scoreTag = signal.score >= 80 ? '🔥' : signal.score >= 60 ? '✅' : '⚠️'
  const stopTag = `stop:-${(dynamicStopLoss * 100).toFixed(0)}%`
  const logMsg = `${scoreTag} COPY (${signal.score}/100) | ${side} @ ${(rawPrice * 100).toFixed(0)}¢→${(entryPrice * 100).toFixed(0)}¢ | $${betAmount.toFixed(0)}${consensusTag}${trustTag} | ${kellyTag} | ${stopTag} | ${slippageTag} | ${trust.phase} | ${signal.reasons.slice(0, 2).join(', ')} | ${alert.position.title} ${domainTag}`
  console.log(`  📋 ${logMsg}`)
  logBotEvent('copy', `${side} @ ${(entryPrice * 100).toFixed(0)}¢ $${betAmount.toFixed(0)} | ${alert.position.title}`, `Score: ${signal.score}/100 | ${alert.walletLabel ?? alert.wallet.slice(0, 10)} | ${domainTag} | ${kellyTag}`)

  return true
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
        logBotEvent('exit', `${decision.reason} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${trade.title}`, decision.message)
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

  const totalInvested = open.reduce((s, t) => s + t.simulatedUsdc, 0)
  const cash = startBal + realizedPnl - totalInvested
  const nextBet = getDynamicBetSize()

  console.log(`\n  ┌─────────────────────────────────────┐`)
  console.log(`  │ Balance:  $${balance.toFixed(2).padStart(10)}  (start: $${startBal.toFixed(0)})`)
  console.log(`  │ Realized: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2).padStart(10)}`)
  console.log(`  │ Unreal:   ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2).padStart(10)}`)
  console.log(`  │ Cash:     $${cash.toFixed(0).padStart(10)}  (next bet: $${nextBet.toFixed(0)})`)
  console.log(`  │ Open:     ${open.length.toString().padStart(10)}  trades`)
  console.log(`  │ Win Rate: ${(winRate * 100).toFixed(0).padStart(9)}%  (${won.length}W / ${lost.length}L)`)
  console.log(`  └─────────────────────────────────────┘`)

  // Expert trust summary
  const trusts = getAllExpertTrust()
  const active = trusts.filter((t) => t.status === 'active')
  const reduced = trusts.filter((t) => t.status === 'reduced')
  const paused = trusts.filter((t) => t.status === 'paused')
  console.log(`  Experts: ${active.length} active | ${reduced.length} reduced | ${paused.length} paused`)
  if (paused.length > 0) {
    for (const p of paused.slice(0, 3)) {
      console.log(`    ⛔ ${(p.label ?? p.wallet.slice(0, 12)).padEnd(20)} | ${p.reason}`)
    }
  }
  console.log('')
}

// ── Main loop ────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const wallets = getActiveWatchedWallets()
  const time = new Date().toISOString().slice(11, 19)

  console.log(`[${time}] Polling ${wallets.length} wallets...`)

  // ── Phase 1: Collect all signals & build consensus ──
  consensusMap.clear()
  const allNewAlerts: PositionAlert[] = []

  for (const { wallet, label } of wallets) {
    try {
      const alerts = await pollWallet(wallet, label)
      for (const alert of alerts) {
        if (alert.type === 'NEW_POSITION') {
          trackConsensus(alert)
          allNewAlerts.push(alert)
        }
      }
    } catch {
      // Skip
    }
    await new Promise((r) => setTimeout(r, 800))
  }

  // Log new positions with consensus info
  for (const alert of allNewAlerts) {
    const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
    const consensus = consensusMap.get(alert.position.conditionId)
    const expertCount = consensus?.experts.length ?? 1
    const consensusTag = expertCount > 1 ? ` [${expertCount} experts]` : ''
    console.log(`  🔔 NEW | ${alert.walletLabel ?? alert.wallet.slice(0, 10)} | ${side} @ ${(alert.position.curPrice * 100).toFixed(0)}¢${consensusTag} | ${alert.position.title}`)
  }

  // Log consensus markets
  for (const [, entry] of consensusMap) {
    if (entry.experts.length >= 2) {
      const names = entry.experts.map((e) => e.label?.split(' ')[0] ?? e.wallet.slice(0, 8)).join(', ')
      console.log(`  🤝 CONSENSUS ${entry.experts.length}x | ${entry.side} @ ${(entry.price * 100).toFixed(0)}¢ | ${entry.title} | by: ${names}`)
    }
  }

  // ── Phase 2: Copy with consensus-based sizing ──
  let copied = 0

  // Deduplicate: only copy each conditionId once (the first alert)
  const copiedConditions = new Set<string>()

  for (const alert of allNewAlerts) {
    if (copiedConditions.has(alert.position.conditionId)) continue

      // Check for contradictory positions
    const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
    const openTrades = getOpenPaperTrades()
    if (isContradictory(alert.position.conditionId, side, openTrades)) {
      console.log(`  ⚠️  CONTRA | Already holding opposite side | ${alert.position.title}`)
      continue
    }

    if (canCopy(alert) && tryCopyWithSignal(alert)) {
      copiedConditions.add(alert.position.conditionId)
      copied++
    }
  }

  // ── Phase 3: Manage existing positions ──
  const pricesUpdated = await refreshOpenPrices()

  const exits = runExitStrategy()
  const totalExits = Object.values(exits).reduce((s, n) => s + n, 0)
  const exitSummary = Object.entries(exits).map(([k, v]) => `${v} ${k}`).join(', ')

  const resolved = await resolveCompletedTrades()

  // ── Summary ──
  const parts = [`${allNewAlerts.length} new`, `${copied} copied`]
  const consensusCount = [...consensusMap.values()].filter((e) => e.experts.length >= 2).length
  if (consensusCount > 0) parts.push(`${consensusCount} consensus`)
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
    setPortfolioSetting('bet_size_usdc', getDynamicBetSize().toString())
  }

  console.log('═══════════════════════════════════════════════')
  console.log('  AUTO PAPER TRADER')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Wallets:    ${wallets.length}`)
  console.log(`  Bet sizing: ${(BET_PCT * 100).toFixed(0)}% of cash ($${MIN_BET}-$${MAX_BET})`)
  console.log(`  Entry range: ${(MIN_ENTRY * 100).toFixed(0)}¢ - ${(MAX_ENTRY * 100).toFixed(0)}¢`)
  console.log(`  Max open:   ${MAX_OPEN}`)
  console.log(`  Take profit: +${(EXIT_CONFIG.takeProfitPct * 100).toFixed(0)}%`)
  console.log(`  Stop-loss:   -${(EXIT_CONFIG.stopLossPct * 100).toFixed(0)}%`)
  console.log(`  Trailing:    +${(EXIT_CONFIG.trailingActivatePct * 100).toFixed(0)}% → +${(EXIT_CONFIG.trailingStopPct * 100).toFixed(0)}%`)
  console.log(`  Stale exit:  ${EXIT_CONFIG.staleDays}d < ${(EXIT_CONFIG.staleThreshold * 100).toFixed(0)}¢ move`)
  console.log(`  Expert exit: ${EXIT_CONFIG.followExpertExit ? 'ON' : 'OFF'}`)
  console.log(`  Max capital: ${(MAX_CAPITAL_PCT * 100).toFixed(0)}%`)
  console.log(`  Consensus:   2x→1.5x, 3x→2x, 5x→3x sizing`)
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
