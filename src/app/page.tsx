'use client'

import { useState, useEffect } from 'react'
import { useRefresh } from './providers'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, ReferenceLine, ComposedChart, Area,
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

// ── Palette — dark, minimal, no garish colors ────────────────────

const C = {
  bg: '#0F1117',       // deep dark
  card: '#181A20',     // card surface
  surface: '#1E2028',  // elevated surface
  up: '#10B981',       // emerald positive
  down: '#EF4444',     // soft red negative
  accent: '#6366F1',   // indigo identity
  dim: '#6B7084',      // muted labels
  text: '#C9CDD8',     // body
  bright: '#EAECF0',   // headings / numbers
  border: '#262835',   // subtle lines
  warn: '#F59E0B',     // warnings only
}

const DOMAIN_COLORS: Record<string, string> = {
  sports: '#10B981', weather: '#38BDF8', politics: '#818CF8',
  crypto: '#FBBF24', economics: '#A78BFA', science: '#22D3EE',
  culture: '#F9A8D4', 'ai-tech': '#C084FC', geopolitics: '#FB7185',
  unknown: '#52525b',
}

function $(n: number): string { return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}` }
function pct(n: number): string { return `${(n * 100).toFixed(1)}%` }

// ── Page ─────────────────────────────────────────────────────────

type WalletData = {
  pendingRedeem: Array<{ title: string; side: string; size: number; curPrice: number; value: number; pnl: number }>
  closedTrades: Array<{ title: string; side: string; result: string; pnl: number; totalTraded: number }>
  openPositions: Array<{ title: string; side: string; size: number; curPrice: number; value: number; pnl: number }>
}

export default function LiveTrading(): React.ReactElement {
  const [data, setData] = useState<LiveData | null>(null)
  const [walletData, setWalletData] = useState<WalletData | null>(null)
  const [loading, setLoading] = useState(true)
  const { tick } = useRefresh()

  useEffect(() => {
    Promise.all([
      // PRIMARY: on-chain data (wallet-equity) = source of truth
      fetch('/api/wallet-equity').then(async (res) => {
        if (!res.ok) return null
        return await res.json() as Record<string, unknown>
      }).catch(() => null),
      // SECONDARY: DB data (snapshot) = charts, events, domain stats only
      fetch('/api/snapshot?mode=live').then(async (res) => {
        if (!res.ok) return null
        return await res.json()
      }).catch(() => null),
    ]).then(([w, s]) => {
      if (!w) { setLoading(false); return }

      const usdc = (w.usdc as number) ?? 0
      const positionsValue = (w.positionsValue as number) ?? 0
      const totalEquity = (w.totalEquity as number) ?? 0
      const realizedPnl = (w.realizedPnl as number) ?? 0
      const unrealizedPnl = (w.unrealizedPnl as number) ?? 0
      const wins = (w.wins as number) ?? 0
      const losses = (w.losses as number) ?? 0
      const winRate = (w.winRate as number) ?? 0
      const totalTrades = (w.totalTrades as number) ?? 0
      const openPositions = (w.openPositions as Array<unknown>) ?? []
      const startingBalance = 9  // known starting point

      // Build LiveData from on-chain truth + DB historical data
      const p = s?.portfolio ?? {}
      const d: LiveData = {
        // Core metrics from ON-CHAIN (wallet-equity)
        totalEquity,
        balance: usdc,
        availableCash: usdc,
        realizedPnl,
        unrealizedPnl,
        wins,
        losses,
        winRate: winRate / 100,
        totalTrades,
        openTrades: openPositions.length,
        totalInvested: positionsValue,
        startingBalance,
        roi: startingBalance > 0 ? (totalEquity - startingBalance) / startingBalance : 0,

        // Historical data from DB (charts, events, domain breakdown)
        partialExitsPnl: p.partialExitsPnl ?? 0,
        tradingDays: p.tradingDays ?? 1,
        avgHoldDays: p.avgHoldDays ?? 0,
        closedTrades: p.closedTrades ?? totalTrades,
        chartData: s?.chartData ?? [],
        equityCurve: s?.equityCurve ?? [],
        events: s?.events ?? [],
        domains: s?.byDomain ?? [],
        experts: s?.byExpert ?? [],
        topOpen: s?.topOpen ?? [],
        bestTrades: s?.bestTrades ?? [],
        worstTrades: s?.worstTrades ?? [],
        bySide: s?.bySide ?? { yes: { trades: 0, won: 0, winRate: 0, pnl: 0 }, no: { trades: 0, won: 0, winRate: 0, pnl: 0 } },
        byEntry: s?.byEntry ?? [],
        costs: s?.costs ?? {},
        gates: s?.gates ?? {},
        stats: s?.stats ?? {},
        expertTrust: s?.expertTrust ?? [],
        risk: {
          maxDrawdown: s?.risk?.maxDrawdown ?? 0,
          currentDrawdown: s?.risk?.currentDrawdown ?? 0,
          peakEquity: s?.risk?.peakEquity ?? totalEquity,
          topConcentration: openPositions.length > 0 ? Math.max(...(openPositions as Array<Record<string, unknown>>).map((p) => ((p.value as number) ?? 0) / (totalEquity || 1))) : 0,
          top3Concentration: 0,
          openCount: openPositions.length,
          cashPct: totalEquity > 0 ? usdc / totalEquity : 1,
        },
      }

      setData(d)
      setWalletData({
        pendingRedeem: (w.pendingRedeem as WalletData['pendingRedeem']) ?? [],
        closedTrades: (w.closedTrades as WalletData['closedTrades']) ?? [],
        openPositions: (w.openPositions as WalletData['openPositions']) ?? [],
      })
    }).catch(() => null).finally(() => setLoading(false))
  }, [tick])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}>
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: C.accent, borderTopColor: 'transparent' }} />
    </div>
  )

  if (!data || data.totalTrades === 0) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}>
      <div className="text-center">
        <h2 className="text-base font-medium text-white mb-2">Live Trading</h2>
        <p className="text-sm" style={{ color: C.dim }}>No live trades yet.</p>
      </div>
    </div>
  )

  // Equity curve with drawdown overlay
  let peak = data.startingBalance
  const eqWithDD = data.equityCurve.map((d) => {
    if (d.balance > peak) peak = d.balance
    const dd = peak > 0 ? ((peak - d.balance) / peak) * 100 : 0
    return { ...d, drawdown: -dd, date: d.day.slice(5) }
  })

  const donutData = data.domains.filter((d) => d.trades > 0).map((d) => ({ name: d.domain, value: d.trades }))

  return (
    <div className="p-6 lg:p-8 max-w-7xl" style={{ color: C.text }}>

          {/* ═══ 1. HEADER BAR ═══ */}
          <div className="flex flex-wrap items-end justify-between gap-4 mb-6 pb-4" style={{ borderBottom: `1px solid ${C.border}` }}>
            <div>
              <div className="text-[11px] uppercase tracking-widest mb-1" style={{ color: C.dim }}>Live Equity</div>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold" style={{ color: C.bright }}>${data.totalEquity.toFixed(2)}</span>
                <span className="text-sm" style={{ color: data.roi >= 0 ? C.up : C.down }}>
                  {data.roi >= 0 ? '+' : ''}{(data.roi * 100).toFixed(1)}%
                </span>
              </div>
              <div className="text-[11px] mt-1" style={{ color: C.dim }}>
                started ${data.startingBalance.toFixed(0)} / {data.tradingDays.toFixed(1)} days / {data.totalTrades} trades
              </div>
            </div>
            <div className="flex gap-6 text-xs">
              <Metric label="Realized" value={$(data.realizedPnl)} color={data.realizedPnl >= 0 ? C.up : C.down} />
              <Metric label="Unrealized" value={$(data.unrealizedPnl)} color={data.unrealizedPnl >= 0 ? C.up : C.down} />
              <Metric label="Cash" value={`$${data.availableCash.toFixed(2)}`} color={C.text} />
              <Metric label="Win Rate" value={`${(data.winRate * 100).toFixed(0)}%`} color={C.text} />
              <Metric label="W / L" value={`${data.wins} / ${data.losses}`} color={C.dim} />
              <Metric label="Open" value={`${data.openTrades}`} color={C.accent} />
            </div>
          </div>

          {/* ═══ 2. RISK ROW ═══ */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 mb-6">
            <Gauge label="Drawdown" value={`${(data.risk.currentDrawdown * 100).toFixed(1)}%`} level={data.risk.currentDrawdown > 0.15 ? 2 : data.risk.currentDrawdown > 0.08 ? 1 : 0} />
            <Gauge label="Max DD" value={`${(data.risk.maxDrawdown * 100).toFixed(1)}%`} level={data.risk.maxDrawdown > 0.20 ? 2 : data.risk.maxDrawdown > 0.12 ? 1 : 0} />
            <Gauge label="Streak" value={`${data.stats.maxConsecutiveLosses ?? 0}`} level={(data.stats.maxConsecutiveLosses ?? 0) > 15 ? 2 : (data.stats.maxConsecutiveLosses ?? 0) > 8 ? 1 : 0} />
            <Gauge label="PF" value={data.stats.profitFactor?.toFixed(2) ?? '--'} level={(data.stats.profitFactor ?? 0) >= 1.3 ? 0 : (data.stats.profitFactor ?? 0) >= 1.0 ? 1 : 2} />
            <Gauge label="Top Pos" value={pct(data.risk.topConcentration)} level={data.risk.topConcentration > 0.30 ? 2 : data.risk.topConcentration > 0.15 ? 1 : 0} />
            <Gauge label="Cash %" value={pct(data.risk.cashPct)} level={data.risk.cashPct < 0.10 ? 2 : data.risk.cashPct < 0.30 ? 1 : 0} />
          </div>

          {/* ═══ 3. EQUITY + DOMAINS ═══ */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
            <div className="lg:col-span-3 rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <div className="flex justify-between items-center mb-2">
                <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Equity + Drawdown</span>
                <span className="text-xs" style={{ color: C.dim }}>peak ${data.risk.peakEquity.toFixed(0)}</span>
              </div>
              {eqWithDD.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <ComposedChart data={eqWithDD} margin={{ top: 5, right: 5, bottom: 0, left: 5 }}>
                    <defs>
                      <linearGradient id="eqG" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.accent} stopOpacity={0.15} />
                        <stop offset="100%" stopColor={C.accent} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="date" tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis yAxisId="eq" tickFormatter={(v: number) => `$${v}`} tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                    <YAxis yAxisId="dd" orientation="right" tickFormatter={(v: number) => `${v}%`} tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickLine={false} width={30} domain={[-50, 0]} />
                    <Tooltip contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 11 }} />
                    <ReferenceLine yAxisId="eq" y={data.startingBalance} stroke={C.dim} strokeDasharray="3 3" strokeOpacity={0.5} />
                    <Area yAxisId="eq" type="monotone" dataKey="balance" stroke={C.accent} fill="url(#eqG)" strokeWidth={1.5} dot={false} />
                    <Bar yAxisId="dd" dataKey="drawdown" fill={C.down} fillOpacity={0.2} radius={[2, 2, 0, 0]} />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-xs" style={{ color: C.dim }}>Waiting for data</div>
              )}
            </div>

            <div className="rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Domains</span>
              {donutData.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={110}>
                    <PieChart>
                      <Pie data={donutData} cx="50%" cy="50%" innerRadius={30} outerRadius={48} paddingAngle={2} dataKey="value" stroke="none">
                        {donutData.map((e) => <Cell key={e.name} fill={DOMAIN_COLORS[e.name] ?? '#52525b'} />)}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-1.5">
                    {data.domains.slice(0, 5).map((d) => (
                      <div key={d.domain} className="flex items-center justify-between text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: DOMAIN_COLORS[d.domain] ?? '#52525b' }} />
                          <span className="capitalize" style={{ color: C.text }}>{d.domain}</span>
                          <span style={{ color: C.dim }}>{d.trades}t</span>
                        </div>
                        <span style={{ color: d.pnl >= 0 ? C.up : C.down }}>{$(d.pnl)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="h-[180px] flex items-center justify-center text-xs" style={{ color: C.dim }}>No data</div>
              )}
            </div>
          </div>

          {/* ═══ 4. OPEN POSITIONS ═══ */}
          {data.topOpen.length > 0 && (
            <div className="rounded-lg p-4 mb-6" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <div className="flex justify-between items-center mb-3">
                <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Open Positions</span>
                <span className="text-[11px]" style={{ color: C.dim }}>{data.openTrades} active / ${data.totalInvested.toFixed(2)} deployed</span>
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr style={{ color: C.dim }}>
                    <th className="text-left pb-2 font-normal">Market</th>
                    <th className="text-left pb-2 font-normal w-12">Side</th>
                    <th className="text-left pb-2 font-normal">Expert</th>
                    <th className="text-right pb-2 font-normal">Entry</th>
                    <th className="text-right pb-2 font-normal">Now</th>
                    <th className="text-right pb-2 font-normal">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topOpen.map((t, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td className="py-2 pr-3 max-w-[300px] truncate" style={{ color: C.text }}>{t.title}</td>
                      <td className="py-2">
                        <span className="text-[10px] font-medium" style={{ color: t.side === 'YES' ? C.up : C.down }}>{t.side}</span>
                      </td>
                      <td className="py-2" style={{ color: C.dim }}>{t.expert}</td>
                      <td className="py-2 text-right tabular-nums">{(t.entryPrice * 100).toFixed(0)}¢</td>
                      <td className="py-2 text-right tabular-nums">{(t.curPrice * 100).toFixed(0)}¢</td>
                      <td className="py-2 text-right tabular-nums font-medium" style={{ color: t.unrealized >= 0 ? C.up : C.down }}>{$(t.unrealized)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ═══ 4b. PENDING REDEEM ═══ */}
          {walletData && walletData.pendingRedeem.length > 0 && (
            <div className="rounded-lg p-4 mb-6" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <div className="flex justify-between items-center mb-3">
                <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Pending Redeem (waiting for oracle)</span>
                <span className="text-[11px]" style={{ color: C.dim }}>{walletData.pendingRedeem.length} positions</span>
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr style={{ color: C.dim }}>
                    <th className="text-left pb-2 font-normal">Market</th>
                    <th className="text-left pb-2 font-normal w-12">Side</th>
                    <th className="text-right pb-2 font-normal">Shares</th>
                    <th className="text-right pb-2 font-normal">Price</th>
                    <th className="text-right pb-2 font-normal">Value</th>
                    <th className="text-right pb-2 font-normal">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {walletData.pendingRedeem.map((p, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td className="py-2 pr-3 max-w-[300px] truncate" style={{ color: C.text }}>{p.title}</td>
                      <td className="py-2">
                        <span className="text-[10px] font-medium" style={{ color: p.side === 'YES' ? C.up : C.down }}>{p.side}</span>
                      </td>
                      <td className="py-2 text-right tabular-nums">{p.size.toFixed(1)}</td>
                      <td className="py-2 text-right tabular-nums">{(p.curPrice * 100).toFixed(0)}¢</td>
                      <td className="py-2 text-right tabular-nums">${p.value.toFixed(2)}</td>
                      <td className="py-2 text-right">
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: p.curPrice > 0.5 ? '#029F0420' : '#EA170120', color: p.curPrice > 0.5 ? C.up : C.down }}>
                          {p.curPrice > 0.5 ? 'WON' : 'LOST'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ═══ 4c. CLOSED TRADES ═══ */}
          {walletData && walletData.closedTrades.length > 0 && (
            <div className="rounded-lg p-4 mb-6" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <div className="flex justify-between items-center mb-3">
                <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Closed Trades (from Polymarket)</span>
                <span className="text-[11px]" style={{ color: C.dim }}>{walletData.closedTrades.filter(t => t.result === 'won').length}W / {walletData.closedTrades.filter(t => t.result === 'lost').length}L</span>
              </div>
              <table className="w-full text-[11px]">
                <thead>
                  <tr style={{ color: C.dim }}>
                    <th className="text-left pb-2 font-normal">Market</th>
                    <th className="text-left pb-2 font-normal w-12">Side</th>
                    <th className="text-right pb-2 font-normal">Result</th>
                    <th className="text-right pb-2 font-normal">P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {walletData.closedTrades.map((t, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td className="py-2 pr-3 max-w-[300px] truncate" style={{ color: C.text }}>{t.title}</td>
                      <td className="py-2">
                        <span className="text-[10px] font-medium" style={{ color: t.side === 'YES' ? C.up : C.down }}>{t.side}</span>
                      </td>
                      <td className="py-2 text-right">
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: t.result === 'won' ? '#029F0420' : '#EA170120', color: t.result === 'won' ? C.up : C.down }}>
                          {t.result.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular-nums font-medium" style={{ color: t.pnl >= 0 ? C.up : C.down }}>{$(t.pnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ═══ 5. P&L + ENTRY EDGE ═══ */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>P&L Breakdown</span>
              <div className="flex items-center gap-3 mt-3 text-[11px]">
                <div className="flex-1 text-center p-3 rounded-md" style={{ background: C.surface }}>
                  <div style={{ color: C.dim }}>Gross</div>
                  <div className="text-base font-semibold mt-1" style={{ color: data.costs.preCostPnl >= 0 ? C.up : C.down }}>{$(data.costs.preCostPnl)}</div>
                </div>
                <span style={{ color: C.dim }}>-</span>
                <div className="flex-1 text-center p-3 rounded-md" style={{ background: C.surface }}>
                  <div style={{ color: C.dim }}>Fees</div>
                  <div className="text-base font-semibold mt-1" style={{ color: C.down }}>-${data.costs.totalFees.toFixed(2)}</div>
                  <div className="text-[10px]" style={{ color: C.dim }}>{(data.costs.feePct * 100).toFixed(1)}%</div>
                </div>
                <span style={{ color: C.dim }}>=</span>
                <div className="flex-1 text-center p-3 rounded-md" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
                  <div style={{ color: C.dim }}>Net</div>
                  <div className="text-base font-semibold mt-1" style={{ color: data.realizedPnl >= 0 ? C.up : C.down }}>{$(data.realizedPnl)}</div>
                </div>
              </div>
            </div>

            <div className="rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Entry Price Edge</span>
              {data.byEntry.length > 0 ? (
                <div className="space-y-3 mt-3">
                  {data.byEntry.map((b) => (
                    <div key={b.label}>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span style={{ color: C.text }}>{b.label}</span>
                        <span style={{ color: b.pnl >= 0 ? C.up : C.down }}>{$(b.pnl)}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1 rounded-full" style={{ background: C.surface }}>
                          <div className="h-full rounded-full" style={{ width: `${Math.min(b.winRate * 100, 100)}%`, background: b.implicitEdge >= 0 ? C.up : C.down, opacity: 0.7 }} />
                        </div>
                        <span className="text-[10px] tabular-nums w-12 text-right" style={{ color: b.implicitEdge >= 0 ? C.up : C.down }}>
                          {b.implicitEdge >= 0 ? '+' : ''}{(b.implicitEdge * 100).toFixed(0)}pts
                        </span>
                      </div>
                      <div className="text-[10px]" style={{ color: C.dim }}>{b.trades}t / exp {(b.expectedWinRate * 100).toFixed(0)}% / act {(b.winRate * 100).toFixed(0)}%</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs py-6 text-center" style={{ color: C.dim }}>Not enough data</div>
              )}
            </div>
          </div>

          {/* ═══ 6. DAILY P&L + WIN RATE ═══ */}
          {data.chartData.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
              <div className="rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
                <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Daily P&L</span>
                <ResponsiveContainer width="100%" height={130}>
                  <BarChart data={data.chartData} margin={{ top: 10, right: 5, bottom: 0, left: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(8)} tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `$${v}`} tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickLine={false} width={35} />
                    <ReferenceLine y={0} stroke={C.border} />
                    <Bar dataKey="dailyPnl" radius={[2, 2, 0, 0]}>
                      {data.chartData.map((e, i) => <Cell key={i} fill={e.dailyPnl >= 0 ? C.up : C.down} fillOpacity={0.6} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
                <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Win Rate (rolling)</span>
                <ResponsiveContainer width="100%" height={130}>
                  <LineChart data={data.chartData} margin={{ top: 10, right: 5, bottom: 0, left: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(8)} tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `${v}%`} tick={{ fill: C.dim, fontSize: 10 }} axisLine={false} tickLine={false} width={30} domain={[0, 100]} />
                    <ReferenceLine y={50} stroke={C.dim} strokeDasharray="3 3" strokeOpacity={0.3} />
                    <Line type="monotone" dataKey="winRate" stroke={C.accent} strokeWidth={1.5} dot={{ r: 2, fill: C.accent }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* ═══ 7. YES/NO + EXPERTS ═══ */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
            <div className="rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Side Performance</span>
              <div className="space-y-4 mt-3">
                {(['yes', 'no'] as const).map((side) => {
                  const s = data.bySide[side]
                  return (
                    <div key={side}>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="font-medium" style={{ color: side === 'yes' ? C.up : C.down }}>{side.toUpperCase()}</span>
                        <span className="tabular-nums" style={{ color: s.pnl >= 0 ? C.up : C.down }}>{$(s.pnl)}</span>
                      </div>
                      <div className="h-1 rounded-full" style={{ background: C.surface }}>
                        <div className="h-full rounded-full" style={{ width: `${s.winRate * 100}%`, background: side === 'yes' ? C.up : C.down, opacity: 0.5 }} />
                      </div>
                      <div className="text-[10px] mt-0.5" style={{ color: C.dim }}>{s.trades}t / {(s.winRate * 100).toFixed(0)}% WR</div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="lg:col-span-3 rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Expert Performance</span>
              <table className="w-full text-[11px] mt-2">
                <thead>
                  <tr style={{ color: C.dim }}>
                    <th className="text-left pb-1.5 font-normal">Expert</th>
                    <th className="text-center pb-1.5 font-normal">Status</th>
                    <th className="text-right pb-1.5 font-normal">Trades</th>
                    <th className="text-right pb-1.5 font-normal">WR</th>
                    <th className="text-right pb-1.5 font-normal">P&L</th>
                    <th className="text-right pb-1.5 font-normal">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {data.experts.slice(0, 12).map((e) => {
                    const trust = data.expertTrust.find((t) => e.expert.includes(t.expert.slice(0, 8)) || t.expert.includes(e.expert.slice(0, 8)))
                    const stColor = trust?.status === 'active' ? C.up : trust?.status === 'reduced' ? C.warn : C.down
                    return (
                      <tr key={e.expert} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td className="py-1.5 truncate max-w-[140px]" style={{ color: C.text }}>{e.expert}</td>
                        <td className="py-1.5 text-center">
                          {trust && <span className="text-[9px]" style={{ color: stColor }}>{trust.status}</span>}
                        </td>
                        <td className="py-1.5 text-right tabular-nums" style={{ color: C.dim }}>{e.trades}</td>
                        <td className="py-1.5 text-right tabular-nums">{(e.winRate * 100).toFixed(0)}%</td>
                        <td className="py-1.5 text-right tabular-nums font-medium" style={{ color: e.pnl >= 0 ? C.up : C.down }}>{$(e.pnl)}</td>
                        <td className="py-1.5 text-right tabular-nums" style={{ color: e.avgPnl >= 0 ? C.up : C.down }}>{$(e.avgPnl)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ═══ 8. RECENT TRADES + ACTIVITY ═══ */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {data.bestTrades.length > 0 && (
              <div className="rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
                <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Best Trades</span>
                <div className="mt-2">
                  {data.bestTrades.slice(0, 5).map((t, i) => (
                    <div key={i} className="flex justify-between text-[11px] py-1.5" style={{ borderTop: i > 0 ? `1px solid ${C.border}` : undefined }}>
                      <span className="truncate max-w-[180px]" style={{ color: C.text }}>{t.title}</span>
                      <span className="tabular-nums ml-2" style={{ color: C.up }}>{$(t.pnl)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {data.worstTrades.length > 0 && (
              <div className="rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
                <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Worst Trades</span>
                <div className="mt-2">
                  {data.worstTrades.slice(0, 5).map((t, i) => (
                    <div key={i} className="flex justify-between text-[11px] py-1.5" style={{ borderTop: i > 0 ? `1px solid ${C.border}` : undefined }}>
                      <span className="truncate max-w-[180px]" style={{ color: C.text }}>{t.title}</span>
                      <span className="tabular-nums ml-2" style={{ color: C.down }}>{$(t.pnl)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
              <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Activity</span>
              <div className="mt-2">
                {data.events.length > 0 ? data.events.slice(0, 8).map((e) => (
                  <div key={e.id} className="text-[11px] py-1.5" style={{ borderTop: `1px solid ${C.border}` }}>
                    <div className="flex justify-between">
                      <span className="truncate" style={{ color: C.text }}>{e.message.slice(0, 55)}</span>
                      <span className="ml-2 shrink-0" style={{ color: C.dim }}>{e.createdAt.slice(11, 16)}</span>
                    </div>
                  </div>
                )) : (
                  <div className="text-xs py-6 text-center" style={{ color: C.dim }}>No activity</div>
                )}
              </div>
            </div>
          </div>

    </div>
  )
}

// ── Components ───────────────────────────────────────────────────

function Metric({ label, value, color }: { label: string; value: string; color: string }): React.ReactElement {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: C.dim }}>{label}</div>
      <div className="text-sm font-medium tabular-nums" style={{ color }}>{value}</div>
    </div>
  )
}

function Gauge({ label, value, level }: { label: string; value: string; level: number }): React.ReactElement {
  const color = level === 0 ? C.up : level === 1 ? C.warn : C.down
  return (
    <div className="rounded-md p-2.5 text-center" style={{ background: C.card, border: `1px solid ${C.border}` }}>
      <div className="text-[9px] uppercase tracking-wider" style={{ color: C.dim }}>{label}</div>
      <div className="text-sm font-semibold mt-0.5 tabular-nums" style={{ color }}>{value}</div>
    </div>
  )
}
