'use client'

import { useEffect, useState } from 'react'
import DomainCard from './DomainCard'
import type { WalletReputation } from '../types/reputation'

type ReputationData = WalletReputation & {
  totalPositions: number
  resolvedTrades: number
  classifiedTrades: number
}

type ReputationProfileProps = {
  address: string
}

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; data: ReputationData }

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function ReputationProfile({
  address,
}: ReputationProfileProps): React.ReactElement {
  const [state, setState] = useState<FetchState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      setState({ status: 'loading' })

      const res = await fetch(`/api/intuition/reputation?address=${address}`)

      if (cancelled) return

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setState({ status: 'error', message: body.error ?? `API error: ${res.status}` })
        return
      }

      const data = (await res.json()) as ReputationData
      if (data.domains.length === 0) {
        setState({ status: 'empty' })
        return
      }

      setState({ status: 'ready', data })
    }

    load().catch((err: unknown) => {
      if (!cancelled) {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [address])

  // Loading
  if (state.status === 'loading') {
    return (
      <div className="text-center py-20">
        <div className="inline-block w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <p className="mt-4 text-zinc-400">Fetching trades from Polymarket & computing scores...</p>
      </div>
    )
  }

  // Error
  if (state.status === 'error') {
    return (
      <div className="text-center py-20">
        <p className="text-red-400 text-lg">Something went wrong</p>
        <p className="text-zinc-500 mt-2">{state.message}</p>
      </div>
    )
  }

  // Empty
  if (state.status === 'empty') {
    return (
      <div className="text-center py-20">
        <p className="text-zinc-400 text-lg">No prediction data found</p>
        <p className="text-zinc-600 mt-2">
          This wallet has no resolved trades on Polymarket.
        </p>
      </div>
    )
  }

  // Ready
  const { data } = state
  const totalPnl = data.domains.reduce((s, d) => s + d.totalPnl, 0)

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-white font-mono">
          {truncateAddress(address)}
        </h2>
        <div className="flex flex-wrap gap-4 mt-2 text-sm text-zinc-500">
          <span>
            {data.resolvedTrades} resolved / {data.totalPositions} positions
          </span>
          <span>&middot;</span>
          <span>{data.classifiedTrades} classified in {data.domains.length} domain{data.domains.length !== 1 ? 's' : ''}</span>
          <span>&middot;</span>
          <span className={totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)} USDC
          </span>
        </div>
      </div>

      {/* Domain cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {data.domains.map((d) => (
          <DomainCard
            key={d.domain}
            domain={d.domain}
            winRate={d.winRate}
            trades={d.trades}
            calibration={d.calibration}
            convictionScore={d.convictionScore}
            tradingStyle={d.tradingStyle}
            profitFactor={d.profitFactor}
            avgPnlPerTrade={d.avgPnlPerTrade}
            maxConsecutiveLosses={d.maxConsecutiveLosses}
            copyabilityScore={d.copyabilityScore}
            compositeScore={d.compositeScore}
            agentRank={d.agentRank}
          />
        ))}
      </div>
    </div>
  )
}
