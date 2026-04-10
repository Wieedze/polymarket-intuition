/**
 * test-live-connection.ts
 *
 * Quick test: connect to Polymarket CLOB, check balance, fetch a market.
 * Run: source secrets/bot-1.env && npx tsx scripts/test-live-connection.ts
 */

async function main(): Promise<void> {
  console.log('\n🧪 Testing Polymarket CLOB connection...\n')

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  const apiKey = process.env.POLYMARKET_API_KEY
  const apiSecret = process.env.POLYMARKET_API_SECRET
  const apiPassphrase = process.env.POLYMARKET_API_PASSPHRASE

  if (!privateKey || !apiKey || !apiSecret) {
    console.error('❌ Missing credentials. Source your bot-1.env first.')
    process.exit(1)
  }

  try {
    // 1. Create wallet
    const { createWalletClient, http } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const { polygon } = await import('viem/chains')

    const account = privateKeyToAccount(privateKey as `0x${string}`)
    console.log(`✅ Wallet: ${account.address}`)

    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    })

    // 2. Connect to CLOB
    const { ClobClient } = await import('@polymarket/clob-client')

    const creds = apiPassphrase && apiPassphrase !== 'undefined' && apiPassphrase !== ''
      ? { key: apiKey, secret: apiSecret, passPhrase: apiPassphrase }
      : { key: apiKey, secret: apiSecret, passPhrase: '' }

    const client = new ClobClient(
      'https://clob.polymarket.com',
      137,
      walletClient as never,
      creds
    )

    console.log('✅ CLOB client initialized')

    // 3. Check balance
    try {
      const balance = await (client as Record<string, Function>).getBalanceAllowance({
        asset_type: 'COLLATERAL',
      })
      console.log(`✅ USDC Balance: $${(parseFloat(balance?.balance ?? '0') / 1e6).toFixed(2)}`)
    } catch (e) {
      console.log(`⚠️  Balance check failed: ${e instanceof Error ? e.message : String(e)}`)
      console.log('   (This might be normal — trying market fetch instead)')
    }

    // 4. Fetch a market to verify API access
    const testConditionId = '0x9c1a953fe92c8357f1b646ba25d983aa83e90c525992db14fb726fa895cb5763'
    try {
      const market = await (client as Record<string, Function>).getMarket(testConditionId)
      const m = market as Record<string, unknown>
      console.log(`✅ Market fetch works: "${(m.question as string)?.slice(0, 50) ?? 'OK'}"`)
      console.log(`   Token IDs: YES=${(m.tokens as Array<Record<string, string>>)?.[0]?.token_id?.slice(0, 20)}...`)
      console.log(`   Tick size: ${m.minimum_tick_size}`)
    } catch (e) {
      console.log(`⚠️  Market fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 5. Fetch order book for that market
    try {
      const book = await (client as Record<string, Function>).getOrderBook(testConditionId)
      const b = book as Record<string, unknown>
      console.log(`✅ Order book accessible`)
    } catch (e) {
      console.log(`⚠️  Order book failed: ${e instanceof Error ? e.message : String(e)}`)
    }

    console.log('\n🎉 Connection test complete!\n')

  } catch (err) {
    console.error('❌ Fatal error:', err instanceof Error ? err.message : String(err))
    console.error(err)
    process.exit(1)
  }
}

main().catch(console.error)
