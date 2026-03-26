'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

type Portfolio = {
  startingBalance: number
  currentBalance: number
  realizedPnl: number
  unrealizedPnl: number
  roi: number
  totalTrades: number
  openTrades: number
  closedTrades: number
  wins: number
  losses: number
  winRate: number
}

type DomainStat = { domain: string; trades: number; won: number; lost: number; winRate: number; pnl: number; avgPnl: number }
type ExpertStat = { expert: string; trades: number; won: number; lost: number; winRate: number; pnl: number; avgPnl: number }
type EntryBucket = { label: string; trades: number; won: number; winRate: number; pnl: number }
type SideStat = { trades: number; won: number; winRate: number; pnl: number }
type TradeInfo = { title: string; side: string; entryPrice: number; pnl: number; expert: string; domain: string }
type OpenInfo = { title: string; side: string; entryPrice: number; curPrice: number; unrealized: number; expert: string; domain: string }

type AnalyticsData = {
  portfolio: Portfolio
  byDomain: DomainStat[]
  byExpert: ExpertStat[]
  bySide: { yes: SideStat; no: SideStat }
  byEntry: EntryBucket[]
  byBetSize: { standard: SideStat; consensus: SideStat }
  bestTrades: TradeInfo[]
  worstTrades: TradeInfo[]
  topOpen: OpenInfo[]
}

function pnlColor(n: number): string {
  return n >= 0 ? 'text-emerald-400' : 'text-red-400'
}

function pnlStr(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`
}

function wrStr(n: number): string {
  return `${(n * 100).toFixed(0)}%`
}

export default function AnalyticsPage(): React.ReactElement {
  const [data, setData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/analytics')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Error ${res.status}`)
        return (await res.json()) as AnalyticsData
      })
      .then(setData)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="min-h-screen flex items-center justify-center text-zinc-400">Loading analytics...</div>
  if (error) return <div className="min-h-screen flex items-center justify-center text-red-400">{error}</div>
  if (!data) return <div className="min-h-screen flex items-center justify-center text-zinc-400">No data</div>

  const p = data.portfolio

  return (
    <main className="min-h-screen px-4 py-12 max-w-5xl mx-auto">
      {/* Nav */}
      <div className="flex items-center justify-between mb-8">
        <Link href="/" className="text-zinc-500 hover:text-zinc-300 text-sm">&larr; Back</Link>
        <div className="flex gap-3">
          <Link href="/paper-trading" className="text-zinc-500 hover:text-zinc-300 text-sm">Paper Trading</Link>
          <Link href="/monitor" className="text-zinc-500 hover:text-zinc-300 text-sm">Monitor</Link>
          <Link href="/leaderboard" className="text-zinc-500 hover:text-zinc-300 text-sm">Leaderboard</Link>
        </div>
      </div>

      <h1 className="text-3xl font-bold text-white mb-2">Analytics</h1>
      <p className="text-zinc-400 mb-8">Paper trading performance breakdown</p>

      {/* Portfolio overview */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
        <Stat label="Balance" value={`$${p.currentBalance.toFixed(0)}`} sub={`Started: $${p.startingBalance.toFixed(0)}`} color={p.currentBalance >= p.startingBalance ? 'text-emerald-400' : 'text-red-400'} />
        <Stat label="Realized P&L" value={pnlStr(p.realizedPnl)} sub={`Unrealized: ${pnlStr(p.unrealizedPnl)}`} color={pnlColor(p.realizedPnl)} />
        <Stat label="Win Rate" value={p.closedTrades > 0 ? wrStr(p.winRate) : '—'} sub={`${p.wins}W / ${p.losses}L`} color="text-white" />
        <Stat label="ROI" value={p.closedTrades > 0 ? `${(p.roi * 100).toFixed(1)}%` : '—'} sub={`${p.openTrades} open / ${p.totalTrades} total`} color={pnlColor(p.roi)} />
      </div>

      {/* By Domain */}
      {data.byDomain.length > 0 && (
        <Section title="Performance by Domain">
          <table className="w-full text-sm">
            <thead><tr className="text-zinc-500 text-xs">
              <th className="text-left py-2">Domain</th><th className="text-right">Trades</th><th className="text-right">Won</th><th className="text-right">WR</th><th className="text-right">P&L</th><th className="text-right">Avg</th>
            </tr></thead>
            <tbody>
              {data.byDomain.map((d) => (
                <tr key={d.domain} className="border-t border-zinc-800">
                  <td className="py-2 text-white capitalize">{d.domain}</td>
                  <td className="text-right text-zinc-400">{d.trades}</td>
                  <td className="text-right text-zinc-400">{d.won}</td>
                  <td className="text-right text-zinc-300">{wrStr(d.winRate)}</td>
                  <td className={`text-right font-medium ${pnlColor(d.pnl)}`}>{pnlStr(d.pnl)}</td>
                  <td className={`text-right ${pnlColor(d.avgPnl)}`}>{pnlStr(d.avgPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* By Expert */}
      {data.byExpert.length > 0 && (
        <Section title="Performance by Expert">
          <table className="w-full text-sm">
            <thead><tr className="text-zinc-500 text-xs">
              <th className="text-left py-2">Expert</th><th className="text-right">Trades</th><th className="text-right">WR</th><th className="text-right">P&L</th><th className="text-right">Avg</th>
            </tr></thead>
            <tbody>
              {data.byExpert.map((e) => (
                <tr key={e.expert} className="border-t border-zinc-800">
                  <td className="py-2 text-white truncate max-w-[200px]">{e.expert}</td>
                  <td className="text-right text-zinc-400">{e.trades}</td>
                  <td className="text-right text-zinc-300">{wrStr(e.winRate)}</td>
                  <td className={`text-right font-medium ${pnlColor(e.pnl)}`}>{pnlStr(e.pnl)}</td>
                  <td className={`text-right ${pnlColor(e.avgPnl)}`}>{pnlStr(e.avgPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* YES vs NO + Entry Price */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8">
        <Section title="YES vs NO">
          <div className="space-y-3">
            <SideRow label="YES" stat={data.bySide.yes} />
            <SideRow label="NO" stat={data.bySide.no} />
          </div>
        </Section>

        <Section title="Entry Price Analysis">
          <div className="space-y-3">
            {data.byEntry.map((b) => (
              <div key={b.label} className="flex items-center justify-between text-sm">
                <span className="text-zinc-300">{b.label}</span>
                <div className="flex gap-4 text-xs">
                  <span className="text-zinc-500">{b.trades}t</span>
                  <span className="text-zinc-400">{wrStr(b.winRate)}</span>
                  <span className={pnlColor(b.pnl)}>{pnlStr(b.pnl)}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* Consensus vs Standard */}
      <Section title="Standard vs Consensus Bets">
        <div className="grid grid-cols-2 gap-4">
          <div className="p-4 bg-zinc-800/50 rounded-lg">
            <div className="text-xs text-zinc-500 mb-1">Standard ($100)</div>
            <div className="text-lg font-bold text-white">{data.byBetSize.standard.trades} trades</div>
            <div className="text-sm text-zinc-400">WR {wrStr(data.byBetSize.standard.winRate)}</div>
            <div className={`text-sm font-medium ${pnlColor(data.byBetSize.standard.pnl)}`}>{pnlStr(data.byBetSize.standard.pnl)}</div>
          </div>
          <div className="p-4 bg-zinc-800/50 rounded-lg">
            <div className="text-xs text-zinc-500 mb-1">Consensus (&gt;$100)</div>
            <div className="text-lg font-bold text-white">{data.byBetSize.consensus.trades} trades</div>
            <div className="text-sm text-zinc-400">WR {wrStr(data.byBetSize.consensus.winRate)}</div>
            <div className={`text-sm font-medium ${pnlColor(data.byBetSize.consensus.pnl)}`}>{pnlStr(data.byBetSize.consensus.pnl)}</div>
          </div>
        </div>
      </Section>

      {/* Best & Worst */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8">
        {data.bestTrades.length > 0 && (
          <Section title="Top 5 Best Trades">
            {data.bestTrades.map((t, i) => (
              <TradeRow key={i} trade={t} />
            ))}
          </Section>
        )}
        {data.worstTrades.length > 0 && (
          <Section title="Top 5 Worst Trades">
            {data.worstTrades.map((t, i) => (
              <TradeRow key={i} trade={t} />
            ))}
          </Section>
        )}
      </div>

      {/* Open positions */}
      {data.topOpen.length > 0 && (
        <Section title="Top Open Positions (by unrealized P&L)">
          {data.topOpen.map((t, i) => (
            <div key={i} className="flex items-center gap-3 py-2 text-sm border-b border-zinc-800 last:border-0">
              <span className={`font-medium ${pnlColor(t.unrealized)}`}>{pnlStr(t.unrealized)}</span>
              <span className={`text-xs ${t.side === 'YES' ? 'text-emerald-400' : 'text-red-400'}`}>{t.side}</span>
              <span className="text-zinc-300 flex-1 truncate">{t.title}</span>
              <span className="text-zinc-500 text-xs">{(t.entryPrice * 100).toFixed(0)}¢ → {(t.curPrice * 100).toFixed(0)}¢</span>
            </div>
          ))}
        </Section>
      )}

      {p.closedTrades === 0 && (
        <div className="text-center py-16 border border-zinc-800 rounded-xl">
          <p className="text-zinc-400 text-lg">No closed trades yet</p>
          <p className="text-zinc-600 mt-2">Analytics will populate as markets resolve. Check back in 24-48h.</p>
        </div>
      )}
    </main>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }): React.ReactElement {
  return (
    <div className="p-4 bg-zinc-900 border border-zinc-800 rounded-xl">
      <div className="text-xs text-zinc-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-zinc-600 mt-1">{sub}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-8">
      <h2 className="text-sm uppercase tracking-wider text-zinc-500 mb-3">{title}</h2>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">{children}</div>
    </div>
  )
}

function SideRow({ label, stat }: { label: string; stat: { trades: number; won: number; winRate: number; pnl: number } }): React.ReactElement {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={`font-medium ${label === 'YES' ? 'text-emerald-400' : 'text-red-400'}`}>{label}</span>
      <div className="flex gap-4 text-xs">
        <span className="text-zinc-500">{stat.trades} trades</span>
        <span className="text-zinc-400">WR {wrStr(stat.winRate)}</span>
        <span className={pnlColor(stat.pnl)}>{pnlStr(stat.pnl)}</span>
      </div>
    </div>
  )
}

function TradeRow({ trade }: { trade: TradeInfo }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 py-2 text-sm border-b border-zinc-800 last:border-0">
      <span className={`font-medium w-16 text-right ${pnlColor(trade.pnl)}`}>{pnlStr(trade.pnl)}</span>
      <span className={`text-xs ${trade.side === 'YES' ? 'text-emerald-400' : 'text-red-400'}`}>{trade.side}</span>
      <span className="text-zinc-500 text-xs">{(trade.entryPrice * 100).toFixed(0)}¢</span>
      <span className="text-zinc-300 flex-1 truncate">{trade.title}</span>
      <span className="text-zinc-600 text-xs">{trade.domain}</span>
    </div>
  )
}
