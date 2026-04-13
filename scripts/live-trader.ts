/**
 * Live Trader — Signal Consumer + Order Executor + Exit Manager
 *
 * Reads pre-scored signals from the signals table (produced by expert-scanner),
 * places GTC orders on the real Polymarket CLOB, and manages exits.
 *
 * Does NOT scan wallets or score signals — that is done by expert-scanner.ts.
 * This process is purely a consumer: read signal → size bet → place order → manage exits.
 *
 * Paper trades are recorded in parallel (labeled [LIVE]) for comparison.
 *
 * Usage:
 *   npx tsx scripts/live-trader.ts
 *
 * Required .env:
 *   POLYMARKET_PRIVATE_KEY
 *   POLYMARKET_API_KEY
 *   POLYMARKET_API_SECRET
 *   POLYMARKET_API_PASSPHRASE
 *   STARTING_BALANCE=100          # your live bankroll in USDC
 *
 * Optional .env:
 *   DRY_RUN=true                  # log everything but skip real orders
 *   MAX_LIVE_CAPITAL=70           # max % of bankroll deployed (default: 70%)
 *   MIN_SIGNAL_SCORE_LIVE=65      # signal threshold (default: 50)
 *   POLL_INTERVAL_MS=30000        # poll interval (default: 30s)
 */

import {
  getOpenPaperTrades,
  openPaperTrade,
  paperTradeExistsForCondition,
  getPortfolioSetting,
  setPortfolioSetting,
  getAllPaperTrades,
  getPositionSnapshot,
  resolvePaperTrade,
  updatePaperTradePrice,
  partialExitPaperTrade,
  logBotEvent,
  savePendingOrder,
  getPendingOrders,
  removePendingOrder,
  getPendingSignals,
  markSignalTaken,
  markSignalRejected,
  expireOldSignals,
  type Position,
  type SignalRow,
} from '../src/lib/db'
import { keywordClassify } from '../src/lib/classifier'
import { fetchAllPages, fetchMarketMetadata } from '../src/lib/polymarket'
import { evaluateExit, exitEmoji, type ExitConfig } from '../src/lib/exit-strategy'
import { isContradictory, kellyBetFraction } from '../src/lib/signal-scorer'
import { getAllExpertTrust, getBankrollScale } from '../src/lib/expert-trust'
import { placeOrder, getRealBalance, getRealPositions, closePosition, checkOrderStatus, cancelOrder, redeemAllResolved, type RealOrder, type RealPosition } from '../src/lib/real-trader'
import { connectOrderbookWS, subscribeToken, unsubscribeToken, getWsBestBid, isWsConnected, getSubscribedCount, connectUserWS, subscribeUserMarket, isUserWsConnected } from '../src/lib/orderbook-ws'

const POLYMARKET_DATA_URL = process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com'

// ── Config ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '15000', 10)  // 15s — faster detection for FOK fills
const BET_PCT = parseFloat(process.env.BET_PCT ?? '0.02')
const MIN_ENTRY = parseFloat(process.env.MIN_ENTRY_PRICE ?? '0.05')
const MAX_ENTRY = parseFloat(process.env.MAX_ENTRY_PRICE ?? '0.50')  // signal-scorer blocks >50¢ with score=0
const MAX_OPEN = parseInt(process.env.MAX_OPEN_TRADES ?? '100', 10)  // fixed cap
const MIN_SIGNAL_SCORE = parseInt(process.env.MIN_SIGNAL_SCORE_LIVE ?? '50', 10)
const ODDS_API_KEY = process.env.ODDS_API_KEY ?? ''

// Polymarket CLOB constraints (cannot change)
const POLY_MIN_ORDER_SHARES = 15   // minimum shares to place a buy order
const POLY_MIN_SELL_SHARES = 5     // minimum shares to sell (exit)
const DRY_RUN = process.env.DRY_RUN === 'true'
const DAILY_LOSS_LIMIT_PCT = 0.50  // 50% of bankroll — catastrophe safety net
const DRAWDOWN_LIMIT_PCT = parseFloat(process.env.DRAWDOWN_LIMIT ?? '0.20')  // 20% from peak — close all, protect gains

// ── On-chain equity (single source of truth) ────────────────────
// The wallet balance is the ONLY source of truth for equity.
// No more calculated equity from DB — what's on-chain is real.

let _cachedOnChainBalance = 0    // USDC.e balance, updated every poll
let _cachedPositions: RealPosition[] = []  // on-chain positions, updated every poll

function setOnChainState(balance: number, positions: RealPosition[]): void {
  _cachedOnChainBalance = balance
  _cachedPositions = positions
}

function getCurrentEquity(): number {
  // On-chain USDC + on-chain position values (NOT from DB)
  const posValue = _cachedPositions.reduce((s, p) => s + p.size * p.curPrice, 0)
  return _cachedOnChainBalance + posValue
}

function getAvailableCash(): number {
  return _cachedOnChainBalance  // what's actually available to spend
}

function getMaxOpen(): number {
  return MAX_OPEN
}

function getMaxBet(equity: number): number {
  const scale = getBankrollScale()
  return Math.min(Math.max(equity * 0.003, Math.max(100 * scale, 1)), Math.max(500 * scale, 1))
}

function getMinBet(equity: number): number {
  const scale = getBankrollScale()
  return Math.max(equity * 0.002, Math.max(20 * scale, 1))
}

function getMaxCapitalPct(): number {
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '9'))
  const equity = getCurrentEquity()
  return equity > startBal * 3 ? 0.70 : 0.60
}

function getDynamicBetSize(): number {
  const equity = getCurrentEquity()
  const cash = getAvailableCash()
  const bet = cash * BET_PCT
  return Math.min(Math.max(bet, getMinBet(equity)), getMaxBet(equity))
}

// ── Live paper trades filter ─────────────────────────────────────
// Live trades are stored as paper_trades with sourceLabel starting with "[LIVE]"
// This keeps them separate from pure paper trades.

function getLivePaperTrades(): Position[] {
  return getAllPaperTrades().filter((t) => t.sourceLabel?.startsWith('[LIVE]'))
}

function getOpenLiveTrades(): Position[] {
  return getOpenPaperTrades().filter((t) => t.sourceLabel?.startsWith('[LIVE]'))
}

// ── Exit strategy config (same as auto-trader) ───────────────────

const EXIT_CONFIG: ExitConfig = {
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT ?? '999'),
  stopLossPct: parseFloat(process.env.STOP_LOSS ?? '0.40'),
  trailingActivatePct: parseFloat(process.env.TRAILING_ACTIVATE ?? '999'),
  trailingStopPct: parseFloat(process.env.TRAILING_STOP ?? '0.10'),
  nearResolutionThreshold: parseFloat(process.env.NEAR_RESOLUTION ?? '0.85'),
  staleDays: parseInt(process.env.STALE_DAYS ?? '7', 10),
  staleThreshold: parseFloat(process.env.STALE_THRESHOLD ?? '0.03'),
  followExpertExit: process.env.FOLLOW_EXPERT_EXIT !== 'false',
  partialExitAt100Pct: parseFloat(process.env.PARTIAL_EXIT_100 ?? '0.50'),
  partialExitAt150Pct: parseFloat(process.env.PARTIAL_EXIT_150 ?? '0.30'),
}

// ── (consensus tracking removed — handled by expert-scanner) ────

// ── Daily loss tracking ──────────────────────────────────────────

let dailyPnlStart = 0
let dailyPnlDate = ''

function checkDailyLossLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10)
  const currentEquity = getCurrentEquity()

  if (dailyPnlDate !== today) {
    dailyPnlDate = today
    dailyPnlStart = currentEquity  // snapshot at start of day
  }

  const dailyLoss = dailyPnlStart - currentEquity
  const limitAmount = currentEquity * DAILY_LOSS_LIMIT_PCT

  if (dailyLoss >= limitAmount) {
    console.log(`  🚨 DAILY LOSS LIMIT HIT | -$${dailyLoss.toFixed(2)} today (limit: -$${limitAmount.toFixed(2)}) | Bot paused until tomorrow`)
    logBotEvent('safety', `DAILY LOSS LIMIT -$${dailyLoss.toFixed(2)}`, `Limit: -$${limitAmount.toFixed(2)}`)
    return true
  }
  return false
}

// ── Drawdown circuit breaker ─────────────────────────────────────
// Uses on-chain equity (USDC + positions) as single source of truth.
// If equity drops 20% from peak → stop trading.

let highWaterMark = 0

function checkDrawdownBreaker(): boolean {
  const totalEquity = getCurrentEquity()  // on-chain USDC + position value

  // Update HWM
  if (totalEquity > highWaterMark) {
    highWaterMark = totalEquity
  }

  // Only check if we've had meaningful gains (at least +10% from on-chain start)
  if (highWaterMark < _cachedOnChainBalance * 1.10) return false

  const drawdown = (highWaterMark - totalEquity) / highWaterMark
  if (drawdown >= DRAWDOWN_LIMIT_PCT) {
    console.log(`  🚨 DRAWDOWN BREAKER | Equity $${totalEquity.toFixed(2)} is -${(drawdown * 100).toFixed(1)}% from peak $${highWaterMark.toFixed(2)} | Closing all positions`)
    logBotEvent('safety', `DRAWDOWN BREAKER -${(drawdown * 100).toFixed(1)}%`, `Peak: $${highWaterMark.toFixed(2)}, Now: $${totalEquity.toFixed(2)}`)
    return true
  }
  return false
}

// ── Live token ID cache ──────────────────────────────────────────
// Maps conditionId+side → tokenId for exit orders

const tokenIdCache = new Map<string, { tokenId: string; negRisk: boolean }>()

// ── GTC order tracking (persisted in DB) ────────────────────────
// Track pending GTC orders in SQLite so they survive restarts.
// Paper trade is ONLY created when order is confirmed FILLED.

const GTC_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes — give market maker time to recharge

async function checkPendingOrders(): Promise<void> {
  const pending = getPendingOrders()
  if (pending.length === 0) return

  const now = Date.now()
  const SELL_TIMEOUT_MS = 10 * 60_000  // 10 min for sells (longer than buys)

  for (const po of pending) {
    const status = await checkOrderStatus(po.orderId)
    const placedMs = new Date(po.placedAt).getTime()
    const timeoutMs = po.orderType === 'SELL' ? SELL_TIMEOUT_MS : GTC_TIMEOUT_MS

    if (status.status === 'filled') {
      if (po.orderType === 'BUY') {
        // BUY FILLED — create the paper trade
        const filledPrice = status.filledPrice ?? po.entryPrice
        openPaperTrade({
          conditionId: po.conditionId,
          title: po.title,
          domain: po.domain,
          side: po.side,
          entryPrice: filledPrice,
          sizeUsdc: po.sizeUsdc,
          sourceRef: po.sourceRef,
          sourceLabel: po.sourceLabel,
        })
        removePendingOrder(po.orderId)
        console.log(`  ✅ BUY FILLED | ${po.side} @ ${(filledPrice * 100).toFixed(0)}¢ | $${po.sizeUsdc.toFixed(2)} | ${po.title.slice(0, 40)}`)
        logBotEvent('live-filled', `BUY FILLED ${po.side} @ ${(filledPrice * 100).toFixed(0)}¢ $${po.sizeUsdc.toFixed(2)} | ${po.title}`, `orderId:${po.orderId.slice(0, 12)}`)
      } else {
        // SELL FILLED — NOW we resolve/partial the paper trade
        const filledPrice = status.filledPrice ?? po.exitPrice ?? po.entryPrice
        if (po.partialFraction) {
          partialExitPaperTrade(po.conditionId, po.partialFraction, filledPrice)
          console.log(`  ✅ SELL FILLED (partial) | ${po.exitReason} | ${(po.partialFraction * 100).toFixed(0)}% @ ${(filledPrice * 100).toFixed(0)}¢ | ${po.title.slice(0, 40)}`)
        } else {
          resolvePaperTrade(po.conditionId, filledPrice)
          // Unsubscribe from WS
          const meta = await getTokenId(po.conditionId, po.side)
          if (meta) unsubscribeToken(meta.tokenId)
          const pnl = (po.sizeUsdc / po.entryPrice) * (filledPrice - po.entryPrice)
          console.log(`  ✅ SELL FILLED | ${po.exitReason} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} @ ${(filledPrice * 100).toFixed(0)}¢ | ${po.title.slice(0, 40)}`)
        }
        removePendingOrder(po.orderId)
        logBotEvent('live-sell-filled', `SELL FILLED ${po.exitReason} @ ${(filledPrice * 100).toFixed(0)}¢ | ${po.title}`, `orderId:${po.orderId.slice(0, 12)}`)
      }
    } else if (status.status === 'cancelled' || (now - placedMs > timeoutMs && status.status === 'open')) {
      if (status.status === 'open') {
        const cancelled = await cancelOrder(po.orderId)
        if (po.orderType === 'SELL') {
          // Sell timeout — cancel order, will retry next exit cycle at fresh price
          console.log(`  ⏰ SELL TIMEOUT | ${po.exitReason} | orderId:${po.orderId.slice(0, 12)} | cancelled: ${cancelled} — will retry | ${po.title.slice(0, 40)}`)
        } else {
          console.log(`  ⏰ BUY TIMEOUT | ${po.side} | orderId:${po.orderId.slice(0, 12)} | cancelled: ${cancelled}`)
        }
      } else {
        console.log(`  ❌ ${po.orderType} CANCELLED | ${po.side} | orderId:${po.orderId.slice(0, 12)}`)
      }
      removePendingOrder(po.orderId)
      logBotEvent('live-cancel', `${po.orderType} not filled — ${po.orderType === 'SELL' ? 'will retry' : 'discarded'} | ${po.title.slice(0, 40)}`, `orderId:${po.orderId.slice(0, 12)}`)
    }
    // else: still open, within timeout — keep waiting
  }
}

function cacheTokenId(conditionId: string, side: string, tokenId: string, negRisk: boolean): void {
  tokenIdCache.set(`${conditionId}-${side}`, { tokenId, negRisk })
}

async function getTokenId(conditionId: string, side: string): Promise<{ tokenId: string; negRisk: boolean } | null> {
  const cached = tokenIdCache.get(`${conditionId}-${side}`)
  if (cached) return cached

  const metadata = await fetchMarketMetadata(conditionId)
  if (!metadata) return null

  const tokenId = side === 'YES' ? metadata.yesTokenId : metadata.noTokenId
  cacheTokenId(conditionId, side, tokenId, metadata.negRisk)
  return { tokenId, negRisk: metadata.negRisk }
}

// ── Signal consumer (reads from signals table, places orders) ────

async function processSignals(): Promise<number> {
  const signals = getPendingSignals(MIN_SIGNAL_SCORE)
  if (signals.length === 0) return 0

  let placed = 0

  for (const signal of signals) {
    // Skip if already have a position for this market
    if (paperTradeExistsForCondition(signal.conditionId)) {
      markSignalRejected(signal.id, 'position-exists')
      continue
    }

    // Skip if contradictory (holding opposite side)
    const openTrades = getOpenLiveTrades()
    if (isContradictory(signal.conditionId, signal.side, openTrades)) {
      markSignalRejected(signal.id, 'contradictory')
      continue
    }

    // Skip if too many open trades
    if (openTrades.length >= MAX_OPEN) {
      markSignalRejected(signal.id, 'max-open')
      break
    }

    // Skip if already pending order for this condition
    const pendingOrders = getPendingOrders()
    if (pendingOrders.some(po => po.conditionId === signal.conditionId)) {
      markSignalRejected(signal.id, 'pending-order')
      continue
    }

    // Kelly-based sizing using on-chain equity
    const currentBankroll = getCurrentEquity()
    const availCash = getAvailableCash()
    const kellyFraction = signal.kellyFraction ?? 0
    const minBet = getMinBet(currentBankroll)
    const maxBet = getMaxBet(currentBankroll)

    const baseBet = kellyFraction > 0
      ? Math.min(Math.max(currentBankroll * kellyFraction, minBet), maxBet)
      : minBet

    // Consensus multiplier (from signal metadata)
    const consensusCount = signal.consensusCount ?? 1
    const consensusMulti = consensusCount >= 5 ? 0.3
      : consensusCount >= 3 ? 0.5
      : consensusCount >= 2 ? 0.7
      : 1

    const signalMulti = signal.signalScore >= 80 ? 1.5 : 1.0
    const trustMulti = signal.expertTrustLevel ?? 1.0
    let betAmount = Math.min(baseBet * signalMulti * consensusMulti * trustMulti, maxBet)

    // Polymarket minimum shares
    const minBetForShares = POLY_MIN_ORDER_SHARES * signal.entryPrice
    if (betAmount < minBetForShares) betAmount = minBetForShares
    if (betAmount > availCash * 0.95) {
      markSignalRejected(signal.id, 'insufficient-cash')
      continue
    }

    // Capital limit check
    const totalInvested = openTrades.reduce((s, t) => s + t.sizeUsdc, 0)
    if (totalInvested + betAmount > currentBankroll * getMaxCapitalPct()) {
      markSignalRejected(signal.id, 'capital-limit')
      continue
    }

    const tokenId = signal.side === 'YES' ? signal.yesTokenId : signal.noTokenId
    if (!tokenId) {
      markSignalRejected(signal.id, 'no-token-id')
      continue
    }

    // Determine source label based on signal source
    const sourceLabel = signal.source === 'expert-copy'
      ? `[LIVE] ${signal.expertLabel ?? signal.expertWallet?.slice(0, 10) ?? 'unknown'}`
      : `[SPORTS] ${signal.sportKey ?? 'unknown'}`

    if (DRY_RUN) {
      const scoreTag = signal.signalScore >= 80 ? '🔥' : signal.signalScore >= 60 ? '✅' : '⚠️'
      console.log(`  🏜️  DRY-RUN | ${scoreTag} ${signal.side} @ ${(signal.entryPrice * 100).toFixed(0)}¢ | $${betAmount.toFixed(2)} | score:${signal.signalScore} | ${signal.title.slice(0, 45)}`)
      markSignalTaken(signal.id)
      logBotEvent('live-dry-run', `${signal.side} @ ${(signal.entryPrice * 100).toFixed(0)}¢ $${betAmount.toFixed(2)} | ${signal.title}`, `Score: ${signal.signalScore}/100 | source: ${signal.source}`)
      placed++
      continue
    }

    // Place GTC order
    subscribeToken(tokenId)
    const PRICE_BUFFER = 0.05
    const MAX_ENTRY_PRICE = parseFloat(process.env.MAX_ENTRY_PRICE ?? '0.50')
    const orderPrice = parseFloat(Math.min(signal.entryPrice + PRICE_BUFFER, MAX_ENTRY_PRICE).toFixed(2))
    const liveBetAmount = parseFloat(Math.min(betAmount, availCash * 0.30).toFixed(2))

    if (liveBetAmount < POLY_MIN_ORDER_SHARES * orderPrice) {
      markSignalRejected(signal.id, 'below-min-shares')
      continue
    }

    const order: RealOrder = {
      conditionId: signal.conditionId,
      tokenId,
      title: signal.title,
      side: signal.side as 'YES' | 'NO',
      price: orderPrice,
      sizeUsdc: liveBetAmount,
      orderType: 'GTC',
      negRisk: signal.negRisk,
    }

    const result = await placeOrder(order)

    if (!result.success) {
      console.log(`  ❌ ORDER FAILED | ${result.error} | ${signal.title.slice(0, 45)}`)
      markSignalRejected(signal.id, `order-failed: ${result.error ?? 'unknown'}`)
      logBotEvent('live-error', `FAILED ${signal.side} @ ${(orderPrice * 100).toFixed(0)}¢ | ${signal.title}`, result.error ?? '')
      continue
    }

    if (result.orderId) {
      const scoreTag = signal.signalScore >= 80 ? '🔥' : signal.signalScore >= 60 ? '✅' : '⚠️'
      const status = result.filledPrice ? 'FILLED' : 'PLACED'
      console.log(`  📋 LIVE ${scoreTag} GTC ${status} | ${signal.side} @ ${(orderPrice * 100).toFixed(0)}¢ | $${liveBetAmount.toFixed(2)} | score:${signal.signalScore} | src:${signal.source} | ${signal.title.slice(0, 40)}`)
      logBotEvent('live-gtc', `GTC ${signal.side} @ ${(orderPrice * 100).toFixed(0)}¢ $${liveBetAmount.toFixed(2)} | ${signal.title}`, `Score: ${signal.signalScore}/100 | source: ${signal.source}`)

      try {
        savePendingOrder({
          orderId: result.orderId,
          conditionId: signal.conditionId,
          title: signal.title,
          domain: signal.domain,
          side: signal.side,
          entryPrice: orderPrice,
          sizeUsdc: liveBetAmount,
          sourceRef: signal.source === 'expert-copy' ? (signal.expertWallet ?? 'expert') : 'sports-arb',
          sourceLabel,
          placedAt: new Date().toISOString(),
          orderType: 'BUY',
          exitPrice: null,
          partialFraction: null,
          exitReason: null,
        })
      } catch (dbErr) {
        console.error(`  🚨 CRITICAL: BUY order ${result.orderId} placed on CLOB but DB save failed! Manual reconciliation needed.`)
        console.error(dbErr)
        logBotEvent('critical-orphan', `BUY order ${result.orderId} orphaned`, String(dbErr))
      }

      cacheTokenId(signal.conditionId, signal.side, tokenId, signal.negRisk)
      subscribeUserMarket(signal.conditionId)
      markSignalTaken(signal.id)
      placed++
    }
  }

  // Expire old signals
  expireOldSignals(60)

  return placed
}

// ── Price refresh (WS best bid + expert positions fallback) ──────

async function refreshOpenPrices(): Promise<number> {
  const openTrades = getOpenLiveTrades()
  if (openTrades.length === 0) return 0

  let updated = 0

  // 1. WS best bid — real-time, works for ALL trades (including on-chain-sync)
  for (const trade of openTrades) {
    const meta = await getTokenId(trade.conditionId, trade.side)
    if (!meta) continue
    const wsBid = getWsBestBid(meta.tokenId)
    if (wsBid && wsBid > 0) {
      updatePaperTradePrice(trade.conditionId, wsBid)
      updated++
    }
  }

  // 2. Expert positions fallback — for trades where WS has no data
  const tradesWithoutPrice = openTrades.filter((t) => {
    // Skip if WS already updated this trade
    return !updated || t.sourceRef === 'on-chain-sync'
  })
  const wallets = [...new Set(
    tradesWithoutPrice
      .filter((t) => t.sourceRef !== 'on-chain-sync')
      .map((t) => t.sourceRef)
  )]

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

// ── Resolve completed markets ────────────────────────────────────

type PositionRecord = {
  conditionId: string
  curPrice: number
  redeemable: boolean
}

async function resolveCompletedTrades(redeemedConditionIds: Set<string>): Promise<number> {
  const openTrades = getOpenLiveTrades()
  if (openTrades.length === 0) return 0

  // Collect our own on-chain positions to check for zero-size
  let ownPositions: RealPosition[] = []
  try {
    ownPositions = await getRealPositions()
  } catch {
    // If we can't fetch, only resolve already-redeemed
  }
  const ownSizeByCondition = new Map<string, number>()
  for (const p of ownPositions) {
    ownSizeByCondition.set(p.conditionId, (ownSizeByCondition.get(p.conditionId) ?? 0) + p.size)
  }

  let resolved = 0

  for (const trade of openTrades) {
    const condId = trade.conditionId
    // Only resolve if already redeemed on-chain OR position is gone (size=0)
    const wasRedeemed = redeemedConditionIds.has(condId)
    const sizeOnChain = ownSizeByCondition.get(condId) ?? 0
    const positionGone = !wasRedeemed && sizeOnChain === 0

    if (!wasRedeemed && !positionGone) continue

    // Determine exit price: redeemed means market resolved, position gone means sold/exited
    const exitPrice = wasRedeemed
      ? (trade.curPrice != null && trade.curPrice > 0.5 ? 1 : 0)
      : (trade.curPrice ?? trade.entryPrice)

    resolvePaperTrade(condId, exitPrice)
    const result = exitPrice > 0.5
      ? (trade.side === 'YES' ? 'WON' : 'LOST')
      : (trade.side === 'NO' ? 'WON' : 'LOST')
    const pnl = trade.shares * (exitPrice > 0.5
      ? (trade.side === 'YES' ? 1 - trade.entryPrice : -trade.entryPrice)
      : (trade.side === 'NO' ? 1 - trade.entryPrice : -trade.entryPrice))
    const reason = wasRedeemed ? 'redeemed' : 'position-gone'
    console.log(`  ✅ RESOLVED (${reason}) | ${result} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | ${trade.title}`)
    logBotEvent('live-resolved', `${result} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | ${trade.title}`, reason)
    resolved++
  }

  return resolved
}

// ── Exit strategy (mirrors auto-trader + real closePosition) ─────

async function runExitStrategy(): Promise<Record<string, number>> {
  const openTrades = getOpenLiveTrades()
  const counts: Record<string, number> = {}

  // Check if experts still hold their positions
  const expertPositions = new Map<string, Set<string>>()
  if (EXIT_CONFIG.followExpertExit) {
    const wallets = [...new Set(openTrades.map((t) => t.sourceRef))]
    for (const w of wallets) {
      const snapshot = getPositionSnapshot(w)
      expertPositions.set(w, new Set(snapshot.keys()))
    }
  }

  // Skip trades that already have a pending SELL order
  const pendingOrders = getPendingOrders()
  const pendingSellConditions = new Set(
    pendingOrders.filter((po) => po.orderType === 'SELL').map((po) => po.conditionId)
  )

  for (const trade of openTrades) {
    // Skip resolved positions — these are handled by redeemAllResolved(), not exit strategy
    if (trade.curPrice != null && (trade.curPrice >= 0.95 || trade.curPrice <= 0.05)) continue

    // Don't place another sell if one is already pending
    if (pendingSellConditions.has(trade.conditionId)) continue

    let expertStillHolding: boolean | null = null
    if (EXIT_CONFIG.followExpertExit && trade.sourceRef !== 'on-chain-sync') {
      const expertKeys = expertPositions.get(trade.sourceRef)
      if (expertKeys) {
        const key0 = `${trade.conditionId}-0`
        const key1 = `${trade.conditionId}-1`
        expertStillHolding = expertKeys.has(key0) || expertKeys.has(key1)
      }
    }

    const decision = evaluateExit(trade, EXIT_CONFIG, expertStillHolding)
    if (!decision.shouldExit) continue

    const exitPrice = trade.curPrice ?? trade.entryPrice

    // Get token ID + negRisk for the close order
    const exitMeta = await getTokenId(trade.conditionId, trade.side)

    try {
      if ((decision.reason === 'partial-exit-100' || decision.reason === 'partial-exit-150') && decision.partialFraction) {
        // Partial exit — sell a fraction
        const sharesRemaining = trade.sharesRemaining ?? trade.shares
        const sharesToSell = sharesRemaining * decision.partialFraction

        // Polymarket minimum sell: 5 shares
        if (sharesToSell < POLY_MIN_SELL_SHARES) {
          console.log(`  ⏭️  PARTIAL SKIP | ${sharesToSell.toFixed(1)} shares < ${POLY_MIN_SELL_SHARES} min | ${trade.title.slice(0, 40)}`)
          continue
        }

        if (DRY_RUN) {
          partialExitPaperTrade(trade.conditionId, decision.partialFraction, exitPrice)
          const pnl = sharesToSell * (exitPrice - trade.entryPrice)
          console.log(`  🏜️ DRY-RUN ${exitEmoji(decision.reason)} ${decision.reason.toUpperCase()} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${(decision.partialFraction * 100).toFixed(0)}% sold @ ${(exitPrice * 100).toFixed(0)}¢ | ${trade.title}`)
        } else if (exitMeta) {
          const result = await closePosition(exitMeta.tokenId, sharesToSell, exitPrice, exitMeta.negRisk)
          if (!result.success) {
            console.log(`  ⚠️  PARTIAL EXIT FAILED | ${result.error} | ${trade.title.slice(0, 40)}`)
            continue
          }
          // Save as pending SELL — only resolve when fill confirmed
          if (result.orderId) {
            try {
              savePendingOrder({
                orderId: result.orderId,
                conditionId: trade.conditionId,
                title: trade.title,
                domain: trade.domain ?? null,
                side: trade.side,
                entryPrice: trade.entryPrice,
                sizeUsdc: trade.sizeUsdc,
                sourceRef: trade.sourceRef,
                sourceLabel: trade.sourceLabel,
                placedAt: new Date().toISOString(),
                orderType: 'SELL',
                exitPrice,
                partialFraction: decision.partialFraction,
                exitReason: decision.reason,
              })
            } catch (dbErr) {
              console.error(`  🚨 CRITICAL: SELL order ${result.orderId} placed on CLOB but DB save failed!`)
              console.error(dbErr)
              logBotEvent('critical-orphan', `SELL order ${result.orderId} orphaned`, String(dbErr))
            }
            console.log(`  📋 SELL PLACED | ${decision.reason} | ${sharesToSell.toFixed(1)} shares @ ${(exitPrice * 100).toFixed(0)}¢ | orderId:${result.orderId.slice(0, 12)} | ${trade.title.slice(0, 40)}`)
            logBotEvent('live-sell-pending', `${decision.reason} | ${sharesToSell.toFixed(1)} shares @ ${(exitPrice * 100).toFixed(0)}¢ | ${trade.title}`, `orderId:${result.orderId.slice(0, 12)}`)
          }
        }
      } else {
        // Full exit
        const sharesToSell = trade.sharesRemaining ?? trade.shares

        // Polymarket minimum sell: 5 shares
        if (!DRY_RUN && sharesToSell < POLY_MIN_SELL_SHARES) {
          console.log(`  ⚠️  EXIT TOO SMALL | ${sharesToSell.toFixed(1)} shares < ${POLY_MIN_SELL_SHARES} min — position stuck | ${trade.title.slice(0, 40)}`)
          resolvePaperTrade(trade.conditionId, exitPrice)
          logBotEvent('live-exit', `EXIT TOO SMALL (${sharesToSell.toFixed(1)} shares) — tokens stuck on-chain | ${trade.title}`, decision.message)
          counts[decision.reason] = (counts[decision.reason] ?? 0) + 1
          continue
        }

        if (DRY_RUN) {
          resolvePaperTrade(trade.conditionId, exitPrice)
          if (exitMeta) unsubscribeToken(exitMeta.tokenId)
          const pnl = sharesToSell * (exitPrice - trade.entryPrice)
          console.log(`  🏜️ DRY-RUN ${exitEmoji(decision.reason)} ${decision.reason.toUpperCase()} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${decision.message} | ${trade.title}`)
        } else if (exitMeta) {
          const result = await closePosition(exitMeta.tokenId, sharesToSell, exitPrice, exitMeta.negRisk)
          if (!result.success) {
            console.log(`  ⚠️  EXIT FAILED | ${result.error} | ${trade.title.slice(0, 40)}`)
            continue
          }
          // Save as pending SELL — only resolve when fill confirmed
          if (result.orderId) {
            try {
              savePendingOrder({
                orderId: result.orderId,
                conditionId: trade.conditionId,
                title: trade.title,
                domain: trade.domain ?? null,
                side: trade.side,
                entryPrice: trade.entryPrice,
                sizeUsdc: trade.sizeUsdc,
                sourceRef: trade.sourceRef,
                sourceLabel: trade.sourceLabel,
                placedAt: new Date().toISOString(),
                orderType: 'SELL',
                exitPrice,
                partialFraction: null,
                exitReason: decision.reason,
              })
            } catch (dbErr) {
              console.error(`  🚨 CRITICAL: SELL order ${result.orderId} placed on CLOB but DB save failed!`)
              console.error(dbErr)
              logBotEvent('critical-orphan', `SELL order ${result.orderId} orphaned`, String(dbErr))
            }
            console.log(`  📋 SELL PLACED | ${decision.reason} | ${sharesToSell.toFixed(1)} shares @ ${(exitPrice * 100).toFixed(0)}¢ | orderId:${result.orderId.slice(0, 12)} | ${trade.title.slice(0, 40)}`)
            logBotEvent('live-sell-pending', `${decision.reason} | ${sharesToSell.toFixed(1)} shares @ ${(exitPrice * 100).toFixed(0)}¢ | ${trade.title}`, `orderId:${result.orderId.slice(0, 12)}`)
          }
        }
      }
      counts[decision.reason] = (counts[decision.reason] ?? 0) + 1
    } catch (err) {
      console.error(`  ⚠ Exit failed for ${trade.conditionId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return counts
}

// ── Stats ────────────────────────────────────────────────────────

function printStats(): void {
  // On-chain data = source of truth
  const equity = getCurrentEquity()
  const cash = getAvailableCash()
  const posValue = _cachedPositions.reduce((s, p) => s + p.size * p.curPrice, 0)
  const posCost = _cachedPositions.reduce((s, p) => s + p.size * p.avgPrice, 0)
  const unrealizedPnl = posValue - posCost
  const openCount = _cachedPositions.length
  const nextBet = getDynamicBetSize()

  // DB data for resolved trades stats
  const all = getLivePaperTrades()
  const won = all.filter((t) => t.status === 'won')
  const lost = all.filter((t) => t.status === 'lost')
  const realizedPnl = [...won, ...lost].reduce((s, t) => s + (t.pnl ?? 0), 0)
  const winRate = (won.length + lost.length) > 0
    ? won.length / (won.length + lost.length)
    : 0

  console.log(`\n  ┌─────────────────────────────────────┐`)
  console.log(`  │ 🔴 LIVE (on-chain)                    │`)
  console.log(`  │ Equity:   $${equity.toFixed(2).padStart(10)}`)
  console.log(`  │ USDC:     $${cash.toFixed(2).padStart(10)}`)
  console.log(`  │ Invested: $${posValue.toFixed(2).padStart(10)}  (${openCount} positions)`)
  console.log(`  │ Unreal:   ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2).padStart(10)}`)
  console.log(`  │ Realized: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2).padStart(10)}  (${won.length}W / ${lost.length}L)`)
  console.log(`  │ Win Rate: ${(winRate * 100).toFixed(0).padStart(9)}%`)
  console.log(`  │ Next bet: $${nextBet.toFixed(2).padStart(10)}`)
  console.log(`  │ WS:      ${isWsConnected() ? '🟢' : '🔴'} market | ${isUserWsConnected() ? '🟢' : '🔴'} user  (${getSubscribedCount()} tokens, ${getPendingOrders().length} pending)`)
  console.log(`  └─────────────────────────────────────┘`)

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
  const time = new Date().toISOString().slice(11, 19)

  // Safety checks
  if (checkDailyLossLimit()) return
  if (checkDrawdownBreaker()) return

  // Check pending GTC orders (BUY fills + SELL fills)
  if (!DRY_RUN) await checkPendingOrders()

  // On-chain state (source of truth)
  if (!DRY_RUN) {
    const [realBalance, realPositions] = await Promise.all([getRealBalance(), getRealPositions()])
    setOnChainState(realBalance, realPositions)
    console.log(`[${time}] 🔴 LIVE | On-chain: $${realBalance.toFixed(2)} | ${realPositions.length} positions`)
  } else {
    console.log(`[${time}] 🏜️ DRY-RUN`)
  }

  // ── Phase 1: Process signals from scanners ──
  const placed = await processSignals()

  // ── Phase 2: Manage existing positions (exits) ──
  const pricesUpdated = await refreshOpenPrices()
  const exits = await runExitStrategy()
  const totalExits = Object.values(exits).reduce((s, n) => s + n, 0)
  const exitSummary = Object.entries(exits).map(([k, v]) => `${v} ${k}`).join(', ')

  // ── Phase 3: Redeem on-chain FIRST, then resolve DB ──
  const redeemedConditionIds = new Set<string>()
  if (!DRY_RUN) {
    const redeemed = await redeemAllResolved()
    for (const { conditionId, exitPrice } of redeemed) {
      redeemedConditionIds.add(conditionId)
      resolvePaperTrade(conditionId, exitPrice)
      logBotEvent('live-redeem', `Redeemed @ ${exitPrice > 0 ? '$1' : '$0'} | ${conditionId.slice(0, 16)}`, exitPrice > 0 ? 'WON' : 'LOST')
    }
  }

  const resolved = await resolveCompletedTrades(redeemedConditionIds)

  // ── Phase 5: Reconcile DB with on-chain (bidirectional) ──
  // Source of truth = Polymarket on-chain. DB must match.
  if (!DRY_RUN) {
    const dbOpenTrades = getOpenLiveTrades()
    const dbConditionIds = new Set(dbOpenTrades.map(t => t.conditionId))
    const onChainConditionIds = new Set(_cachedPositions.map(p => p.conditionId))
    const pendingConditionIds = new Set(getPendingOrders().map(po => po.conditionId))

    // 1. Remove phantoms: DB says open but not on-chain
    let phantomsRemoved = 0
    for (const trade of dbOpenTrades) {
      if (onChainConditionIds.has(trade.conditionId)) continue
      if (pendingConditionIds.has(trade.conditionId)) continue
      resolvePaperTrade(trade.conditionId, trade.curPrice ?? trade.entryPrice)
      console.log(`  🧹 PHANTOM REMOVED | not on-chain | ${trade.title.slice(0, 50)}`)
      logBotEvent('reconcile', `Phantom removed: ${trade.title}`, 'Not on-chain')
      phantomsRemoved++
    }

    // 2. Add missing: on-chain exists but not in DB → import from Polymarket
    let positionsAdded = 0
    for (const pos of _cachedPositions) {
      if (dbConditionIds.has(pos.conditionId)) continue
      if (pendingConditionIds.has(pos.conditionId)) continue
      // Real on-chain position not tracked in DB → add it
      const side = pos.side
      cacheTokenId(pos.conditionId, side, pos.tokenId, false)
      openPaperTrade({
        conditionId: pos.conditionId,
        title: pos.title,
        domain: keywordClassify(pos.title)?.domain ?? null,
        side,
        entryPrice: pos.avgPrice,
        sizeUsdc: pos.size * pos.avgPrice,
        sourceRef: 'on-chain-sync',
        sourceLabel: '[LIVE] synced from on-chain',
      })
      updatePaperTradePrice(pos.conditionId, pos.curPrice)
      console.log(`  📥 SYNCED FROM CHAIN | ${side} ${pos.size.toFixed(1)} shares @ ${(pos.avgPrice * 100).toFixed(0)}¢ → ${(pos.curPrice * 100).toFixed(0)}¢ | ${pos.title.slice(0, 50)}`)
      positionsAdded++
    }

    if (phantomsRemoved > 0 || positionsAdded > 0) {
      console.log(`  🔄 Reconciled: -${phantomsRemoved} phantoms, +${positionsAdded} from chain`)
    }
  }

  // ── Summary ──
  const parts = [`${placed} placed`]
  if (totalExits > 0) parts.push(`${totalExits} exits (${exitSummary})`)
  if (resolved > 0) parts.push(`${resolved} resolved`)
  parts.push(`${pricesUpdated} prices`)
  console.log(`  → ${parts.join(' | ')}`)

  printStats()
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = DRY_RUN ? '🏜️ DRY-RUN' : '🔴 REAL MONEY'

  // Verify credentials (skip in dry-run)
  if (!DRY_RUN) {
    if (!process.env.POLYMARKET_PRIVATE_KEY) {
      console.error('❌ POLYMARKET_PRIVATE_KEY not set')
      console.error('   Run: npx tsx scripts/init-polymarket-creds.ts')
      process.exit(1)
    }
  }

  // On-chain state first — this is the source of truth
  if (!DRY_RUN) {
    const [realBalance, realPositions] = await Promise.all([getRealBalance(), getRealPositions()])
    setOnChainState(realBalance, realPositions)
    if (realBalance < 0.10) {
      console.error(`❌ Balance too low ($${realBalance.toFixed(2)}) — need USDC.e on Polygon`)
      process.exit(1)
    }
  }

  // Starting balance = on-chain equity at startup (auto-detected, not hardcoded)
  const eq = getCurrentEquity()
  const existingStartBal = getPortfolioSetting('starting_balance', '')
  if (existingStartBal === '' || existingStartBal === '9') {
    // First run or legacy value — set to current on-chain equity
    setPortfolioSetting('starting_balance', eq.toFixed(2))
    console.log(`  💰 Starting balance set from on-chain: $${eq.toFixed(2)}`)
  }
  const startBal = parseFloat(getPortfolioSetting('starting_balance', eq.toFixed(2)))
  const scale = getBankrollScale()

  // HWM = current on-chain equity (reset every restart, no phantom peaks)
  highWaterMark = eq

  console.log('═══════════════════════════════════════════════')
  console.log(`  ${mode} LIVE TRADER`)
  console.log('═══════════════════════════════════════════════')
  console.log(`  Equity:      $${eq.toFixed(2)} (on-chain)`)
  console.log(`  Start bal:   $${startBal.toFixed(2)} (scale: ${scale.toFixed(3)})`)
  console.log(`  Source:      signals table (from scanners)`)
  console.log(`  Bet sizing:  ${(BET_PCT * 100).toFixed(0)}% of cash ($${getMinBet(eq).toFixed(2)}-$${getMaxBet(eq).toFixed(2)})`)
  console.log(`  Entry range: ${(MIN_ENTRY * 100).toFixed(0)}¢ - ${(MAX_ENTRY * 100).toFixed(0)}¢`)
  console.log(`  Min signal:  ${MIN_SIGNAL_SCORE}/100`)
  console.log(`  Max open:    ${getMaxOpen()} (scales with equity)`)
  console.log(`  Max capital: ${(getMaxCapitalPct() * 100).toFixed(0)}%`)
  console.log(`  Stop-loss:   -${(EXIT_CONFIG.stopLossPct * 100).toFixed(0)}%`)
  console.log(`  Near-res:    >${(EXIT_CONFIG.nearResolutionThreshold * 100).toFixed(0)}¢ YES / <${((1 - EXIT_CONFIG.nearResolutionThreshold) * 100).toFixed(0)}¢ NO`)
  console.log(`  Partials:    50% @ +100%, 30% @ +150%`)
  console.log(`  Stale exit:  ${EXIT_CONFIG.staleDays}d < ${(EXIT_CONFIG.staleThreshold * 100).toFixed(0)}¢ move`)
  console.log(`  Expert exit: ${EXIT_CONFIG.followExpertExit ? 'ON' : 'OFF'}`)
  console.log(`  Consensus:   1x=1.0 | 2x=0.7 | 3x=0.5 | 5x=0.3 (inverted)`)
  console.log(`  Daily limit: -${(DAILY_LOSS_LIMIT_PCT * 100).toFixed(0)}% ($${(startBal * DAILY_LOSS_LIMIT_PCT).toFixed(0)})`)
  console.log(`  Poll every:  ${POLL_INTERVAL_MS / 1000}s`)
  console.log('═══════════════════════════════════════════════')

  // ── Sync existing on-chain positions into live.db ──────────────
  // If the bot restarts or live.db was recreated, import real positions
  // from the Data API so the dashboard and exit logic can track them.
  if (!DRY_RUN) {
    try {
      // Use getRealPositions() which handles wallet init internally
      const positions = await getRealPositions()
      const dbOpenTrades = getOpenLiveTrades()
      const dbConditionIds = new Set(dbOpenTrades.map(t => t.conditionId))

      for (const p of positions) {
        cacheTokenId(p.conditionId, p.side, p.tokenId, false)

        // Create position record if not in DB (startup sync after DB wipe or first run)
        if (!dbConditionIds.has(p.conditionId)) {
          openPaperTrade({
            conditionId: p.conditionId,
            title: p.title,
            domain: keywordClassify(p.title)?.domain ?? null,
            side: p.side,
            entryPrice: p.avgPrice,
            sizeUsdc: p.size * p.avgPrice,
            sourceRef: 'on-chain-sync',
            sourceLabel: '[LIVE] synced from on-chain',
          })
          updatePaperTradePrice(p.conditionId, p.curPrice)
          console.log(`  📥 SYNCED | ${p.side} ${p.size.toFixed(1)} shares @ ${(p.avgPrice * 100).toFixed(0)}¢ → ${(p.curPrice * 100).toFixed(0)}¢ | ${p.title.slice(0, 50)}`)
        }
      }
      if (positions.length > 0) {
        console.log(`  📥 Cached ${positions.length} on-chain token IDs`)
      }
    } catch (err) {
      console.log(`  ⚠️  Position sync failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  printStats()

  // ── Connect orderbook websocket for real-time prices ───────────
  connectOrderbookWS()

  // ── Connect User WS for order fill/cancel notifications ────────
  const apiKey = process.env.POLYMARKET_API_KEY ?? ''
  const apiSecret = process.env.POLYMARKET_API_SECRET ?? ''
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE ?? ''

  if (apiKey && apiSecret) {
    connectUserWS(
      { apiKey, secret: apiSecret, passphrase: apiPassphrase },
      // On order fill: verify on-chain FIRST, then update DB
      async (orderId: string, filledPrice: number, _filledSize: number) => {
        const pending = getPendingOrders()
        const po = pending.find(p => p.orderId === orderId)
        if (!po) return

        // Double-verify with CLOB API — WS can fire before on-chain settlement
        const verified = await checkOrderStatus(orderId)
        if (verified.status !== 'filled') {
          console.log(`  ⏳ WS says filled but CLOB says "${verified.status}" — waiting | ${po.title.slice(0, 40)}`)
          return  // checkPendingOrders() will handle it when truly filled
        }

        const confirmedPrice = verified.filledPrice ?? filledPrice
        if (po.orderType === 'BUY') {
          openPaperTrade({
            conditionId: po.conditionId,
            title: po.title,
            domain: po.domain,
            side: po.side,
            entryPrice: confirmedPrice,
            sizeUsdc: po.sizeUsdc,
            sourceRef: po.sourceRef,
            sourceLabel: po.sourceLabel,
          })
          subscribeToken(tokenIdCache.get(`${po.conditionId}-${po.side}`)?.tokenId ?? '')
          console.log(`  💰 BUY FILLED (verified) | ${po.side} @ ${(confirmedPrice * 100).toFixed(0)}¢ | $${po.sizeUsdc.toFixed(2)} | ${po.title.slice(0, 40)}`)
        } else {
          const exitPrice = verified.filledPrice ?? po.exitPrice ?? confirmedPrice
          if (po.partialFraction) {
            partialExitPaperTrade(po.conditionId, po.partialFraction, exitPrice)
          } else {
            resolvePaperTrade(po.conditionId, exitPrice)
          }
          console.log(`  💰 SELL FILLED (verified) | ${po.exitReason} @ ${(exitPrice * 100).toFixed(0)}¢ | ${po.title.slice(0, 40)}`)
        }
        removePendingOrder(orderId)
        logBotEvent('live-filled', `${po.orderType} FILLED (verified) @ ${(confirmedPrice * 100).toFixed(0)}¢ | ${po.title}`, `orderId:${orderId.slice(0, 12)}`)
      },
      // On order cancel
      (orderId: string) => {
        removePendingOrder(orderId)
      }
    )
  }

  // Subscribe to tokens for any existing open positions
  const openForWs = getOpenLiveTrades()
  for (const trade of openForWs) {
    const meta = await getTokenId(trade.conditionId, trade.side)
    if (meta) subscribeToken(meta.tokenId)
  }
  if (openForWs.length > 0) {
    console.log(`  [WS] Subscribed to ${openForWs.length} open position token(s)`)
  }

  console.log('Starting first poll...\n')
  await pollOnce()

  setInterval(() => {
    pollOnce().catch((err) => {
      console.error(`Poll error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, POLL_INTERVAL_MS)

}

main().catch(console.error)
