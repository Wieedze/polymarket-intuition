export type ResolvedTrade = {
  id: string
  marketId: string
  marketQuestion: string
  side: 'YES' | 'NO'
  entryPrice: number
  size: number
  outcome: 'won' | 'lost'
  pnl: number
  resolvedAt: string
  transactionHash: string
}

export type WalletTrades = {
  address: string
  trades: ResolvedTrade[]
  totalTrades: number
  totalPositions: number
  totalPnl: number
}
