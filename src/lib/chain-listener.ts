/**
 * Chain Listener — Real-time ERC1155 TransferSingle events on Polymarket CTF
 *
 * Watches the CTF contract on Polygon for token transfers TO watched wallets.
 * When an expert receives conditional tokens, we detect it in <10 seconds
 * instead of 60s+ with data API polling.
 *
 * Standalone module. No DB dependency, no side effects.
 */

import { createPublicClient, http, parseAbiItem, type Log } from 'viem'
import { polygon } from 'viem/chains'

// ── Config ───────────────────────────────────────────────────────

const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`

// ERC1155 TransferSingle event
const TRANSFER_SINGLE_EVENT = parseAbiItem(
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'
)

// ── Types ────────────────────────────────────────────────────────

export type ExpertTrade = {
  wallet: string          // expert address (to)
  tokenId: string         // conditional token ID
  amount: bigint          // number of shares
  operator: string        // who executed (exchange contract)
  from: string            // sender (exchange or 0x0 for mint)
  blockNumber: bigint
  transactionHash: string
  detectedAt: number      // timestamp ms
}

export type TradeCallback = (trade: ExpertTrade) => void

// ── State ────────────────────────────────────────────────────────

const watchedAddresses = new Set<string>()  // lowercase expert addresses
let unwatch: (() => void) | null = null
let tradeCallback: TradeCallback | null = null
let isListening = false

// ── Public API ───────────────────────────────────────────────────

export function addWatchedAddress(address: string): void {
  watchedAddresses.add(address.toLowerCase())
}

export function addWatchedAddresses(addresses: string[]): void {
  for (const addr of addresses) {
    watchedAddresses.add(addr.toLowerCase())
  }
}

export function getWatchedCount(): number {
  return watchedAddresses.size
}

export function isChainListening(): boolean {
  return isListening
}

export function startChainListener(onTrade: TradeCallback): void {
  if (isListening) return
  tradeCallback = onTrade

  const client = createPublicClient({
    chain: polygon,
    transport: http(POLYGON_RPC),
  })

  // Watch for TransferSingle events on the CTF contract
  // pollingInterval = 4s (Polygon block time is ~2s, but we don't need every block)
  unwatch = client.watchContractEvent({
    address: CTF_ADDRESS,
    abi: [TRANSFER_SINGLE_EVENT],
    eventName: 'TransferSingle',
    pollingInterval: 4_000,
    onLogs: (logs) => {
      for (const log of logs) {
        handleTransferEvent(log)
      }
    },
    onError: (error) => {
      console.log(`  [CHAIN] Error: ${error.message.slice(0, 100)}`)
    },
  })

  isListening = true
  console.log(`  [CHAIN] Listening for TransferSingle on CTF | ${watchedAddresses.size} wallets | poll:4s`)
}

export function stopChainListener(): void {
  if (unwatch) {
    unwatch()
    unwatch = null
  }
  isListening = false
}

// ── Internal ─────────────────────────────────────────────────────

function handleTransferEvent(log: Log<bigint, number, false, typeof TRANSFER_SINGLE_EVENT, true>): void {
  const { args, blockNumber, transactionHash } = log
  if (!args.to || !args.id || !args.value) return

  const to = args.to.toLowerCase()

  // Only care about transfers TO watched expert wallets
  if (!watchedAddresses.has(to)) return

  // Ignore zero-value transfers
  if (args.value === 0n) return

  // Ignore transfers FROM the expert (they're selling, not buying)
  const from = (args.from ?? '').toLowerCase()
  if (from === to) return

  const trade: ExpertTrade = {
    wallet: to,
    tokenId: args.id.toString(),
    amount: args.value,
    operator: (args.operator ?? '').toLowerCase(),
    from,
    blockNumber: blockNumber ?? 0n,
    transactionHash: transactionHash ?? '',
    detectedAt: Date.now(),
  }

  if (tradeCallback) {
    tradeCallback(trade)
  }
}
