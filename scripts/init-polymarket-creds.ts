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
    const { ethers } = await import('ethers')

    const wallet = new ethers.Wallet(privateKey)
    console.log(`Wallet address: ${wallet.address}`)
    console.log(`⚠️  Make sure this wallet has USDC on Polygon before trading\n`)

    // Create client without creds first to derive them
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet)

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
    console.error('\nMake sure @polymarket/clob-client is installed:')
    console.error('  npm install @polymarket/clob-client ethers')
    process.exit(1)
  }
}

main().catch(console.error)
