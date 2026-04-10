/**
 * test-exit-withdraw.ts
 *
 * Test the full exit pipeline:
 *   1. List current real positions
 *   2. Close a position (sell outcome tokens)
 *   3. Check balance after
 *
 * Usage:
 *   export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/test-exit-withdraw.ts
 */

import { createWalletClient, createPublicClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import { getRealPositions, getRealBalance, closePosition } from '../src/lib/real-trader'

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`
const POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com'

const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
])

async function main(): Promise<void> {
  console.log('\n🧪 Testing Exit & Withdraw pipeline...\n')

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY
  if (!privateKey) {
    console.error('❌ Missing credentials')
    process.exit(1)
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`)
  console.log(`Wallet: ${account.address}`)

  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(POLYGON_RPC),
  })

  // ── 1. Check wallet USDC.e balance (on-chain, in wallet) ──
  const walletBalance = await publicClient.readContract({
    address: USDC_E,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })
  console.log(`\n💰 Wallet USDC.e: $${(Number(walletBalance) / 1e6).toFixed(2)} (on-chain, in your wallet)`)

  // ── 2. Check Polymarket CLOB balance ──
  const clobBalance = await getRealBalance()
  console.log(`💰 CLOB balance: $${clobBalance.toFixed(2)} (deposited in Polymarket)`)

  // ── 3. List current positions ──
  console.log('\n📋 Current positions:')
  const positions = await getRealPositions()

  if (positions.length === 0) {
    console.log('   No open positions found.')
    console.log('\n   Your USDC.e should already be in your wallet on Polygon.')
    console.log('   Check Rabby — no withdraw needed, it stays on-chain.\n')
    return
  }

  for (const pos of positions) {
    const pnl = (pos.curPrice - pos.avgPrice) * pos.size
    console.log(`   ${pos.side} | ${pos.title.slice(0, 50)}`)
    console.log(`     Size: ${pos.size.toFixed(2)} shares | Entry: ${(pos.avgPrice * 100).toFixed(1)}¢ | Current: ${(pos.curPrice * 100).toFixed(1)}¢ | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`)
    console.log(`     Token: ${pos.tokenId.slice(0, 30)}...`)
  }

  // ── 4. Close the first position (smallest one) ──
  const toClose = positions.sort((a, b) => a.size - b.size)[0]
  if (!toClose) {
    console.log('\n   No position to close.')
    return
  }

  console.log(`\n🔄 Closing position: ${toClose.side} ${toClose.title.slice(0, 45)}...`)
  console.log(`   Selling ${toClose.size.toFixed(2)} shares @ ${(toClose.curPrice * 100).toFixed(1)}¢`)

  const result = await closePosition(toClose.tokenId, toClose.size, toClose.curPrice)

  if (result.success) {
    console.log(`   ✅ SOLD! orderId: ${result.orderId}`)
  } else {
    console.log(`   ❌ SELL FAILED: ${result.error}`)
    console.log('   Trying at a slightly lower price (-2¢)...')

    // Retry at a lower price (more likely to fill)
    const lowerPrice = Math.max(toClose.curPrice - 0.02, 0.01)
    const retry = await closePosition(toClose.tokenId, toClose.size, lowerPrice)
    if (retry.success) {
      console.log(`   ✅ SOLD at ${(lowerPrice * 100).toFixed(1)}¢! orderId: ${retry.orderId}`)
    } else {
      console.log(`   ❌ STILL FAILED: ${retry.error}`)
    }
  }

  // ── 5. Check balance after ──
  console.log('\n📊 After exit:')
  const newWalletBalance = await publicClient.readContract({
    address: USDC_E,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  })
  console.log(`   Wallet USDC.e: $${(Number(newWalletBalance) / 1e6).toFixed(2)}`)
  const newClobBalance = await getRealBalance()
  console.log(`   CLOB balance: $${newClobBalance.toFixed(2)}`)

  const newPositions = await getRealPositions()
  console.log(`   Positions remaining: ${newPositions.length}`)

  console.log('\n💡 Note: On Polymarket, when you sell tokens, USDC.e goes back to your')
  console.log('   wallet automatically. No separate "withdraw" step needed.\n')

  console.log('🎉 Exit test complete!\n')
}

main().catch((err) => {
  console.error('❌ Fatal:', err)
  process.exit(1)
})
