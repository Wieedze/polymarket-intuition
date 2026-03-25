import type { DomainAtom } from './attestation'
import type { TradingStyle } from '../lib/scorer'

export type DomainReputation = {
  domain: DomainAtom
  winRate: number
  trades: number
  calibration: number
  avgConviction: number
  convictionScore: number
  tradingStyle: TradingStyle
  profitFactor: number
  avgPnlPerTrade: number
  maxConsecutiveLosses: number
  copyabilityScore: number
  totalPnl: number
  agentRank?: number
  compositeScore?: number
  lastUpdated: string
}

export type WalletReputation = {
  address: string
  domains: DomainReputation[]
  totalAttestations: number
  computedAt: string
}
