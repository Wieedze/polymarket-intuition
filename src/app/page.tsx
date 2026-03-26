'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

type PnlPoint = { date: string; pnl: number }
type BotEvent = { id: number; type: string; message: string; detail: string | null; createdAt: string }
type DomainInfo = { domain: string; pnl: number; trades: number; won: number; winRate: number }

type DashboardData = {
  balance: number
  startingBalance: number
  realizedPnl: number
  unrealizedPnl: number
  totalInvested: number
  totalEquity: number
  winRate: number
  wins: number
  losses: number
  openTrades: number
  totalTrades: number
  roi: number
  pnlHistory: PnlPoint[]
  events: BotEvent[]
  domains: DomainInfo[]
}

function pnlColor(n: number): string { return n >= 0 ? 'text-emerald-400' : 'text-red-400' }
function pnlStr(n: number): string { return `${n >= 0 ? '+' : ''}${n.toFixed(0)}` }

const EVENT_ICONS: Record<string, string> = {
  copy: '📋',
  exit: '🚪',
  skip: '⏭️',
  resolve: '✅',
}

const DOMAIN_COLORS: Record<string, string> = {
  sports: 'bg-green-500',
  weather: 'bg-sky-500',
  politics: 'bg-blue-500',
  crypto: 'bg-orange-500',
  economics: 'bg-yellow-500',
  science: 'bg-cyan-500',
  culture: 'bg-pink-500',
  'ai-tech': 'bg-violet-500',
  geopolitics: 'bg-red-500',
  unknown: 'bg-zinc-500',
}

export default function Dashboard(): React.ReactElement {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  async function load(): Promise<void> {
    try {
      const res = await fetch('/api/dashboard')
      if (res.ok) setData((await res.json()) as DashboardData)
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { void load() }, [])

  if (loading) return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="inline-block w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  if (!data) return (
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center text-zinc-400">
      No data yet — bot is starting up
    </div>
  )

  const pnlMax = Math.max(...data.pnlHistory.map((p) => Math.abs(p.pnl)), 1)

  return (
    <div className="min-h-screen bg-zinc-950">
      {/* Header */}
      <header className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">Polymarket Copy Trader</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Paper trading simulation</p>
          </div>
          <nav className="flex gap-2">
            <NavLink href="/analytics">Analytics</NavLink>
            <NavLink href="/paper-trading">Trades</NavLink>
            <NavLink href="/leaderboard">Leaderboard</NavLink>
          </nav>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
          <StatCard label="Total Equity" value={`$${data.totalEquity.toFixed(0)}`} color={data.totalEquity >= data.startingBalance ? 'text-emerald-400' : 'text-red-400'} />
          <StatCard label="Realized P&L" value={`${pnlStr(data.realizedPnl)}`} color={pnlColor(data.realizedPnl)} />
          <StatCard label="Unrealized" value={`${pnlStr(data.unrealizedPnl)}`} color={pnlColor(data.unrealizedPnl)} />
          <StatCard label="Win Rate" value={data.totalTrades > 0 ? `${(data.winRate * 100).toFixed(0)}%` : '—'} color="text-white" sub={`${data.wins}W / ${data.losses}L`} />
          <StatCard label="ROI" value={data.totalTrades > 0 ? `${(data.roi * 100).toFixed(1)}%` : '—'} color={pnlColor(data.roi)} />
          <StatCard label="Open" value={`${data.openTrades}`} color="text-indigo-400" sub={`$${data.totalInvested.toFixed(0)} at risk`} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* PnL Chart */}
          <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-medium text-zinc-400">P&L Over Time</h2>
              <span className={`text-lg font-bold ${pnlColor(data.realizedPnl)}`}>
                {pnlStr(data.realizedPnl)} USDC
              </span>
            </div>
            {data.pnlHistory.length > 1 ? (
              <div className="h-48 flex items-end gap-px">
                {data.pnlHistory.map((point, i) => {
                  const height = Math.max(Math.abs(point.pnl) / pnlMax * 100, 2)
                  const isPositive = point.pnl >= 0
                  return (
                    <div key={i} className="flex-1 flex flex-col justify-end relative group" title={`${point.date}: ${pnlStr(point.pnl)}`}>
                      <div
                        className={`w-full rounded-t-sm transition-all ${isPositive ? 'bg-emerald-500/70' : 'bg-red-500/70'} group-hover:${isPositive ? 'bg-emerald-400' : 'bg-red-400'}`}
                        style={{ height: `${height}%` }}
                      />
                      <div className="absolute -top-8 left-1/2 -translate-x-1/2 hidden group-hover:block bg-zinc-800 text-xs text-white px-2 py-1 rounded whitespace-nowrap z-10">
                        {point.date.slice(5)}: {pnlStr(point.pnl)}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="h-48 flex items-center justify-center text-zinc-600 text-sm">
                Chart will appear after trades resolve
              </div>
            )}
          </div>

          {/* Activity feed */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-zinc-400 mb-4">Bot Activity</h2>
            <div className="space-y-2 max-h-[250px] overflow-y-auto">
              {data.events.length > 0 ? data.events.map((e) => (
                <div key={e.id} className="flex gap-2 text-xs">
                  <span>{EVENT_ICONS[e.type] ?? '•'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-zinc-300 truncate">{e.message}</div>
                    {e.detail && <div className="text-zinc-600 truncate">{e.detail}</div>}
                  </div>
                  <span className="text-zinc-700 whitespace-nowrap">
                    {e.createdAt.slice(11, 16)}
                  </span>
                </div>
              )) : (
                <div className="text-zinc-600 text-xs">Waiting for bot activity...</div>
              )}
            </div>
          </div>
        </div>

        {/* Domain performance */}
        {data.domains.length > 0 && (
          <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-medium text-zinc-400 mb-4">Domain Performance</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {data.domains.map((d) => (
                <div key={d.domain} className="p-3 bg-zinc-800/50 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-2 h-2 rounded-full ${DOMAIN_COLORS[d.domain] ?? 'bg-zinc-500'}`} />
                    <span className="text-sm text-white capitalize">{d.domain}</span>
                  </div>
                  <div className={`text-lg font-bold ${pnlColor(d.pnl)}`}>{pnlStr(d.pnl)}</div>
                  <div className="text-xs text-zinc-500">{d.trades}t · {(d.winRate * 100).toFixed(0)}% WR</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick links */}
        <div className="mt-6 grid grid-cols-3 gap-3">
          <Link href="/analytics" className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl hover:border-zinc-600 transition-colors text-center">
            <div className="text-2xl mb-1">📊</div>
            <div className="text-sm text-zinc-300">Analytics</div>
            <div className="text-xs text-zinc-600">Full breakdown</div>
          </Link>
          <Link href="/paper-trading" className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl hover:border-zinc-600 transition-colors text-center">
            <div className="text-2xl mb-1">📋</div>
            <div className="text-sm text-zinc-300">Trades</div>
            <div className="text-xs text-zinc-600">{data.openTrades} open</div>
          </Link>
          <Link href="/leaderboard" className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl hover:border-zinc-600 transition-colors text-center">
            <div className="text-2xl mb-1">🏆</div>
            <div className="text-sm text-zinc-300">Leaderboard</div>
            <div className="text-xs text-zinc-600">Top experts</div>
          </Link>
        </div>
      </main>
    </div>
  )
}

function StatCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }): React.ReactElement {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3">
      <div className="text-[11px] text-zinc-500 uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-bold mt-1 ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-zinc-600 mt-0.5">{sub}</div>}
    </div>
  )
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Link href={href} className="px-3 py-1.5 text-xs text-zinc-400 hover:text-white border border-zinc-800 hover:border-zinc-600 rounded-lg transition-colors">
      {children}
    </Link>
  )
}
