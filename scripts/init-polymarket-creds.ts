/**
 * init-polymarket-creds.ts
 *
 * Run ONCE to derive your Polymarket API credentials from your private key.
 * Outputs the values to add to your .env file.
 *
 * Usage:
 *   POLYMARKET_PRIVATE_KEY=0x... npx tsx scripts/init-polymarket-creds.ts
 */

async function main() {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  if (!privateKey) {
    console.error('❌ Set POLYMARKET_PRIVATE_KEY in your environment first')
    console.error('   Example: POLYMARKET_PRIVATE_KEY=0x... npx tsx scripts/init-polymarket-creds.ts')
    process.exit(1)
  }

  console.log('\n🔑 Deriving Polymarket API credentials...\n')

  try {
    const { ClobClient } = await import('@polymarket/clob-client')
    const { createWalletClient, http } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const { polygon } = await import('viem/chains')

    const account = privateKeyToAccount(privateKey as `0x${string}`)
    console.log(`Wallet address: ${account.address}`)
    console.log(`⚠️  Make sure this wallet has USDC on Polygon before trading\n`)

    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    })

    // Create client without creds first to derive them
    const client = new ClobClient(
      'https://clob.polymarket.com',
      137,
      walletClient as unknown as Parameters<typeof ClobClient>[2]
    )

    // Derive API credentials from wallet signature
    const creds = await client.createOrDeriveApiKey()

    console.log('✅ Credentials derived successfully!\n')
    console.log('Add these to your .env file:')
    console.log('─'.repeat(50))
    console.log(`POLYMARKET_PRIVATE_KEY=${privateKey}`)
    console.log(`POLYMARKET_API_KEY=${creds.key}`)
    console.log(`POLYMARKET_API_SECRET=${creds.secret}`)
    console.log(`POLYMARKET_API_PASSPHRASE=${creds.passPhrase}`)
    console.log('─'.repeat(50))
    console.log('\n⚠️  Never commit these values to git!')
    console.log('⚠️  Use a DEDICATED wallet — not your main wallet')
  } catch (err) {
    console.error('❌ Error:', err instanceof Error ? err.message : String(err))
    console.error('\nFull error:')
    console.error(err)
    process.exit(1)
  }
}

main().catch(console.error)
