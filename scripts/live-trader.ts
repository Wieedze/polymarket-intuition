/**
 * Live Trader — Real money execution on Polymarket
 *
 * Full mirror of auto-trader.ts with real order execution.
 * Every signal, sizing, exit, and risk decision is identical to paper trading,
 * but orders are placed on the real Polymarket CLOB.
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
  getActiveWatchedWallets,
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
  type PaperTrade,
  getWalletStats,
  updateWalletCopyability,
} from '../src/lib/db'
import { indexWallet } from '../src/lib/indexer'
import { calculateCopyabilityFromStats } from '../src/lib/scorer'
import { pollWallet, type PositionAlert } from '../src/lib/position-tracker'
import { keywordClassify } from '../src/lib/classifier'
import { fetchAllPages, fetchMarketMetadata } from '../src/lib/polymarket'
import { evaluateExit, exitEmoji, type ExitConfig } from '../src/lib/exit-strategy'
import { scoreSignal, signalBetMultiplier, isContradictory, kellyBetFraction } from '../src/lib/signal-scorer'
import { evaluateExpertTrust, getAllExpertTrust, getBankrollScale } from '../src/lib/expert-trust'
import { placeOrder, getRealBalance, getRealPositions, closePosition, checkOrderStatus, cancelOrder, redeemAllResolved, type RealOrder, type RealPosition } from '../src/lib/real-trader'
import { connectOrderbookWS, subscribeToken, unsubscribeToken, getWsBestBid, isWsConnected, getSubscribedCount, connectUserWS, subscribeUserMarket, isUserWsConnected } from '../src/lib/orderbook-ws'
import { getNoVigConsensus } from '../src/lib/odds-api'
import { detectSportKey, parseMarketTitle } from '../src/lib/sports-scanner'
import { findGameMatch } from '../src/lib/team-matcher'

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
// Live trades are stored as paper_trades with copiedLabel starting with "[LIVE]"
// This keeps them separate from pure paper trades.

function getLivePaperTrades(): PaperTrade[] {
  return getAllPaperTrades().filter((t) => t.copiedLabel?.startsWith('[LIVE]'))
}

function getOpenLiveTrades(): PaperTrade[] {
  return getOpenPaperTrades().filter((t) => t.copiedLabel?.startsWith('[LIVE]'))
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

// ── Consensus tracking (same as auto-trader) ─────────────────────

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
    if (existing.side === side) {
      existing.experts.push({ wallet: alert.wallet, label: alert.walletLabel, size: alert.position.size })
    }
  } else {
    consensusMap.set(key, {
      conditionId: key, title: alert.position.title, side, price: alert.position.curPrice,
      experts: [{ wallet: alert.wallet, label: alert.walletLabel, size: alert.position.size }],
    })
  }
}

function getConsensusMultiplier(conditionId: string): number {
  const entry = consensusMap.get(conditionId)
  if (!entry) return 1
  const n = entry.experts.length
  if (n >= 5) return 0.3
  if (n >= 3) return 0.5
  if (n >= 2) return 0.7
  return 1
}

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
          simulatedUsdc: po.simulatedUsdc,
          copiedFrom: po.copiedFrom,
          copiedLabel: po.copiedLabel,
        })
        removePendingOrder(po.orderId)
        console.log(`  ✅ BUY FILLED | ${po.side} @ ${(filledPrice * 100).toFixed(0)}¢ | $${po.simulatedUsdc.toFixed(2)} | ${po.title.slice(0, 40)}`)
        logBotEvent('live-filled', `BUY FILLED ${po.side} @ ${(filledPrice * 100).toFixed(0)}¢ $${po.simulatedUsdc.toFixed(2)} | ${po.title}`, `orderId:${po.orderId.slice(0, 12)}`)
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
          const pnl = (po.simulatedUsdc / po.entryPrice) * (filledPrice - po.entryPrice)
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

// ── Entry logic (mirrors auto-trader exactly) ────────────────────

function canCopy(alert: PositionAlert): boolean {
  if (alert.type !== 'NEW_POSITION') return false

  const price = alert.position.curPrice
  if (price < MIN_ENTRY || price > MAX_ENTRY) {
    console.log(`  ⏭️  PRICE ${(price * 100).toFixed(0)}¢ out of ${(MIN_ENTRY * 100).toFixed(0)}-${(MAX_ENTRY * 100).toFixed(0)}¢ | ${alert.position.title.slice(0, 40)}`)
    return false
  }
  if (paperTradeExistsForCondition(alert.position.conditionId)) {
    console.log(`  ⏭️  ALREADY TRADED | ${alert.position.title.slice(0, 40)}`)
    return false
  }
  // Check pending orders too — prevent duplicate GTC orders for same market
  const pendingOrders = getPendingOrders()
  if (pendingOrders.some(po => po.conditionId === alert.position.conditionId)) {
    console.log(`  ⏭️  PENDING ORDER | ${alert.position.title.slice(0, 40)}`)
    return false
  }

  const openTrades = getOpenLiveTrades()
  if (openTrades.length >= getMaxOpen()) return false

  const equity = getCurrentEquity()
  const totalInvested = openTrades.reduce((s, t) => s + t.simulatedUsdc, 0)
  const betSize = getDynamicBetSize()
  if (totalInvested + betSize > equity * getMaxCapitalPct()) return false

  return true
}

async function tryCopyWithSignal(alert: PositionAlert): Promise<boolean> {
  const trust = evaluateExpertTrust(alert.wallet, alert.walletLabel)
  if (trust.status === 'paused') {
    console.log(`  ⛔ PAUSED | ${alert.walletLabel ?? alert.wallet.slice(0, 10)} | ${trust.reason}`)
    return false
  }

  // Sports odds lookup — adds bonus points to signal score, never blocks
  let bookmakerEdgeBonus = 0
  let bookmakerNoVigProb: number | null = null

  if (ODDS_API_KEY) {
    const titleClass = keywordClassify(alert.position.title)
    if (titleClass?.domain === 'pm-domain/sports') {
      const sportKey = detectSportKey(alert.position.title)
      if (sportKey) {
        try {
          const parsed = parseMarketTitle(alert.position.title)
          const noVigGames = await getNoVigConsensus(sportKey, ODDS_API_KEY)
          const matched = findGameMatch(parsed.homeTeam, parsed.awayTeam, noVigGames)
          if (matched) {
            const oddsKey = parsed.marketType === 'total' ? 'totals'
              : parsed.marketType === 'spread' ? 'spreads' : 'h2h'
            const oddsMarket = matched.markets.find((m) => m.type === oddsKey)
            if (oddsMarket && oddsMarket.outcomes.length >= 2) {
              const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
              // For h2h: match away team name to find the right outcome
              const lastWord = matched.matchInfo.awayTeam.toLowerCase().split(' ').pop() ?? ''
              const awayOutcome = oddsMarket.outcomes.find((o) => o.name.toLowerCase().includes(lastWord))
              if (awayOutcome) {
                const yesProb = awayOutcome.noVigProb
                const price = alert.position.curPrice
                const prob = side === 'YES' ? yesProb : 1 - yesProb
                const polyPrice = side === 'YES' ? price : 1 - price
                const edge = prob - polyPrice
                bookmakerNoVigProb = prob

                bookmakerEdgeBonus = edge >= 0.15 ? 25
                  : edge >= 0.10 ? 18
                  : edge >= 0.07 ? 12
                  : edge >= 0.04 ? 6
                  : 0
              }
            }
          }
        } catch {
          // Odds lookup failure = 0 bonus, non-blocking
        }
      }
    }
  }

  const signal = scoreSignal({
    expertWallet: alert.wallet,
    marketTitle: alert.position.title,
    entryPrice: alert.position.curPrice,
    positionSize: alert.position.size,
    bookmakerEdgeBonus,
    bookmakerNoVigProb: bookmakerNoVigProb ?? undefined,
  })

  if (signal.score < MIN_SIGNAL_SCORE) {
    // Only log non-zero scores (blocked domains/unknown = score 0, too noisy)
    if (signal.score > 0) {
      const oddsTag = bookmakerEdgeBonus > 0 ? ` | book:+${bookmakerEdgeBonus}pts` : ''
      console.log(`  ⏭️  SKIP (${signal.score}/${MIN_SIGNAL_SCORE}) | ${signal.reasons[0]}${oddsTag} | ${alert.position.title.slice(0, 50)}`)
    }
    return false
  }

  const domain = keywordClassify(alert.position.title)
  const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'

  // ── Entry price (live = real orderbook, no simulated slippage) ──
  const rawPrice = alert.position.curPrice
  const entryPrice = rawPrice  // GTC at market price — orderbook handles real execution

  // ── Kelly-based sizing ─────────────────────────────────────────
  const kellyFraction = kellyBetFraction(trust.winRate, entryPrice)
  const currentBankroll = getCurrentEquity()

  const minBet = getMinBet(currentBankroll)
  const maxBet = getMaxBet(currentBankroll)
  const baseBet = kellyFraction > 0
    ? Math.min(Math.max(currentBankroll * kellyFraction, minBet), maxBet)
    : minBet

  const signalMulti = signalBetMultiplier(signal)
  const consensusMulti = getConsensusMultiplier(alert.position.conditionId)
  const trustMulti = trust.trustLevel
  let betAmount = Math.min(baseBet * signalMulti * consensusMulti * trustMulti, maxBet)

  // Polymarket minimum: order must have >= 15 shares
  // shares = betAmount / entryPrice, so betAmount must be >= 15 * entryPrice
  const minBetForShares = POLY_MIN_ORDER_SHARES * entryPrice
  if (betAmount < minBetForShares) {
    betAmount = minBetForShares  // bump up to meet minimum
  }
  if (betAmount > getAvailableCash() * 0.95) {
    // Not enough cash for minimum order
    return false
  }


  // ── Fetch token ID for real order ──────────────────────────────
  const metadata = await fetchMarketMetadata(alert.position.conditionId)
  if (!metadata) {
    console.log(`  ⚠️  NO METADATA | ${alert.position.title.slice(0, 45)}`)
    return false
  }
  if (!metadata.active) {
    console.log(`  ⚠️  MARKET CLOSED | ${alert.position.title.slice(0, 45)}`)
    return false
  }
  const tokenId = side === 'YES' ? metadata.yesTokenId : metadata.noTokenId
  cacheTokenId(alert.position.conditionId, side, tokenId, metadata.negRisk)

  // ── Place real order (or dry-run log) ──────────────────────────
  const consensusEntry = consensusMap.get(alert.position.conditionId)
  const expertCount = consensusEntry?.experts.length ?? 1
  const consensusTag = expertCount > 1 ? ` 🤝${expertCount}x(${consensusMulti}x)` : ''
  const kellyTag = kellyFraction > 0 ? `kelly:${(kellyFraction * 100).toFixed(1)}%` : 'kelly:0→min'
  const trustTag = trust.status === 'reduced' ? ' ⚡reduced' : ''
  const scoreTag = signal.score >= 80 ? '🔥' : signal.score >= 60 ? '✅' : '⚠️'
  const stopTag = `stop:-${(EXIT_CONFIG.stopLossPct * 100).toFixed(0)}%`
  const domainTag = domain ? `[${domain.domain.replace('pm-domain/', '')}]` : ''
  const oddsTag = signal.bookmakerEdgeBonus > 0 ? ` | 📊book:${((signal.bookmakerNoVigProb ?? 0) * 100).toFixed(0)}%(+${signal.bookmakerEdgeBonus}pts)` : ''

  if (DRY_RUN) {
    console.log(`  🏜️  DRY-RUN | ${scoreTag} ${side} @ ${(rawPrice * 100).toFixed(0)}¢ | $${betAmount.toFixed(2)}${consensusTag}${trustTag} | ${kellyTag} | ${stopTag}${oddsTag} | ${alert.position.title.slice(0, 45)} ${domainTag}`)
    logBotEvent('live-dry-run', `${side} @ ${(entryPrice * 100).toFixed(0)}¢ $${betAmount.toFixed(2)} | ${alert.position.title}`, `Score: ${signal.score}/100`)
  } else {
    // ── Place GTC order at expert price + buffer ─────────────────────
    // The order sits in the orderbook until filled or timeout.
    // User WS notifies us instantly when filled — no polling needed.
    subscribeToken(tokenId)

    // Price: expert's entry price + 5¢ buffer (max MAX_ENTRY)
    const PRICE_BUFFER = 0.05
    const maxPrice = Math.min(rawPrice + PRICE_BUFFER, MAX_ENTRY)
    const orderPrice = parseFloat(maxPrice.toFixed(2))

    const liveBetAmount = parseFloat(Math.min(betAmount, getAvailableCash() * 0.30).toFixed(2))
    if (liveBetAmount < POLY_MIN_ORDER_SHARES * orderPrice) {
      return false
    }

    const order: RealOrder = {
      conditionId: alert.position.conditionId,
      tokenId,
      title: alert.position.title,
      side: side as 'YES' | 'NO',
      price: orderPrice,
      sizeUsdc: liveBetAmount,
      orderType: 'GTC',  // stays in orderbook until filled or cancelled
      negRisk: metadata.negRisk,
    }

    const result = await placeOrder(order)

    if (!result.success) {
      console.log(`  ❌ ORDER FAILED | ${result.error} | ${alert.position.title.slice(0, 45)}`)
      logBotEvent('live-error', `FAILED ${side} @ ${(orderPrice * 100).toFixed(0)}¢ | ${alert.position.title}`, result.error ?? '')
      return false
    }

    // ALL orders go through pending flow — no immediate paper trade
    // checkPendingOrders() or WS callback will create the paper trade after on-chain verification
    if (result.orderId) {
      const status = result.filledPrice ? 'FILLED' : 'PLACED'
      console.log(`  📋 LIVE ${scoreTag} GTC ${status} | ${side} @ ${(orderPrice * 100).toFixed(0)}¢ | $${liveBetAmount.toFixed(2)}${consensusTag}${trustTag} | ${kellyTag} | orderId:${result.orderId.slice(0, 12)} | ${alert.position.title.slice(0, 40)} ${domainTag}`)
      logBotEvent('live-gtc', `GTC ${side} @ ${(orderPrice * 100).toFixed(0)}¢ $${liveBetAmount.toFixed(2)} | ${alert.position.title}`, `Score: ${signal.score}/100 | timeout: 5min`)

      savePendingOrder({
        orderId: result.orderId,
        conditionId: alert.position.conditionId,
        title: alert.position.title,
        domain: domain?.domain ?? null,
        side,
        entryPrice: orderPrice,
        simulatedUsdc: liveBetAmount,
        copiedFrom: alert.wallet,
        copiedLabel: `[LIVE] ${alert.walletLabel ?? alert.wallet.slice(0, 10)}`,
        placedAt: new Date().toISOString(),
        orderType: 'BUY',
        exitPrice: null,
        partialFraction: null,
        exitReason: null,
      })

      subscribeUserMarket(alert.position.conditionId)
    }
  }

  return true
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
    return !updated || t.copiedFrom === 'on-chain-sync'
  })
  const wallets = [...new Set(
    tradesWithoutPrice
      .filter((t) => t.copiedFrom !== 'on-chain-sync')
      .map((t) => t.copiedFrom)
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
    const wallets = [...new Set(openTrades.map((t) => t.copiedFrom))]
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
    // Don't place another sell if one is already pending
    if (pendingSellConditions.has(trade.conditionId)) continue

    let expertStillHolding: boolean | null = null
    if (EXIT_CONFIG.followExpertExit && trade.copiedFrom !== 'on-chain-sync') {
      const expertKeys = expertPositions.get(trade.copiedFrom)
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
            savePendingOrder({
              orderId: result.orderId,
              conditionId: trade.conditionId,
              title: trade.title,
              domain: trade.domain ?? null,
              side: trade.side,
              entryPrice: trade.entryPrice,
              simulatedUsdc: trade.simulatedUsdc,
              copiedFrom: trade.copiedFrom,
              copiedLabel: trade.copiedLabel,
              placedAt: new Date().toISOString(),
              orderType: 'SELL',
              exitPrice,
              partialFraction: decision.partialFraction,
              exitReason: decision.reason,
            })
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
            savePendingOrder({
              orderId: result.orderId,
              conditionId: trade.conditionId,
              title: trade.title,
              domain: trade.domain ?? null,
              side: trade.side,
              entryPrice: trade.entryPrice,
              simulatedUsdc: trade.simulatedUsdc,
              copiedFrom: trade.copiedFrom,
              copiedLabel: trade.copiedLabel,
              placedAt: new Date().toISOString(),
              orderType: 'SELL',
              exitPrice,
              partialFraction: null,
              exitReason: decision.reason,
            })
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
  const all = getLivePaperTrades()
  const open = all.filter((t) => t.status === 'open')
  const won = all.filter((t) => t.status === 'won')
  const lost = all.filter((t) => t.status === 'lost')
  const realizedPnl = [...won, ...lost].reduce((s, t) => s + (t.pnl ?? 0), 0)
  const unrealizedPnl = open.reduce((s, t) => {
    if (t.curPrice == null) return s
    const sharesNow = t.sharesRemaining ?? t.shares
    const fraction = sharesNow / t.shares
    return s + sharesNow * t.curPrice * (1 - 0.02) - t.simulatedUsdc * fraction
  }, 0)
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '9'))
  const balance = startBal + realizedPnl
  const winRate = (won.length + lost.length) > 0
    ? won.length / (won.length + lost.length)
    : 0

  const totalInvested = open.reduce((s, t) => s + t.simulatedUsdc, 0)
  const cash = startBal + realizedPnl - totalInvested
  const nextBet = getDynamicBetSize()

  console.log(`\n  ┌─────────────────────────────────────┐`)
  console.log(`  │ 🔴 LIVE BALANCE                      │`)
  console.log(`  │ Balance:  $${balance.toFixed(2).padStart(10)}  (start: $${startBal.toFixed(0)})`)
  console.log(`  │ Realized: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2).padStart(10)}`)
  console.log(`  │ Unreal:   ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2).padStart(10)}`)
  console.log(`  │ Cash:     $${cash.toFixed(2).padStart(10)}  (next bet: $${nextBet.toFixed(2)})`)
  console.log(`  │ Open:     ${open.length.toString().padStart(10)}  trades`)
  console.log(`  │ Win Rate: ${(winRate * 100).toFixed(0).padStart(9)}%  (${won.length}W / ${lost.length}L)`)
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
  const wallets = getActiveWatchedWallets()
  const time = new Date().toISOString().slice(11, 19)

  // Safety checks
  if (checkDailyLossLimit()) return
  if (checkDrawdownBreaker()) return

  // Verify pending GTC orders (fill check / timeout cancel)
  if (!DRY_RUN) await checkPendingOrders()

  if (!DRY_RUN) {
    const [realBalance, realPositions] = await Promise.all([getRealBalance(), getRealPositions()])
    setOnChainState(realBalance, realPositions)
    console.log(`[${time}] 🔴 LIVE | On-chain: $${realBalance.toFixed(2)} | ${realPositions.length} positions | Polling ${wallets.length} wallets...`)
  } else {
    console.log(`[${time}] 🏜️ DRY-RUN | Polling ${wallets.length} wallets...`)
  }

  // ── Phase 1: Collect signals & build consensus ──
  consensusMap.clear()
  const allNewAlerts: PositionAlert[] = []
  const copyScoreMap = new Map<string, number>()
  for (const w of wallets) {
    if (w.copyabilityScore != null) copyScoreMap.set(w.wallet, w.copyabilityScore)
  }

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

  // Log new positions
  for (const alert of allNewAlerts) {
    const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
    const consensus = consensusMap.get(alert.position.conditionId)
    const expertCount = consensus?.experts.length ?? 1
    const consensusTag = expertCount > 1 ? ` [${expertCount} experts]` : ''
    const copyScore = copyScoreMap.get(alert.wallet)
    const copyTag = copyScore != null ? ` (copy:${(copyScore * 100).toFixed(0)}%)` : ''
    console.log(`  🔔 NEW | ${alert.walletLabel ?? alert.wallet.slice(0, 10)}${copyTag} | ${side} @ ${(alert.position.curPrice * 100).toFixed(0)}¢${consensusTag} | ${alert.position.title}`)
  }

  // Log consensus
  for (const [, entry] of consensusMap) {
    if (entry.experts.length >= 2) {
      const names = entry.experts.map((e) => e.label?.split(' ')[0] ?? e.wallet.slice(0, 8)).join(', ')
      console.log(`  🤝 CONSENSUS ${entry.experts.length}x | ${entry.side} @ ${(entry.price * 100).toFixed(0)}¢ | ${entry.title} | by: ${names}`)
    }
  }

  // ── Phase 2: Copy with signal-based sizing (parallel liquidity wait) ──
  let copied = 0
  const copiedConditions = new Set<string>()

  // Filter eligible alerts first, then launch all copies in parallel
  const eligibleAlerts: PositionAlert[] = []
  for (const alert of allNewAlerts) {
    if (copiedConditions.has(alert.position.conditionId)) continue
    const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
    const openTrades = getOpenPaperTrades()
    if (isContradictory(alert.position.conditionId, side, openTrades)) {
      console.log(`  ⚠️  CONTRA | Already holding opposite side | ${alert.position.title}`)
      continue
    }
    if (canCopy(alert)) {
      eligibleAlerts.push(alert)
      copiedConditions.add(alert.position.conditionId)  // prevent duplicates
    }
  }

  // Launch all copy attempts in parallel (each waits for its own liquidity)
  if (eligibleAlerts.length > 0) {
    const results = await Promise.allSettled(
      eligibleAlerts.map(alert => tryCopyWithSignal(alert))
    )
    copied = results.filter(r => r.status === 'fulfilled' && r.value).length
  }

  // ── Phase 3: Manage existing positions ──
  const pricesUpdated = await refreshOpenPrices()
  const exits = await runExitStrategy()
  const totalExits = Object.values(exits).reduce((s, n) => s + n, 0)
  const exitSummary = Object.entries(exits).map(([k, v]) => `${v} ${k}`).join(', ')
  // ── Phase 4: Redeem on-chain FIRST, then resolve DB ──
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
        simulatedUsdc: pos.size * pos.avgPrice,
        copiedFrom: 'on-chain-sync',
        copiedLabel: '[LIVE] synced from on-chain',
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
  const parts = [`${allNewAlerts.length} new`, `${copied} copied`]
  const consensusCount = [...consensusMap.values()].filter((e) => e.experts.length >= 2).length
  if (consensusCount > 0) parts.push(`${consensusCount} consensus`)
  if (totalExits > 0) parts.push(`${totalExits} exits (${exitSummary})`)
  if (resolved > 0) parts.push(`${resolved} resolved`)
  parts.push(`${pricesUpdated} prices`)
  console.log(`  → ${parts.join(' | ')}`)

  printStats()
}

// ── 24h Re-index ─────────────────────────────────────────────────

async function reindexAllWallets(): Promise<void> {
  const wallets = getActiveWatchedWallets()
  const time = new Date().toISOString().slice(11, 19)
  console.log(`\n[${time}] 📊 DAILY RE-INDEX — ${wallets.length} wallets`)

  let indexed = 0
  let errors = 0

  for (const { wallet, label } of wallets) {
    try {
      const result = await indexWallet(wallet)
      indexed += result.tradesIndexed
      if (result.errors.length > 0) errors++

      // Recalculate copyability from fresh wallet_stats
      const stats = getWalletStats(wallet)
      const newScore = calculateCopyabilityFromStats(stats)
      if (newScore > 0) updateWalletCopyability(wallet, newScore)

      if (result.tradesIndexed > 0) {
        console.log(`  ✓ ${(label ?? wallet.slice(0, 12)).padEnd(24)} +${result.tradesIndexed} trades (copy:${(newScore * 100).toFixed(0)}%)`)
      }
    } catch {
      errors++
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  console.log(`  → Re-index done: ${indexed} new trades, ${errors} errors\n`)
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

  const wallets = getActiveWatchedWallets()
  if (wallets.length === 0) {
    console.error('❌ No watched wallets. Run bulk-index first.')
    process.exit(1)
  }

  // Init portfolio settings — use STARTING_BALANCE env var or default to $9
  if (getPortfolioSetting('starting_balance', '') === '') {
    const startBal = process.env.STARTING_BALANCE ?? '9'
    setPortfolioSetting('starting_balance', startBal)
    console.log(`  💰 Starting balance: $${startBal}`)
  }

  const startBal = parseFloat(getPortfolioSetting('starting_balance', '9'))
  const scale = getBankrollScale()

  // Startup balance check
  if (!DRY_RUN) {
    const [realBalance, realPositions] = await Promise.all([getRealBalance(), getRealPositions()])
    setOnChainState(realBalance, realPositions)
    if (realBalance < 0.10) {
      console.error(`❌ Balance too low ($${realBalance.toFixed(2)}) — need USDC.e on Polygon`)
      process.exit(1)
    }
  }

  // HWM = current on-chain equity at startup (no DB memory of phantom peaks)
  const eq = getCurrentEquity()
  highWaterMark = eq

  console.log('═══════════════════════════════════════════════')
  console.log(`  ${mode} LIVE TRADER`)
  console.log('═══════════════════════════════════════════════')
  console.log(`  Bankroll:    $${startBal} (scale: ${scale.toFixed(3)})`)
  console.log(`  Equity:      $${eq.toFixed(2)}`)
  console.log(`  Wallets:     ${wallets.length}`)
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
      const res = await fetch(
        `https://data-api.polymarket.com/positions?user=${(await import('../src/lib/real-trader')).getWalletAddress().toLowerCase()}&sizeThreshold=0`
      )
      if (res.ok) {
        // Only cache token IDs for exit orders — don't create phantom paper trades
        // Real positions are visible via /api/wallet-equity (on-chain source of truth)
        const positions = await res.json() as Array<{
          conditionId: string; title: string; outcomeIndex: number
          size: number; asset: string; negativeRisk: boolean
        }>
        const openPositions = positions.filter(p => p.size > 0)
        for (const p of openPositions) {
          const side = p.outcomeIndex === 0 ? 'YES' : 'NO'
          cacheTokenId(p.conditionId, side, p.asset, p.negativeRisk ?? false)
        }
        if (openPositions.length > 0) {
          console.log(`  📥 Cached ${openPositions.length} on-chain token IDs (no phantom trades)`)
        }
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
            simulatedUsdc: po.simulatedUsdc,
            copiedFrom: po.copiedFrom,
            copiedLabel: po.copiedLabel,
          })
          subscribeToken(tokenIdCache.get(`${po.conditionId}-${po.side}`)?.tokenId ?? '')
          console.log(`  💰 BUY FILLED (verified) | ${po.side} @ ${(confirmedPrice * 100).toFixed(0)}¢ | $${po.simulatedUsdc.toFixed(2)} | ${po.title.slice(0, 40)}`)
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

  // Re-index every 24h
  const REINDEX_INTERVAL_MS = 24 * 60 * 60 * 1000
  setInterval(() => {
    reindexAllWallets().catch((err) => {
      console.error(`Re-index error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, REINDEX_INTERVAL_MS)
}

main().catch(console.error)
