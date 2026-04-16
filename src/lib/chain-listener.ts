/**
 * Chain Listener — Real-time ERC1155 TransferSingle events on Polymarket CTF
 *
 * Uses WebSocket (wss://) for instant event streaming — <1 second latency.
 * Falls back to HTTP polling if WSS is not available.
 *
 * Subscribes to ALL TransferSingle on the CTF contract, filters watched
 * wallets in code (RPC can't handle 75 address filters).
 *
 * Standalone module. No DB dependency, no side effects.
 */

import { createPublicClient, http, webSocket, parseAbiItem, type Log, type Transport } from 'viem'
import { polygon } from 'viem/chains'

// ── Config ───────────────────────────────────────────────────────

const POLYGON_RPC = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com'
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`

const TRANSFER_SINGLE_EVENT = parseAbiItem(
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'
)

// ── Types ────────────────────────────────────────────────────────

export type ExpertTrade = {
  wallet: string
  tokenId: string
  amount: bigint
  operator: string
  from: string
  blockNumber: bigint
  transactionHash: string
  detectedAt: number
}

export type TradeCallback = (trade: ExpertTrade) => void

// ── State ────────────────────────────────────────────────────────

const watchedAddresses = new Set<string>()
let unwatch: (() => void) | null = null
let tradeCallback: TradeCallback | null = null
let isListening = false
let mode: 'ws' | 'http' = 'http'

// ── Public API ───────────────────────────────────────────────────

export function addWatchedAddress(address: string): void {
  watchedAddresses.add(address.toLowerCase())
}

export function addWatchedAddresses(addresses: string[]): void {
  for (const addr of addresses) watchedAddresses.add(addr.toLowerCase())
}

export function getWatchedCount(): number {
  return watchedAddresses.size
}

export function isChainListening(): boolean {
  return isListening
}

export function getListenerMode(): string {
  return mode
}

export function startChainListener(onTrade: TradeCallback): void {
  if (isListening) return
  tradeCallback = onTrade

  // Determine transport: WSS if Alchemy/Infura URL, else HTTP polling
  let transport: Transport
  const wssUrl = POLYGON_RPC.replace('https://', 'wss://').replace('http://', 'ws://')

  if (POLYGON_RPC.includes('alchemy.com') || POLYGON_RPC.includes('infura.io') || POLYGON_RPC.includes('quiknode')) {
    transport = webSocket(wssUrl)
    mode = 'ws'
  } else {
    transport = http(POLYGON_RPC)
    mode = 'http'
  }

  const client = createPublicClient({
    chain: polygon,
    transport,
  })

  // Subscribe to ALL TransferSingle events on CTF — filter watched wallets in code
  unwatch = client.watchContractEvent({
    address: CTF_ADDRESS,
    abi: [TRANSFER_SINGLE_EVENT],
    eventName: 'TransferSingle',
    pollingInterval: mode === 'http' ? 4_000 : undefined,  // only for HTTP fallback
    onLogs: (logs) => {
      for (const log of logs) {
        handleTransferEvent(log as Log<bigint, number, false, typeof TRANSFER_SINGLE_EVENT, true>)
      }
    },
    onError: (error) => {
      console.log(`  [CHAIN] Error: ${error.message.slice(0, 150)}`)
    },
  })

  isListening = true
  console.log(`  [CHAIN] Listening on CTF | mode:${mode.toUpperCase()} | ${watchedAddresses.size} wallets`)
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

  // Ignore self-transfers
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

  if (tradeCallback) tradeCallback(trade)
}
