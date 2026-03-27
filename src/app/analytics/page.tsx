'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

// Design system — same as dashboard
const COLORS = {
  bg: '#171821',
  card: '#21222D',
  surface: '#2B2B36',
  teal: '#A9DFD8',
  amber: '#FCB859',
  pink: '#F2C8ED',
  red: '#EA1701',
  green: '#029F04',
  blue: '#28AEF3',
  textMuted: '#87888C',
  textLight: '#D2D2D2',
}

type Portfolio = {
  startingBalance: number
  currentBalance: number
  realizedPnl: number
  unrealizedPnl: number
  totalInvested: number
  availableCash: number
  totalRedeemable: number
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

type ExpertTrustInfo = {
  expert: string
  phase: string
  status: string
  trustLevel: number
  resolvedTrades: number
  winRate: number
  pnl: number
  reason: string
}

type Gate = { value: number; threshold: number; ok: boolean }
type Gates = {
  profitFactor: Gate
  maxConsecutiveLosses: Gate
  avgPnlPerTrade: Gate
  minResolvedTrades: Gate
  allOk: boolean
}
type Stats = {
  profitFactor: number
  maxConsecutiveLosses: number
  avgPnlPerTrade: number
  maxDrawdown: number
  significance: 'not_significant' | 'low' | 'medium' | 'high'
  winRateCI: { low: number; high: number }
  grossWins: number
  grossLosses: number
}
type EquityPoint = { day: string; balance: number; dailyPnl: number; trades: number }

type AnalyticsData = {
  portfolio: Portfolio
  gates: Gates
  stats: Stats
  equityCurve: EquityPoint[]
  byDomain: DomainStat[]
  byExpert: ExpertStat[]
  bySide: { yes: SideStat; no: SideStat }
  byEntry: EntryBucket[]
  byBetSize: { standard: SideStat; consensus: SideStat }
  bestTrades: TradeInfo[]
  worstTrades: TradeInfo[]
  topOpen: OpenInfo[]
  expertTrust: ExpertTrustInfo[]
}

function pnlColor(n: number): string {
  return n >= 0 ? COLORS.teal : COLORS.red
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
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function loadData(): Promise<void> {
    try {
      const res = await fetch('/api/analytics')
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const result = (await res.json()) as AnalyticsData
      setData(result)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    }
  }

  async function refresh(): Promise<void> {
    setRefreshing(true)
    await fetch('/api/paper-trading?action=refresh').catch(() => {})
    await fetch('/api/paper-trading?action=resolve').catch(() => {})
    await loadData()
    setRefreshing(false)
  }

  useEffect(() => {
    loadData().finally(() => setLoading(false))
    const interval = setInterval(() => { void loadData() }, 30_000)
    return () => clearInterval(interval)
  }, [])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: COLORS.bg }}>
      <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: COLORS.teal, borderTopColor: 'transparent' }} />
    </div>
  )

  if (error) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: COLORS.bg, color: COLORS.red }}>
      {error}
    </div>
  )

  if (!data) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: COLORS.bg, color: COLORS.textMuted }}>
      No data
    </div>
  )

  const p = data.portfolio

  return (
    <div className="min-h-screen" style={{ background: COLORS.bg, color: COLORS.textLight }}>
      <div className="flex">
        {/* Sidebar */}
        <aside className="hidden lg:flex flex-col w-56 min-h-screen p-5 border-r" style={{ background: COLORS.card, borderColor: COLORS.surface }}>
          <div className="mb-10">
            <h1 className="text-lg font-bold text-white">Copy Trader</h1>
            <p className="text-xs mt-1" style={{ color: COLORS.textMuted }}>Paper simulation</p>
          </div>
          <nav className="flex flex-col gap-1">
            <SideLink href="/">Dashboard</SideLink>
            <SideLink href="/analytics" active>Analytics</SideLink>
            <SideLink href="/paper-trading">Trades</SideLink>
            <SideLink href="/leaderboard">Leaderboard</SideLink>
            <SideLink href="/settings">Settings</SideLink>
          </nav>
          <div className="mt-auto pt-8">
            <div className="p-3 rounded-lg" style={{ background: COLORS.surface }}>
              <div className="text-xs" style={{ color: COLORS.textMuted }}>Bot Status</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: COLORS.green }} />
                <span className="text-xs text-white">Running</span>
              </div>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 p-6 lg:p-8">
          {/* Mobile nav */}
          <div className="lg:hidden flex items-center justify-between mb-6">
            <h1 className="text-lg font-bold text-white">Copy Trader</h1>
            <div className="flex gap-2">
              <Link href="/" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Dashboard</Link>
              <Link href="/leaderboard" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Leaderboard</Link>
            </div>
          </div>

          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-2xl font-bold text-white">Analytics</h2>
              <p className="mt-1 text-sm" style={{ color: COLORS.textMuted }}>Paper trading performance breakdown</p>
            </div>
            <button
              onClick={() => void refresh()}
              disabled={refreshing}
              className="px-5 py-2 text-sm font-medium rounded-lg transition-colors"
              style={{
                background: refreshing ? COLORS.surface : COLORS.teal,
                color: refreshing ? COLORS.textMuted : COLORS.bg,
              }}
            >
              {refreshing ? 'Refreshing...' : 'Refresh All'}
            </button>
          </div>

          {/* Portfolio overview */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <StatCard label="Balance" value={`$${p.currentBalance.toFixed(0)}`} sub={`Started: $${p.startingBalance.toFixed(0)}`} color={p.currentBalance >= p.startingBalance ? COLORS.teal : COLORS.red} />
            <StatCard label="Realized P&L" value={pnlStr(p.realizedPnl)} sub={`Unrealized: ${pnlStr(p.unrealizedPnl)}`} color={pnlColor(p.realizedPnl)} />
            <StatCard label="Win Rate" value={p.closedTrades > 0 ? wrStr(p.winRate) : '—'} sub={`${p.wins}W / ${p.losses}L`} color={COLORS.amber} />
            <StatCard label="ROI" value={p.closedTrades > 0 ? `${(p.roi * 100).toFixed(1)}%` : '—'} sub={`${p.openTrades} open / ${p.totalTrades} total`} color={pnlColor(p.roi)} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
            <StatCard label="Invested (at risk)" value={`$${p.totalInvested.toFixed(0)}`} sub={`${p.openTrades} positions`} color={COLORS.amber} />
            <StatCard label="Available Cash" value={`$${p.availableCash.toFixed(0)}`} sub={`${((p.availableCash / p.startingBalance) * 100).toFixed(0)}% of start`} color={p.availableCash > 0 ? COLORS.textLight : COLORS.red} />
            <StatCard label="Redeemable Value" value={`$${p.totalRedeemable.toFixed(0)}`} sub="If sold all now" color={COLORS.blue} />
            <StatCard label="Total Equity" value={`$${(p.availableCash + p.totalRedeemable).toFixed(0)}`} sub="Cash + positions" color={(p.availableCash + p.totalRedeemable) >= p.startingBalance ? COLORS.teal : COLORS.red} />
          </div>

          {/* Validation Gates */}
          {data.gates && (
            <div className="mb-8 rounded-xl p-5 border" style={{ background: COLORS.card, borderColor: data.gates.allOk ? COLORS.teal : COLORS.amber }}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-white">Validation Gates — Avant passage en réel</h3>
                <span className="text-sm font-bold px-3 py-1 rounded-full" style={{
                  background: data.gates.allOk ? COLORS.teal : COLORS.amber,
                  color: COLORS.bg,
                }}>
                  {data.gates.allOk ? '✅ PRÊT' : '🔴 PAS ENCORE'}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Profit Factor', value: data.gates.profitFactor.value === 999 ? '∞' : data.gates.profitFactor.value.toFixed(2), threshold: '≥ 1.30', ok: data.gates.profitFactor.ok },
                  { label: 'Max pertes consécutives', value: data.gates.maxConsecutiveLosses.value.toString(), threshold: '≤ 15', ok: data.gates.maxConsecutiveLosses.ok },
                  { label: 'PnL moyen/trade', value: `${data.gates.avgPnlPerTrade.value >= 0 ? '+' : ''}$${data.gates.avgPnlPerTrade.value.toFixed(2)}`, threshold: '> +$5', ok: data.gates.avgPnlPerTrade.ok },
                  { label: 'Trades résolus', value: data.gates.minResolvedTrades.value.toString(), threshold: '≥ 4000', ok: data.gates.minResolvedTrades.ok },
                ].map((g) => (
                  <div key={g.label} className="rounded-lg p-3" style={{ background: COLORS.surface }}>
                    <div className="text-xs mb-1" style={{ color: COLORS.textMuted }}>{g.label}</div>
                    <div className="text-lg font-bold" style={{ color: g.ok ? COLORS.teal : COLORS.amber }}>{g.value}</div>
                    <div className="text-xs mt-1" style={{ color: COLORS.textMuted }}>seuil: {g.threshold}</div>
                    <div className="text-xs font-medium mt-1" style={{ color: g.ok ? COLORS.teal : COLORS.amber }}>{g.ok ? '✅' : '⏳'}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Advanced Stats */}
          {data.stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
              <StatCard
                label="Profit Factor"
                value={data.stats.profitFactor === 999 ? '∞' : data.stats.profitFactor.toFixed(2)}
                sub={data.stats.profitFactor >= 1.3 ? '✅ Good edge' : '⏳ Need > 1.3'}
                color={data.stats.profitFactor >= 1.3 ? COLORS.teal : COLORS.amber}
              />
              <StatCard
                label="WR intervalle 95%"
                value={`[${(data.stats.winRateCI.low * 100).toFixed(0)}%–${(data.stats.winRateCI.high * 100).toFixed(0)}%]`}
                sub={{
                  not_significant: '⚠️ < 100 trades',
                  low: '🟡 100-1000 trades',
                  medium: '🟠 1000-4000 trades',
                  high: '🟢 4000+ trades',
                }[data.stats.significance]}
                color={COLORS.blue}
              />
              <StatCard
                label="Max Drawdown"
                value={`-${(data.stats.maxDrawdown * 100).toFixed(1)}%`}
                sub="Depuis le pic"
                color={data.stats.maxDrawdown < 0.2 ? COLORS.teal : COLORS.red}
              />
              <StatCard
                label="Max pertes consécutives"
                value={data.stats.maxConsecutiveLosses.toString()}
                sub={data.stats.maxConsecutiveLosses <= 15 ? '✅ Ok' : '⚠️ Élevé'}
                color={data.stats.maxConsecutiveLosses <= 15 ? COLORS.teal : COLORS.amber}
              />
            </div>
          )}

          {/* Equity Curve */}
          {data.equityCurve && data.equityCurve.length > 1 && (
            <Section title="Courbe d'équité">
              <div className="space-y-1">
                {(() => {
                  const maxAbs = Math.max(...data.equityCurve.map((d) => Math.abs(d.dailyPnl)), 1)
                  return data.equityCurve.map((d) => {
                    const barPct = Math.abs(d.dailyPnl) / maxAbs * 100
                    const isPos = d.dailyPnl >= 0
                    return (
                      <div key={d.day} className="flex items-center gap-3 text-xs">
                        <span className="w-24 shrink-0" style={{ color: COLORS.textMuted }}>{d.day}</span>
                        <span className="w-24 shrink-0 text-right font-mono text-white">${d.balance.toFixed(0)}</span>
                        <div className="flex-1 h-4 rounded overflow-hidden" style={{ background: COLORS.surface }}>
                          <div
                            className="h-full rounded transition-all"
                            style={{
                              width: `${barPct}%`,
                              background: isPos ? COLORS.teal : COLORS.red,
                              opacity: 0.85,
                            }}
                          />
                        </div>
                        <span className="w-20 shrink-0 text-right font-mono" style={{ color: isPos ? COLORS.teal : COLORS.red }}>
                          {isPos ? '+' : ''}{d.dailyPnl.toFixed(0)}
                        </span>
                        <span className="w-12 shrink-0 text-right" style={{ color: COLORS.textMuted }}>{d.trades}t</span>
                      </div>
                    )
                  })
                })()}
              </div>
            </Section>
          )}

          {/* By Domain */}
          {data.byDomain.length > 0 && (
            <Section title="Performance by Domain">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs" style={{ color: COLORS.textMuted }}>
                    <th className="text-left py-2">Domain</th>
                    <th className="text-right">Trades</th>
                    <th className="text-right">Won</th>
                    <th className="text-right">WR</th>
                    <th className="text-right">P&L</th>
                    <th className="text-right">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byDomain.map((d) => (
                    <tr key={d.domain} className="border-t" style={{ borderColor: COLORS.surface }}>
                      <td className="py-2 capitalize" style={{ color: COLORS.textLight }}>{d.domain}</td>
                      <td className="text-right" style={{ color: COLORS.textMuted }}>{d.trades}</td>
                      <td className="text-right" style={{ color: COLORS.textMuted }}>{d.won}</td>
                      <td className="text-right" style={{ color: COLORS.textLight }}>{wrStr(d.winRate)}</td>
                      <td className="text-right font-medium" style={{ color: pnlColor(d.pnl) }}>{pnlStr(d.pnl)}</td>
                      <td className="text-right" style={{ color: pnlColor(d.avgPnl) }}>{pnlStr(d.avgPnl)}</td>
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
                <thead>
                  <tr className="text-xs" style={{ color: COLORS.textMuted }}>
                    <th className="text-left py-2">Expert</th>
                    <th className="text-right">Trades</th>
                    <th className="text-right">WR</th>
                    <th className="text-right">P&L</th>
                    <th className="text-right">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byExpert.map((e) => (
                    <tr key={e.expert} className="border-t" style={{ borderColor: COLORS.surface }}>
                      <td className="py-2 truncate max-w-[200px]" style={{ color: COLORS.textLight }}>{e.expert}</td>
                      <td className="text-right" style={{ color: COLORS.textMuted }}>{e.trades}</td>
                      <td className="text-right" style={{ color: COLORS.textLight }}>{wrStr(e.winRate)}</td>
                      <td className="text-right font-medium" style={{ color: pnlColor(e.pnl) }}>{pnlStr(e.pnl)}</td>
                      <td className="text-right" style={{ color: pnlColor(e.avgPnl) }}>{pnlStr(e.avgPnl)}</td>
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
                    <span style={{ color: COLORS.textLight }}>{b.label}</span>
                    <div className="flex gap-4 text-xs">
                      <span style={{ color: COLORS.textMuted }}>{b.trades}t</span>
                      <span style={{ color: COLORS.textLight }}>{wrStr(b.winRate)}</span>
                      <span style={{ color: pnlColor(b.pnl) }}>{pnlStr(b.pnl)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          </div>

          {/* Expert Trust */}
          {data.expertTrust && data.expertTrust.length > 0 && (
            <Section title="Expert Trust Levels">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs" style={{ color: COLORS.textMuted }}>
                    <th className="text-left py-2">Expert</th>
                    <th className="text-right">Phase</th>
                    <th className="text-right">Trust</th>
                    <th className="text-right">Trades</th>
                    <th className="text-right">WR</th>
                    <th className="text-right">P&L</th>
                    <th className="text-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.expertTrust.map((e) => (
                    <tr key={e.expert} className="border-t" style={{ borderColor: COLORS.surface }}>
                      <td className="py-2 truncate max-w-[180px]" style={{ color: COLORS.textLight }}>{e.expert}</td>
                      <td className="text-right text-xs" style={{ color: COLORS.textMuted }}>{e.phase}</td>
                      <td className="text-right font-medium" style={{
                        color: e.trustLevel >= 1 ? COLORS.teal :
                          e.trustLevel >= 0.5 ? COLORS.amber :
                          e.trustLevel > 0 ? '#fb923c' : COLORS.red
                      }}>
                        {(e.trustLevel * 100).toFixed(0)}%
                      </td>
                      <td className="text-right" style={{ color: COLORS.textMuted }}>{e.resolvedTrades}</td>
                      <td className="text-right" style={{ color: COLORS.textLight }}>{e.resolvedTrades > 0 ? wrStr(e.winRate) : '—'}</td>
                      <td className="text-right font-medium" style={{ color: pnlColor(e.pnl) }}>{e.resolvedTrades > 0 ? pnlStr(e.pnl) : '—'}</td>
                      <td className="text-right">
                        <span className="text-xs px-2 py-0.5 rounded" style={{
                          background: e.status === 'active' ? `${COLORS.teal}22` :
                            e.status === 'reduced' ? `${COLORS.amber}22` : `${COLORS.red}22`,
                          color: e.status === 'active' ? COLORS.teal :
                            e.status === 'reduced' ? COLORS.amber : COLORS.red,
                        }}>
                          {e.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {/* Standard vs Consensus */}
          <Section title="Standard vs Consensus Bets">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-lg" style={{ background: COLORS.surface }}>
                <div className="text-xs mb-1" style={{ color: COLORS.textMuted }}>Standard ($100)</div>
                <div className="text-lg font-bold text-white">{data.byBetSize.standard.trades} trades</div>
                <div className="text-sm" style={{ color: COLORS.textMuted }}>WR {wrStr(data.byBetSize.standard.winRate)}</div>
                <div className="text-sm font-medium" style={{ color: pnlColor(data.byBetSize.standard.pnl) }}>{pnlStr(data.byBetSize.standard.pnl)}</div>
              </div>
              <div className="p-4 rounded-lg" style={{ background: COLORS.surface }}>
                <div className="text-xs mb-1" style={{ color: COLORS.textMuted }}>Consensus (&gt;$100)</div>
                <div className="text-lg font-bold text-white">{data.byBetSize.consensus.trades} trades</div>
                <div className="text-sm" style={{ color: COLORS.textMuted }}>WR {wrStr(data.byBetSize.consensus.winRate)}</div>
                <div className="text-sm font-medium" style={{ color: pnlColor(data.byBetSize.consensus.pnl) }}>{pnlStr(data.byBetSize.consensus.pnl)}</div>
              </div>
            </div>
          </Section>

          {/* Best & Worst */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-8">
            {data.bestTrades.length > 0 && (
              <Section title="Top 5 Best Trades">
                {data.bestTrades.map((t, i) => <TradeRow key={i} trade={t} />)}
              </Section>
            )}
            {data.worstTrades.length > 0 && (
              <Section title="Top 5 Worst Trades">
                {data.worstTrades.map((t, i) => <TradeRow key={i} trade={t} />)}
              </Section>
            )}
          </div>

          {/* Open positions */}
          {data.topOpen.length > 0 && (
            <Section title="Top Open Positions (by unrealized P&L)">
              {data.topOpen.map((t, i) => (
                <div key={i} className="flex items-center gap-3 py-2 text-sm border-b last:border-0" style={{ borderColor: COLORS.surface }}>
                  <span className="font-medium" style={{ color: pnlColor(t.unrealized) }}>{pnlStr(t.unrealized)}</span>
                  <span className="text-xs" style={{ color: t.side === 'YES' ? COLORS.teal : COLORS.red }}>{t.side}</span>
                  <span className="flex-1 truncate" style={{ color: COLORS.textLight }}>{t.title}</span>
                  <span className="text-xs" style={{ color: COLORS.textMuted }}>{(t.entryPrice * 100).toFixed(0)}¢ → {(t.curPrice * 100).toFixed(0)}¢</span>
                </div>
              ))}
            </Section>
          )}

          {p.closedTrades === 0 && (
            <div className="text-center py-16 border rounded-xl" style={{ borderColor: COLORS.surface }}>
              <p className="text-lg" style={{ color: COLORS.textMuted }}>No closed trades yet</p>
              <p className="mt-2 text-sm" style={{ color: COLORS.surface }}>Analytics will populate as markets resolve. Check back in 24-48h.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }): React.ReactElement {
  return (
    <div className="p-4 rounded-xl" style={{ background: COLORS.card }}>
      <div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: COLORS.textMuted }}>{label}</div>
      <div className="text-xl font-bold" style={{ color }}>{value}</div>
      <div className="text-xs mt-1" style={{ color: COLORS.textMuted }}>{sub}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-8">
      <h2 className="text-xs uppercase tracking-wider mb-3" style={{ color: COLORS.textMuted }}>{title}</h2>
      <div className="rounded-xl p-4" style={{ background: COLORS.card }}>{children}</div>
    </div>
  )
}

function SideRow({ label, stat }: { label: string; stat: { trades: number; won: number; winRate: number; pnl: number } }): React.ReactElement {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="font-medium" style={{ color: label === 'YES' ? COLORS.teal : COLORS.red }}>{label}</span>
      <div className="flex gap-4 text-xs">
        <span style={{ color: COLORS.textMuted }}>{stat.trades} trades</span>
        <span style={{ color: COLORS.textLight }}>WR {wrStr(stat.winRate)}</span>
        <span style={{ color: pnlColor(stat.pnl) }}>{pnlStr(stat.pnl)}</span>
      </div>
    </div>
  )
}

function TradeRow({ trade }: { trade: { title: string; side: string; entryPrice: number; pnl: number; domain: string } }): React.ReactElement {
  return (
    <div className="flex items-center gap-3 py-2 text-sm border-b last:border-0" style={{ borderColor: COLORS.surface }}>
      <span className="font-medium w-16 text-right" style={{ color: pnlColor(trade.pnl) }}>{pnlStr(trade.pnl)}</span>
      <span className="text-xs" style={{ color: trade.side === 'YES' ? COLORS.teal : COLORS.red }}>{trade.side}</span>
      <span className="text-xs" style={{ color: COLORS.textMuted }}>{(trade.entryPrice * 100).toFixed(0)}¢</span>
      <span className="flex-1 truncate" style={{ color: COLORS.textLight }}>{trade.title}</span>
      <span className="text-xs" style={{ color: COLORS.textMuted }}>{trade.domain}</span>
    </div>
  )
}

function SideLink({ href, children, active }: { href: string; children: React.ReactNode; active?: boolean }): React.ReactElement {
  return (
    <Link
      href={href}
      className="px-3 py-2 rounded-lg text-sm transition-colors"
      style={{
        background: active ? COLORS.surface : 'transparent',
        color: active ? COLORS.teal : COLORS.textMuted,
      }}
    >
      {children}
    </Link>
  )
}
