'use client'

import { useState, useEffect } from 'react'
import { useRefresh } from '../providers'
import Link from 'next/link'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, ReferenceLine, ComposedChart,
} from 'recharts'

// ── Types ────────────────────────────────────────────────────────

type ChartPoint = { date: string; equity: number; dailyPnl: number; cumPnl: number; trades: number; winRate: number }
type EquityDay = { day: string; balance: number; dailyPnl: number; trades: number }
type BotEvent = { id: number; type: string; message: string; detail: string | null; createdAt: string }
type DomainInfo = { domain: string; pnl: number; trades: number; won: number; winRate: number; avgPnl: number }
type ExpertInfo = { expert: string; trades: number; won: number; winRate: number; pnl: number; avgPnl: number }
type TradeInfo = { title: string; side: string; entryPrice: number; curPrice: number; unrealized: number; expert: string; domain: string }
type SideInfo = { trades: number; won: number; winRate: number; pnl: number }
type EntryInfo = { label: string; trades: number; won: number; winRate: number; expectedWinRate: number; implicitEdge: number; pnl: number }
type ExpertTrustInfo = { expert: string; phase: string; status: string; trustLevel: number; resolvedTrades: number; winRate: number; pnl: number; reason: string }
type GateInfo = { value: number; threshold: number; ok: boolean }
type ClosedTrade = { title: string; side: string; entryPrice: number; pnl: number; expert: string; domain: string }

type LiveData = {
  balance: number; startingBalance: number; realizedPnl: number; partialExitsPnl: number
  unrealizedPnl: number; tradingDays: number; avgHoldDays: number; totalInvested: number
  totalEquity: number; winRate: number; wins: number; losses: number; openTrades: number
  totalTrades: number; closedTrades: number; roi: number; availableCash: number
  chartData: ChartPoint[]; equityCurve: EquityDay[]; events: BotEvent[]
  domains: DomainInfo[]; experts: ExpertInfo[]; topOpen: TradeInfo[]
  bestTrades: ClosedTrade[]; worstTrades: ClosedTrade[]
  bySide: { yes: SideInfo; no: SideInfo }; byEntry: EntryInfo[]
  costs: { preCostPnl: number; totalFees: number; totalSlippage: number; feePct: number; slippagePct: number; totalDeployed: number }
  gates: { profitFactor: GateInfo; maxConsecutiveLosses: GateInfo; avgPnlPerTrade: GateInfo; minResolvedTrades: GateInfo; allOk: boolean }
  stats: { profitFactor: number; maxConsecutiveLosses: number; avgPnlPerTrade: number; maxDrawdown: number; significance: string; winRateCI: { lower: number; upper: number }; grossWins: number; grossLosses: number }
  expertTrust: ExpertTrustInfo[]
  risk: { maxDrawdown: number; currentDrawdown: number; peakEquity: number; topConcentration: number; top3Concentration: number; openCount: number; cashPct: number }
}

// ── Design ───────────────────────────────────────────────────────

const C = {
  bg: '#171821', card: '#21222D', surface: '#2B2B36',
  teal: '#A9DFD8', amber: '#FCB859', pink: '#F2C8ED',
  red: '#EA1701', green: '#029F04', blue: '#28AEF3',
  muted: '#87888C', text: '#D2D2D2',
  live: '#3B82F6', liveGlow: '#60A5FA',
}

const DOMAIN_COLORS: Record<string, string> = {
  sports: C.teal, weather: C.blue, politics: '#6366f1',
  crypto: C.amber, economics: '#eab308', science: '#06b6d4',
  culture: C.pink, 'ai-tech': '#8b5cf6', geopolitics: C.red,
  unknown: '#52525b',
}

function pnl(n: number): string { return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}` }
function pct(n: number): string { return `${(n * 100).toFixed(1)}%` }

// ── Page ─────────────────────────────────────────────────────────

export default function LiveTrading(): React.ReactElement {
  const [data, setData] = useState<LiveData | null>(null)
  const [loading, setLoading] = useState(true)
  const { tick } = useRefresh()

  useEffect(() => {
    fetch('/api/snapshot?mode=live')
      .then(async (res) => {
        if (!res.ok) return null
        const s = await res.json()
        const p = s.portfolio
        return {
          balance: p.currentBalance, startingBalance: p.startingBalance,
          realizedPnl: p.realizedPnl, partialExitsPnl: p.partialExitsPnl,
          unrealizedPnl: p.unrealizedPnl, tradingDays: p.tradingDays,
          avgHoldDays: p.avgHoldDays, totalInvested: p.totalInvested,
          totalEquity: p.totalEquity, winRate: p.winRate,
          wins: p.wins, losses: p.losses, openTrades: p.openTrades,
          totalTrades: p.totalTrades, closedTrades: p.closedTrades ?? 0,
          roi: p.roi, availableCash: p.availableCash ?? 0,
          chartData: s.chartData, equityCurve: s.equityCurve ?? [],
          events: s.events, domains: s.byDomain,
          experts: s.byExpert ?? [], topOpen: s.topOpen ?? [],
          bestTrades: s.bestTrades ?? [], worstTrades: s.worstTrades ?? [],
          bySide: s.bySide ?? { yes: { trades: 0, won: 0, winRate: 0, pnl: 0 }, no: { trades: 0, won: 0, winRate: 0, pnl: 0 } },
          byEntry: s.byEntry ?? [], costs: s.costs ?? {},
          gates: s.gates ?? {}, stats: s.stats ?? {},
          expertTrust: s.expertTrust ?? [],
          risk: s.risk ?? { maxDrawdown: 0, currentDrawdown: 0, peakEquity: 0, topConcentration: 0, top3Concentration: 0, openCount: 0, cashPct: 1 },
        } as LiveData
      })
      .then((d) => { if (d) setData(d) })
      .catch(() => null)
      .finally(() => setLoading(false))
  }, [tick])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}>
      <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: C.live, borderTopColor: 'transparent' }} />
    </div>
  )

  if (!data || data.totalTrades === 0) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}>
      <div className="text-center">
        <div className="text-4xl mb-4">🔴</div>
        <h2 className="text-lg font-bold text-white mb-2">Live Trading</h2>
        <p className="text-sm" style={{ color: C.muted }}>No live trades yet.</p>
      </div>
    </div>
  )

  // Equity curve with drawdown
  let peak = data.startingBalance
  const eqWithDD = data.equityCurve.map((d) => {
    if (d.balance > peak) peak = d.balance
    const dd = peak > 0 ? ((peak - d.balance) / peak) * 100 : 0
    return { ...d, drawdown: -dd, date: d.day.slice(5) }
  })

  const donutData = data.domains.filter((d) => d.trades > 0).map((d) => ({ name: d.domain, value: d.trades }))

  return (
    <div className="min-h-screen" style={{ background: C.bg, color: C.text }}>
      <div className="flex">
        {/* Sidebar */}
        <aside className="hidden lg:flex flex-col w-56 min-h-screen p-5 border-r" style={{ background: C.card, borderColor: C.surface }}>
          <div className="mb-10">
            <h1 className="text-lg font-bold text-white">Copy Trader</h1>
            <p className="text-xs mt-1" style={{ color: C.live }}>
              <span className="inline-block w-2 h-2 rounded-full mr-1 animate-pulse" style={{ background: C.live }} />
              Live Trading
            </p>
          </div>
          <nav className="flex flex-col gap-1">
            <SideLink href="/">Dashboard</SideLink>
            <SideLink href="/analytics">Analytics</SideLink>
            <SideLink href="/paper-trading">Paper Trades</SideLink>
            <SideLink href="/live-trading" active>Live Trading</SideLink>
            <SideLink href="/activity">Activity</SideLink>
            <SideLink href="/leaderboard">Leaderboard</SideLink>
            <SideLink href="/settings">Settings</SideLink>
          </nav>
        </aside>

        <main className="flex-1 p-6 lg:p-8 max-w-[1400px]">

          {/* ═══ 1. STATUS BAR ═══ */}
          <div className="rounded-xl p-4 mb-6 flex flex-wrap items-center justify-between gap-4" style={{ background: `${C.live}10`, border: `1px solid ${C.live}30` }}>
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 rounded-full animate-pulse" style={{ background: C.live }} />
              <div>
                <span className="text-2xl font-bold text-white">${data.totalEquity.toFixed(2)}</span>
                <span className="text-sm ml-2" style={{ color: data.roi >= 0 ? C.green : C.red }}>
                  {data.roi >= 0 ? '+' : ''}{(data.roi * 100).toFixed(1)}%
                </span>
              </div>
            </div>
            <div className="flex items-center gap-6 text-xs">
              <div className="text-center">
                <div style={{ color: C.muted }}>Realized</div>
                <div className="font-bold" style={{ color: data.realizedPnl >= 0 ? C.green : C.red }}>{pnl(data.realizedPnl)}</div>
              </div>
              <div className="text-center">
                <div style={{ color: C.muted }}>Unrealized</div>
                <div className="font-bold" style={{ color: data.unrealizedPnl >= 0 ? C.teal : C.red }}>{pnl(data.unrealizedPnl)}</div>
              </div>
              <div className="text-center">
                <div style={{ color: C.muted }}>Cash</div>
                <div className="font-bold" style={{ color: C.text }}>${data.availableCash.toFixed(2)}</div>
              </div>
              <div className="text-center">
                <div style={{ color: C.muted }}>Win Rate</div>
                <div className="font-bold" style={{ color: C.amber }}>{(data.winRate * 100).toFixed(0)}%</div>
              </div>
              <div className="text-center">
                <div style={{ color: C.muted }}>Open</div>
                <div className="font-bold" style={{ color: C.blue }}>{data.openTrades}</div>
              </div>
              <div className="text-center">
                <div style={{ color: C.muted }}>Trades</div>
                <div className="font-bold" style={{ color: C.text }}>{data.totalTrades}</div>
              </div>
            </div>
          </div>

          {/* ═══ 2. RISK GAUGES ═══ */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <RiskGauge
              label="Drawdown"
              value={`-${(data.risk.currentDrawdown * 100).toFixed(1)}%`}
              sub={`peak $${data.risk.peakEquity.toFixed(0)}`}
              level={data.risk.currentDrawdown > 0.15 ? 'danger' : data.risk.currentDrawdown > 0.08 ? 'warn' : 'ok'}
            />
            <RiskGauge
              label="Max Drawdown"
              value={`-${(data.risk.maxDrawdown * 100).toFixed(1)}%`}
              sub="all time"
              level={data.risk.maxDrawdown > 0.20 ? 'danger' : data.risk.maxDrawdown > 0.12 ? 'warn' : 'ok'}
            />
            <RiskGauge
              label="Loss Streak"
              value={`${data.stats.maxConsecutiveLosses ?? 0}`}
              sub="consecutive"
              level={(data.stats.maxConsecutiveLosses ?? 0) > 15 ? 'danger' : (data.stats.maxConsecutiveLosses ?? 0) > 8 ? 'warn' : 'ok'}
            />
            <RiskGauge
              label="Profit Factor"
              value={data.stats.profitFactor?.toFixed(2) ?? '--'}
              sub="wins / losses"
              level={(data.stats.profitFactor ?? 0) >= 1.3 ? 'ok' : (data.stats.profitFactor ?? 0) >= 1.0 ? 'warn' : 'danger'}
            />
            <RiskGauge
              label="Concentration"
              value={pct(data.risk.topConcentration)}
              sub="top 1 position"
              level={data.risk.topConcentration > 0.30 ? 'danger' : data.risk.topConcentration > 0.15 ? 'warn' : 'ok'}
            />
            <RiskGauge
              label="Cash Reserve"
              value={pct(data.risk.cashPct)}
              sub="available"
              level={data.risk.cashPct < 0.10 ? 'danger' : data.risk.cashPct < 0.30 ? 'warn' : 'ok'}
            />
          </div>

          {/* ═══ 3. EQUITY CURVE + DRAWDOWN ═══ */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            <div className="lg:col-span-2 rounded-xl p-5" style={{ background: C.card }}>
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-sm font-medium" style={{ color: C.muted }}>Equity Curve + Drawdown</h2>
                <span className="text-xs" style={{ color: C.muted }}>started ${data.startingBalance.toFixed(0)} | {data.tradingDays.toFixed(1)}d</span>
              </div>
              {eqWithDD.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={eqWithDD} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                    <defs>
                      <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.live} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={C.live} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.surface} />
                    <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="eq" tickFormatter={(v: number) => `$${v}`} tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} width={45} />
                    <YAxis yAxisId="dd" orientation="right" tickFormatter={(v: number) => `${v}%`} tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} width={35} domain={[-50, 0]} />
                    <Tooltip contentStyle={{ background: C.surface, border: 'none', borderRadius: 8, fontSize: 12 }} />
                    <ReferenceLine yAxisId="eq" y={data.startingBalance} stroke={C.muted} strokeDasharray="3 3" />
                    <Area yAxisId="eq" type="monotone" dataKey="balance" stroke={C.live} fill="url(#eqFill)" strokeWidth={2} dot={false} />
                    <Bar yAxisId="dd" dataKey="drawdown" fill={C.red} fillOpacity={0.3} radius={[2, 2, 0, 0]} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[220px] flex items-center justify-center text-sm" style={{ color: C.muted }}>Chart appears after trades resolve</div>
              )}
            </div>

            {/* Domain donut */}
            <div className="rounded-xl p-5" style={{ background: C.card }}>
              <h2 className="text-sm font-medium mb-3" style={{ color: C.muted }}>Domain Allocation</h2>
              {donutData.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={120}>
                    <PieChart>
                      <Pie data={donutData} cx="50%" cy="50%" innerRadius={35} outerRadius={55} paddingAngle={3} dataKey="value">
                        {donutData.map((e) => <Cell key={e.name} fill={DOMAIN_COLORS[e.name] ?? '#52525b'} />)}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-1.5 mt-2">
                    {data.domains.slice(0, 6).map((d) => (
                      <div key={d.domain} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ background: DOMAIN_COLORS[d.domain] ?? '#52525b' }} />
                          <span className="capitalize">{d.domain}</span>
                          <span style={{ color: C.muted }}>{d.trades}t / {(d.winRate * 100).toFixed(0)}%</span>
                        </div>
                        <span style={{ color: d.pnl >= 0 ? C.green : C.red }}>{pnl(d.pnl)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-sm" style={{ color: C.muted }}>No data</div>
              )}
            </div>
          </div>

          {/* ═══ 4. OPEN POSITIONS ═══ */}
          {data.topOpen.length > 0 && (
            <div className="rounded-xl p-5 mb-6" style={{ background: C.card }}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-medium" style={{ color: C.muted }}>Open Positions</h2>
                <span className="text-xs px-2 py-1 rounded" style={{ background: C.surface, color: C.live }}>{data.openTrades} active / ${data.totalInvested.toFixed(2)} deployed</span>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: C.muted }}>
                    <th className="text-left pb-2">Market</th>
                    <th className="text-left pb-2">Side</th>
                    <th className="text-left pb-2">Expert</th>
                    <th className="text-right pb-2">Entry</th>
                    <th className="text-right pb-2">Now</th>
                    <th className="text-right pb-2">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topOpen.map((t, i) => (
                    <tr key={i} className="border-t" style={{ borderColor: C.surface }}>
                      <td className="py-2 max-w-[250px] truncate">{t.title}</td>
                      <td className="py-2">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{
                          background: t.side === 'YES' ? `${C.green}20` : `${C.red}20`,
                          color: t.side === 'YES' ? C.green : C.red,
                        }}>{t.side}</span>
                      </td>
                      <td className="py-2" style={{ color: C.muted }}>{t.expert}</td>
                      <td className="py-2 text-right">{(t.entryPrice * 100).toFixed(0)}¢</td>
                      <td className="py-2 text-right">{(t.curPrice * 100).toFixed(0)}¢</td>
                      <td className="py-2 text-right font-medium" style={{ color: t.unrealized >= 0 ? C.green : C.red }}>{pnl(t.unrealized)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ═══ 5. P&L + EDGE ═══ */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* P&L Breakdown */}
            <div className="rounded-xl p-5" style={{ background: C.card }}>
              <h2 className="text-sm font-medium mb-4" style={{ color: C.muted }}>P&L BREAKDOWN</h2>
              <div className="flex items-center gap-3 text-xs flex-wrap">
                <MetricBox label="Gross P&L" value={pnl(data.costs.preCostPnl)} color={data.costs.preCostPnl >= 0 ? C.teal : C.red} sub="before fees" />
                <span style={{ color: C.muted }}>-</span>
                <MetricBox label="Fees (2%)" value={`-$${data.costs.totalFees.toFixed(2)}`} color={C.amber} sub={`${(data.costs.feePct * 100).toFixed(1)}% of deployed`} />
                <span style={{ color: C.muted }}>=</span>
                <MetricBox label="Net P&L" value={pnl(data.realizedPnl)} color={data.realizedPnl >= 0 ? C.teal : C.red} sub="real execution" highlight />
              </div>
            </div>

            {/* Entry Price Edge */}
            <div className="rounded-xl p-5" style={{ background: C.card }}>
              <h2 className="text-sm font-medium mb-4" style={{ color: C.muted }}>ENTRY PRICE EDGE</h2>
              {data.byEntry.length > 0 ? (
                <div className="space-y-3">
                  {data.byEntry.map((b) => (
                    <div key={b.label}>
                      <div className="flex justify-between text-xs mb-1">
                        <span>{b.label}</span>
                        <span style={{ color: b.pnl >= 0 ? C.green : C.red }}>{pnl(b.pnl)} / {b.trades}t</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px]">
                        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: C.surface }}>
                          <div className="h-full rounded-full" style={{
                            width: `${Math.min(b.winRate * 100, 100)}%`,
                            background: b.implicitEdge >= 0 ? C.green : C.red,
                          }} />
                        </div>
                        <span style={{ color: b.implicitEdge >= 0 ? C.green : C.red }}>
                          {b.implicitEdge >= 0 ? '+' : ''}{(b.implicitEdge * 100).toFixed(0)}pts
                        </span>
                      </div>
                      <div className="text-[10px] mt-0.5" style={{ color: C.muted }}>
                        expected {(b.expectedWinRate * 100).toFixed(0)}% / actual {(b.winRate * 100).toFixed(0)}%
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm py-4 text-center" style={{ color: C.muted }}>Not enough data</div>
              )}
            </div>
          </div>

          {/* ═══ 6. DAILY P&L + WIN RATE ═══ */}
          {data.chartData.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              <div className="rounded-xl p-5" style={{ background: C.card }}>
                <h2 className="text-sm font-medium mb-1" style={{ color: C.muted }}>Daily P&L</h2>
                <ResponsiveContainer width="100%" height={140}>
                  <BarChart data={data.chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.surface} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(8)} tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `$${v}`} tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                    <ReferenceLine y={0} stroke={C.muted} />
                    <Bar dataKey="dailyPnl" radius={[3, 3, 0, 0]}>
                      {data.chartData.map((e, i) => <Cell key={i} fill={e.dailyPnl >= 0 ? C.teal : C.red} fillOpacity={0.8} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="rounded-xl p-5" style={{ background: C.card }}>
                <h2 className="text-sm font-medium mb-1" style={{ color: C.muted }}>Win Rate (rolling 20d)</h2>
                <ResponsiveContainer width="100%" height={140}>
                  <LineChart data={data.chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.surface} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(8)} tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `${v}%`} tick={{ fill: C.muted, fontSize: 10 }} axisLine={false} tickLine={false} width={35} domain={[0, 100]} />
                    <ReferenceLine y={50} stroke={C.amber} strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="winRate" stroke={C.amber} strokeWidth={2} dot={{ r: 3, fill: C.amber }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* ═══ 7. YES/NO + EXPERTS ═══ */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            {/* YES vs NO */}
            <div className="rounded-xl p-5" style={{ background: C.card }}>
              <h2 className="text-sm font-medium mb-4" style={{ color: C.muted }}>YES VS NO</h2>
              <div className="space-y-4">
                {(['yes', 'no'] as const).map((side) => {
                  const s = data.bySide[side]
                  return (
                    <div key={side}>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="font-bold" style={{ color: side === 'yes' ? C.green : C.red }}>{side.toUpperCase()}</span>
                        <span className="font-bold" style={{ color: s.pnl >= 0 ? C.green : C.red }}>{pnl(s.pnl)}</span>
                      </div>
                      <div className="flex items-center gap-2 text-[10px]" style={{ color: C.muted }}>
                        <span>{s.trades}t</span>
                        <span>WR {(s.winRate * 100).toFixed(0)}%</span>
                        <div className="flex-1 h-1.5 rounded-full" style={{ background: C.surface }}>
                          <div className="h-full rounded-full" style={{ width: `${s.winRate * 100}%`, background: side === 'yes' ? C.green : C.red }} />
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Expert Performance */}
            <div className="lg:col-span-2 rounded-xl p-5" style={{ background: C.card }}>
              <h2 className="text-sm font-medium mb-3" style={{ color: C.muted }}>EXPERT PERFORMANCE</h2>
              <table className="w-full text-xs">
                <thead>
                  <tr style={{ color: C.muted }}>
                    <th className="text-left pb-2">Expert</th>
                    <th className="text-center pb-2">Trust</th>
                    <th className="text-right pb-2">Trades</th>
                    <th className="text-right pb-2">WR</th>
                    <th className="text-right pb-2">P&L</th>
                    <th className="text-right pb-2">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {data.experts.slice(0, 10).map((e) => {
                    const trust = data.expertTrust.find((t) => e.expert.includes(t.expert.slice(0, 10)) || t.expert.includes(e.expert.slice(0, 10)))
                    const statusColor = trust?.status === 'active' ? C.green : trust?.status === 'reduced' ? C.amber : C.red
                    return (
                      <tr key={e.expert} className="border-t" style={{ borderColor: C.surface }}>
                        <td className="py-1.5 truncate max-w-[120px]">{e.expert}</td>
                        <td className="py-1.5 text-center">
                          {trust && (
                            <span className="px-1 py-0.5 rounded text-[9px] font-bold" style={{ background: `${statusColor}20`, color: statusColor }}>
                              {trust.status}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 text-right" style={{ color: C.muted }}>{e.trades}</td>
                        <td className="py-1.5 text-right">{(e.winRate * 100).toFixed(0)}%</td>
                        <td className="py-1.5 text-right font-medium" style={{ color: e.pnl >= 0 ? C.green : C.red }}>{pnl(e.pnl)}</td>
                        <td className="py-1.5 text-right" style={{ color: e.avgPnl >= 0 ? C.teal : C.red }}>{pnl(e.avgPnl)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ═══ 8. BEST/WORST + ACTIVITY ═══ */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            {data.bestTrades.length > 0 && (
              <div className="rounded-xl p-5" style={{ background: C.card }}>
                <h2 className="text-sm font-medium mb-3" style={{ color: C.muted }}>Best Trades</h2>
                {data.bestTrades.slice(0, 5).map((t, i) => (
                  <div key={i} className="flex justify-between text-xs py-1.5 border-b" style={{ borderColor: C.surface }}>
                    <div className="truncate max-w-[180px]">{t.title}</div>
                    <span className="font-medium ml-2" style={{ color: C.green }}>{pnl(t.pnl)}</span>
                  </div>
                ))}
              </div>
            )}
            {data.worstTrades.length > 0 && (
              <div className="rounded-xl p-5" style={{ background: C.card }}>
                <h2 className="text-sm font-medium mb-3" style={{ color: C.muted }}>Worst Trades</h2>
                {data.worstTrades.slice(0, 5).map((t, i) => (
                  <div key={i} className="flex justify-between text-xs py-1.5 border-b" style={{ borderColor: C.surface }}>
                    <div className="truncate max-w-[180px]">{t.title}</div>
                    <span className="font-medium ml-2" style={{ color: C.red }}>{pnl(t.pnl)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="rounded-xl p-5" style={{ background: C.card }}>
              <h2 className="text-sm font-medium mb-3" style={{ color: C.muted }}>Activity</h2>
              <div className="space-y-2">
                {data.events.length > 0 ? data.events.slice(0, 8).map((e) => (
                  <div key={e.id} className="text-xs py-1 border-b" style={{ borderColor: C.surface }}>
                    <div className="flex justify-between">
                      <span className="truncate" style={{ color: C.text }}>{e.message.slice(0, 60)}</span>
                      <span className="ml-2 shrink-0" style={{ color: C.muted }}>{e.createdAt.slice(11, 16)}</span>
                    </div>
                  </div>
                )) : (
                  <div className="text-sm py-4 text-center" style={{ color: C.muted }}>No activity</div>
                )}
              </div>
            </div>
          </div>

        </main>
      </div>
    </div>
  )
}

// ── Components ───────────────────────────────────────────────────

function RiskGauge({ label, value, sub, level }: {
  label: string; value: string; sub: string; level: 'ok' | 'warn' | 'danger'
}): React.ReactElement {
  const color = level === 'ok' ? C.green : level === 'warn' ? C.amber : C.red
  const bg = level === 'ok' ? `${C.green}10` : level === 'warn' ? `${C.amber}10` : `${C.red}10`
  const border = level === 'ok' ? `${C.green}30` : level === 'warn' ? `${C.amber}30` : `${C.red}30`
  return (
    <div className="rounded-xl p-3 text-center" style={{ background: bg, border: `1px solid ${border}` }}>
      <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: C.muted }}>{label}</div>
      <div className="text-lg font-bold" style={{ color }}>{value}</div>
      <div className="text-[10px]" style={{ color: C.muted }}>{sub}</div>
    </div>
  )
}

function MetricBox({ label, value, color, sub, highlight }: {
  label: string; value: string; color: string; sub: string; highlight?: boolean
}): React.ReactElement {
  return (
    <div className="text-center p-3 rounded-lg" style={{
      background: C.surface,
      border: highlight ? `1px solid ${C.live}40` : undefined,
    }}>
      <div style={{ color: C.muted }}>{label}</div>
      <div className="text-lg font-bold mt-1" style={{ color }}>{value}</div>
      <div className="text-[10px]" style={{ color: C.muted }}>{sub}</div>
    </div>
  )
}

function SideLink({ href, children, active }: { href: string; children: React.ReactNode; active?: boolean }): React.ReactElement {
  return (
    <Link href={href} className="px-3 py-2 rounded-lg text-sm transition-colors"
      style={{ background: active ? C.surface : 'transparent', color: active ? C.teal : C.muted }}>
      {children}
    </Link>
  )
}
