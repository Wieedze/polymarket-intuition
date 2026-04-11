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
 *   MIN_SIGNAL_SCORE_LIVE=65      # signal threshold (default: 65)
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
  type PaperTrade,
} from '../src/lib/db'
import { indexWallet } from '../src/lib/indexer'
import { pollWallet, type PositionAlert } from '../src/lib/position-tracker'
import { keywordClassify } from '../src/lib/classifier'
import { fetchAllPages, fetchMarketMetadata } from '../src/lib/polymarket'
import { evaluateExit, exitEmoji, type ExitConfig } from '../src/lib/exit-strategy'
import { scoreSignal, shouldCopySignal, signalBetMultiplier, isContradictory, kellyBetFraction } from '../src/lib/signal-scorer'
import { evaluateExpertTrust, getAllExpertTrust, getBankrollScale } from '../src/lib/expert-trust'
import { placeOrder, getRealBalance, getRealPositions, closePosition, type RealOrder } from '../src/lib/real-trader'

const POLYMARKET_DATA_URL = process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com'

// ── Config ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '30000', 10)
const BET_PCT = parseFloat(process.env.BET_PCT ?? '0.02')
const MIN_ENTRY = parseFloat(process.env.MIN_ENTRY_PRICE ?? '0.15')
const MAX_ENTRY = parseFloat(process.env.MAX_ENTRY_PRICE ?? '0.50')  // block 50¢+ — no edge
const MAX_OPEN = parseInt(process.env.MAX_OPEN_TRADES ?? '100', 10)  // fixed cap
const MIN_SIGNAL_SCORE = parseInt(process.env.MIN_SIGNAL_SCORE_LIVE ?? '65', 10)

// Polymarket CLOB constraints (cannot change)
const POLY_MIN_ORDER_SHARES = 15   // minimum shares to place a buy order
const POLY_MIN_SELL_SHARES = 5     // minimum shares to sell (exit)
const DRY_RUN = process.env.DRY_RUN === 'true'
const DAILY_LOSS_LIMIT_PCT = 0.50  // 50% of bankroll — catastrophe safety net
const DRAWDOWN_LIMIT_PCT = parseFloat(process.env.DRAWDOWN_LIMIT ?? '0.20')  // 20% from peak — close all, protect gains

// ── Scaling (mirrors auto-trader with BANKROLL_SCALE) ────────────

function getCurrentEquity(): number {
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '9'))
  const allTrades = getLivePaperTrades()
  const realizedPnl = allTrades
    .filter((t) => t.status !== 'open')
    .reduce((s, t) => s + (t.pnl ?? 0), 0)
  return startBal + realizedPnl
}

function getAvailableCash(): number {
  const equity = getCurrentEquity()
  const totalInvested = getLivePaperTrades()
    .filter((t) => t.status === 'open')
    .reduce((s, t) => s + t.simulatedUsdc, 0)
  return equity - totalInvested
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
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '9'))

  if (dailyPnlDate !== today) {
    // New day — reset baseline
    dailyPnlDate = today
    dailyPnlStart = getCurrentEquity()
  }

  const currentEquity = getCurrentEquity()
  const dailyLoss = dailyPnlStart - currentEquity
  const limitAmount = startBal * DAILY_LOSS_LIMIT_PCT

  if (dailyLoss >= limitAmount) {
    console.log(`  🚨 DAILY LOSS LIMIT HIT | -$${dailyLoss.toFixed(2)} today (limit: -$${limitAmount.toFixed(2)}) | Bot paused until tomorrow`)
    logBotEvent('safety', `DAILY LOSS LIMIT -$${dailyLoss.toFixed(2)}`, `Limit: -$${limitAmount.toFixed(2)}`)
    return true  // limit hit
  }
  return false
}

// ── Drawdown circuit breaker ─────────────────────────────────────
// Track High Water Mark (peak equity). If equity drops 20% from peak,
// close all positions and stop trading. Protects gains on small accounts.
// Institutional standard: Bridgewater 15-20%, prop desks 10-20%.

let highWaterMark = 0

function checkDrawdownBreaker(): boolean {
  const equity = getCurrentEquity()
  const openTrades = getOpenLiveTrades()
  const unrealized = openTrades.reduce((s, t) => {
    const cur = t.curPrice ?? t.entryPrice
    const pnl = (t.sharesRemaining ?? t.shares) * (t.side === 'YES' ? cur - t.entryPrice : t.entryPrice - cur)
    return s + pnl
  }, 0)
  const totalEquity = equity + unrealized

  // Update HWM
  if (totalEquity > highWaterMark) {
    highWaterMark = totalEquity
    setPortfolioSetting('live_hwm', highWaterMark.toFixed(2))
  }

  // Only check if we've had meaningful gains (at least +10% from start)
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '9'))
  if (highWaterMark < startBal * 1.10) return false

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

const tokenIdCache = new Map<string, string>()

function cacheTokenId(conditionId: string, side: string, tokenId: string): void {
  tokenIdCache.set(`${conditionId}-${side}`, tokenId)
}

async function getTokenId(conditionId: string, side: string): Promise<string | null> {
  const cached = tokenIdCache.get(`${conditionId}-${side}`)
  if (cached) return cached

  const metadata = await fetchMarketMetadata(conditionId)
  if (!metadata) return null

  const tokenId = side === 'YES' ? metadata.yesTokenId : metadata.noTokenId
  cacheTokenId(conditionId, side, tokenId)
  return tokenId
}

// ── Entry logic (mirrors auto-trader exactly) ────────────────────

function canCopy(alert: PositionAlert): boolean {
  if (alert.type !== 'NEW_POSITION') return false

  const price = alert.position.curPrice
  if (price < MIN_ENTRY || price > MAX_ENTRY) return false
  if (paperTradeExistsForCondition(alert.position.conditionId)) return false

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

  const signal = scoreSignal({
    expertWallet: alert.wallet,
    marketTitle: alert.position.title,
    entryPrice: alert.position.curPrice,
    positionSize: alert.position.size,
  })

  if (signal.score < MIN_SIGNAL_SCORE || !shouldCopySignal(signal)) {
    if (signal.score > 20) {
      console.log(`  ⏭️  SKIP (${signal.score}/${MIN_SIGNAL_SCORE}) | ${signal.reasons[0]} | ${alert.position.title}`)
    }
    return false
  }

  const domain = keywordClassify(alert.position.title)
  const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'

  // ── Slippage (same as auto-trader) ─────────────────────────────
  const rawPrice = alert.position.curPrice
  const baseSlippage = rawPrice < 0.20 ? 0.06
    : rawPrice < 0.30 ? 0.05
    : rawPrice < 0.50 ? 0.03
    : 0.02

  // ── Kelly-based sizing (same as auto-trader) ───────────────────
  const entryPriceEst = Math.min(rawPrice * (1 + baseSlippage), 0.95)
  const kellyFraction = kellyBetFraction(trust.winRate, entryPriceEst)
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

  // Final entry price with size-adjusted slippage
  const sizeImpact = (betAmount / 100) * 0.005
  const slippage = baseSlippage + sizeImpact
  const entryPrice = Math.min(rawPrice * (1 + slippage), 0.95)

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

  // Dynamic stop-loss
  const dynamicStopLoss = entryPrice < 0.30 ? 0.20 : 0.25

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
  cacheTokenId(alert.position.conditionId, side, tokenId)

  // ── Place real order (or dry-run log) ──────────────────────────
  const consensusEntry = consensusMap.get(alert.position.conditionId)
  const expertCount = consensusEntry?.experts.length ?? 1
  const consensusTag = expertCount > 1 ? ` 🤝${expertCount}x(${consensusMulti}x)` : ''
  const kellyTag = kellyFraction > 0 ? `kelly:${(kellyFraction * 100).toFixed(1)}%` : 'kelly:0→min'
  const trustTag = trust.status === 'reduced' ? ' ⚡reduced' : ''
  const scoreTag = signal.score >= 80 ? '🔥' : signal.score >= 60 ? '✅' : '⚠️'
  const stopTag = `stop:-${(dynamicStopLoss * 100).toFixed(0)}%`
  const domainTag = domain ? `[${domain.domain.replace('pm-domain/', '')}]` : ''

  if (DRY_RUN) {
    console.log(`  🏜️  DRY-RUN | ${scoreTag} ${side} @ ${(rawPrice * 100).toFixed(0)}¢→${(entryPrice * 100).toFixed(0)}¢ | $${betAmount.toFixed(2)}${consensusTag}${trustTag} | ${kellyTag} | ${stopTag} | ${alert.position.title.slice(0, 45)} ${domainTag}`)
    logBotEvent('live-dry-run', `${side} @ ${(entryPrice * 100).toFixed(0)}¢ $${betAmount.toFixed(2)} | ${alert.position.title}`, `Score: ${signal.score}/100`)
  } else {
    const order: RealOrder = {
      conditionId: alert.position.conditionId,
      tokenId,
      title: alert.position.title,
      side: side as 'YES' | 'NO',
      price: entryPrice,
      sizeUsdc: betAmount,
      orderType: 'GTC',  // GTC instead of FOK — stays in orderbook if not immediately filled
    }

    const result = await placeOrder(order)

    if (!result.success) {
      console.log(`  ❌ ORDER FAILED | ${result.error} | ${alert.position.title.slice(0, 45)}`)
      logBotEvent('live-error', `FAILED ${side} @ ${(entryPrice * 100).toFixed(0)}¢ | ${alert.position.title}`, result.error ?? '')
      return false
    }

    const fillStatus = result.filledPrice ? 'FILLED' : 'PLACED (GTC pending)'
    console.log(`  💰 LIVE ${scoreTag} ${fillStatus} | ${side} @ ${(rawPrice * 100).toFixed(0)}¢→${(entryPrice * 100).toFixed(0)}¢ | $${betAmount.toFixed(2)}${consensusTag}${trustTag} | ${kellyTag} | ${stopTag} | orderId:${result.orderId?.slice(0, 12)} | ${alert.position.title.slice(0, 40)} ${domainTag}`)
    logBotEvent('live-copy', `${fillStatus} ${side} @ ${(entryPrice * 100).toFixed(0)}¢ $${betAmount.toFixed(2)} | ${alert.position.title}`, `Score: ${signal.score}/100 | ${kellyTag}`)
  }

  // Record as paper trade for tracking (labeled [LIVE])
  openPaperTrade({
    conditionId: alert.position.conditionId,
    title: alert.position.title,
    domain: domain?.domain ?? null,
    side,
    entryPrice,
    simulatedUsdc: betAmount,
    copiedFrom: alert.wallet,
    copiedLabel: `[LIVE] ${alert.walletLabel ?? alert.wallet.slice(0, 10)}`,
  })

  return true
}

// ── Price refresh (using our real positions) ─────────────────────

async function refreshOpenPrices(): Promise<number> {
  const openTrades = getOpenLiveTrades()
  if (openTrades.length === 0) return 0

  // Use expert positions for price data (same as auto-trader)
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

// ── Resolve completed markets ────────────────────────────────────

type PositionRecord = {
  conditionId: string
  curPrice: number
  redeemable: boolean
}

async function resolveCompletedTrades(): Promise<number> {
  const openTrades = getOpenLiveTrades()
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
            logBotEvent('live-resolved', `${result} PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | ${trade.title}`, '')
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

  for (const trade of openTrades) {
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

    // Get token ID for the close order
    const tokenId = await getTokenId(trade.conditionId, trade.side)

    try {
      if ((decision.reason === 'partial-exit-100' || decision.reason === 'partial-exit-150') && decision.partialFraction) {
        // Partial exit — sell a fraction
        const sharesRemaining = trade.sharesRemaining ?? trade.shares
        let sharesToSell = sharesRemaining * decision.partialFraction

        // Polymarket minimum sell: 5 shares
        if (sharesToSell < POLY_MIN_SELL_SHARES) {
          // Can't do partial — too few shares. Skip and wait for full exit.
          console.log(`  ⏭️  PARTIAL SKIP | ${sharesToSell.toFixed(1)} shares < ${POLY_MIN_SELL_SHARES} min | ${trade.title.slice(0, 40)}`)
          continue
        }

        if (!DRY_RUN && tokenId) {
          const result = await closePosition(tokenId, sharesToSell, exitPrice)
          if (!result.success) {
            console.log(`  ⚠️  PARTIAL EXIT FAILED | ${result.error} | ${trade.title.slice(0, 40)}`)
            continue
          }
        }

        partialExitPaperTrade(trade.conditionId, decision.partialFraction, exitPrice)
        const pnl = sharesToSell * (exitPrice - trade.entryPrice)
        const prefix = DRY_RUN ? '🏜️ DRY-RUN ' : '💰 LIVE '
        console.log(`  ${prefix}${exitEmoji(decision.reason)} ${decision.reason.toUpperCase()} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${(decision.partialFraction * 100).toFixed(0)}% sold @ ${(exitPrice * 100).toFixed(0)}¢ | ${trade.title}`)
        logBotEvent('live-exit', `${decision.reason} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${trade.title}`, decision.message)
      } else {
        // Full exit
        const sharesToSell = trade.sharesRemaining ?? trade.shares

        // Polymarket minimum sell: 5 shares
        if (!DRY_RUN && sharesToSell < POLY_MIN_SELL_SHARES) {
          console.log(`  ⚠️  EXIT TOO SMALL | ${sharesToSell.toFixed(1)} shares < ${POLY_MIN_SELL_SHARES} min — position stuck | ${trade.title.slice(0, 40)}`)
          // Still mark as resolved in DB so it doesn't retry every poll
          resolvePaperTrade(trade.conditionId, exitPrice)
          logBotEvent('live-exit', `EXIT TOO SMALL (${sharesToSell.toFixed(1)} shares) — tokens stuck on-chain | ${trade.title}`, decision.message)
          counts[decision.reason] = (counts[decision.reason] ?? 0) + 1
          continue
        }

        if (!DRY_RUN && tokenId) {
          const result = await closePosition(tokenId, sharesToSell, exitPrice)
          if (!result.success) {
            console.log(`  ⚠️  EXIT FAILED | ${result.error} | ${trade.title.slice(0, 40)}`)
            continue
          }
        }

        resolvePaperTrade(trade.conditionId, exitPrice)
        const pnl = sharesToSell * (exitPrice - trade.entryPrice)
        const prefix = DRY_RUN ? '🏜️ DRY-RUN ' : '💰 LIVE '
        console.log(`  ${prefix}${exitEmoji(decision.reason)} ${decision.reason.toUpperCase()} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${decision.message} | ${trade.title}`)
        logBotEvent('live-exit', `${decision.reason} | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | ${trade.title}`, decision.message)
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

  if (!DRY_RUN) {
    const realBalance = await getRealBalance()
    console.log(`[${time}] 🔴 LIVE | On-chain: $${realBalance.toFixed(2)} | Polling ${wallets.length} wallets...`)
  } else {
    console.log(`[${time}] 🏜️ DRY-RUN | Polling ${wallets.length} wallets...`)
  }

  // ── Phase 1: Collect signals & build consensus ──
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

  // Log new positions
  for (const alert of allNewAlerts) {
    const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
    const consensus = consensusMap.get(alert.position.conditionId)
    const expertCount = consensus?.experts.length ?? 1
    const consensusTag = expertCount > 1 ? ` [${expertCount} experts]` : ''
    console.log(`  🔔 NEW | ${alert.walletLabel ?? alert.wallet.slice(0, 10)} | ${side} @ ${(alert.position.curPrice * 100).toFixed(0)}¢${consensusTag} | ${alert.position.title}`)
  }

  // Log consensus
  for (const [, entry] of consensusMap) {
    if (entry.experts.length >= 2) {
      const names = entry.experts.map((e) => e.label?.split(' ')[0] ?? e.wallet.slice(0, 8)).join(', ')
      console.log(`  🤝 CONSENSUS ${entry.experts.length}x | ${entry.side} @ ${(entry.price * 100).toFixed(0)}¢ | ${entry.title} | by: ${names}`)
    }
  }

  // ── Phase 2: Copy with signal-based sizing ──
  let copied = 0
  const copiedConditions = new Set<string>()

  for (const alert of allNewAlerts) {
    if (copiedConditions.has(alert.position.conditionId)) continue

    const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
    const openTrades = getOpenPaperTrades()
    if (isContradictory(alert.position.conditionId, side, openTrades)) {
      console.log(`  ⚠️  CONTRA | Already holding opposite side | ${alert.position.title}`)
      continue
    }

    if (canCopy(alert) && await tryCopyWithSignal(alert)) {
      copiedConditions.add(alert.position.conditionId)
      copied++
    }
  }

  // ── Phase 3: Manage existing positions ──
  const pricesUpdated = await refreshOpenPrices()
  const exits = await runExitStrategy()
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
      if (result.tradesIndexed > 0) {
        console.log(`  ✓ ${(label ?? wallet.slice(0, 12)).padEnd(24)} +${result.tradesIndexed} trades`)
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
    const realBalance = await getRealBalance()
    if (realBalance < 0.10) {
      console.error(`❌ Balance too low ($${realBalance.toFixed(2)}) — need USDC.e on Polygon`)
      process.exit(1)
    }
    if (realBalance < startBal * 0.5) {
      console.warn(`⚠️  WARNING: On-chain balance ($${realBalance.toFixed(2)}) is much lower than starting_balance ($${startBal})`)
      console.warn(`   Some capital may already be deployed in open positions.`)
    }
  }

  // Load saved HWM or initialize from current equity
  const savedHwm = parseFloat(getPortfolioSetting('live_hwm', '0'))
  const eq = getCurrentEquity()
  highWaterMark = Math.max(savedHwm, eq)

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
        const positions = await res.json() as Array<{
          conditionId: string; title: string; outcome: string; outcomeIndex: number
          size: number; avgPrice: number; curPrice: number; initialValue: number
          asset: string; endDate: string
        }>
        const openPositions = positions.filter(p => p.size > 0 && p.curPrice >= 0.05 && p.curPrice <= 0.95)
        const existingTrades = getOpenPaperTrades()
        let synced = 0
        for (const p of openPositions) {
          const alreadyTracked = existingTrades.some(t => t.conditionId === p.conditionId)
          if (!alreadyTracked) {
            const side = p.outcomeIndex === 0 ? 'YES' : 'NO'
            // Cache the token ID for exit orders
            cacheTokenId(p.conditionId, side, p.asset)
            openPaperTrade({
              conditionId: p.conditionId,
              title: p.title,
              domain: keywordClassify(p.title)?.domain ?? null,
              side,
              entryPrice: p.avgPrice,
              simulatedUsdc: p.initialValue,
              copiedFrom: 'on-chain-sync',
              copiedLabel: '[LIVE] synced from on-chain',
            })
            // Update price immediately
            updatePaperTradePrice(p.conditionId, p.curPrice)
            synced++
            console.log(`  📥 SYNCED | ${side} @ ${(p.avgPrice * 100).toFixed(0)}¢ → ${(p.curPrice * 100).toFixed(0)}¢ | $${p.initialValue.toFixed(2)} | token:${p.asset.slice(0, 15)}... | ${p.title.slice(0, 50)}`)
          }
        }
        if (synced > 0) console.log(`  📥 Synced ${synced} existing on-chain positions into live.db`)
      }
    } catch (err) {
      console.log(`  ⚠️  Position sync failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  printStats()

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
