/**
 * test-live-order.ts
 *
 * Place a REAL order on Polymarket to validate the full pipeline.
 * Uses a GTC limit order at a very low price (1-2¢) so it likely won't fill.
 * Then cancels the order immediately.
 *
 * This tests: wallet → CLOB auth → market fetch → token IDs → order creation → cancellation
 *
 * Usage:
 *   export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/test-live-order.ts
 */

import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import { fetchMarketMetadata } from '../src/lib/polymarket'

async function main(): Promise<void> {
  console.log('\n🧪 Testing LIVE order placement on Polymarket...\n')

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  const apiKey = process.env.POLYMARKET_API_KEY
  const apiSecret = process.env.POLYMARKET_API_SECRET
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE

  if (!privateKey || !apiKey || !apiSecret) {
    console.error('❌ Missing credentials. Export bot-1.env first.')
    process.exit(1)
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`)
  console.log(`Wallet: ${account.address}`)

  // ── 1. Initialize CLOB client ──
  const { ClobClient } = await import('@polymarket/clob-client')

  const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http('https://polygon-bor-rpc.publicnode.com'),
  })

  const creds = {
    key: apiKey,
    secret: apiSecret,
    passPhrase: apiPassphrase ?? '',
  }

  const client = new ClobClient(
    'https://clob.polymarket.com',
    137,
    walletClient as never,
    creds,
  )

  console.log('✅ CLOB client initialized\n')

  // ── 2. Pick a test market — large, liquid, far from resolution ──
  // "Will there be a US recession in 2026?" or similar long-running market
  // We'll find one dynamically from Gamma API
  console.log('🔍 Finding a test market...')

  const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&order=liquidityNum&ascending=false')
  const gammaMarkets = await gammaRes.json() as Array<{
    conditionId: string
    question: string
    clobTokenIds: [string, string]
    outcomePrices: [string, string]
    liquidity: string
  }>

  if (!gammaMarkets || gammaMarkets.length === 0) {
    console.error('❌ No active markets found')
    process.exit(1)
  }

  const testMarket = gammaMarkets[0]
  console.log(`   Market: "${testMarket.question}"`)
  console.log(`   Condition: ${testMarket.conditionId.slice(0, 20)}...`)
  console.log(`   YES token: ${testMarket.clobTokenIds[0].slice(0, 20)}...`)
  console.log(`   NO token: ${testMarket.clobTokenIds[1].slice(0, 20)}...`)
  console.log(`   Current prices: YES=${testMarket.outcomePrices[0]} NO=${testMarket.outcomePrices[1]}`)
  console.log(`   Liquidity: $${parseFloat(testMarket.liquidity).toFixed(0)}\n`)

  // ── 3. Also test our fetchMarketMetadata (cache layer) ──
  console.log('🔍 Testing fetchMarketMetadata (Gamma cache)...')
  const metadata = await fetchMarketMetadata(testMarket.conditionId)
  if (metadata) {
    console.log(`   ✅ Cached: YES=${metadata.yesTokenId.slice(0, 20)}... endDate=${metadata.endDate}\n`)
  } else {
    console.log('   ⚠️  fetchMarketMetadata returned null (check DB)\n')
  }

  // ── 4. Place a GTC limit order at 1¢ (won't fill, just tests the pipeline) ──
  console.log('📝 Placing test GTC order: BUY YES @ 1¢ for $1...')

  const yesTokenId = testMarket.clobTokenIds[0]

  try {
    // Get tick size from CLOB
    const marketInfo = await (client as Record<string, Function>).getMarket(testMarket.conditionId) as Record<string, unknown>
    const tickSize = (marketInfo?.minimum_tick_size as string) ?? '0.01'
    console.log(`   Tick size: ${tickSize}`)

    const { OrderType, Side } = await import('@polymarket/clob-client')

    // Create order: BUY 100 YES shares @ $0.01 each = $1 total
    const orderPayload = {
      tokenID: yesTokenId,
      price: 0.02,  // 2¢ — very unlikely to fill on a liquid market
      size: 50,     // 50 shares × $0.02 = $1 total
      side: Side.BUY,
    }

    console.log(`   Payload: ${JSON.stringify({ ...orderPayload, tokenID: orderPayload.tokenID.slice(0, 20) + '...' })}`)

    const result = await (client as Record<string, Function>).createAndPostOrder(
      orderPayload,
      { tickSize, negRisk: false },
      OrderType.GTC,
    ) as Record<string, unknown>

    console.log(`   Response:`, JSON.stringify(result, null, 2))

    if (result.orderID || result.success || result.orderIds) {
      const orderId = (result.orderID ?? (result.orderIds as string[])?.[0]) as string
      console.log(`\n✅ ORDER PLACED! orderId: ${orderId}`)

      // ── 5. Cancel the order immediately ──
      if (orderId) {
        console.log('\n🗑️  Cancelling test order...')
        try {
          const cancelResult = await (client as Record<string, Function>).cancelOrder(orderId)
          console.log(`   ✅ Cancelled:`, JSON.stringify(cancelResult))
        } catch (cancelErr) {
          console.log(`   ⚠️  Cancel failed (order may have expired): ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`)
        }
      }
    } else {
      console.log('\n⚠️  Order might not have been placed. Check response above.')
    }

  } catch (err) {
    console.error(`\n❌ Order failed:`, err instanceof Error ? err.message : String(err))
    if (err instanceof Error && err.message.includes('not enough balance')) {
      console.error('   → Your USDC.e needs to be deposited into Polymarket first')
      console.error('   → Go to polymarket.com with this wallet and deposit, or use the Bridge API')
    }
    console.error('\nFull error:', err)
  }

  console.log('\n🎉 Test complete!\n')
}

main().catch((err) => {
  console.error('❌ Fatal:', err)
  process.exit(1)
})
