/**
 * Orderbook WebSocket — Real-time best bid/ask from Polymarket CLOB
 *
 * Subscribes to specific token IDs and maintains a live price cache.
 * Used by live-trader.ts for instant entry/exit price lookups.
 *
 * Protocol: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * Subscribe with: { assets_ids: [tokenId], type: "market", custom_feature_enabled: true }
 * Receives: book, price_change, best_bid_ask events
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

// ── State ─────────────────────────────────────────────────────────

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const STALE_MS = 120_000  // 2 min — price considered stale after this

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 1000  // starts at 1s, doubles up to 30s
let isConnecting = false

const priceCache = new Map<string, PriceEntry>()
const subscribedTokens = new Set<string>()

// ── Public API ────────────────────────────────────────────────────

export function connectOrderbookWS(): void {
  if (ws || isConnecting) return
  isConnecting = true
  _connect()
}

export function disconnectOrderbookWS(): void {
  subscribedTokens.clear()
  priceCache.clear()
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (ws) {
    ws.close()
    ws = null
  }
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
 * Get real-time best ask (buy price). Returns null if no WS data or stale.
 */
export function getWsBestAsk(tokenId: string): number | null {
  const entry = priceCache.get(tokenId)
  if (!entry) return null
  if (Date.now() - entry.updatedAt > STALE_MS) return null
  return entry.bestAsk > 0 ? entry.bestAsk : null
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

export function getSubscribedCount(): number {
  return subscribedTokens.size
}

export function isWsConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

// ── Internal ──────────────────────────────────────────────────────

function _connect(): void {
  try {
    ws = new WebSocket(WS_URL)

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

function _handleMessage(msg: WsEvent): void {
  switch (msg.event_type) {
    case 'book': {
      const e = msg as BookEvent
      const bestBid = e.bids.length > 0
        ? Math.max(...e.bids.map(b => parseFloat(b.price)))
        : 0
      const bestAsk = e.asks.length > 0
        ? Math.min(...e.asks.map(a => parseFloat(a.price)))
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
          bestBid: pc.best_bid ? parseFloat(pc.best_bid) : (existing?.bestBid ?? 0),
          bestAsk: pc.best_ask ? parseFloat(pc.best_ask) : (existing?.bestAsk ?? 0),
          updatedAt: Date.now(),
        })
      }
      break
    }

    case 'best_bid_ask': {
      const e = msg as BestBidAskEvent
      priceCache.set(e.asset_id, {
        bestBid: parseFloat(e.best_bid),
        bestAsk: parseFloat(e.best_ask),
        updatedAt: Date.now(),
      })
      break
    }
  }
}
