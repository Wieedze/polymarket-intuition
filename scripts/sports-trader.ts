/**
 * Sports Arbitrage Trader
 *
 * Autonomous sports betting bot — generates signals by comparing
 * Polymarket prices with bookmaker consensus odds (via the-odds-api.com).
 * No expert copying — pure cross-platform arbitrage.
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/sports-trader.ts
 *
 * Required env:
 *   ODDS_API_KEY               # the-odds-api.com API key
 *   POLYMARKET_PRIVATE_KEY     # (if DRY_RUN=false)
 *
 * Optional env:
 *   DB_PATH=data/sports.db     # separate DB for sports trades
 *   SHARED_DB_PATH=data/polymarket.db
 *   STARTING_BALANCE=50        # bankroll
 *   POLL_INTERVAL_MS=300000    # 5 min poll cycle
 *   SCAN_INTERVAL_MS=3600000   # 1h market rescan
 *   MAX_OPEN_TRADES=20
 *   MIN_SIGNAL_SCORE_SPORTS=50
 *   DRY_RUN=true               # log only, no real orders
 *   STOP_LOSS=0.40
 */

import {
  getOpenPaperTrades,
  openPaperTrade,
  paperTradeExistsForCondition,
  getPortfolioSetting,
  setPortfolioSetting,
  getAllPaperTrades,
  resolvePaperTrade,
  updatePaperTradePrice,
  partialExitPaperTrade,
  logBotEvent,
  savePendingOrder,
  getPendingOrders,
  removePendingOrder,
  getActiveSportsMarkets,
  saveSportsMarket,
  type PaperTrade,
} from '../src/lib/db'
import { fetchMarketMetadata } from '../src/lib/polymarket'
import { evaluateExit, exitEmoji, type ExitConfig } from '../src/lib/exit-strategy'
import { kellyBetFraction } from '../src/lib/signal-scorer'
import { placeOrder, getRealBalance, closePosition, checkOrderStatus, cancelOrder, type RealOrder } from '../src/lib/real-trader'
import { connectOrderbookWS, subscribeToken, unsubscribeToken, getWsBestBid, isWsConnected, getSubscribedCount, connectUserWS, isUserWsConnected } from '../src/lib/orderbook-ws'
import { scanSportsMarkets, getActiveSportKeys } from '../src/lib/sports-scanner'
import { getNoVigConsensus, getRequestsRemaining, type NoVigGame } from '../src/lib/odds-api'
import { generateSportsSignals, rankSignals, type SportsSignal } from '../src/lib/sports-signal'

// ── Config ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '300000', 10)  // 5 min
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS ?? '3600000', 10) // 1h rescan
const ODDS_API_KEY = process.env.ODDS_API_KEY ?? ''
const MIN_SIGNAL_SCORE = parseInt(process.env.MIN_SIGNAL_SCORE_SPORTS ?? '50', 10)
const MAX_OPEN = parseInt(process.env.MAX_OPEN_TRADES ?? '20', 10)
const MAX_SPORTS = parseInt(process.env.MAX_SPORTS ?? '10', 10)
const ALLOWED_SPORTS = process.env.ALLOWED_SPORTS?.split(',').filter(Boolean) ?? []  // empty = all
const DRY_RUN = process.env.DRY_RUN !== 'false'
const MAX_ENTRY = parseFloat(process.env.MAX_ENTRY_PRICE ?? '0.65')
const GTC_TIMEOUT_MS = 5 * 60 * 1000  // 5 min timeout for pending GTC orders

const POLY_MIN_ORDER_SHARES = 15
const POLY_MIN_SELL_SHARES = 5

const EXIT_CONFIG: ExitConfig = {
  takeProfitPct: 999,
  stopLossPct: parseFloat(process.env.STOP_LOSS ?? '0.40'),
  trailingActivatePct: 999,
  trailingStopPct: 0.10,
  nearResolutionThreshold: 0.90,   // tighter for sports (snap fast)
  staleDays: 2,                    // sports resolve in 1-2 days
  staleThreshold: 0.05,
  followExpertExit: false,         // no expert to follow
  partialExitAt100Pct: 0.50,
  partialExitAt150Pct: 0.30,
}

// ── State ────────────────────────────────────────────────────────

let activeSportKeys: string[] = []
let dailyPnlStart = 0
let dailyPnlDate = ''
let highWaterMark = 0

// ── Helpers ──────────────────────────────────────────────────────

function getStartBal(): number {
  return parseFloat(getPortfolioSetting('starting_balance', '50'))
}

function getCurrentEquity(): number {
  const startBal = getStartBal()
  const allTrades = getAllPaperTrades()
  const realizedPnl = allTrades
    .filter((t) => t.status !== 'open')
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  return startBal + realizedPnl
}

function getOpenSportsTrades(): PaperTrade[] {
  return getOpenPaperTrades().filter((t) => t.copiedLabel?.startsWith('[SPORTS]'))
}

function getAvailableCash(): number {
  const equity = getCurrentEquity()
  const invested = getOpenSportsTrades().reduce((sum, t) => sum + t.simulatedUsdc, 0)
  return Math.max(equity * 0.70 - invested, 0)  // max 70% deployed
}

function getMinBet(): number {
  return Math.max(getCurrentEquity() * 0.005, 1)
}

function getMaxBet(): number {
  return Math.max(getCurrentEquity() * 0.05, 2)
}

// ── Safety checks ────────────────────────────────────────────────

function checkDailyLossLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10)
  if (today !== dailyPnlDate) {
    dailyPnlDate = today
    dailyPnlStart = getCurrentEquity()
  }
  const dailyLoss = dailyPnlStart - getCurrentEquity()
  const limit = getStartBal() * 0.50
  if (dailyLoss >= limit) {
    console.log(`  🛑 DAILY LOSS LIMIT HIT: -$${dailyLoss.toFixed(2)} (limit: $${limit.toFixed(2)})`)
    logBotEvent('sports-safety', 'Daily loss limit hit', `Loss: $${dailyLoss.toFixed(2)}`)
    return true
  }
  return false
}

function checkDrawdownBreaker(): boolean {
  const equity = getCurrentEquity()
  if (equity > highWaterMark) highWaterMark = equity
  const startBal = getStartBal()
  if (highWaterMark < startBal * 1.10) return false  // must grow 10% first
  const drawdown = (highWaterMark - equity) / highWaterMark
  if (drawdown >= 0.20) {
    console.log(`  🛑 DRAWDOWN BREAKER: ${(drawdown * 100).toFixed(1)}% from HWM $${highWaterMark.toFixed(2)}`)
    logBotEvent('sports-safety', 'Drawdown breaker', `DD: ${(drawdown * 100).toFixed(1)}%`)
    return true
  }
  return false
}

// ── Pending GTC orders ───────────────────────────────────────────

async function checkPendingOrders(): Promise<void> {
  const pending = getPendingOrders()
  if (pending.length === 0) return

  for (const order of pending) {
    try {
      const result = await checkOrderStatus(order.orderId)
      if (result.status === 'filled') {
        console.log(`  ✅ GTC FILLED | ${order.side} @ ${((result.filledPrice ?? order.entryPrice) * 100).toFixed(0)}¢ | ${order.title?.slice(0, 40)}`)
        openPaperTrade({
          conditionId: order.conditionId,
          title: order.title ?? '',
          domain: order.domain,
          side: order.side,
          entryPrice: result.filledPrice ?? order.entryPrice,
          simulatedUsdc: order.simulatedUsdc,
          copiedFrom: 'sports-arb',
          copiedLabel: order.copiedLabel,
        })
        removePendingOrder(order.orderId)
        logBotEvent('sports-fill', `FILLED ${order.side} @ ${((result.filledPrice ?? order.entryPrice) * 100).toFixed(0)}¢`, order.title ?? '')
      } else if (result.status === 'cancelled') {
        console.log(`  ❌ GTC CANCELLED | ${order.title?.slice(0, 40)}`)
        removePendingOrder(order.orderId)
      } else if (result.status === 'open') {
        const age = Date.now() - new Date(order.placedAt).getTime()
        if (age > GTC_TIMEOUT_MS) {
          console.log(`  ⏰ GTC TIMEOUT | ${order.title?.slice(0, 40)}`)
          await cancelOrder(order.orderId)
          removePendingOrder(order.orderId)
        }
      }
    } catch {
      // skip
    }
  }
}

// ── Order placement ──────────────────────────────────────────────

async function tryPlaceSportsOrder(signal: SportsSignal): Promise<boolean> {
  const cash = getAvailableCash()
  if (cash < getMinBet()) return false

  // Kelly sizing
  const baseBet = Math.max(
    Math.min(getCurrentEquity() * signal.kellyFraction, getMaxBet()),
    getMinBet()
  )

  // Signal multiplier: high score = bigger bet
  const signalMulti = signal.signalScore >= 80 ? 1.5 : 1.0
  let betAmount = Math.min(baseBet * signalMulti, getMaxBet())

  // Cap at 30% of available cash
  betAmount = Math.min(betAmount, cash * 0.30)

  // Ensure minimum order size
  const entryPrice = signal.polymarketPrice
  const minUsdc = POLY_MIN_ORDER_SHARES * entryPrice
  if (betAmount < minUsdc) betAmount = minUsdc
  if (betAmount > cash * 0.95) return false

  // Round to 2 decimals
  betAmount = Math.round(betAmount * 100) / 100

  const tokenId = signal.side === 'YES' ? signal.yesTokenId : signal.noTokenId
  const orderPrice = Math.min(entryPrice + 0.05, MAX_ENTRY)  // 5c buffer

  const domainTag = `[${signal.sport}]`
  const edgeTag = `edge:+${(signal.edge * 100).toFixed(1)}pts`
  const kellyTag = `kelly:${(signal.kellyFraction * 100).toFixed(1)}%`

  if (DRY_RUN) {
    console.log(`  🏜️  DRY-RUN | ${signal.side} @ ${(entryPrice * 100).toFixed(0)}¢ | $${betAmount.toFixed(2)} | ${edgeTag} | ${kellyTag} | ${signal.title.slice(0, 45)} ${domainTag}`)
    // Still open paper trade for tracking
    openPaperTrade({
      conditionId: signal.conditionId,
      title: signal.title,
      domain: 'pm-domain/sports',
      side: signal.side,
      entryPrice: orderPrice,
      simulatedUsdc: betAmount,
      copiedFrom: 'sports-arb',
      copiedLabel: `[SPORTS] ${signal.sport}`,
    })
    logBotEvent('sports-dry', `${signal.side} @ ${(entryPrice * 100).toFixed(0)}¢ $${betAmount.toFixed(2)}`, `${edgeTag} | ${signal.title.slice(0, 60)}`)
    return true
  }

  // Live order
  try {
    const order: RealOrder = {
      conditionId: signal.conditionId,
      tokenId,
      title: signal.title,
      side: signal.side,
      price: Math.round(orderPrice * 100) / 100,
      sizeUsdc: betAmount,
      orderType: 'GTC',
      negRisk: true,  // always true for sports
    }

    const result = await placeOrder(order)

    if (result.filledPrice) {
      console.log(`  ⚡ FILLED | ${signal.side} @ ${(result.filledPrice * 100).toFixed(0)}¢ | $${betAmount.toFixed(2)} | ${edgeTag} | ${signal.title.slice(0, 40)} ${domainTag}`)
      openPaperTrade({
        conditionId: signal.conditionId,
        title: signal.title,
        domain: 'pm-domain/sports',
        side: signal.side,
        entryPrice: result.filledPrice,
        simulatedUsdc: betAmount,
        copiedFrom: 'sports-arb',
        copiedLabel: `[SPORTS] ${signal.sport}`,
      })
      subscribeToken(tokenId)
      logBotEvent('sports-fill', `FILLED ${signal.side} @ ${(result.filledPrice * 100).toFixed(0)}¢ $${betAmount.toFixed(2)}`, `${edgeTag} | ${signal.title.slice(0, 60)}`)
      return true
    } else if (result.orderId) {
      console.log(`  📋 GTC PLACED | ${signal.side} @ ${(orderPrice * 100).toFixed(0)}¢ | $${betAmount.toFixed(2)} | ${edgeTag} | ${signal.title.slice(0, 40)} ${domainTag}`)
      savePendingOrder({
        orderId: result.orderId,
        conditionId: signal.conditionId,
        title: signal.title,
        domain: 'pm-domain/sports',
        side: signal.side,
        entryPrice: orderPrice,
        simulatedUsdc: betAmount,
        copiedFrom: 'sports-arb',
        copiedLabel: `[SPORTS] ${signal.sport}`,
        placedAt: new Date().toISOString(),
      })
      subscribeToken(tokenId)
      return true
    } else {
      console.log(`  ⚠️  ORDER FAILED | ${signal.title.slice(0, 40)} | ${result.error ?? 'unknown'}`)
      return false
    }
  } catch (err) {
    console.log(`  ❌ ORDER ERROR | ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

// ── Exit strategy ────────────────────────────────────────────────

async function runExitStrategy(): Promise<void> {
  const openTrades = getOpenSportsTrades()
  if (openTrades.length === 0) return

  for (const trade of openTrades) {
    const decision = evaluateExit(trade, EXIT_CONFIG, false) // no expert to follow
    if (!decision.shouldExit) continue

    const emoji = exitEmoji(decision.reason)
    const sharesRemaining = trade.sharesRemaining ?? trade.shares
    const curPrice = trade.curPrice ?? trade.entryPrice

    if (decision.reason.startsWith('partial-exit')) {
      const fraction = decision.partialFraction ?? 0.5
      const sharesToSell = sharesRemaining * fraction
      if (sharesToSell < POLY_MIN_SELL_SHARES) continue

      console.log(`  ${emoji} PARTIAL | ${decision.reason} | ${trade.title.slice(0, 40)}`)

      if (!DRY_RUN) {
        try {
          const meta = await fetchMarketMetadata(trade.conditionId)
          if (!meta) continue
          const tokenId = trade.side === 'YES' ? meta.yesTokenId : meta.noTokenId
          await closePosition(tokenId, sharesToSell, curPrice, meta.negRisk)
        } catch {
          continue
        }
      }

      partialExitPaperTrade(trade.conditionId, fraction, curPrice)
      logBotEvent('sports-exit', `${decision.reason} @ ${(curPrice * 100).toFixed(0)}¢`, trade.title)
    } else {
      // Full exit
      console.log(`  ${emoji} EXIT | ${decision.message} | ${trade.title.slice(0, 40)}`)

      if (!DRY_RUN && sharesRemaining >= POLY_MIN_SELL_SHARES) {
        try {
          const meta = await fetchMarketMetadata(trade.conditionId)
          if (meta) {
            const tokenId = trade.side === 'YES' ? meta.yesTokenId : meta.noTokenId
            await closePosition(tokenId, sharesRemaining, curPrice, meta.negRisk)
            unsubscribeToken(tokenId)
          }
        } catch {
          // continue with paper resolution
        }
      }

      resolvePaperTrade(trade.conditionId, curPrice)
      logBotEvent('sports-exit', `${decision.reason} @ ${(curPrice * 100).toFixed(0)}¢ | PnL: ${trade.pnl?.toFixed(2) ?? '?'}`, trade.title)
    }
  }
}

// ── Price refresh ────────────────────────────────────────────────

function refreshPricesFromWs(): void {
  const openTrades = getOpenSportsTrades()
  for (const trade of openTrades) {
    const meta = getActiveSportsMarkets().find((m) => m.conditionId === trade.conditionId)
    if (!meta) continue

    const tokenId = trade.side === 'YES' ? meta.yesTokenId : meta.noTokenId
    if (!tokenId) continue

    const wsBid = getWsBestBid(tokenId)
    if (wsBid && wsBid > 0) {
      updatePaperTradePrice(trade.conditionId, wsBid)
    }
  }
}

// ── Market scan ──────────────────────────────────────────────────

async function scanMarkets(): Promise<void> {
  const time = new Date().toISOString().slice(11, 19)
  console.log(`\n[${time}] 🏟️  SCANNING sports markets...`)

  try {
    const discovered = await scanSportsMarkets()
    let detectedKeys = getActiveSportKeys(discovered)

    // Filter by allowed sports (if configured)
    if (ALLOWED_SPORTS.length > 0) {
      detectedKeys = detectedKeys.filter((k) => ALLOWED_SPORTS.includes(k))
    }

    // Cap to MAX_SPORTS
    activeSportKeys = detectedKeys.slice(0, MAX_SPORTS)

    console.log(`  Found ${discovered.length} sports markets | Active: ${activeSportKeys.join(', ') || 'none'}`)

    // Subscribe WS for all active markets
    for (const market of discovered) {
      if (market.yesTokenId) subscribeToken(market.yesTokenId)
    }
  } catch (err) {
    console.log(`  ❌ Scan error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Resolve completed ────────────────────────────────────────────

function resolveCompletedTrades(): void {
  const openTrades = getOpenSportsTrades()
  for (const trade of openTrades) {
    const price = trade.curPrice ?? trade.entryPrice
    if (price >= 0.95 || price <= 0.05) {
      console.log(`  🏁 RESOLVED | ${price >= 0.95 ? 'YES' : 'NO'} won | ${trade.title.slice(0, 45)}`)
      resolvePaperTrade(trade.conditionId, price)
      logBotEvent('sports-resolve', `Resolved @ ${(price * 100).toFixed(0)}¢`, trade.title)
    }
  }
}

// ── Stats ────────────────────────────────────────────────────────

function printStats(): void {
  const startBal = getStartBal()
  const allTrades = getAllPaperTrades().filter((t) => t.copiedLabel?.startsWith('[SPORTS]'))
  const resolved = allTrades.filter((t) => t.status !== 'open')
  const won = resolved.filter((t) => t.status === 'won').length
  const lost = resolved.filter((t) => t.status === 'lost').length
  const realizedPnl = resolved.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const openTrades = allTrades.filter((t) => t.status === 'open')
  const invested = openTrades.reduce((s, t) => s + t.simulatedUsdc, 0)
  const unrealizedPnl = openTrades.reduce((s, t) => {
    const shares = t.sharesRemaining ?? t.shares
    const cur = t.curPrice ?? t.entryPrice
    return s + (shares * cur * 0.98 - t.simulatedUsdc * (shares / t.shares))
  }, 0)
  const cash = startBal + realizedPnl - invested
  const wr = won + lost > 0 ? ((won / (won + lost)) * 100).toFixed(0) : '0'
  const mode = DRY_RUN ? '🏜️ DRY-RUN' : '🏟️ LIVE'
  const apiRemaining = getRequestsRemaining()

  console.log(`  ┌─────────────────────────────────────┐`)
  console.log(`  │ ${mode} SPORTS ARB                    │`)
  console.log(`  │ Balance:  $${(startBal + realizedPnl).toFixed(2).padStart(10)}  (start: $${startBal})`)
  console.log(`  │ Realized: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2).padStart(10)}`)
  console.log(`  │ Unreal:   ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2).padStart(10)}`)
  console.log(`  │ Cash:     $${cash.toFixed(2).padStart(10)}`)
  console.log(`  │ Open:     ${openTrades.length.toString().padStart(10)}  trades`)
  console.log(`  │ Win Rate: ${wr.padStart(9)}%  (${won}W / ${lost}L)`)
  console.log(`  │ Sports:   ${activeSportKeys.length.toString().padStart(10)}  active leagues`)
  console.log(`  │ WS:      ${isWsConnected() ? '🟢' : '🔴'} market | ${isUserWsConnected() ? '🟢' : '🔴'} user  (${getSubscribedCount()} tokens)`)
  if (apiRemaining >= 0) {
    console.log(`  │ API:     ${apiRemaining.toString().padStart(10)}  requests remaining`)
  }
  console.log(`  └─────────────────────────────────────┘`)
}

// ── Poll loop ────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const time = new Date().toISOString().slice(11, 19)

  // Safety
  if (checkDailyLossLimit()) return
  if (checkDrawdownBreaker()) return

  // Check pending GTC
  if (!DRY_RUN) await checkPendingOrders()

  console.log(`[${time}] 🏟️  ${DRY_RUN ? 'DRY-RUN' : 'LIVE'} | Polling ${activeSportKeys.length} sports...`)

  // Fetch bookmaker odds for active sports
  const allNoVigGames: NoVigGame[] = []
  for (const sportKey of activeSportKeys) {
    try {
      const games = await getNoVigConsensus(sportKey, ODDS_API_KEY)
      allNoVigGames.push(...games)
    } catch (err) {
      console.log(`  ⚠️  Odds error for ${sportKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Refresh Polymarket prices via WS
  refreshPricesFromWs()

  // Also update prices from Gamma scan data
  const sportsMarkets = getActiveSportsMarkets()

  // Generate signals
  const signals = generateSportsSignals(sportsMarkets, allNoVigGames)
  const ranked = rankSignals(signals)

  const openCount = getOpenSportsTrades().length
  let copied = 0

  if (ranked.length > 0) {
    console.log(`  📊 ${ranked.length} signals | top: ${ranked[0].side} ${(ranked[0].edge * 100).toFixed(1)}pts edge @ ${(ranked[0].polymarketPrice * 100).toFixed(0)}¢ | ${ranked[0].title.slice(0, 35)}`)
  }

  // Log top signals
  for (const signal of ranked.slice(0, 5)) {
    console.log(`  🔔 ${signal.side} @ ${(signal.polymarketPrice * 100).toFixed(0)}¢ | edge:+${(signal.edge * 100).toFixed(1)}pts | score:${signal.signalScore} | ${signal.title.slice(0, 45)}`)
  }

  // Place orders
  for (const signal of ranked) {
    if (signal.signalScore < MIN_SIGNAL_SCORE) continue
    if (paperTradeExistsForCondition(signal.conditionId)) continue
    if (openCount + copied >= MAX_OPEN) break

    const success = await tryPlaceSportsOrder(signal)
    if (success) copied++
  }

  // Manage exits
  runExitStrategy()
  resolveCompletedTrades()

  console.log(`  → ${allNoVigGames.length} games | ${ranked.length} signals | ${copied} copied | ${openCount} open`)
  printStats()
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════')
  console.log(`  🏟️  SPORTS ARBITRAGE TRADER`)
  console.log('═══════════════════════════════════════════════')

  // Validate API key
  if (!ODDS_API_KEY) {
    console.log('❌ ODDS_API_KEY is required. Get one at https://the-odds-api.com/')
    process.exit(1)
  }

  // Init portfolio
  const existing = getPortfolioSetting('starting_balance', '')
  if (!existing) {
    const startBal = process.env.STARTING_BALANCE ?? '50'
    setPortfolioSetting('starting_balance', startBal)
    console.log(`  Init starting balance: $${startBal}`)
  }

  const startBal = getStartBal()
  highWaterMark = getCurrentEquity()

  console.log(`  Mode:        ${DRY_RUN ? '🏜️ DRY-RUN' : '🏟️ LIVE'}`)
  console.log(`  Bankroll:    $${startBal}`)
  console.log(`  Poll:        ${POLL_INTERVAL_MS / 1000}s`)
  console.log(`  Scan:        ${SCAN_INTERVAL_MS / 60000}min`)
  console.log(`  Max open:    ${MAX_OPEN}`)
  console.log(`  Max sports:  ${MAX_SPORTS}`)
  console.log(`  Sports:      ${ALLOWED_SPORTS.length > 0 ? ALLOWED_SPORTS.join(', ') : 'all'}`)
  console.log(`  Min score:   ${MIN_SIGNAL_SCORE}`)
  console.log(`  Stop-loss:   -${(EXIT_CONFIG.stopLossPct * 100).toFixed(0)}%`)
  console.log(`  Stale exit:  ${EXIT_CONFIG.staleDays}d`)
  console.log('═══════════════════════════════════════════════\n')

  // Connect WebSockets (for price tracking + fill notifications)
  if (!DRY_RUN) {
    try {
      const balance = await getRealBalance()
      console.log(`  On-chain balance: $${balance.toFixed(2)}`)
      if (balance < 0.10) {
        console.log('❌ Insufficient balance')
        process.exit(1)
      }
    } catch (err) {
      console.log(`  ⚠️  Balance check failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  connectOrderbookWS()
  if (!DRY_RUN) {
    const apiKey = process.env.POLYMARKET_API_KEY ?? ''
    const secret = process.env.POLYMARKET_API_SECRET ?? ''
    const passphrase = process.env.POLYMARKET_API_PASSPHRASE ?? ''
    if (apiKey && secret && passphrase) {
      connectUserWS(
        { apiKey, secret, passphrase },
        // onFill callback
        (orderId: string, filledPrice: number, _filledSize: number) => {
          const pending = getPendingOrders().find((p) => p.orderId === orderId)
          if (!pending) return
          console.log(`  ⚡ [WS-FILL] ${pending.side} @ ${(filledPrice * 100).toFixed(0)}¢ | ${pending.title?.slice(0, 40)}`)
          openPaperTrade({
            conditionId: pending.conditionId,
            title: pending.title ?? '',
            domain: pending.domain,
            side: pending.side,
            entryPrice: filledPrice,
            simulatedUsdc: pending.simulatedUsdc,
            copiedFrom: 'sports-arb',
            copiedLabel: pending.copiedLabel,
          })
          removePendingOrder(orderId)
        },
        // onCancel callback
        (orderId: string) => {
          removePendingOrder(orderId)
        }
      )
    }
  }

  // Subscribe existing open positions to WS
  const openTrades = getOpenSportsTrades()
  for (const trade of openTrades) {
    const meta = await fetchMarketMetadata(trade.conditionId)
    if (meta) {
      const tokenId = trade.side === 'YES' ? meta.yesTokenId : meta.noTokenId
      subscribeToken(tokenId)
    }
  }

  // Initial market scan
  await scanMarkets()

  // Initial stats
  printStats()

  // First poll
  console.log('\nStarting first poll...\n')
  await pollOnce()

  // Schedule recurring
  setInterval(() => { pollOnce().catch(console.error) }, POLL_INTERVAL_MS)
  setInterval(() => { scanMarkets().catch(console.error) }, SCAN_INTERVAL_MS)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
