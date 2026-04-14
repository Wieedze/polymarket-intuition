/**
 * Diagnose and redeem stuck neg_risk positions
 * Usage: export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/redeem-positions.ts
 */
import 'dotenv/config'
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'

const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`
const NEG_RISK_ADAPTER = '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`
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
])

const negRiskAbi = parseAbi([
  'function redeemPositions(bytes32 conditionId, uint256[] indexSets) external',
])

const usdcAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
])

async function main(): Promise<void> {
  console.log(`\n🔍 Account: ${account.address}\n`)

  // Step 1: Check USDC balance before
  const usdcBefore = await publicClient.readContract({
    address: USDC_E, abi: usdcAbi,
    functionName: 'balanceOf', args: [account.address],
  })
  console.log(`💰 USDC.e balance: ${(Number(usdcBefore) / 1e6).toFixed(2)}\n`)

  // Step 2: Check approvals
  const adapters = [
    { name: 'NegRiskAdapter', address: NEG_RISK_ADAPTER },
    { name: 'CTF Exchange', address: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}` },
    { name: 'NegRisk CTF Exchange', address: '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}` },
  ]

  console.log('📋 Approval status on CTF contract:')
  for (const adapter of adapters) {
    const approved = await publicClient.readContract({
      address: CTF_ADDRESS, abi: ctfAbi,
      functionName: 'isApprovedForAll',
      args: [account.address, adapter.address],
    })
    console.log(`   ${adapter.name} (${adapter.address}): ${approved ? '✅ APPROVED' : '❌ NOT APPROVED'}`)
  }

  // Step 3: Approve NegRiskAdapter if needed
  const negRiskApproved = await publicClient.readContract({
    address: CTF_ADDRESS, abi: ctfAbi,
    functionName: 'isApprovedForAll',
    args: [account.address, NEG_RISK_ADAPTER],
  })

  if (!negRiskApproved) {
    console.log(`\n⚙️  Approving NegRiskAdapter on CTF...`)
    const hash = await walletClient.writeContract({
      address: CTF_ADDRESS, abi: ctfAbi,
      functionName: 'setApprovalForAll',
      args: [NEG_RISK_ADAPTER, true],
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`   ✅ Approved! tx: ${hash}`)
  }

  // Step 4: Fetch resolved positions
  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${account.address.toLowerCase()}&sizeThreshold=0`
  )
  const positions = await res.json() as Array<{
    conditionId: string; asset: string; outcomeIndex: number;
    title: string; size: number; curPrice: number; negativeRisk: boolean;
  }>

  const resolved = positions.filter(p => p.size > 0 && (p.curPrice >= 0.95 || p.curPrice <= 0.05))
  console.log(`\n📋 Found ${resolved.length} resolved positions to redeem:\n`)

  // Step 5: Try to redeem each one
  let totalRedeemed = 0
  for (const pos of resolved) {
    const tokenId = BigInt(pos.asset)
    const balance = await publicClient.readContract({
      address: CTF_ADDRESS, abi: ctfAbi,
      functionName: 'balanceOf', args: [account.address, tokenId],
    })

    if (balance === 0n) {
      console.log(`⏭️  SKIP (balance 0) | ${pos.title}`)
      continue
    }

    console.log(`🔄 Redeeming: ${pos.title}`)
    console.log(`   conditionId: ${pos.conditionId}`)
    console.log(`   outcomeIndex: ${pos.outcomeIndex} | negRisk: ${pos.negativeRisk}`)
    console.log(`   balance: ${balance.toString()} | size: ${pos.size}`)

    const conditionIdBytes = pos.conditionId as `0x${string}`
    const indexSets = [1n << BigInt(pos.outcomeIndex)]

    // Try NegRiskAdapter first (for neg_risk), then CTF direct
    if (pos.negativeRisk) {
      // Try NegRiskAdapter
      try {
        await publicClient.simulateContract({
          address: NEG_RISK_ADAPTER, abi: negRiskAbi,
          functionName: 'redeemPositions',
          args: [conditionIdBytes, indexSets],
          account: account.address,
        })
        console.log(`   ✅ NegRiskAdapter simulation OK — sending tx...`)
        const hash = await walletClient.writeContract({
          address: NEG_RISK_ADAPTER, abi: negRiskAbi,
          functionName: 'redeemPositions',
          args: [conditionIdBytes, indexSets],
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        console.log(`   ✅ TX confirmed: ${hash} (gas: ${receipt.gasUsed})`)
        totalRedeemed++
        continue
      } catch (e) {
        console.log(`   ❌ NegRiskAdapter failed: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`)
      }

      // Fallback: try CTF direct with parentCollectionId=0x0
      try {
        const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
        const hash = await walletClient.writeContract({
          address: CTF_ADDRESS, abi: ctfAbi,
          functionName: 'redeemPositions',
          args: [USDC_E, parentCollectionId, conditionIdBytes, indexSets],
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })

        // Check if balance actually changed
        const balanceAfter = await publicClient.readContract({
          address: CTF_ADDRESS, abi: ctfAbi,
          functionName: 'balanceOf', args: [account.address, tokenId],
        })
        if (balanceAfter < balance) {
          console.log(`   ✅ CTF direct worked! Balance: ${balance} → ${balanceAfter}`)
          totalRedeemed++
        } else {
          console.log(`   ⚠️  CTF direct was no-op (balance unchanged). tx: ${hash}`)
        }
      } catch (e) {
        console.log(`   ❌ CTF direct also failed: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`)
      }
    } else {
      // Standard CTF redeem
      try {
        const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
        const hash = await walletClient.writeContract({
          address: CTF_ADDRESS, abi: ctfAbi,
          functionName: 'redeemPositions',
          args: [USDC_E, parentCollectionId, conditionIdBytes, indexSets],
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })

        const balanceAfter = await publicClient.readContract({
          address: CTF_ADDRESS, abi: ctfAbi,
          functionName: 'balanceOf', args: [account.address, tokenId],
        })
        if (balanceAfter < balance) {
          console.log(`   ✅ Redeemed! Balance: ${balance} → ${balanceAfter}`)
          totalRedeemed++
        } else {
          console.log(`   ⚠️  No-op (balance unchanged)`)
        }
      } catch (e) {
        console.log(`   ❌ Failed: ${e instanceof Error ? e.message.slice(0, 100) : 'unknown'}`)
      }
    }

    // Small delay between txs to avoid nonce issues
    await new Promise(r => setTimeout(r, 3000))
  }

  // Step 6: Check USDC balance after
  const usdcAfter = await publicClient.readContract({
    address: USDC_E, abi: usdcAbi,
    functionName: 'balanceOf', args: [account.address],
  })
  const gained = (Number(usdcAfter) - Number(usdcBefore)) / 1e6
  console.log(`\n✅ Done! Redeemed ${totalRedeemed}/${resolved.length}`)
  console.log(`💰 USDC.e: ${(Number(usdcBefore) / 1e6).toFixed(2)} → ${(Number(usdcAfter) / 1e6).toFixed(2)} (${gained >= 0 ? '+' : ''}${gained.toFixed(2)})`)
}

main().catch(console.error)
