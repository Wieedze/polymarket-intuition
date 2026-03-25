'use client'

import { useState } from 'react'
import Link from 'next/link'

type DomainStats = {
  domain: string
  trades: number
  winRate: number
  calibration: number
  profitFactor: number
  avgPnlPerTrade: number
  maxConsecutiveLosses: number
  copyabilityScore: number
  tradingStyle: string
  totalPnl: number
}

type LeaderboardWallet = {
  rank: number
  address: string
  userName: string
  pnl: number
  volume: number
  resolvedTrades: number
  classifiedTrades: number
  bestDomain: DomainStats | null
  topCopyability: number
  domains: DomainStats[]
}

type LeaderboardData = {
  period: string
  wallets: LeaderboardWallet[]
  computedAt: string
}

const DOMAIN_LABELS: Record<string, string> = {
  'pm-domain/ai-tech': 'AI & Tech',
  'pm-domain/politics': 'Politics',
  'pm-domain/crypto': 'Crypto',
  'pm-domain/sports': 'Sports',
  'pm-domain/economics': 'Economics',
  'pm-domain/science': 'Science',
  'pm-domain/culture': 'Culture',
  'pm-domain/weather': 'Weather',
  'pm-domain/geopolitics': 'Geopolitics',
}

const DOMAIN_COLORS: Record<string, string> = {
  'pm-domain/ai-tech': 'text-violet-400',
  'pm-domain/politics': 'text-blue-400',
  'pm-domain/crypto': 'text-orange-400',
  'pm-domain/sports': 'text-green-400',
  'pm-domain/economics': 'text-yellow-400',
  'pm-domain/science': 'text-cyan-400',
  'pm-domain/culture': 'text-pink-400',
  'pm-domain/weather': 'text-sky-400',
  'pm-domain/geopolitics': 'text-red-400',
}

const PERIODS = [
  { value: 'WEEK', label: 'This Week' },
  { value: 'MONTH', label: 'This Month' },
  { value: 'ALL', label: 'All Time' },
]

function copyabilityColor(score: number): string {
  if (score >= 0.6) return 'text-emerald-400'
  if (score >= 0.4) return 'text-yellow-400'
  return 'text-red-400'
}

function copyabilityBg(score: number): string {
  if (score >= 0.6) return 'bg-emerald-500'
  if (score >= 0.4) return 'bg-yellow-500'
  return 'bg-red-500'
}

function pfLabel(pf: number): string {
  if (!pf || !isFinite(pf)) return '—'
  if (pf >= 100) return `${pf.toFixed(0)}x`
  return `${pf.toFixed(2)}x`
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function LeaderboardPage(): React.ReactElement {
  const [period, setPeriod] = useState('MONTH')
  const [limit, setLimit] = useState(10)
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<LeaderboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  async function fetchLeaderboard(): Promise<void> {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/leaderboard?period=${period}&limit=${limit}`)
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `API error: ${res.status}`)
        return
      }
      const result = (await res.json()) as LeaderboardData
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen px-4 py-12 max-w-5xl mx-auto">
      {/* Nav */}
      <div className="flex items-center justify-between mb-8">
        <Link href="/" className="text-zinc-500 hover:text-zinc-300 text-sm">
          &larr; Back to search
        </Link>
        <Link
          href="/signal"
          className="text-zinc-500 hover:text-zinc-300 text-sm"
        >
          Signal &rarr;
        </Link>
      </div>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">Copy Trade Leaderboard</h1>
        <p className="mt-2 text-zinc-400">
          Top Polymarket traders ranked by copyability — who to follow with a small account
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-8">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={`px-4 py-2 text-sm rounded-lg border transition-colors ${
              period === p.value
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500'
            }`}
          >
            {p.label}
          </button>
        ))}
        <select
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10))}
          className="px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded-lg text-zinc-300"
        >
          <option value={5}>Top 5</option>
          <option value={10}>Top 10</option>
          <option value={20}>Top 20</option>
        </select>
        <button
          onClick={() => void fetchLeaderboard()}
          disabled={loading}
          className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {loading ? 'Computing...' : 'Load Leaderboard'}
        </button>
      </div>

      {loading && (
        <div className="text-center py-20">
          <div className="inline-block w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="mt-4 text-zinc-400">
            Fetching leaderboard & computing copyability scores...
          </p>
          <p className="mt-2 text-zinc-600 text-sm">
            This may take a minute — analyzing trades for each wallet
          </p>
        </div>
      )}

      {error && (
        <div className="text-red-400 text-center py-8">{error}</div>
      )}

      {data && !loading && (
        <div className="space-y-3">
          {data.wallets.map((w, idx) => (
            <div
              key={w.address}
              className="border border-zinc-800 rounded-xl bg-zinc-900/50 hover:border-zinc-700 transition-colors"
            >
              {/* Main row */}
              <button
                onClick={() => setExpanded(expanded === w.address ? null : w.address)}
                className="w-full px-5 py-4 flex items-center gap-4 text-left"
              >
                {/* Rank */}
                <span className="text-2xl font-bold text-zinc-600 w-8 text-right">
                  {idx + 1}
                </span>

                {/* Copyability gauge */}
                <div className="w-16 text-center">
                  <div className={`text-xl font-bold ${copyabilityColor(w.topCopyability)}`}>
                    {Math.round(w.topCopyability * 100)}
                  </div>
                  <div className="text-[10px] text-zinc-500 uppercase">Copy</div>
                </div>

                {/* Name + address */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white font-medium truncate">
                      {w.userName}
                    </span>
                    <span className="text-zinc-600 text-xs font-mono">
                      {truncateAddress(w.address)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-zinc-500">
                    <span>{w.resolvedTrades} trades</span>
                    {w.bestDomain && (
                      <>
                        <span>&middot;</span>
                        <span className={DOMAIN_COLORS[w.bestDomain.domain] ?? 'text-zinc-400'}>
                          Best: {DOMAIN_LABELS[w.bestDomain.domain] ?? w.bestDomain.domain}
                        </span>
                        <span>&middot;</span>
                        <span>WR {Math.round(w.bestDomain.winRate * 100)}%</span>
                        <span>&middot;</span>
                        <span>PF {pfLabel(w.bestDomain.profitFactor)}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* PnL from Polymarket */}
                <div className="text-right">
                  <div className={`font-medium ${w.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {w.pnl >= 0 ? '+' : ''}{(w.pnl / 1000).toFixed(0)}K
                  </div>
                  <div className="text-[10px] text-zinc-500">PnL ({data.period})</div>
                </div>

                {/* Expand indicator */}
                <span className="text-zinc-600 text-sm">
                  {expanded === w.address ? '▲' : '▼'}
                </span>
              </button>

              {/* Expanded domain details */}
              {expanded === w.address && w.domains.length > 0 && (
                <div className="px-5 pb-4 border-t border-zinc-800">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                    {w.domains.map((d) => (
                      <div
                        key={d.domain}
                        className="p-3 bg-zinc-800/50 rounded-lg"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className={`text-sm font-medium ${DOMAIN_COLORS[d.domain] ?? 'text-zinc-300'}`}>
                            {DOMAIN_LABELS[d.domain] ?? d.domain}
                          </span>
                          <span className={`text-sm font-bold ${copyabilityColor(d.copyabilityScore)}`}>
                            {Math.round(d.copyabilityScore * 100)}%
                          </span>
                        </div>
                        <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden mb-2">
                          <div
                            className={`h-full rounded-full ${copyabilityBg(d.copyabilityScore)}`}
                            style={{ width: `${Math.round(d.copyabilityScore * 100)}%` }}
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-1 text-[11px]">
                          <div>
                            <span className="text-zinc-500">WR </span>
                            <span className="text-zinc-300">{Math.round(d.winRate * 100)}%</span>
                          </div>
                          <div>
                            <span className="text-zinc-500">PF </span>
                            <span className={`${d.profitFactor >= 1.5 ? 'text-emerald-400' : 'text-zinc-300'}`}>
                              {pfLabel(d.profitFactor)}
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-500">MaxL </span>
                            <span className={`${d.maxConsecutiveLosses <= 5 ? 'text-zinc-300' : 'text-red-400'}`}>
                              {d.maxConsecutiveLosses}
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-500">Cal </span>
                            <span className="text-zinc-300">{Math.round(d.calibration * 100)}%</span>
                          </div>
                          <div>
                            <span className="text-zinc-500">Avg </span>
                            <span className={`${d.avgPnlPerTrade >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {d.avgPnlPerTrade >= 0 ? '+' : ''}{d.avgPnlPerTrade.toFixed(0)}
                            </span>
                          </div>
                          <div>
                            <span className="text-zinc-500">{d.trades}t </span>
                            <span className="text-zinc-500">{d.tradingStyle}</span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 text-center">
                    <Link
                      href={`/profile/${w.address}`}
                      className="text-indigo-400 hover:text-indigo-300 text-sm"
                    >
                      View full profile &rarr;
                    </Link>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
