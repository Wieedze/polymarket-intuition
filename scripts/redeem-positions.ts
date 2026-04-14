/**
 * Redeem resolved neg_risk positions on Polymarket
 *
 * Key insight: NegRiskAdapter (0xd91E...) is for REDEEM,
 * NegRisk CTF Exchange (0xC5d5...) is for TRADING — different contracts!
 *
 * NegRiskAdapter.redeemPositions(conditionId, amounts[]) takes ACTUAL token balances,
 * not indexSets like the CTF.
 *
 * Usage: export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/redeem-positions.ts
 */
import 'dotenv/config'
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, keccak256, encodePacked } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' as `0x${string}` // REDEEM contract
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`

const privateKey = process.env.POLYMARKET_PRIVATE_KEY
if (!privateKey) throw new Error('POLYMARKET_PRIVATE_KEY not set')

const account = privateKeyToAccount(privateKey as `0x${string}`)
const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) })
const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) })

const ctfAbi = parseAbi([
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved) external',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function getPositionId(bytes32 collateralToken, uint256 outcomeIndex) view returns (uint256)',
])

const negRiskAdapterAbi = parseAbi([
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external',
])

const usdcAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
])

async function main(): Promise<void> {
  console.log(`\n🔍 Account: ${account.address}`)
  console.log(`📋 NegRiskAdapter: ${NEG_RISK_ADAPTER}\n`)

  // Step 1: Check USDC balance
  const usdcBefore = await publicClient.readContract({
    address: USDC_E, abi: usdcAbi,
    functionName: 'balanceOf', args: [account.address],
  })
  console.log(`💰 USDC.e balance: ${(Number(usdcBefore) / 1e6).toFixed(2)}\n`)

  // Step 2: Check approval for NegRiskAdapter
  const approved = await publicClient.readContract({
    address: CTF_ADDRESS, abi: ctfAbi,
    functionName: 'isApprovedForAll',
    args: [account.address, NEG_RISK_ADAPTER],
  })
  console.log(`📋 NegRiskAdapter approved on CTF: ${approved ? '✅ YES' : '❌ NO'}`)

  if (!approved) {
    console.log(`⚙️  Approving NegRiskAdapter...`)
    const hash = await walletClient.writeContract({
      address: CTF_ADDRESS, abi: ctfAbi,
      functionName: 'setApprovalForAll',
      args: [NEG_RISK_ADAPTER, true],
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`   ✅ Approved! tx: ${hash}`)
  }

  // Step 3: Fetch resolved positions
  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${account.address.toLowerCase()}&sizeThreshold=0&redeemable=true`
  )
  let positions = await res.json() as Array<{
    conditionId: string; asset: string; outcomeIndex: number;
    title: string; size: number; curPrice: number; negativeRisk: boolean;
  }>

  // If redeemable=true returns empty, fall back to all positions filtered by price
  if (positions.length === 0) {
    console.log(`   redeemable=true returned 0, falling back to price filter...`)
    const res2 = await fetch(
      `https://data-api.polymarket.com/positions?user=${account.address.toLowerCase()}&sizeThreshold=0`
    )
    positions = (await res2.json() as typeof positions).filter(
      p => p.size > 0 && (p.curPrice >= 0.95 || p.curPrice <= 0.05)
    )
  }

  console.log(`\n📋 Found ${positions.length} resolved positions:\n`)

  // Step 4: Redeem each position
  let totalRedeemed = 0
  for (const pos of positions) {
    const tokenId = BigInt(pos.asset)
    const balance = await publicClient.readContract({
      address: CTF_ADDRESS, abi: ctfAbi,
      functionName: 'balanceOf', args: [account.address, tokenId],
    })

    if (balance === 0n) {
      console.log(`⏭️  SKIP (balance 0) | ${pos.title}`)
      continue
    }

    console.log(`🔄 ${pos.title}`)
    console.log(`   conditionId: ${pos.conditionId}`)
    console.log(`   outcome: ${pos.outcomeIndex} | negRisk: ${pos.negativeRisk} | balance: ${balance}`)

    const conditionIdBytes = pos.conditionId as `0x${string}`

    if (pos.negativeRisk) {
      // NegRiskAdapter: amounts = [yesBalance, noBalance]
      // We need balances for BOTH outcomes (index 0 and index 1)
      // The asset field gives us our outcome's tokenId, we need the other one too

      // Fetch all positions for this conditionId to get both outcome tokens
      const allForCondition = positions.filter(p => p.conditionId === pos.conditionId)

      // Build amounts array: [outcome0_balance, outcome1_balance]
      const amounts: bigint[] = [0n, 0n]

      for (const p of allForCondition) {
        const tid = BigInt(p.asset)
        const bal = await publicClient.readContract({
          address: CTF_ADDRESS, abi: ctfAbi,
          functionName: 'balanceOf', args: [account.address, tid],
        })
        amounts[p.outcomeIndex] = bal
      }

      // If we only have one outcome from the API, check the other manually
      if (allForCondition.length < 2) {
        // We only know one tokenId. For the missing outcome, try balance = 0
        console.log(`   amounts: [${amounts[0]}, ${amounts[1]}]`)
      } else {
        console.log(`   amounts: [${amounts[0]}, ${amounts[1]}]`)
      }

      // Simulate first
      try {
        await publicClient.simulateContract({
          address: NEG_RISK_ADAPTER,
          abi: negRiskAdapterAbi,
          functionName: 'redeemPositions',
          args: [conditionIdBytes, amounts],
          account: account.address,
        })
        console.log(`   ✅ Simulation OK — sending tx...`)
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)
        console.log(`   ❌ Simulation FAILED: ${msg}`)
        console.log()
        continue
      }

      try {
        const hash = await walletClient.writeContract({
          address: NEG_RISK_ADAPTER,
          abi: negRiskAdapterAbi,
          functionName: 'redeemPositions',
          args: [conditionIdBytes, amounts],
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })

        // Verify balance changed
        const balanceAfter = await publicClient.readContract({
          address: CTF_ADDRESS, abi: ctfAbi,
          functionName: 'balanceOf', args: [account.address, tokenId],
        })
        if (balanceAfter < balance) {
          console.log(`   💰 REDEEMED! Balance: ${balance} → ${balanceAfter} | tx: ${hash}`)
          totalRedeemed++
        } else {
          console.log(`   ⚠️  TX confirmed but balance unchanged | tx: ${hash}`)
        }
      } catch (e) {
        console.log(`   ❌ TX failed: ${e instanceof Error ? e.message.slice(0, 150) : 'unknown'}`)
      }
    } else {
      // Standard CTF redeem
      try {
        const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
        const hash = await walletClient.writeContract({
          address: CTF_ADDRESS, abi: ctfAbi,
          functionName: 'redeemPositions',
          args: [USDC_E, parentCollectionId, conditionIdBytes, [1n, 2n]],
        })
        await publicClient.waitForTransactionReceipt({ hash })

        const balanceAfter = await publicClient.readContract({
          address: CTF_ADDRESS, abi: ctfAbi,
          functionName: 'balanceOf', args: [account.address, tokenId],
        })
        if (balanceAfter < balance) {
          console.log(`   💰 REDEEMED! Balance: ${balance} → ${balanceAfter}`)
          totalRedeemed++
        } else {
          console.log(`   ⚠️  No-op (balance unchanged)`)
        }
      } catch (e) {
        console.log(`   ❌ Failed: ${e instanceof Error ? e.message.slice(0, 150) : 'unknown'}`)
      }
    }

    // Delay between txs to avoid nonce issues
    await new Promise(r => setTimeout(r, 3000))
    console.log()
  }

  // Step 5: Final balance
  const usdcAfter = await publicClient.readContract({
    address: USDC_E, abi: usdcAbi,
    functionName: 'balanceOf', args: [account.address],
  })
  const gained = (Number(usdcAfter) - Number(usdcBefore)) / 1e6
  console.log(`✅ Done! Redeemed ${totalRedeemed}/${positions.length}`)
  console.log(`💰 USDC.e: ${(Number(usdcBefore) / 1e6).toFixed(2)} → ${(Number(usdcAfter) / 1e6).toFixed(2)} (${gained >= 0 ? '+' : ''}${gained.toFixed(2)})`)
}

main().catch(console.error)
