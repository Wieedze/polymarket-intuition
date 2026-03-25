'use client'

import { useState } from 'react'
import Link from 'next/link'

type OpenPosition = {
  conditionId: string
  title: string
  side: string
  avgPrice: number
  curPrice: number
  size: number
  domain: string | null
}

type MonitorWallet = {
  address: string
  label: string | null
  openPositions: OpenPosition[]
}

type AlertData = {
  type: 'NEW_POSITION' | 'POSITION_CLOSED' | 'POSITION_INCREASED'
  wallet: string
  walletLabel: string | null
  position: { title: string; avgPrice: number; curPrice: number; size: number; outcomeIndex: number }
  detectedAt: string
  previousSize?: number
}

type MonitorData = {
  wallets: MonitorWallet[]
  alerts: AlertData[]
  totalWatched: number
  totalOpenPositions: number
  polledAt: string
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
  'pm-domain/geopolitics': 'Geopolitics',
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

function truncateAddress(addr: string): string {
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function pnlColor(entry: number, cur: number): string {
  if (cur > entry * 1.05) return 'text-emerald-400'
  if (cur < entry * 0.95) return 'text-red-400'
  return 'text-zinc-300'
}

export default function MonitorPage(): React.ReactElement {
  const [loading, setLoading] = useState(false)
  const [polling, setPolling] = useState(false)
  const [data, setData] = useState<MonitorData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null)
  const [copying, setCopying] = useState<string | null>(null)

  async function copyPosition(walletAddr: string, walletLabel: string | null, p: OpenPosition): Promise<void> {
    const key = `${p.conditionId}-${walletAddr}`
    setCopying(key)
    try {
      const res = await fetch('/api/paper-trading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'copy',
          conditionId: p.conditionId,
          title: p.title,
          side: p.side,
          entryPrice: p.curPrice,
          copiedFrom: walletAddr,
          copiedLabel: walletLabel,
        }),
      })
      if (res.ok) {
        alert(`Copied! ${p.side} "${p.title}" @ ${(p.curPrice * 100).toFixed(0)}c`)
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        alert(body.error ?? 'Failed to copy')
      }
    } catch {
      alert('Failed to copy')
    } finally {
      setCopying(null)
    }
  }

  async function fetchData(poll: boolean): Promise<void> {
    if (poll) setPolling(true)
    else setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/monitor${poll ? '?poll=true' : ''}`)
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? `Error: ${res.status}`)
        return
      }
      const result = (await res.json()) as MonitorData
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
      setPolling(false)
    }
  }

  return (
    <main className="min-h-screen px-4 py-12 max-w-5xl mx-auto">
      {/* Nav */}
      <div className="flex items-center justify-between mb-8">
        <Link href="/" className="text-zinc-500 hover:text-zinc-300 text-sm">
          &larr; Back
        </Link>
        <div className="flex gap-2">
          <Link href="/leaderboard" className="text-zinc-500 hover:text-zinc-300 text-sm">Leaderboard</Link>
          <Link href="/signal" className="text-zinc-500 hover:text-zinc-300 text-sm">Signal</Link>
        </div>
      </div>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white">Position Monitor</h1>
        <p className="mt-2 text-zinc-400">
          Live positions from watched expert wallets
        </p>
      </div>

      {/* Controls */}
      <div className="flex gap-3 mb-8">
        <button
          onClick={() => void fetchData(false)}
          disabled={loading}
          className="px-5 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900 text-white text-sm rounded-lg border border-zinc-700 transition-colors"
        >
          {loading ? 'Loading...' : 'Load Snapshots'}
        </button>
        <button
          onClick={() => void fetchData(true)}
          disabled={polling}
          className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {polling ? 'Polling...' : 'Poll Now (fetch new)'}
        </button>
      </div>

      {error && <div className="text-red-400 text-center py-8">{error}</div>}

      {/* Alerts */}
      {data && data.alerts.length > 0 && (
        <div className="mb-8">
          <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">New Alerts</h2>
          <div className="space-y-2">
            {data.alerts.map((alert, i) => (
              <div
                key={i}
                className={`px-4 py-3 rounded-lg border ${
                  alert.type === 'NEW_POSITION'
                    ? 'bg-emerald-500/10 border-emerald-500/20'
                    : alert.type === 'POSITION_CLOSED'
                    ? 'bg-red-500/10 border-red-500/20'
                    : 'bg-yellow-500/10 border-yellow-500/20'
                }`}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className={
                    alert.type === 'NEW_POSITION' ? 'text-emerald-400' :
                    alert.type === 'POSITION_CLOSED' ? 'text-red-400' : 'text-yellow-400'
                  }>
                    {alert.type === 'NEW_POSITION' ? 'NEW' :
                     alert.type === 'POSITION_CLOSED' ? 'EXIT' : 'ADD'}
                  </span>
                  <span className="text-zinc-400">{alert.walletLabel ?? truncateAddress(alert.wallet)}</span>
                  <span className="text-white">{alert.position.title}</span>
                  <span className="text-zinc-500 text-xs ml-auto">
                    @ {(alert.position.avgPrice * 100).toFixed(0)}c
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats bar */}
      {data && (
        <div className="flex gap-6 mb-6 text-sm text-zinc-500">
          <span>{data.totalWatched} wallets watched</span>
          <span>{data.totalOpenPositions} open positions</span>
          <span>Last poll: {new Date(data.polledAt).toLocaleTimeString()}</span>
        </div>
      )}

      {/* Wallets list */}
      {data && data.wallets.length > 0 && (
        <div className="space-y-3">
          {data.wallets.map((w) => (
            <div
              key={w.address}
              className="border border-zinc-800 rounded-xl bg-zinc-900/50"
            >
              <button
                onClick={() => setExpandedWallet(expandedWallet === w.address ? null : w.address)}
                className="w-full px-5 py-4 flex items-center justify-between text-left"
              >
                <div>
                  <span className="text-white font-medium">
                    {w.label ?? truncateAddress(w.address)}
                  </span>
                  <span className="text-zinc-500 text-xs font-mono ml-2">
                    {truncateAddress(w.address)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-zinc-400">
                    {w.openPositions.length} open
                  </span>
                  <span className="text-zinc-600">
                    {expandedWallet === w.address ? '▲' : '▼'}
                  </span>
                </div>
              </button>

              {expandedWallet === w.address && w.openPositions.length > 0 && (
                <div className="px-5 pb-4 border-t border-zinc-800">
                  <div className="space-y-2 mt-3">
                    {w.openPositions.slice(0, 20).map((p, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 py-2 px-3 bg-zinc-800/50 rounded-lg text-sm"
                      >
                        {/* Domain badge */}
                        {p.domain && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full ${DOMAIN_COLORS[p.domain] ?? 'bg-zinc-700 text-zinc-400'}`}>
                            {DOMAIN_LABELS[p.domain] ?? '?'}
                          </span>
                        )}

                        {/* Side */}
                        <span className={`text-xs font-medium ${p.side === 'YES' ? 'text-emerald-400' : 'text-red-400'}`}>
                          {p.side}
                        </span>

                        {/* Title */}
                        <span className="text-zinc-300 flex-1 truncate">
                          {p.title}
                        </span>

                        {/* Entry → Current */}
                        <span className="text-zinc-500 text-xs">
                          {(p.avgPrice * 100).toFixed(0)}c
                        </span>
                        <span className="text-zinc-600 text-xs">&rarr;</span>
                        <span className={`text-xs font-medium ${pnlColor(p.avgPrice, p.curPrice)}`}>
                          {(p.curPrice * 100).toFixed(0)}c
                        </span>

                        {/* Size */}
                        <span className="text-zinc-600 text-xs w-16 text-right">
                          {p.size >= 1000 ? `${(p.size / 1000).toFixed(1)}K` : p.size.toFixed(0)} sh
                        </span>

                        {/* Copy button */}
                        <button
                          onClick={(e) => { e.stopPropagation(); void copyPosition(w.address, w.label, p) }}
                          disabled={copying === `${p.conditionId}-${w.address}`}
                          className="px-2 py-1 text-[10px] bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 text-white rounded transition-colors"
                        >
                          {copying === `${p.conditionId}-${w.address}` ? '...' : 'Copy'}
                        </button>
                      </div>
                    ))}
                    {w.openPositions.length > 20 && (
                      <div className="text-center text-zinc-600 text-xs py-2">
                        + {w.openPositions.length - 20} more positions
                      </div>
                    )}
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

      {data && data.wallets.length === 0 && (
        <div className="text-center py-16 border border-zinc-800 rounded-xl">
          <p className="text-zinc-400 text-lg">No watched wallets yet</p>
          <p className="text-zinc-600 mt-2">
            Run: <code className="text-zinc-400">npm run bulk-index -- 20 MONTH --watch</code>
          </p>
        </div>
      )}
    </main>
  )
}
