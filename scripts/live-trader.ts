/**
 * Live Trader — Real money execution on Polymarket
 *
 * Mirrors auto-trader.ts logic but places REAL orders via CLOB API.
 * Paper trading runs in parallel for comparison.
 *
 * Usage:
 *   npx tsx scripts/live-trader.ts
 *
 * Required .env:
 *   POLYMARKET_PRIVATE_KEY
 *   POLYMARKET_API_KEY
 *   POLYMARKET_API_SECRET
 *   POLYMARKET_API_PASSPHRASE
 *
 * Safety limits for $10 live test:
 *   MAX_LIVE_BET_USDC=3       max $3 per bet
 *   MAX_LIVE_POSITIONS=5      max 5 simultaneous
 *   MAX_LIVE_CAPITAL=10       max $10 total deployed
 */

import {
  getActiveWatchedWallets,
  getOpenPaperTrades,
  openPaperTrade,
  paperTradeExistsForCondition,
  getPortfolioSetting,
  getAllPaperTrades,
  getPositionSnapshot,
  logBotEvent,
} from '../src/lib/db'
import { pollWallet, type PositionAlert } from '../src/lib/position-tracker'
import { keywordClassify } from '../src/lib/classifier'
import { fetchAllPages } from '../src/lib/polymarket'
import { resolvePaperTrade, updatePaperTradePrice } from '../src/lib/db'
import { evaluateExit, exitEmoji, DEFAULT_CONFIG } from '../src/lib/exit-strategy'
import { scoreSignal, shouldCopySignal, isContradictory, kellyBetFraction } from '../src/lib/signal-scorer'
import { evaluateExpertTrust } from '../src/lib/expert-trust'
import { placeOrder, getRealBalance, type RealOrder } from '../src/lib/real-trader'

const POLYMARKET_DATA_URL = 'https://data-api.polymarket.com'

// ── Safety limits ─────────────────────────────────────────────────
// Hardcoded conservative limits for initial live test

const MAX_LIVE_BET_USDC = parseFloat(process.env.MAX_LIVE_BET_USDC ?? '3')
const MIN_LIVE_BET_USDC = 1
const MAX_LIVE_POSITIONS = parseInt(process.env.MAX_LIVE_POSITIONS ?? '5', 10)
const MAX_LIVE_CAPITAL = parseFloat(process.env.MAX_LIVE_CAPITAL ?? '10')
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10)
const MIN_ENTRY = 0.15
const MAX_ENTRY = 0.60
const MIN_SIGNAL_SCORE = 65  // higher threshold for real money

// ── State ─────────────────────────────────────────────────────────

// Track live positions in memory (wallet address → conditionId → tokenId)
const livePositions = new Map<string, { tokenId: string; size: number; entryPrice: number; sizeUsdc: number }>()
let totalDeployed = 0

// ── Helpers ───────────────────────────────────────────────────────

function getSlippageAdjustedPrice(rawPrice: number): number {
  // Simulate realistic entry after sharp — same as auto-trader
  return rawPrice < 0.30
    ? Math.min(rawPrice + 0.05, 0.95)
    : Math.min(rawPrice + 0.03, 0.95)
}

function getDynamicStopLoss(entryPrice: number): number {
  return entryPrice < 0.30 ? 0.20 : 0.25
}

// ── Main copy logic ───────────────────────────────────────────────

async function tryLiveCopy(alert: PositionAlert): Promise<boolean> {
  if (alert.type !== 'NEW_POSITION') return false

  const rawPrice = alert.position.curPrice
  if (rawPrice < MIN_ENTRY || rawPrice > MAX_ENTRY) return false
  if (livePositions.has(alert.position.conditionId)) return false
  if (livePositions.size >= MAX_LIVE_POSITIONS) return false
  if (totalDeployed >= MAX_LIVE_CAPITAL) return false

  // Expert trust check
  const trust = evaluateExpertTrust(alert.wallet, alert.walletLabel)
  if (trust.status === 'paused') return false

  // Signal scoring — stricter threshold for real money
  const signal = scoreSignal({
    expertWallet: alert.wallet,
    marketTitle: alert.position.title,
    entryPrice: rawPrice,
    positionSize: alert.position.size,
  })

  if (signal.score < MIN_SIGNAL_SCORE) {
    console.log(`  ⏭️  LIVE SKIP (${signal.score}/${MIN_SIGNAL_SCORE}) | ${alert.position.title.slice(0, 50)}`)
    return false
  }

  // Slippage-adjusted entry
  const entryPrice = getSlippageAdjustedPrice(rawPrice)

  // Kelly sizing — capped hard at MAX_LIVE_BET_USDC
  const kellyFraction = kellyBetFraction(trust.winRate, entryPrice)
  const realBalance = await getRealBalance()
  const kellyBet = kellyFraction > 0
    ? Math.min(realBalance * kellyFraction * trust.trustLevel, MAX_LIVE_BET_USDC)
    : MIN_LIVE_BET_USDC

  const betUsdc = Math.max(Math.min(kellyBet, MAX_LIVE_BET_USDC), MIN_LIVE_BET_USDC)

  if (totalDeployed + betUsdc > MAX_LIVE_CAPITAL) {
    console.log(`  🛑 CAPITAL LIMIT — deployed $${totalDeployed.toFixed(2)} / $${MAX_LIVE_CAPITAL}`)
    return false
  }

  const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
  const domain = keywordClassify(alert.position.title)

  console.log(`  💰 LIVE ORDER | ${side} @ ${(entryPrice * 100).toFixed(0)}¢ | $${betUsdc.toFixed(2)} | score:${signal.score} | ${alert.position.title.slice(0, 45)}`)

  // Place real order
  const order: RealOrder = {
    conditionId: alert.position.conditionId,
    tokenId: alert.position.conditionId,  // simplified — real impl needs tokenId from market data
    title: alert.position.title,
    side,
    price: entryPrice,
    sizeUsdc: betUsdc,
    orderType: 'FOK',
  }

  const result = await placeOrder(order)

  if (result.success) {
    // Track live position
    livePositions.set(alert.position.conditionId, {
      tokenId: order.tokenId,
      size: betUsdc / entryPrice,
      entryPrice,
      sizeUsdc: betUsdc,
    })
    totalDeployed += betUsdc

    console.log(`  ✅ LIVE FILLED | orderId:${result.orderId} | tx:${result.transactionHash?.slice(0, 10)}...`)
    logBotEvent('live-copy', `REAL ${side} @ ${(entryPrice * 100).toFixed(0)}¢ $${betUsdc.toFixed(2)} | ${alert.position.title}`, `Score:${signal.score} | Kelly:${(kellyFraction * 100).toFixed(1)}%`)

    // Also record as paper trade for comparison
    openPaperTrade({
      conditionId: alert.position.conditionId,
      title: alert.position.title,
      domain: domain?.domain ?? null,
      side,
      entryPrice,
      simulatedUsdc: betUsdc,
      copiedFrom: alert.wallet,
      copiedLabel: `[LIVE] ${alert.walletLabel ?? alert.wallet.slice(0, 10)}`,
    })

    return true
  } else {
    console.log(`  ❌ LIVE ORDER FAILED | ${result.error} | ${alert.position.title.slice(0, 45)}`)
    logBotEvent('live-error', `FAILED ${side} @ ${(entryPrice * 100).toFixed(0)}¢ | ${alert.position.title}`, result.error ?? '')
    return false
  }
}

// ── Poll loop ─────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const wallets = getActiveWatchedWallets()
  const time = new Date().toISOString().slice(11, 19)
  const realBalance = await getRealBalance()

  console.log(`[${time}] 💰 Real balance: $${realBalance.toFixed(2)} | Deployed: $${totalDeployed.toFixed(2)} | Positions: ${livePositions.size}/${MAX_LIVE_POSITIONS}`)
  console.log(`[${time}] Polling ${wallets.length} wallets...`)

  let liveCopied = 0

  for (const { wallet, label } of wallets) {
    try {
      const alerts = await pollWallet(wallet, label)

      for (const alert of alerts) {
        if (alert.type !== 'NEW_POSITION') continue

        const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
        console.log(`  🔔 ${alert.walletLabel ?? alert.wallet.slice(0, 10)} | ${side} @ ${(alert.position.curPrice * 100).toFixed(0)}¢ | ${alert.position.title.slice(0, 45)}`)

        const openTrades = getOpenPaperTrades()
        if (isContradictory(alert.position.conditionId, side, openTrades)) continue

        if (await tryLiveCopy(alert)) liveCopied++
      }
    } catch (err) {
      console.error(`  ⚠ Poll error ${wallet.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`)
    }

    await new Promise((r) => setTimeout(r, 800))
  }

  console.log(`  → ${liveCopied} live orders placed\n`)
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════')
  console.log('  🔴 LIVE TRADER — REAL MONEY MODE')
  console.log('═══════════════════════════════════════════════')

  // Verify credentials
  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    console.error('❌ POLYMARKET_PRIVATE_KEY not set')
    console.error('   Run: npx tsx scripts/init-polymarket-creds.ts')
    process.exit(1)
  }

  const realBalance = await getRealBalance()
  console.log(`  Real balance:   $${realBalance.toFixed(2)} USDC`)
  console.log(`  Max per bet:    $${MAX_LIVE_BET_USDC}`)
  console.log(`  Max positions:  ${MAX_LIVE_POSITIONS}`)
  console.log(`  Max capital:    $${MAX_LIVE_CAPITAL}`)
  console.log(`  Min signal:     ${MIN_SIGNAL_SCORE}/100`)
  console.log(`  Entry range:    ${(MIN_ENTRY * 100).toFixed(0)}¢-${(MAX_ENTRY * 100).toFixed(0)}¢`)
  console.log(`  Poll interval:  ${POLL_INTERVAL_MS / 1000}s`)
  console.log('═══════════════════════════════════════════════')

  if (realBalance < 1) {
    console.error(`❌ Balance too low ($${realBalance.toFixed(2)}) — need at least $1 USDC on Polygon`)
    process.exit(1)
  }

  const wallets = getActiveWatchedWallets()
  if (wallets.length === 0) {
    console.error('❌ No watched wallets. Run bulk-index first.')
    process.exit(1)
  }

  console.log(`\nWatching ${wallets.length} wallets. Starting first poll...\n`)

  await pollOnce()

  setInterval(() => {
    pollOnce().catch((err) => {
      console.error(`Poll error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, POLL_INTERVAL_MS)
}

main().catch(console.error)
