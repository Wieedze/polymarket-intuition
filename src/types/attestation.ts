export type DomainAtom =
  | 'pm-domain/ai-tech'
  | 'pm-domain/politics'
  | 'pm-domain/crypto'
  | 'pm-domain/sports'
  | 'pm-domain/economics'
  | 'pm-domain/science'
  | 'pm-domain/culture'
  | 'pm-domain/weather'
  | 'pm-domain/geopolitics'

export type PredicateAtom =
  | 'predicted-correctly-in'
  | 'predicted-incorrectly-in'
  | 'has-prediction-reputation-in'

export type AtomicAttestation = {
  subject: `0x${string}`
  predicate: 'predicted-correctly-in' | 'predicted-incorrectly-in'
  object: DomainAtom
  metadata: {
    platform: 'polymarket'
    marketId: string
    marketQuestion: string
    conviction: number
    entryPrice: number
    resolvedAt: string
    pnl: number
    classifierConfidence: number
  }
}

export type AggregatedAttestation = {
  subject: `0x${string}`
  predicate: 'has-prediction-reputation-in'
  object: DomainAtom
  metadata: {
    winRate: number
    trades: number
    calibration: number
    avgConviction: number
    totalPnl: number
    lastUpdated: string
    source: 'polymarket-indexer-v1'
  }
}
