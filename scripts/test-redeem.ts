/**
 * Test different redeem approaches for stuck resolved positions
 * Usage: npx tsx scripts/test-redeem.ts
 */
import 'dotenv/config'
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`
const NEG_RISK_ADAPTER = '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`
const ZERO_PARENT = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

const privateKey = process.env.POLYMARKET_PRIVATE_KEY
if (!privateKey) throw new Error('POLYMARKET_PRIVATE_KEY not set')

const account = privateKeyToAccount(privateKey as `0x${string}`)
const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) })
const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) })

const ctfAbi = parseAbi([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function getOutcomeSlotCount(bytes32 conditionId) view returns (uint256)',
])

const negRiskAbi = parseAbi([
  'function redeemPositions(bytes32 conditionId, uint256[] indexSets) external',
])

// Test with smallest position first: CSKA Moskva (1.06 shares)
const TEST_CONDITION = '0x58394953ab38572054a6a5848cf90819d158739ac1d65a51b99840cebd13ed20' as `0x${string}`
const TEST_OUTCOME_INDEX = 1

async function main(): Promise<void> {
  console.log(`\n🔍 Analyzing condition: ${TEST_CONDITION}`)
  console.log(`   Account: ${account.address}\n`)

  // Check condition details
  const payoutDenom = await publicClient.readContract({
    address: CTF_ADDRESS, abi: ctfAbi,
    functionName: 'payoutDenominator', args: [TEST_CONDITION],
  })
  console.log(`   payoutDenominator: ${payoutDenom}`)

  const slotCount = await publicClient.readContract({
    address: CTF_ADDRESS, abi: ctfAbi,
    functionName: 'getOutcomeSlotCount', args: [TEST_CONDITION],
  })
  console.log(`   outcomeSlotCount: ${slotCount}`)

  for (let i = 0; i < Number(slotCount); i++) {
    const payout = await publicClient.readContract({
      address: CTF_ADDRESS, abi: ctfAbi,
      functionName: 'payoutNumerators', args: [TEST_CONDITION, BigInt(i)],
    })
    console.log(`   payoutNumerator[${i}]: ${payout}`)
  }

  // Try approach 1: CTF direct with single indexSet
  console.log(`\n--- Approach 1: CTF direct, indexSet [${1 << TEST_OUTCOME_INDEX}] ---`)
  try {
    await publicClient.simulateContract({
      address: CTF_ADDRESS, abi: ctfAbi,
      functionName: 'redeemPositions',
      args: [USDC_E, ZERO_PARENT, TEST_CONDITION, [BigInt(1 << TEST_OUTCOME_INDEX)]],
      account: account.address,
    })
    console.log('   ✅ SIMULATION OK — this approach works!')
  } catch (e) {
    console.log(`   ❌ Reverted: ${e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150)}`)
  }

  // Try approach 2: CTF direct with both indexSets [1, 2]
  console.log(`\n--- Approach 2: CTF direct, indexSets [1, 2] ---`)
  try {
    await publicClient.simulateContract({
      address: CTF_ADDRESS, abi: ctfAbi,
      functionName: 'redeemPositions',
      args: [USDC_E, ZERO_PARENT, TEST_CONDITION, [1n, 2n]],
      account: account.address,
    })
    console.log('   ✅ SIMULATION OK — this approach works!')
  } catch (e) {
    console.log(`   ❌ Reverted: ${e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150)}`)
  }

  // Try approach 3: NegRisk adapter with single indexSet
  console.log(`\n--- Approach 3: NegRisk adapter, indexSet [${1 << TEST_OUTCOME_INDEX}] ---`)
  try {
    await publicClient.simulateContract({
      address: NEG_RISK_ADAPTER, abi: negRiskAbi,
      functionName: 'redeemPositions',
      args: [TEST_CONDITION, [BigInt(1 << TEST_OUTCOME_INDEX)]],
      account: account.address,
    })
    console.log('   ✅ SIMULATION OK — this approach works!')
  } catch (e) {
    console.log(`   ❌ Reverted: ${e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150)}`)
  }

  // Try approach 4: NegRisk adapter with both indexSets
  console.log(`\n--- Approach 4: NegRisk adapter, indexSets [1, 2] ---`)
  try {
    await publicClient.simulateContract({
      address: NEG_RISK_ADAPTER, abi: negRiskAbi,
      functionName: 'redeemPositions',
      args: [TEST_CONDITION, [1n, 2n]],
      account: account.address,
    })
    console.log('   ✅ SIMULATION OK — this approach works!')
  } catch (e) {
    console.log(`   ❌ Reverted: ${e instanceof Error ? e.message.slice(0, 150) : String(e).slice(0, 150)}`)
  }

  console.log('\n✅ Done. Use the approach that says SIMULATION OK to redeem.\n')
}

main().catch(console.error)
