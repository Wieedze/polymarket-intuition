import { fetchAllPages } from './polymarket'
import {
  getPositionSnapshot,
  savePositionSnapshot,
  updateWalletPolledAt,
  type PositionSnapshotRow,
} from './db'

const POLYMARKET_DATA_URL =
  process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com'

// ── Types ─────────────────────────────────────────────────────────

type PositionRecord = {
  conditionId: string
  title: string
  outcome: string
  outcomeIndex: number
  size: number
  avgPrice: number
  curPrice: number
  initialValue: number
  currentValue: number
  cashPnl: number
}

export type OpenPosition = {
  conditionId: string
  outcomeIndex: number
  title: string
  size: number
  avgPrice: number
  curPrice: number
}

export type PositionAlert = {
  type: 'NEW_POSITION' | 'POSITION_CLOSED' | 'POSITION_INCREASED'
  wallet: string
  walletLabel: string | null
  position: OpenPosition
  detectedAt: string
  previousSize?: number
}

// ── Core logic ────────────────────────────────────────────────────

export async function fetchOpenPositions(address: string): Promise<OpenPosition[]> {
  const positions = await fetchAllPages<PositionRecord>(
    `${POLYMARKET_DATA_URL}/positions?user=${address}&sizeThreshold=0`,
    3
  )

  // Open = size > 0 and market not resolved (curPrice between 0.05 and 0.95)
  return positions
    .filter((p) => p.size > 0 && p.curPrice >= 0.05 && p.curPrice <= 0.95)
    .map((p) => ({
      conditionId: p.conditionId,
      outcomeIndex: p.outcomeIndex,
      title: p.title,
      size: p.size,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
    }))
}

export function diffPositions(
  previous: Map<string, PositionSnapshotRow>,
  current: Map<string, OpenPosition>
): Omit<PositionAlert, 'wallet' | 'walletLabel'>[] {
  const alerts: Omit<PositionAlert, 'wallet' | 'walletLabel'>[] = []
  const now = new Date().toISOString()

  // New or increased positions
  for (const [key, pos] of current) {
    const prev = previous.get(key)
    if (!prev) {
      alerts.push({ type: 'NEW_POSITION', position: pos, detectedAt: now })
    } else if (pos.size > prev.size * 1.1) {
      // 10% threshold to avoid noise
      alerts.push({
        type: 'POSITION_INCREASED',
        position: pos,
        detectedAt: now,
        previousSize: prev.size,
      })
    }
  }

  // Closed positions
  for (const [key, prev] of previous) {
    if (!current.has(key)) {
      alerts.push({
        type: 'POSITION_CLOSED',
        position: {
          conditionId: prev.conditionId,
          outcomeIndex: prev.outcomeIndex,
          title: prev.title,
          size: prev.size,
          avgPrice: prev.avgPrice,
          curPrice: prev.curPrice,
        },
        detectedAt: now,
      })
    }
  }

  return alerts
}

/**
 * Poll a single wallet: fetch positions, diff, save snapshot.
 * Returns alerts found.
 */
export async function pollWallet(
  wallet: string,
  label: string | null
): Promise<PositionAlert[]> {
  const previous = getPositionSnapshot(wallet)
  const currentPositions = await fetchOpenPositions(wallet)

  const currentMap = new Map<string, OpenPosition>()
  for (const p of currentPositions) {
    currentMap.set(`${p.conditionId}-${p.outcomeIndex}`, p)
  }

  const rawAlerts = diffPositions(previous, currentMap)

  // Save new snapshot
  savePositionSnapshot(wallet, currentPositions)
  updateWalletPolledAt(wallet)

  return rawAlerts.map((a) => ({
    ...a,
    wallet,
    walletLabel: label,
  }))
}
