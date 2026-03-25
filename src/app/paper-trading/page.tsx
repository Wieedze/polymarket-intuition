'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

type PaperTrade = {
  id: string
  conditionId: string
  title: string
  domain: string | null
  side: string
  entryPrice: number
  simulatedUsdc: number
  shares: number
  copiedFrom: string
  copiedLabel: string | null
  status: 'open' | 'won' | 'lost'
  curPrice: number | null
  exitPrice: number | null
  pnl: number | null
  openedAt: string
  resolvedAt: string | null
}

type Portfolio = {
  startingBalance: number
  currentBalance: number
  realizedPnl: number
  unrealizedPnl: number
  totalInvested: number
  betSizeUsdc: number
  totalTrades: number
  openTrades: number
  closedTrades: number
  wins: number
  losses: number
  winRate: number
  roi: number
}

type PaperTradingData = {
  portfolio: Portfolio
  trades: PaperTrade[]
}

const DOMAIN_LABELS: Record<string, string> = {
  'pm-domain/ai-tech': 'AI',
  'pm-domain/politics': 'Politics',
  'pm-domain/crypto': 'Crypto',
  'pm-domain/sports': 'Sports',
  'pm-domain/economics': 'Econ',
  'pm-domain/science': 'Science',
  'pm-domain/culture': 'Culture',
  'pm-domain/weather': 'Weather',
  'pm-domain/geopolitics': 'Geo',
}

const DOMAIN_COLORS: Record<string, string> = {
  'pm-domain/ai-tech': 'bg-violet-500/20 text-violet-400',
  'pm-domain/politics': 'bg-blue-500/20 text-blue-400',
  'pm-domain/crypto': 'bg-orange-500/20 text-orange-400',
  'pm-domain/sports': 'bg-green-500/20 text-green-400',
  'pm-domain/economics': 'bg-yellow-500/20 text-yellow-400',
  'pm-domain/science': 'bg-cyan-500/20 text-cyan-400',
  'pm-domain/culture': 'bg-pink-500/20 text-pink-400',
  'pm-domain/weather': 'bg-sky-500/20 text-sky-400',
  'pm-domain/geopolitics': 'bg-red-500/20 text-red-400',
}

function truncAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr
}

export default function PaperTradingPage(): React.ReactElement {
  const [data, setData] = useState<PaperTradingData | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'open' | 'closed' | 'all'>('open')
  const [betSize, setBetSize] = useState('100')
  const [startBal, setStartBal] = useState('10000')

  async function fetchData(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/paper-trading')
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const result = (await res.json()) as PaperTradingData
      setData(result)
      setBetSize(result.portfolio.betSizeUsdc.toString())
      setStartBal(result.portfolio.startingBalance.toString())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function refreshPrices(): Promise<void> {
    setRefreshing(true)
    await fetch('/api/paper-trading?action=refresh')
    await fetchData()
    setRefreshing(false)
  }

  async function checkResolutions(): Promise<void> {
    setResolving(true)
    await fetch('/api/paper-trading?action=resolve')
    await fetchData()
    setResolving(false)
  }

  async function saveSetting(): Promise<void> {
    await fetch('/api/paper-trading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'configure',
        startingBalance: parseFloat(startBal),
        betSizeUsdc: parseFloat(betSize),
      }),
    })
    await fetchData()
  }

  useEffect(() => { void fetchData() }, [])

  const p = data?.portfolio
  const trades = data?.trades ?? []
  const filtered = tab === 'open'
    ? trades.filter((t) => t.status === 'open')
    : tab === 'closed'
    ? trades.filter((t) => t.status !== 'open')
    : trades

  return (
    <main className="min-h-screen px-4 py-12 max-w-5xl mx-auto">
      {/* Nav */}
      <div className="flex items-center justify-between mb-8">
        <Link href="/" className="text-zinc-500 hover:text-zinc-300 text-sm">&larr; Back</Link>
        <div className="flex gap-2">
          <Link href="/monitor" className="text-zinc-500 hover:text-zinc-300 text-sm">Monitor</Link>
          <Link href="/leaderboard" className="text-zinc-500 hover:text-zinc-300 text-sm">Leaderboard</Link>
        </div>
      </div>

      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">Paper Trading</h1>
        <p className="mt-2 text-zinc-400">Simulated copy trading — test your strategy with fake money</p>
      </div>

      {error && <div className="text-red-400 mb-6">{error}</div>}

      {/* Portfolio stats */}
      {p && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
          <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
            <div className="text-xs text-zinc-500 mb-1">Balance</div>
            <div className={`text-xl font-bold ${p.currentBalance >= p.startingBalance ? 'text-emerald-400' : 'text-red-400'}`}>
              ${p.currentBalance.toFixed(0)}
            </div>
            <div className="text-xs text-zinc-600 mt-1">Started: ${p.startingBalance.toFixed(0)}</div>
          </div>
          <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
            <div className="text-xs text-zinc-500 mb-1">Realized P&L</div>
            <div className={`text-xl font-bold ${p.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {p.realizedPnl >= 0 ? '+' : ''}{p.realizedPnl.toFixed(2)}
            </div>
            <div className="text-xs text-zinc-600 mt-1">
              Unrealized: {p.unrealizedPnl >= 0 ? '+' : ''}{p.unrealizedPnl.toFixed(2)}
            </div>
          </div>
          <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
            <div className="text-xs text-zinc-500 mb-1">Win Rate</div>
            <div className="text-xl font-bold text-white">
              {p.closedTrades > 0 ? `${Math.round(p.winRate * 100)}%` : '—'}
            </div>
            <div className="text-xs text-zinc-600 mt-1">{p.wins}W / {p.losses}L</div>
          </div>
          <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
            <div className="text-xs text-zinc-500 mb-1">ROI</div>
            <div className={`text-xl font-bold ${p.roi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {p.closedTrades > 0 ? `${(p.roi * 100).toFixed(1)}%` : '—'}
            </div>
            <div className="text-xs text-zinc-600 mt-1">{p.openTrades} open / {p.totalTrades} total</div>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-wrap gap-3 mb-6">
        <button
          onClick={() => void refreshPrices()}
          disabled={refreshing}
          className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-white rounded-lg disabled:opacity-50"
        >
          {refreshing ? 'Refreshing...' : 'Refresh Prices'}
        </button>
        <button
          onClick={() => void checkResolutions()}
          disabled={resolving}
          className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg disabled:opacity-50"
        >
          {resolving ? 'Checking...' : 'Check Resolutions'}
        </button>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-zinc-500">Bet size:</span>
          <input
            type="number"
            value={betSize}
            onChange={(e) => setBetSize(e.target.value)}
            className="w-20 px-2 py-1 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-300"
          />
          <span className="text-xs text-zinc-500">Balance:</span>
          <input
            type="number"
            value={startBal}
            onChange={(e) => setStartBal(e.target.value)}
            className="w-24 px-2 py-1 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-300"
          />
          <button
            onClick={() => void saveSetting()}
            className="px-3 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded"
          >
            Save
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        {(['open', 'closed', 'all'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 text-sm rounded-lg ${
              tab === t ? 'bg-indigo-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-white'
            }`}
          >
            {t === 'open' ? `Open (${trades.filter((x) => x.status === 'open').length})` :
             t === 'closed' ? `Closed (${trades.filter((x) => x.status !== 'open').length})` :
             `All (${trades.length})`}
          </button>
        ))}
      </div>

      {/* Trades list */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 border border-zinc-800 rounded-xl">
          <p className="text-zinc-400">No paper trades yet</p>
          <p className="text-zinc-600 mt-2 text-sm">
            Go to <Link href="/monitor" className="text-indigo-400 hover:text-indigo-300">Monitor</Link> and
            copy expert positions, or they&apos;ll be auto-copied when monitoring runs.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => {
            const unrealized = t.curPrice != null ? t.shares * (t.curPrice - t.entryPrice) : 0
            const displayPnl = t.status === 'open' ? unrealized : (t.pnl ?? 0)

            return (
              <div
                key={t.id}
                className={`px-4 py-3 rounded-lg border ${
                  t.status === 'open' ? 'border-zinc-800 bg-zinc-900/50' :
                  t.status === 'won' ? 'border-emerald-500/20 bg-emerald-500/5' :
                  'border-red-500/20 bg-red-500/5'
                }`}
              >
                <div className="flex items-center gap-3">
                  {/* Status badge */}
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${
                    t.status === 'open' ? 'bg-indigo-500/20 text-indigo-400' :
                    t.status === 'won' ? 'bg-emerald-500/20 text-emerald-400' :
                    'bg-red-500/20 text-red-400'
                  }`}>
                    {t.status.toUpperCase()}
                  </span>

                  {/* Domain */}
                  {t.domain && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${DOMAIN_COLORS[t.domain] ?? 'bg-zinc-700 text-zinc-400'}`}>
                      {DOMAIN_LABELS[t.domain] ?? '?'}
                    </span>
                  )}

                  {/* Side */}
                  <span className={`text-xs font-medium ${t.side === 'YES' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {t.side}
                  </span>

                  {/* Title */}
                  <span className="text-sm text-zinc-300 flex-1 truncate">{t.title}</span>

                  {/* Prices */}
                  <div className="text-xs text-zinc-500 text-right">
                    <span>{(t.entryPrice * 100).toFixed(0)}c</span>
                    <span className="text-zinc-600"> → </span>
                    <span className={
                      t.status === 'open'
                        ? (t.curPrice ?? 0) > t.entryPrice ? 'text-emerald-400' : 'text-red-400'
                        : t.status === 'won' ? 'text-emerald-400' : 'text-red-400'
                    }>
                      {((t.status === 'open' ? t.curPrice : t.exitPrice) ?? 0 * 100).toFixed(0)}c
                    </span>
                  </div>

                  {/* PnL */}
                  <div className={`text-sm font-medium w-20 text-right ${displayPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {displayPnl >= 0 ? '+' : ''}{displayPnl.toFixed(2)}
                  </div>

                  {/* Copied from */}
                  <span className="text-[10px] text-zinc-600 w-20 text-right truncate">
                    {t.copiedLabel ?? truncAddr(t.copiedFrom)}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}
