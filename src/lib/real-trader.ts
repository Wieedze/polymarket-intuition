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
  negRisk?: boolean    // true for sports markets (neg_risk on Polymarket)
}

type RealOrderResult = {
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

// ── Orderbook price fetch ────────────────────────────────────────

/**
 * Fetch the current best ask price from the CLOB orderbook.
 * Returns the lowest price at which someone is willing to sell.
 * This is the price we should use for FOK orders (instant fill).
 */
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

    // Calculate size in shares (round to 2 decimals — CLOB requirement)
    // sizeUsdc = shares × price → shares = sizeUsdc / price
    const size = parseFloat((order.sizeUsdc / order.price).toFixed(2))

    // Get tick size for this market (minimum 0.01 for most markets)
    const marketInfo = await client.getMarket(order.conditionId) as Record<string, unknown>
    const rawTickSize = parseFloat((marketInfo?.minimum_tick_size as string) ?? '0.01')
    const tick = Math.max(rawTickSize, 0.01)
    const tickSize = tick.toString()

    // Round price to tick size
    const roundedPrice = Math.round(order.price / tick) * tick
    // Avoid floating point issues: ensure clean decimal
    const cleanPrice = parseFloat(roundedPrice.toFixed(2))

    const orderType = order.orderType === 'FOK'
      ? OrderType.FOK
      : order.orderType === 'GTD'
      ? OrderType.GTD
      : OrderType.GTC

    // Entry orders are always BUY — tokenId determines YES vs NO
    const side = Side.BUY

    const result = await client.createAndPostOrder(
      {
        tokenID: order.tokenId,
        price: cleanPrice,
        size,
        side,
      },
      { tickSize, negRisk: order.negRisk ?? false },
      orderType
    ) as Record<string, unknown>

    // Parse response
    const orderInfo = result as {
      orderID?: string
      success?: boolean
      status?: string
      successOrdering?: boolean
      transactionsHashes?: string[]
      errorMsg?: string
      error?: string
    }

    // GTC: status='live' = order placed in orderbook (success, not yet filled)
    // FOK: status='matched' = order filled immediately (success)
    // Both: successOrdering=true or orderID present = success
    const isSuccess = !!(
      orderInfo.successOrdering ||
      orderInfo.success ||
      orderInfo.orderID ||
      orderInfo.status === 'live' ||
      orderInfo.status === 'matched'
    )

    if (isSuccess) {
      const filled = orderInfo.status === 'matched'
      return {
        success: true,
        orderId: orderInfo.orderID,
        filledSize: filled ? size : undefined,
        filledPrice: filled ? cleanPrice : undefined,
        transactionHash: orderInfo.transactionsHashes?.[0],
      }
    }

    // Truly rejected — show the real error
    const errorMsg = orderInfo.errorMsg || orderInfo.error || JSON.stringify(result)
    return {
      success: false,
      error: errorMsg,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Check if a GTC order has been filled, is still open, or was cancelled.
 * Returns 'filled' | 'open' | 'cancelled' | 'unknown'
 */
export async function checkOrderStatus(orderId: string): Promise<{
  status: 'filled' | 'open' | 'cancelled' | 'unknown'
  filledSize?: number
  filledPrice?: number
}> {
  try {
    const client = await getClient()
    const order = await client.getOrder(orderId) as Record<string, unknown>

    if (!order) return { status: 'unknown' }

    const st = order.status as string ?? ''
    if (st === 'MATCHED' || st === 'matched') {
      return {
        status: 'filled',
        filledSize: Number(order.size_matched ?? order.original_size ?? 0),
        filledPrice: Number(order.price ?? 0),
      }
    }
    if (st === 'LIVE' || st === 'live') return { status: 'open' }
    if (st === 'CANCELLED' || st === 'cancelled') return { status: 'cancelled' }

    return { status: 'unknown' }
  } catch {
    return { status: 'unknown' }
  }
}

/**
 * Cancel an open GTC order.
 */
export async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    const client = await getClient()
    await client.cancelOrder(orderId)
    return true
  } catch {
    return false
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
  if (!_walletAddress) await getClient()
  if (!_walletAddress) return 0

  try {
    // Read USDC.e balance directly on-chain (not CLOB allowance)
    const { createPublicClient, http, parseAbi } = await import('viem')
    const { polygon } = await import('viem/chains')

    const publicClient = createPublicClient({
      chain: polygon,
      transport: http(POLYGON_RPC),
    })

    const balance = await publicClient.readContract({
      address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [_walletAddress as `0x${string}`],
    })

    return Number(balance) / 1e6  // USDC.e has 6 decimals
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
  curPrice: number,
  negRisk: boolean = false
): Promise<RealOrderResult> {
  try {
    const client = await getClient()
    const { OrderType, Side } = await import('@polymarket/clob-client')

    // Round price down to tick size 0.01
    const roundedPrice = parseFloat((Math.floor(curPrice * 100) / 100).toFixed(2))

    // GTC for sells — FOK is too strict, often rejected
    const result = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        size,
        side: Side.SELL,
      },
      { tickSize: '0.01', negRisk },
      OrderType.GTC
    ) as Record<string, unknown>

    const orderInfo = result as {
      success?: boolean
      successOrdering?: boolean
      errorMsg?: string
      error?: string
      orderID?: string
      status?: string
    }

    const success = !!(orderInfo.success || orderInfo.successOrdering || orderInfo.orderID)
    const error = orderInfo.errorMsg || orderInfo.error || (!success ? JSON.stringify(result) : undefined)

    return {
      success,
      orderId: orderInfo.orderID,
      error,
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Redeem resolved positions — claim winning conditional tokens for USDC.
 *
 * When a market resolves, the CLOB orderbook closes. You can't sell anymore.
 * Instead, call redeemPositions() on the CTF contract to get $1 per winning share.
 *
 * Returns list of { conditionId, exitPrice } — only after on-chain tx confirmed.
 */
export async function redeemAllResolved(): Promise<Array<{ conditionId: string; exitPrice: number }>> {
  if (!_walletAddress) await getClient()
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
      curPrice: number
      negativeRisk: boolean
    }>

    // Resolved = price > 95¢ (winner) or < 5¢ (loser)
    const resolved = positions.filter(p => p.size > 0 && (p.curPrice > 0.95 || p.curPrice < 0.05))
    if (resolved.length === 0) return []

    const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const { polygon } = await import('viem/chains')

    const privateKey = process.env.POLYMARKET_PRIVATE_KEY
    if (!privateKey) return []

    const account = privateKeyToAccount(privateKey as `0x${string}`)
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(POLYGON_RPC),
    })
    const publicClient = createPublicClient({
      chain: polygon,
      transport: http(POLYGON_RPC),
    })

    const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`
    const NEG_RISK_ADAPTER = '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`
    const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`

    const ctfAbi = parseAbi([
      'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
    ])
    const negRiskAbi = parseAbi([
      'function redeemPositions(bytes32 conditionId, uint256[] indexSets) external',
    ])

    const redeemed: Array<{ conditionId: string; exitPrice: number }> = []

    for (const pos of resolved) {
      try {
        const indexSets = [1n, 2n]
        const conditionIdBytes = pos.conditionId as `0x${string}`

        // On-chain redemption FIRST — only update DB after tx confirmed
        if (pos.negativeRisk) {
          const hash = await walletClient.writeContract({
            address: NEG_RISK_ADAPTER,
            abi: negRiskAbi,
            functionName: 'redeemPositions',
            args: [conditionIdBytes, indexSets],
          })
          await publicClient.waitForTransactionReceipt({ hash })
        } else {
          const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
          const hash = await walletClient.writeContract({
            address: CTF_ADDRESS,
            abi: ctfAbi,
            functionName: 'redeemPositions',
            args: [USDC_E, parentCollectionId, conditionIdBytes, indexSets],
          })
          await publicClient.waitForTransactionReceipt({ hash })
        }

        // On-chain tx confirmed — now safe to report
        const exitPrice = pos.curPrice > 0.95 ? 1.0 : 0.0
        const status = exitPrice > 0 ? 'WON' : 'LOST'
        const value = (pos.size * exitPrice).toFixed(2)
        console.log(`  💰 REDEEMED | ${status} | ${pos.size.toFixed(1)} shares → $${value} | ${pos.title.slice(0, 50)}`)
        redeemed.push({ conditionId: pos.conditionId, exitPrice })
      } catch (err) {
        console.log(`  ⚠️  REDEEM FAILED | ${pos.title.slice(0, 40)} | ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return redeemed
  } catch {
    return []
  }
}
