/**
 * Real Trader — Live order execution on Polymarket CLOB
 *
 * Wraps @polymarket/clob-client to place actual orders.
 * Used by scripts/live-trader.ts — NOT by auto-trader.ts (paper only).
 *
 * Required env vars:
 *   POLYMARKET_PRIVATE_KEY  — hex private key of your dedicated trading wallet
 *   POLYMARKET_API_KEY      — derived from wallet (run initCreds() once)
 *   POLYMARKET_API_SECRET   — derived from wallet
 *   POLYMARKET_API_PASSPHRASE — derived from wallet
 *
 * Setup (run once):
 *   npx tsx scripts/init-polymarket-creds.ts
 */

// ── Types ─────────────────────────────────────────────────────────

export type RealOrder = {
  conditionId: string
  tokenId: string      // YES or NO token ID from Polymarket
  title: string
  side: 'YES' | 'NO'
  price: number        // entry price (0-1)
  sizeUsdc: number     // amount in USDC to spend
  orderType: 'FOK' | 'GTC' | 'GTD'
}

export type RealOrderResult = {
  success: boolean
  orderId?: string
  filledSize?: number
  filledPrice?: number
  transactionHash?: string
  error?: string
}

export type RealPosition = {
  conditionId: string
  tokenId: string
  title: string
  side: 'YES' | 'NO'
  size: number         // shares held
  avgPrice: number
  curPrice: number
  unrealizedPnl: number
}

// ── Config ────────────────────────────────────────────────────────

const CLOB_HOST = 'https://clob.polymarket.com'
const CHAIN_ID = 137  // Polygon mainnet

// ── Client initialization ─────────────────────────────────────────

/**
 * Lazy-loaded CLOB client — initialized on first use.
 * Requires @polymarket/clob-client installed.
 */
let _client: unknown = null

async function getClient() {
  if (_client) return _client

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  if (!privateKey) throw new Error('POLYMARKET_PRIVATE_KEY not set in .env')

  const apiKey = process.env.POLYMARKET_API_KEY
  const apiSecret = process.env.POLYMARKET_API_SECRET
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE

  // Dynamic import — only loaded when live trading is active
  const { ClobClient } = await import('@polymarket/clob-client')
  const { ethers } = await import('ethers')

  const wallet = new ethers.Wallet(privateKey)

  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error(
      'Missing POLYMARKET_API_KEY/SECRET/PASSPHRASE.\n' +
      'Run: npx tsx scripts/init-polymarket-creds.ts to generate them.'
    )
  }

  _client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    wallet,
    { key: apiKey, secret: apiSecret, passPhrase: apiPassphrase }
  )

  return _client
}

// ── Core trading functions ────────────────────────────────────────

/**
 * Place a real order on Polymarket CLOB.
 *
 * Uses FOK (Fill or Kill) by default — if not immediately filled, cancels.
 * This avoids leaving open limit orders that could fill at bad prices later.
 */
export async function placeOrder(order: RealOrder): Promise<RealOrderResult> {
  try {
    const client = await getClient() as Record<string, Function>

    const { OrderType, Side } = await import('@polymarket/clob-client')

    // Calculate size in shares
    // sizeUsdc = shares × price → shares = sizeUsdc / price
    const size = order.sizeUsdc / order.price

    // Get tick size for this market (needed to round price correctly)
    const marketInfo = await client.getMarket(order.conditionId) as Record<string, unknown>
    const tickSize = (marketInfo?.minimumTickSize as string) ?? '0.01'

    // Round price to tick size
    const tick = parseFloat(tickSize)
    const roundedPrice = Math.round(order.price / tick) * tick

    const orderType = order.orderType === 'FOK'
      ? OrderType.FOK
      : order.orderType === 'GTD'
      ? OrderType.GTD
      : OrderType.GTC

    const side = order.side === 'YES' ? Side.BUY : Side.BUY
    // Note: on Polymarket, you always BUY the token you want
    // YES token = buy YES shares | NO token = buy NO shares
    // The tokenId determines YES vs NO, not the side

    const result = await client.createAndPostOrder(
      {
        tokenID: order.tokenId,
        price: roundedPrice,
        size,
        side,
      },
      { tickSize, negRisk: false },
      orderType
    ) as Record<string, unknown>

    // Parse response
    const orderInfo = result as {
      orderID?: string
      status?: string
      successOrdering?: boolean
      transactionsHashes?: string[]
      errorMsg?: string
    }

    if (orderInfo.successOrdering || orderInfo.status === 'matched') {
      return {
        success: true,
        orderId: orderInfo.orderID,
        filledSize: size,
        filledPrice: roundedPrice,
        transactionHash: orderInfo.transactionsHashes?.[0],
      }
    }

    return {
      success: false,
      error: orderInfo.errorMsg ?? 'Order not filled (FOK rejected)',
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Get real open positions for our trading wallet.
 */
export async function getRealPositions(): Promise<RealPosition[]> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  if (!privateKey) return []

  try {
    const { ethers } = await import('ethers')
    const wallet = new ethers.Wallet(privateKey)
    const address = wallet.address.toLowerCase()

    const res = await fetch(
      `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0`
    )
    if (!res.ok) return []

    const positions = await res.json() as Array<{
      conditionId: string
      outcomeIndex: number
      title: string
      size: number
      avgPrice: number
      curPrice: number
      cashPnl: number
    }>

    return positions
      .filter((p) => p.size > 0 && p.curPrice >= 0.05 && p.curPrice <= 0.95)
      .map((p) => ({
        conditionId: p.conditionId,
        tokenId: p.conditionId,  // simplified — real tokenId differs
        title: p.title,
        side: p.outcomeIndex === 0 ? 'YES' : 'NO',
        size: p.size,
        avgPrice: p.avgPrice,
        curPrice: p.curPrice,
        unrealizedPnl: p.cashPnl,
      }))
  } catch {
    return []
  }
}

/**
 * Get real wallet balance (USDC on Polygon).
 */
export async function getRealBalance(): Promise<number> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  if (!privateKey) return 0

  try {
    const client = await getClient() as Record<string, Function>
    const balance = await client.getBalanceAllowance({
      asset_type: 'COLLATERAL',
    }) as { balance: string }
    return parseFloat(balance.balance ?? '0')
  } catch {
    return 0
  }
}

/**
 * Resolve/cancel an open position by selling shares back.
 * On Polymarket you "sell" by placing a sell order at current price.
 */
export async function closePosition(
  tokenId: string,
  size: number,
  curPrice: number
): Promise<RealOrderResult> {
  try {
    const client = await getClient() as Record<string, Function>
    const { OrderType, Side } = await import('@polymarket/clob-client')

    const result = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: curPrice,
        size,
        side: Side.SELL,
      },
      { tickSize: '0.01', negRisk: false },
      OrderType.FOK
    ) as Record<string, unknown>

    const orderInfo = result as { successOrdering?: boolean; errorMsg?: string; orderID?: string }

    return {
      success: !!orderInfo.successOrdering,
      orderId: orderInfo.orderID,
      error: orderInfo.errorMsg,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
