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
let _walletAddress: string = ''

const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'

async function getClient(): Promise<Record<string, Function>> {
  if (_client) return _client as Record<string, Function>

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  if (!privateKey) throw new Error('POLYMARKET_PRIVATE_KEY not set in .env')

  const apiKey = process.env.POLYMARKET_API_KEY
  const apiSecret = process.env.POLYMARKET_API_SECRET
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE

  if (!apiKey || !apiSecret) {
    throw new Error(
      'Missing POLYMARKET_API_KEY/SECRET.\n' +
      'Run: export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/init-polymarket-creds.ts'
    )
  }

  const { ClobClient } = await import('@polymarket/clob-client')
  const { createWalletClient, http } = await import('viem')
  const { privateKeyToAccount } = await import('viem/accounts')
  const { polygon } = await import('viem/chains')

  const account = privateKeyToAccount(privateKey as `0x${string}`)
  _walletAddress = account.address

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http(POLYGON_RPC),
  })

  _client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    walletClient as never,
    { key: apiKey, secret: apiSecret, passphrase: apiPassphrase ?? '' }
  )

  return _client as Record<string, Function>
}

export function getWalletAddress(): string {
  return _walletAddress
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
    const client = await getClient()

    const { OrderType, Side } = await import('@polymarket/clob-client')

    // Calculate size in shares
    // sizeUsdc = shares × price → shares = sizeUsdc / price
    const size = order.sizeUsdc / order.price

    // Get tick size for this market
    const marketInfo = await client.getMarket(order.conditionId) as Record<string, unknown>
    const tickSize = (marketInfo?.minimum_tick_size as string) ?? '0.01'

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
  if (!_walletAddress) {
    // Initialize client to get wallet address
    await getClient()
  }
  if (!_walletAddress) return []

  try {
    const address = _walletAddress.toLowerCase()

    const res = await fetch(
      `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0`
    )
    if (!res.ok) return []

    const positions = await res.json() as Array<{
      conditionId: string
      asset: string
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
        tokenId: p.asset ?? p.conditionId,  // asset field = real CLOB token ID
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
  try {
    const client = await getClient()
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
