/**
 * Orderbook WebSocket — Real-time prices + order fill notifications
 *
 * Two WS connections:
 * 1. Market channel: best bid/ask for tokens (public, no auth)
 * 2. User channel: order fill/cancel notifications (authenticated)
 *
 * Market: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * User:   wss://ws-subscriptions-clob.polymarket.com/ws/user
 */

import WebSocket from 'ws'

// ── Types ─────────────────────────────────────────────────────────

type PriceEntry = {
  bestBid: number
  bestAsk: number
  updatedAt: number  // timestamp ms
}

type BookEvent = {
  event_type: 'book'
  asset_id: string
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
}

type PriceChangeEvent = {
  event_type: 'price_change'
  price_changes: Array<{
    asset_id: string
    best_bid: string
    best_ask: string
  }>
}

type BestBidAskEvent = {
  event_type: 'best_bid_ask'
  asset_id: string
  best_bid: string
  best_ask: string
}

type WsEvent = BookEvent | PriceChangeEvent | BestBidAskEvent | { event_type: string }

// ── User WS types (order fills) ──────────────────────────────────

type OrderFillCallback = (orderId: string, filledPrice: number, filledSize: number) => void
type OrderCancelCallback = (orderId: string) => void

type UserTradeEvent = {
  event_type: 'trade'
  id: string
  status: 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED'
  asset_id: string
  price: string
  size: string
  side: string
  trade_owner: string
  maker_orders: Array<{ matched_amount: string; order_id: string }>
}

type UserOrderEvent = {
  event_type: 'order'
  id: string
  asset_id: string
  type: 'PLACEMENT' | 'UPDATE' | 'CANCELLATION'
  price: string
  original_size: string
  size_matched: string
  order_owner: string
}

type UserWsEvent = UserTradeEvent | UserOrderEvent | { event_type: string }

// ── State ─────────────────────────────────────────────────────────

const MARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const USER_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user'
const STALE_MS = 120_000  // 2 min — price considered stale after this

// ── Market WS state ──────────────────────────────────────────────
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000
let isConnecting = false

const priceCache = new Map<string, PriceEntry>()
const subscribedTokens = new Set<string>()

// ── User WS state ────────────────────────────────────────────────
let userWs: WebSocket | null = null
let userReconnectTimer: ReturnType<typeof setTimeout> | null = null
let userReconnectDelay = 1000
let userIsConnecting = false

let _onOrderFill: OrderFillCallback | null = null
let _onOrderCancel: OrderCancelCallback | null = null
let _userAuth: { apiKey: string; secret: string; passphrase: string } | null = null
let _userMarkets: string[] = []  // conditionIds to subscribe to

// ── Public API ────────────────────────────────────────────────────

export function connectOrderbookWS(): void {
  if (ws || isConnecting) return
  isConnecting = true
  _connect()
}

export function subscribeToken(tokenId: string): void {
  if (subscribedTokens.has(tokenId)) return
  subscribedTokens.add(tokenId)
  _sendSubscription([tokenId])
}

export function unsubscribeToken(tokenId: string): void {
  subscribedTokens.delete(tokenId)
  priceCache.delete(tokenId)
}

/**
 * Get real-time best bid (sell price). Returns null if no WS data or stale.
 */
export function getWsBestBid(tokenId: string): number | null {
  const entry = priceCache.get(tokenId)
  if (!entry) return null
  if (Date.now() - entry.updatedAt > STALE_MS) return null
  return entry.bestBid > 0 ? entry.bestBid : null
}

export function getWsSpread(tokenId: string): { bid: number; ask: number; spread: number } | null {
  const entry = priceCache.get(tokenId)
  if (!entry) return null
  if (Date.now() - entry.updatedAt > STALE_MS) return null
  if (entry.bestBid <= 0 || entry.bestAsk <= 0) return null
  return { bid: entry.bestBid, ask: entry.bestAsk, spread: entry.bestAsk - entry.bestBid }
}

export function getSubscribedCount(): number {
  return subscribedTokens.size
}

export function isWsConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

// ── Internal ──────────────────────────────────────────────────────

function _connect(): void {
  try {
    ws = new WebSocket(MARKET_WS_URL)

    ws.on('open', () => {
      console.log(`  [WS] Connected to CLOB orderbook`)
      isConnecting = false
      reconnectDelay = 1000  // reset backoff

      // Re-subscribe all tokens
      if (subscribedTokens.size > 0) {
        _sendSubscription([...subscribedTokens])
      }
    })

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsEvent
        _handleMessage(msg)
      } catch {
        // Ignore parse errors
      }
    })

    ws.on('close', () => {
      ws = null
      isConnecting = false
      _scheduleReconnect()
    })

    ws.on('error', (err: Error) => {
      console.log(`  [WS] Error: ${err.message}`)
      if (ws) ws.close()
    })
  } catch {
    isConnecting = false
    _scheduleReconnect()
  }
}

function _scheduleReconnect(): void {
  if (reconnectTimer) return
  console.log(`  [WS] Reconnecting in ${(reconnectDelay / 1000).toFixed(0)}s...`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)  // max 30s
    _connect()
  }, reconnectDelay)
}

function _sendSubscription(tokenIds: string[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (tokenIds.length === 0) return

  const msg = JSON.stringify({
    assets_ids: tokenIds,
    type: 'market',
    custom_feature_enabled: true,
  })
  ws.send(msg)
  console.log(`  [WS] Subscribed to ${tokenIds.length} token(s)`)
}

function safeParseFloat(v: string): number {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
}

function _handleMessage(msg: WsEvent): void {
  switch (msg.event_type) {
    case 'book': {
      const e = msg as BookEvent
      const bestBid = e.bids.length > 0
        ? Math.max(...e.bids.map(b => safeParseFloat(b.price)))
        : 0
      const bestAsk = e.asks.length > 0
        ? Math.min(...e.asks.map(a => safeParseFloat(a.price)))
        : 0
      priceCache.set(e.asset_id, { bestBid, bestAsk, updatedAt: Date.now() })
      break
    }

    case 'price_change': {
      const e = msg as PriceChangeEvent
      for (const pc of e.price_changes) {
        if (!pc.best_bid && !pc.best_ask) continue
        const existing = priceCache.get(pc.asset_id)
        priceCache.set(pc.asset_id, {
          bestBid: pc.best_bid ? safeParseFloat(pc.best_bid) : (existing?.bestBid ?? 0),
          bestAsk: pc.best_ask ? safeParseFloat(pc.best_ask) : (existing?.bestAsk ?? 0),
          updatedAt: Date.now(),
        })
      }
      break
    }

    case 'best_bid_ask': {
      const e = msg as BestBidAskEvent
      priceCache.set(e.asset_id, {
        bestBid: safeParseFloat(e.best_bid),
        bestAsk: safeParseFloat(e.best_ask),
        updatedAt: Date.now(),
      })
      break
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ── User WS (authenticated — order fill notifications) ───────────
// ══════════════════════════════════════════════════════════════════

export function connectUserWS(
  auth: { apiKey: string; secret: string; passphrase: string },
  onFill: OrderFillCallback,
  onCancel: OrderCancelCallback
): void {
  if (userWs || userIsConnecting) return
  _userAuth = auth
  _onOrderFill = onFill
  _onOrderCancel = onCancel
  userIsConnecting = true
  _connectUser()
}

export function subscribeUserMarket(conditionId: string): void {
  if (_userMarkets.includes(conditionId)) return
  _userMarkets.push(conditionId)
  _sendUserSubscription()
}

export function isUserWsConnected(): boolean {
  return userWs !== null && userWs.readyState === WebSocket.OPEN
}


// ── User WS internal ─────────────────────────────────────────────

function _connectUser(): void {
  if (!_userAuth) return

  try {
    userWs = new WebSocket(USER_WS_URL)

    userWs.on('open', () => {
      console.log(`  [USER-WS] Connected — order notifications active`)
      userIsConnecting = false
      userReconnectDelay = 1000
      _sendUserSubscription()
    })

    userWs.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as UserWsEvent
        _handleUserMessage(msg)
      } catch {
        // Ignore parse errors
      }
    })

    userWs.on('close', () => {
      userWs = null
      userIsConnecting = false
      _scheduleUserReconnect()
    })

    userWs.on('error', (err: Error) => {
      console.log(`  [USER-WS] Error: ${err.message}`)
      if (userWs) userWs.close()
    })
  } catch {
    userIsConnecting = false
    _scheduleUserReconnect()
  }
}

function _scheduleUserReconnect(): void {
  if (userReconnectTimer) return
  userReconnectTimer = setTimeout(() => {
    userReconnectTimer = null
    userReconnectDelay = Math.min(userReconnectDelay * 2, 30_000)
    _connectUser()
  }, userReconnectDelay)
}

function _sendUserSubscription(): void {
  if (!userWs || userWs.readyState !== WebSocket.OPEN || !_userAuth) return

  const msg = JSON.stringify({
    auth: {
      apiKey: _userAuth.apiKey,
      secret: _userAuth.secret,
      passphrase: _userAuth.passphrase,
    },
    markets: _userMarkets,
    type: 'user',
  })
  userWs.send(msg)
}

function _handleUserMessage(msg: UserWsEvent): void {
  if (msg.event_type === 'trade') {
    const e = msg as UserTradeEvent
    if (e.status === 'MATCHED') {
      console.log(`  [USER-WS] ⏳ ORDER MATCHED (awaiting on-chain confirmation) | ${e.id}`)
    } else if (e.status === 'CONFIRMED' || e.status === 'MINED') {
      // Our order was confirmed on-chain
      const orderId = e.maker_orders?.[0]?.order_id ?? e.id
      const filledPrice = parseFloat(e.price)
      const filledSize = parseFloat(e.size)
      console.log(`  [USER-WS] 🎯 ORDER FILLED | ${e.side} @ ${(filledPrice * 100).toFixed(0)}¢ | ${filledSize.toFixed(2)} shares`)
      _onOrderFill?.(orderId, filledPrice, filledSize)
    } else if (e.status === 'FAILED') {
      console.log(`  [USER-WS] ❌ TRADE FAILED | ${e.id}`)
    }
  } else if (msg.event_type === 'order') {
    const e = msg as UserOrderEvent
    if (e.type === 'CANCELLATION') {
      console.log(`  [USER-WS] ⏰ ORDER CANCELLED | ${e.id}`)
      _onOrderCancel?.(e.id)
    }
  }
}
