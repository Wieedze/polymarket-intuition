import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseAbi,
  stringToHex,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ATOM_IDS, PREDICATE_ATOMS } from './atoms'
import type { AggregatedAttestation } from '../types/attestation'

// ── Chain & contract ──────────────────────────────────────────────

const intuitionMainnet = defineChain({
  id: 1155,
  name: 'Intuition',
  nativeCurrency: { decimals: 18, name: 'Intuition', symbol: 'TRUST' },
  rpcUrls: {
    default: {
      http: [
        process.env.INTUITION_RPC_URL ?? 'https://rpc.intuition.systems/http',
      ],
    },
  },
  blockExplorers: {
    default: {
      name: 'Intuition Explorer',
      url: 'https://explorer.intuition.systems',
    },
  },
})

const MULTIVAULT = '0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e' as const
const GRAPHQL =
  process.env.INTUITION_GRAPH_URL ?? 'https://mainnet.intuition.sh/v1/graphql'

const readAbi = parseAbi([
  'function getAtomCost() view returns (uint256)',
  'function getTripleCost() view returns (uint256)',
  'function calculateAtomId(bytes data) pure returns (bytes32)',
  'function calculateTripleId(bytes32 subjectId, bytes32 predicateId, bytes32 objectId) pure returns (bytes32)',
  'function isTermCreated(bytes32 id) view returns (bool)',
  'function getBondingCurveConfig() view returns (address, uint256)',
])

const writeAbi = parseAbi([
  'function createAtoms(bytes[] atomDatas, uint256[] assets) payable returns (bytes32[])',
  'function createTriples(bytes32[] subjectIds, bytes32[] predicateIds, bytes32[] objectIds, uint256[] assets) payable returns (bytes32[])',
  'function deposit(address receiver, bytes32 termId, uint256 curveId, uint256 minShares) payable returns (uint256)',
])

// ── Clients ───────────────────────────────────────────────────────

function getPublicClient(): ReturnType<typeof createPublicClient> {
  return createPublicClient({
    chain: intuitionMainnet,
    transport: http(),
  })
}

function getWalletClient(): ReturnType<typeof createWalletClient> {
  const pk = process.env.INTUITION_PRIVATE_KEY
  if (!pk) {
    throw new Error('Missing INTUITION_PRIVATE_KEY in environment')
  }
  const account = privateKeyToAccount(pk as Hex)
  return createWalletClient({
    account,
    chain: intuitionMainnet,
    transport: http(),
  })
}

// ── GraphQL helpers ───────────────────────────────────────────────

type GraphQLResponse<T> = {
  data?: T
  errors?: Array<{ message: string }>
}

async function graphqlQuery<T>(
  query: string,
  variables: Record<string, unknown>
): Promise<T | null> {
  const response = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) return null

  const json = (await response.json()) as GraphQLResponse<T>
  if (json.errors && json.errors.length > 0) return null
  return json.data ?? null
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Check if a triple (attestation) already exists in the Intuition graph.
 */
export async function attestationExists(
  subject: string,
  predicate: string,
  object: string
): Promise<boolean> {
  const data = await graphqlQuery<{
    triples: Array<{ term_id: string }>
  }>(
    `query CheckTriple($subjectId: String!, $predicateId: String!, $objectId: String!) {
      triples(where: {
        subject_id: { _eq: $subjectId },
        predicate_id: { _eq: $predicateId },
        object_id: { _eq: $objectId }
      }, limit: 1) {
        term_id
      }
    }`,
    {
      subjectId: subject,
      predicateId: predicate,
      objectId: object,
    }
  )

  return (data?.triples?.length ?? 0) > 0
}

/**
 * Create or update an aggregated attestation on-chain.
 *
 * This creates a triple: (wallet, has-prediction-reputation-in, domain)
 * and deposits TRUST to signal the strength of the attestation.
 *
 * IMPORTANT: Only writes aggregated attestations (>= 5 trades per domain).
 * Never writes individual trades on-chain.
 */
export async function upsertAggregatedAttestation(
  attestation: AggregatedAttestation
): Promise<string> {
  const publicClient = getPublicClient()
  const walletClient = getWalletClient()

  // Resolve atom IDs
  const subjectAtomId = await getOrCreateCaip10Atom(
    attestation.subject,
    publicClient,
    walletClient
  )
  const predicateAtomId = ATOM_IDS[attestation.predicate]
  const objectAtomId = ATOM_IDS[attestation.object]

  if (!predicateAtomId || !objectAtomId) {
    throw new Error(
      `Missing ATOM_ID for predicate="${attestation.predicate}" or object="${attestation.object}". Run /init-atoms first.`
    )
  }

  // Check if triple exists on-chain
  const tripleId = await publicClient.readContract({
    address: MULTIVAULT,
    abi: readAbi,
    functionName: 'calculateTripleId',
    args: [
      subjectAtomId as Hex,
      predicateAtomId as Hex,
      objectAtomId as Hex,
    ],
  })

  const tripleExists = await publicClient.readContract({
    address: MULTIVAULT,
    abi: readAbi,
    functionName: 'isTermCreated',
    args: [tripleId],
  })

  if (tripleExists) {
    // Triple exists → deposit more TRUST to signal updated conviction
    const curveConfig = await publicClient.readContract({
      address: MULTIVAULT,
      abi: readAbi,
      functionName: 'getBondingCurveConfig',
    })
    const curveId = curveConfig[1]

    const depositAmount = BigInt(1e15) // 0.001 TRUST signal deposit

    const hash = await walletClient.writeContract({
      address: MULTIVAULT,
      abi: writeAbi,
      functionName: 'deposit',
      args: [
        walletClient.account!.address,
        tripleId,
        curveId,
        BigInt(0), // minShares
      ],
      value: depositAmount,
    })

    await publicClient.waitForTransactionReceipt({ hash })
    return hash
  }

  // Triple does not exist → create it
  const tripleCost = await publicClient.readContract({
    address: MULTIVAULT,
    abi: readAbi,
    functionName: 'getTripleCost',
  })

  const hash = await walletClient.writeContract({
    address: MULTIVAULT,
    abi: writeAbi,
    functionName: 'createTriples',
    args: [
      [subjectAtomId as Hex],
      [predicateAtomId as Hex],
      [objectAtomId as Hex],
      [tripleCost],
    ],
    value: tripleCost,
  })

  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}

/**
 * Get or create a CAIP-10 atom for a wallet address.
 */
async function getOrCreateCaip10Atom(
  address: `0x${string}`,
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>
): Promise<Hex> {
  const caip10Uri = `caip10:eip155:1:${address.toLowerCase()}`
  const atomData = stringToHex(caip10Uri)

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

  if (exists) return atomId

  // Create the atom
  const atomCost = await publicClient.readContract({
    address: MULTIVAULT,
    abi: readAbi,
    functionName: 'getAtomCost',
  })

  const hash = await walletClient.writeContract({
    address: MULTIVAULT,
    abi: writeAbi,
    functionName: 'createAtoms',
    args: [[atomData], [atomCost]],
    value: atomCost,
  })

  await publicClient.waitForTransactionReceipt({ hash })
  return atomId
}

/**
 * Initialize domain and predicate atoms if they don't exist.
 * Delegates to the init-atoms script logic.
 */
export async function initAtoms(): Promise<void> {
  // This is handled by scripts/init-atoms.ts
  // Importing here to provide the function signature expected by CLAUDE.md
  throw new Error(
    'Use `npm run init-atoms` script instead — it handles IPFS pinning + batch creation'
  )
}
