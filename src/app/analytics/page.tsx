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

type Costs = {
  totalEntryFees: number
  totalExitFees: number
  totalFees: number
  totalSlippage: number
  totalCost: number
  preCostPnl: number
  costPct: number
  feePct: number
  slippagePct: number
  totalDeployed: number
}

type AnalyticsData = {
  portfolio: Portfolio
  gates: Gates
  stats: Stats
  costs: Costs
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

          {/* ── BLOCK 1: Bottom line ─────────────────────────────────── */}
          <div className="rounded-xl p-6 mb-5" style={{ background: COLORS.card }}>
            {/* Main numbers */}
            <div className="flex flex-wrap items-end gap-6 mb-5">
              <div>
                <div className="text-xs uppercase tracking-wider mb-1" style={{ color: COLORS.textMuted }}>Total Equity</div>
                <div className="text-4xl font-bold" style={{ color: (p.availableCash + p.totalRedeemable) >= p.startingBalance ? COLORS.teal : COLORS.red }}>
                  ${(p.availableCash + p.totalRedeemable).toFixed(0)}
                </div>
                <div className="text-sm mt-1" style={{ color: COLORS.textMuted }}>started at ${p.startingBalance.toFixed(0)}</div>
              </div>
              <div className="pb-1">
                <div className="text-2xl font-bold" style={{ color: pnlColor(p.realizedPnl) }}>
                  {pnlStr(p.realizedPnl)} realized
                </div>
                <div className="text-sm" style={{ color: COLORS.textMuted }}>
                  {pnlStr(p.unrealizedPnl)} unrealized · {(p.roi * 100).toFixed(1)}% ROI
                </div>
              </div>
            </div>

            {/* P&L waterfall — costs flow left-to-right REDUCING the pre-cost alpha */}
            {data.stats && data.costs && (
              <div className="mb-5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  {/* Pre-cost alpha */}
                  <div className="flex flex-col items-center px-4 py-2 rounded-lg" style={{ background: COLORS.surface }}>
                    <span className="text-xs mb-0.5" style={{ color: COLORS.textMuted }}>Alpha before costs</span>
                    <span className="font-bold" style={{ color: COLORS.teal }}>+${data.costs.preCostPnl.toFixed(0)}</span>
                  </div>

                  <div className="flex flex-col items-center gap-1">
                    <span className="text-lg" style={{ color: COLORS.textMuted }}>−</span>
                  </div>

                  {/* Fees */}
                  <div className="flex flex-col items-center px-4 py-2 rounded-lg border" style={{ background: COLORS.surface, borderColor: `${COLORS.amber}55` }}>
                    <span className="text-xs mb-0.5" style={{ color: COLORS.amber }}>Fees (2% taker)</span>
                    <span className="font-bold" style={{ color: COLORS.amber }}>−${data.costs.totalFees.toFixed(0)}</span>
                    <span className="text-[10px]" style={{ color: COLORS.textMuted }}>{(data.costs.feePct * 100).toFixed(1)}% of deployed</span>
                  </div>

                  <div className="flex flex-col items-center gap-1">
                    <span className="text-lg" style={{ color: COLORS.textMuted }}>−</span>
                  </div>

                  {/* Slippage */}
                  <div className="flex flex-col items-center px-4 py-2 rounded-lg border" style={{ background: COLORS.surface, borderColor: `${COLORS.amber}55` }}>
                    <span className="text-xs mb-0.5" style={{ color: COLORS.amber }}>Slippage (est.)</span>
                    <span className="font-bold" style={{ color: COLORS.amber }}>−${data.costs.totalSlippage.toFixed(0)}</span>
                    <span className="text-[10px]" style={{ color: COLORS.textMuted }}>{(data.costs.slippagePct * 100).toFixed(1)}% of deployed</span>
                  </div>

                  <div className="flex flex-col items-center gap-1">
                    <span className="text-lg font-bold" style={{ color: COLORS.textMuted }}>=</span>
                  </div>

                  {/* Net realized */}
                  <div className="flex flex-col items-center px-4 py-2 rounded-lg border-2" style={{
                    background: COLORS.surface,
                    borderColor: p.realizedPnl >= 0 ? COLORS.teal : COLORS.red,
                  }}>
                    <span className="text-xs mb-0.5 font-medium" style={{ color: COLORS.textMuted }}>Net realized P&L</span>
                    <span className="text-lg font-bold" style={{ color: pnlColor(p.realizedPnl) }}>{pnlStr(p.realizedPnl)}</span>
                    <span className="text-[10px]" style={{ color: COLORS.textMuted }}>costs already deducted</span>
                  </div>
                </div>

                {/* Visual proportion bar */}
                {data.costs.preCostPnl > 0 && (
                  <div className="mt-3">
                    <div className="h-2 rounded-full overflow-hidden flex gap-0.5" style={{ background: COLORS.surface }}>
                      <div style={{
                        width: `${Math.max((p.realizedPnl / data.costs.preCostPnl) * 100, 0)}%`,
                        background: COLORS.teal,
                        borderRadius: '4px',
                      }} />
                      <div style={{
                        width: `${(data.costs.totalFees / data.costs.preCostPnl) * 100}%`,
                        background: COLORS.amber,
                        opacity: 0.8,
                      }} />
                      <div style={{
                        width: `${(data.costs.totalSlippage / data.costs.preCostPnl) * 100}%`,
                        background: COLORS.amber,
                        opacity: 0.5,
                      }} />
                    </div>
                    <div className="flex gap-4 mt-1 text-[10px]" style={{ color: COLORS.textMuted }}>
                      <span><span className="inline-block w-2 h-1.5 rounded-sm mr-1 align-middle" style={{ background: COLORS.teal }} />Net P&L {((p.realizedPnl / data.costs.preCostPnl) * 100).toFixed(0)}%</span>
                      <span><span className="inline-block w-2 h-1.5 rounded-sm mr-1 align-middle" style={{ background: COLORS.amber, opacity: 0.8 }} />Fees {((data.costs.totalFees / data.costs.preCostPnl) * 100).toFixed(0)}%</span>
                      <span><span className="inline-block w-2 h-1.5 rounded-sm mr-1 align-middle" style={{ background: COLORS.amber, opacity: 0.5 }} />Slippage {((data.costs.totalSlippage / data.costs.preCostPnl) * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Capital state bar */}
            {(() => {
              const total = p.startingBalance
              const cashPct = Math.min((p.availableCash / total) * 100, 100)
              const redeemPct = Math.min((p.totalRedeemable / total) * 100, 100)
              return (
                <div>
                  <div className="flex items-center justify-between text-xs mb-1" style={{ color: COLORS.textMuted }}>
                    <span>Capital allocation</span>
                    <span>${p.startingBalance.toFixed(0)} total</span>
                  </div>
                  <div className="h-6 rounded-lg overflow-hidden flex" style={{ background: COLORS.surface }}>
                    <div style={{ width: `${cashPct}%`, background: COLORS.blue, opacity: 0.8 }} title={`Cash: $${p.availableCash.toFixed(0)}`} />
                    <div style={{ width: `${redeemPct}%`, background: COLORS.teal, opacity: 0.7 }} title={`In positions: $${p.totalRedeemable.toFixed(0)}`} />
                  </div>
                  <div className="flex gap-4 mt-1.5 text-xs" style={{ color: COLORS.textMuted }}>
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ background: COLORS.blue }} />${p.availableCash.toFixed(0)} cash ({((p.availableCash / p.startingBalance) * 100).toFixed(0)}%)</span>
                    <span><span className="inline-block w-2 h-2 rounded-sm mr-1" style={{ background: COLORS.teal }} />${p.totalRedeemable.toFixed(0)} in {p.openTrades} positions</span>
                    <span style={{ color: COLORS.textMuted }}>${p.totalInvested.toFixed(0)} invested at cost</span>
                  </div>
                </div>
              )
            })()}
          </div>

          {/* ── BLOCK 2: Edge + Risk (side by side) ──────────────────── */}
          {data.stats && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-5">
              {/* Edge quality */}
              <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
                <div className="text-xs uppercase tracking-wider mb-4" style={{ color: COLORS.textMuted }}>Edge Quality</div>
                <div className="space-y-4">
                  {/* Win rate row */}
                  <div>
                    <div className="flex items-end justify-between mb-1">
                      <span className="text-sm" style={{ color: COLORS.textLight }}>Win Rate</span>
                      <span className="text-lg font-bold" style={{ color: COLORS.amber }}>{wrStr(p.winRate)}</span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: COLORS.surface }}>
                      <div className="h-full rounded-full" style={{ width: `${p.winRate * 100}%`, background: COLORS.amber }} />
                    </div>
                    <div className="flex justify-between text-xs mt-1" style={{ color: COLORS.textMuted }}>
                      <span>{p.wins}W · {p.losses}L · {p.closedTrades} resolved</span>
                      <span>95% CI [{(data.stats.winRateCI.low * 100).toFixed(0)}%–{(data.stats.winRateCI.high * 100).toFixed(0)}%] {
                        { not_significant: '⚠️ not sig.', low: '🟡 low sig.', medium: '🟠 medium', high: '🟢 high' }[data.stats.significance]
                      }</span>
                    </div>
                  </div>
                  {/* Profit factor */}
                  <div className="flex items-center justify-between py-3 border-t border-b" style={{ borderColor: COLORS.surface }}>
                    <div>
                      <div className="text-xs" style={{ color: COLORS.textMuted }}>Profit Factor</div>
                      <div className="text-xs mt-0.5" style={{ color: COLORS.textMuted }}>gross wins ÷ gross losses</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold" style={{ color: data.stats.profitFactor >= 1.3 ? COLORS.teal : COLORS.amber }}>
                        {data.stats.profitFactor === 999 ? '∞' : data.stats.profitFactor.toFixed(2)}
                      </div>
                      <div className="text-xs" style={{ color: data.stats.profitFactor >= 1.3 ? COLORS.teal : COLORS.amber }}>
                        {data.stats.profitFactor >= 1.3 ? '✅ edge confirmed' : '⏳ need ≥ 1.30'}
                      </div>
                    </div>
                  </div>
                  {/* Avg P&L / trade */}
                  <div className="flex items-center justify-between">
                    <div className="text-sm" style={{ color: COLORS.textLight }}>Avg P&L / trade</div>
                    <div className="text-right">
                      <div className="text-lg font-bold" style={{ color: pnlColor(data.stats.avgPnlPerTrade) }}>
                        {data.stats.avgPnlPerTrade >= 0 ? '+' : ''}${data.stats.avgPnlPerTrade.toFixed(2)}
                      </div>
                      <div className="text-xs" style={{ color: COLORS.textMuted }}>threshold: &gt; +$5</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Risk + live gate */}
              <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
                <div className="text-xs uppercase tracking-wider mb-4" style={{ color: COLORS.textMuted }}>Risk & Live Readiness</div>
                <div className="space-y-3">
                  {/* Drawdown */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm" style={{ color: COLORS.textLight }}>Max Drawdown</div>
                      <div className="text-xs" style={{ color: COLORS.textMuted }}>from peak equity</div>
                    </div>
                    <div className="text-xl font-bold" style={{ color: data.stats.maxDrawdown < 0.2 ? COLORS.teal : COLORS.red }}>
                      -{(data.stats.maxDrawdown * 100).toFixed(1)}%
                    </div>
                  </div>
                  <div className="flex items-center justify-between py-3 border-t border-b" style={{ borderColor: COLORS.surface }}>
                    <div>
                      <div className="text-sm" style={{ color: COLORS.textLight }}>Max consecutive losses</div>
                      <div className="text-xs" style={{ color: COLORS.textMuted }}>worst losing streak</div>
                    </div>
                    <div className="text-xl font-bold" style={{ color: data.stats.maxConsecutiveLosses <= 15 ? COLORS.teal : COLORS.amber }}>
                      {data.stats.maxConsecutiveLosses}
                      <span className="text-xs font-normal ml-1" style={{ color: COLORS.textMuted }}>/ 15 max</span>
                    </div>
                  </div>
                  {/* Gate progress */}
                  {data.gates && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm" style={{ color: COLORS.textLight }}>Live trading gates</span>
                        <span className="text-sm font-bold px-2 py-0.5 rounded" style={{
                          background: data.gates.allOk ? `${COLORS.teal}22` : `${COLORS.amber}22`,
                          color: data.gates.allOk ? COLORS.teal : COLORS.amber,
                        }}>
                          {[data.gates.profitFactor.ok, data.gates.maxConsecutiveLosses.ok, data.gates.avgPnlPerTrade.ok, data.gates.minResolvedTrades.ok].filter(Boolean).length}/4 passed
                        </span>
                      </div>
                      <div className="space-y-1.5">
                        {[
                          { label: `Profit Factor ${data.gates.profitFactor.value.toFixed(2)} ≥ 1.30`, ok: data.gates.profitFactor.ok },
                          { label: `Consecutive losses ${data.gates.maxConsecutiveLosses.value} ≤ 15`, ok: data.gates.maxConsecutiveLosses.ok },
                          { label: `Avg P&L ${data.gates.avgPnlPerTrade.value >= 0 ? '+' : ''}$${data.gates.avgPnlPerTrade.value.toFixed(2)} > $5`, ok: data.gates.avgPnlPerTrade.ok },
                          { label: `${data.gates.minResolvedTrades.value} / 4000 resolved trades`, ok: data.gates.minResolvedTrades.ok },
                        ].map((g) => (
                          <div key={g.label} className="flex items-center gap-2 text-xs" style={{ color: g.ok ? COLORS.teal : COLORS.textMuted }}>
                            <span>{g.ok ? '✅' : '⏳'}</span>
                            <span>{g.label}</span>
                          </div>
                        ))}
                      </div>
                      {!data.gates.minResolvedTrades.ok && (
                        <div className="mt-3">
                          <div className="flex justify-between text-xs mb-1" style={{ color: COLORS.textMuted }}>
                            <span>Resolved trades progress</span>
                            <span>{data.gates.minResolvedTrades.value} / 4000</span>
                          </div>
                          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: COLORS.surface }}>
                            <div className="h-full rounded-full" style={{
                              width: `${Math.min((data.gates.minResolvedTrades.value / 4000) * 100, 100)}%`,
                              background: COLORS.amber,
                            }} />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Equity Curve */}
          {data.equityCurve && data.equityCurve.length > 1 && (
            <Section title="Equity Curve">
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
