/**
 * init-atoms.ts — Create the 12 Intuition atoms (9 domains + 3 predicates)
 *
 * Usage: npx tsx scripts/init-atoms.ts
 * Requires: .env with INTUITION_PRIVATE_KEY
 */

import 'dotenv/config'
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseAbi,
  stringToHex,
  formatEther,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import * as fs from 'fs'
import * as path from 'path'

// ── Chain definition ──────────────────────────────────────────────

const intuitionMainnet = defineChain({
  id: 1155,
  name: 'Intuition',
  nativeCurrency: { decimals: 18, name: 'Intuition', symbol: 'TRUST' },
  rpcUrls: { default: { http: ['https://rpc.intuition.systems/http'] } },
  blockExplorers: {
    default: {
      name: 'Intuition Explorer',
      url: 'https://explorer.intuition.systems',
    },
  },
})

// ── Constants ─────────────────────────────────────────────────────

const MULTIVAULT = '0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e' as const
const GRAPHQL = 'https://mainnet.intuition.sh/v1/graphql'

const readAbi = parseAbi([
  'function getAtomCost() view returns (uint256)',
  'function calculateAtomId(bytes data) pure returns (bytes32)',
  'function isTermCreated(bytes32 id) view returns (bool)',
])

const writeAbi = parseAbi([
  'function createAtoms(bytes[] atomDatas, uint256[] assets) payable returns (bytes32[])',
])

// ── Atom definitions ──────────────────────────────────────────────

type AtomDef = {
  key: string
  label: string
  description: string
}

const ATOMS_TO_CREATE: AtomDef[] = [
  // 9 domains
  {
    key: 'pm-domain/ai-tech',
    label: 'pm-domain/ai-tech',
    description:
      'Polymarket prediction domain: AI & Technology (LLMs, chips, robotics, software)',
  },
  {
    key: 'pm-domain/politics',
    label: 'pm-domain/politics',
    description:
      'Polymarket prediction domain: Politics (elections, congress, parties)',
  },
  {
    key: 'pm-domain/crypto',
    label: 'pm-domain/crypto',
    description:
      'Polymarket prediction domain: Crypto (BTC, ETH, DeFi, NFTs, ETFs)',
  },
  {
    key: 'pm-domain/sports',
    label: 'pm-domain/sports',
    description:
      'Polymarket prediction domain: Sports (NBA, NFL, World Cup, tournaments)',
  },
  {
    key: 'pm-domain/economics',
    label: 'pm-domain/economics',
    description:
      'Polymarket prediction domain: Economics (Fed, CPI, GDP, interest rates)',
  },
  {
    key: 'pm-domain/science',
    label: 'pm-domain/science',
    description:
      'Polymarket prediction domain: Science (FDA, NASA, clinical trials, vaccines)',
  },
  {
    key: 'pm-domain/culture',
    label: 'pm-domain/culture',
    description:
      'Polymarket prediction domain: Culture (Oscars, Grammys, Netflix, celebrities)',
  },
  {
    key: 'pm-domain/weather',
    label: 'pm-domain/weather',
    description:
      'Polymarket prediction domain: Weather (temperature, hurricanes, forecasts)',
  },
  {
    key: 'pm-domain/geopolitics',
    label: 'pm-domain/geopolitics',
    description:
      'Polymarket prediction domain: Geopolitics (wars, NATO, sanctions, diplomacy)',
  },
  // 3 predicates
  {
    key: 'predicted-correctly-in',
    label: 'predicted-correctly-in',
    description:
      'Predicate: subject made a correct prediction in a given domain',
  },
  {
    key: 'predicted-incorrectly-in',
    label: 'predicted-incorrectly-in',
    description:
      'Predicate: subject made an incorrect prediction in a given domain',
  },
  {
    key: 'has-prediction-reputation-in',
    label: 'has-prediction-reputation-in',
    description:
      'Predicate: subject has an aggregated prediction reputation score in a given domain',
  },
]

// ── Pin to IPFS ───────────────────────────────────────────────────

async function pinThing(
  name: string,
  description: string
): Promise<string> {
  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `mutation pinThing($name: String!, $description: String!, $image: String!, $url: String!) {
        pinThing(thing: { name: $name, description: $description, image: $image, url: $url }) { uri }
      }`,
      variables: { name, description, image: '', url: '' },
    }),
  })

  if (!response.ok) {
    throw new Error(`Pin HTTP error: ${response.status}`)
  }

  const json = (await response.json()) as {
    data?: { pinThing?: { uri?: string } }
    errors?: Array<{ message: string }>
  }

  if (json.errors && json.errors.length > 0) {
    throw new Error(`Pin GraphQL error: ${json.errors[0]?.message}`)
  }

  const uri = json.data?.pinThing?.uri
  if (!uri || !uri.startsWith('ipfs://')) {
    throw new Error(`Pin failed — no valid IPFS URI returned`)
  }

  return uri
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Validate env
  const privateKey = process.env.INTUITION_PRIVATE_KEY
  if (!privateKey) {
    throw new Error(
      'Missing INTUITION_PRIVATE_KEY in .env — needed to sign transactions'
    )
  }

  const account = privateKeyToAccount(privateKey as Hex)
  console.log(`\n🔑 Wallet: ${account.address}`)

  const publicClient = createPublicClient({
    chain: intuitionMainnet,
    transport: http(),
  })

  const walletClient = createWalletClient({
    account,
    chain: intuitionMainnet,
    transport: http(),
  })

  // Get atom cost
  const atomCost = await publicClient.readContract({
    address: MULTIVAULT,
    abi: readAbi,
    functionName: 'getAtomCost',
  })
  console.log(`💰 Atom cost: ${formatEther(atomCost)} TRUST per atom`)
  console.log(
    `💰 Total needed: ${formatEther(atomCost * BigInt(ATOMS_TO_CREATE.length))} TRUST for ${ATOMS_TO_CREATE.length} atoms\n`
  )

  // Step 1: Pin all atoms to IPFS
  console.log('📌 Pinning atoms to IPFS...\n')

  const pinResults: Array<{ def: AtomDef; uri: string }> = []

  for (const def of ATOMS_TO_CREATE) {
    const uri = await pinThing(def.label, def.description)
    pinResults.push({ def, uri })
    console.log(`  📌 ${def.label} → ${uri}`)
  }

  // Step 2: Check which atoms already exist on-chain
  console.log('\n🔍 Checking existing atoms on-chain...\n')

  type AtomToCreate = {
    def: AtomDef
    uri: string
    atomData: Hex
    atomId: Hex
  }

  const toCreate: AtomToCreate[] = []
  const alreadyExist: Array<{ def: AtomDef; atomId: Hex }> = []

  for (const { def, uri } of pinResults) {
    const atomData = stringToHex(uri)
    const atomId = await publicClient.readContract({
      address: MULTIVAULT,
      abi: readAbi,
      functionName: 'calculateAtomId',
      args: [atomData],
    })

    const exists = await publicClient.readContract({
      address: MULTIVAULT,
      abi: readAbi,
      functionName: 'isTermCreated',
      args: [atomId],
    })

    if (exists) {
      console.log(`  ⏭️  ${def.label} already exists → ${atomId}`)
      alreadyExist.push({ def, atomId })
    } else {
      console.log(`  🆕 ${def.label} needs creation → ${atomId}`)
      toCreate.push({ def, uri, atomData, atomId })
    }
  }

  // Collect all IDs (existing + to-be-created)
  const atomIds: Record<string, string> = {}

  for (const { def, atomId } of alreadyExist) {
    atomIds[def.key] = atomId
  }

  // Step 3: Create atoms on-chain (batch)
  if (toCreate.length > 0) {
    console.log(`\n⛓️  Creating ${toCreate.length} atoms on-chain...\n`)

    const atomDatas = toCreate.map((a) => a.atomData)
    const assets = toCreate.map(() => atomCost)
    const totalValue = atomCost * BigInt(toCreate.length)

    const hash = await walletClient.writeContract({
      address: MULTIVAULT,
      abi: writeAbi,
      functionName: 'createAtoms',
      args: [atomDatas, assets],
      value: totalValue,
    })

    console.log(`  📝 Transaction: ${hash}`)
    console.log(`  ⏳ Waiting for confirmation...`)

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status === 'reverted') {
      throw new Error(`Transaction reverted: ${hash}`)
    }

    console.log(
      `  ✅ Confirmed in block ${receipt.blockNumber} (gas: ${receipt.gasUsed})\n`
    )

    // Re-read atom IDs after creation
    for (const { def, atomData } of toCreate) {
      const atomId = await publicClient.readContract({
        address: MULTIVAULT,
        abi: readAbi,
        functionName: 'calculateAtomId',
        args: [atomData],
      })
      atomIds[def.key] = atomId
    }
  } else {
    console.log('\n✅ All atoms already exist on-chain!')
  }

  // Step 4: Update atoms.ts with IDs
  console.log('\n📝 Updating src/lib/atoms.ts with ATOM_IDS...\n')

  const atomsFilePath = path.resolve('src/lib/atoms.ts')
  let atomsContent = fs.readFileSync(atomsFilePath, 'utf-8')

  // Build the ATOM_IDS record
  const entries = Object.entries(atomIds)
    .map(([key, id]) => `  '${key}': '${id}',`)
    .join('\n')

  const newAtomIds = `export const ATOM_IDS: Partial<Record<DomainAtomValue | string, string>> = {\n${entries}\n}`

  atomsContent = atomsContent.replace(
    /export const ATOM_IDS: Partial<Record<DomainAtomValue \| string, string>> = \{[^}]*\}/,
    newAtomIds
  )

  fs.writeFileSync(atomsFilePath, atomsContent)

  // Step 5: Summary
  console.log('─'.repeat(50))
  for (const [key, id] of Object.entries(atomIds)) {
    const padded = key.padEnd(32)
    console.log(`✅ ${padded} → ID: ${id}`)
  }
  console.log('─'.repeat(50))
  console.log(`\n🎉 ${Object.keys(atomIds).length} atomes prêts\n`)
}

main().catch((err: unknown) => {
  console.error('\n❌ Fatal error:', err instanceof Error ? err.message : err)
  process.exit(1)
})
