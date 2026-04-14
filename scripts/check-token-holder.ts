/**
 * Check who actually holds the CTF tokens — EOA or Safe/Proxy wallet
 * Usage: npx tsx scripts/check-token-holder.ts
 */
import 'dotenv/config'
import { createPublicClient, http, parseAbi } from 'viem'
import { polygon } from 'viem/chains'

const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`
const NEG_RISK_CTF = '0x69308FB03f5d8110F04ABDb6e329FC44aab3B32A' as `0x${string}` // NegRisk CTF exchange (holds wrapped tokens)

const EOA = '0x1acC2880Cca00f61C41eb2b436C4f7D2d09a2fEC' as `0x${string}`

// One of the resolved conditionIds (Levante YES, outcomeIndex 0)
const CONDITION_ID = '0x8f0d1da2c973c162023bbb3778d381b90543545a2b8cafcfee6dacd88e571aa3'

const publicClient = createPublicClient({
  chain: polygon,
  transport: http(POLYGON_RPC),
})

const erc1155Abi = parseAbi([
  'function balanceOf(address account, uint256 id) view returns (uint256)',
])

// For CTF, tokenId = uint256(keccak256(abi.encodePacked(conditionId, outcomeIndex)))
// But Polymarket uses a different token ID scheme — the "asset" from positions API

async function main(): Promise<void> {
  // Fetch positions to get actual asset/token IDs
  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${EOA.toLowerCase()}&sizeThreshold=0`
  )
  const positions = await res.json() as Array<{
    conditionId: string
    asset: string
    outcomeIndex: number
    title: string
    size: number
    curPrice: number
  }>

  const resolved = positions.filter(p => p.curPrice >= 0.95 || p.curPrice <= 0.05)

  console.log(`\nFound ${resolved.length} resolved positions:\n`)

  for (const pos of resolved) {
    const tokenId = BigInt(pos.asset)

    // Check balance on EOA
    const eoaBalance = await publicClient.readContract({
      address: CTF_ADDRESS,
      abi: erc1155Abi,
      functionName: 'balanceOf',
      args: [EOA, tokenId],
    })

    console.log(`📋 ${pos.title}`)
    console.log(`   conditionId: ${pos.conditionId}`)
    console.log(`   tokenId (asset): ${pos.asset}`)
    console.log(`   outcomeIndex: ${pos.outcomeIndex}`)
    console.log(`   API size: ${pos.size}`)
    console.log(`   EOA balance: ${eoaBalance.toString()}`)

    // Check if code exists at EOA (to determine if it's a Safe)
    const code = await publicClient.getCode({ address: EOA })
    console.log(`   EOA is contract: ${code && code !== '0x' ? 'YES (Safe/Proxy)' : 'NO (regular EOA)'}`)

    // Check payoutDenominator to see if condition is resolved
    const ctfAbi2 = parseAbi([
      'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    ])
    const payoutDenom = await publicClient.readContract({
      address: CTF_ADDRESS,
      abi: ctfAbi2,
      functionName: 'payoutDenominator',
      args: [pos.conditionId as `0x${string}`],
    })
    console.log(`   payoutDenominator: ${payoutDenom.toString()} (0 = NOT resolved on-chain)`)
    console.log()
  }
}

main().catch(console.error)
