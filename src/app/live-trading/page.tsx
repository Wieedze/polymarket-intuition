'use client'

import { useState, useEffect } from 'react'
import { useRefresh } from '../providers'
import Link from 'next/link'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, ReferenceLine,
} from 'recharts'

type ChartPoint = {
  date: string
  equity: number
  dailyPnl: number
  cumPnl: number
  trades: number
  winRate: number
}
type BotEvent = { id: number; type: string; message: string; detail: string | null; createdAt: string }
type DomainInfo = { domain: string; pnl: number; trades: number; won: number; winRate: number }
type TradeInfo = {
  title: string; side: string; entryPrice: number; curPrice: number
  unrealized: number; expert: string; domain: string
}

type LiveData = {
  balance: number
  startingBalance: number
  realizedPnl: number
  partialExitsPnl: number
  unrealizedPnl: number
  tradingDays: number
  avgHoldDays: number
  totalInvested: number
  totalEquity: number
  winRate: number
  wins: number
  losses: number
  openTrades: number
  totalTrades: number
  roi: number
  chartData: ChartPoint[]
  events: BotEvent[]
  domains: DomainInfo[]
  topOpen: TradeInfo[]
  bestTrades: Array<{ title: string; side: string; entryPrice: number; pnl: number; expert: string; domain: string }>
  worstTrades: Array<{ title: string; side: string; entryPrice: number; pnl: number; expert: string; domain: string }>
}

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
  live: '#3B82F6',        // electric blue — live trading identity
  liveGlow: '#60A5FA',    // lighter blue for accents
}

const DOMAIN_PIE_COLORS: Record<string, string> = {
  sports: COLORS.teal, weather: COLORS.blue, politics: '#6366f1',
  crypto: COLORS.amber, economics: '#eab308', science: '#06b6d4',
  culture: COLORS.pink, 'ai-tech': '#8b5cf6', geopolitics: COLORS.red,
  unknown: '#52525b',
}

function pnlStr(n: number): string { return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}` }

export default function LiveTrading(): React.ReactElement {
  const [data, setData] = useState<LiveData | null>(null)
  const [loading, setLoading] = useState(true)
  const { tick } = useRefresh()

  useEffect(() => {
    function loadData(): void {
      fetch('/api/snapshot?mode=live')
        .then(async (res) => {
          if (!res.ok) return null
          const snap = await res.json()
          const p = snap.portfolio
          return {
            balance: p.currentBalance,
            startingBalance: p.startingBalance,
            realizedPnl: p.realizedPnl,
            partialExitsPnl: p.partialExitsPnl,
            unrealizedPnl: p.unrealizedPnl,
            tradingDays: p.tradingDays,
            avgHoldDays: p.avgHoldDays,
            totalInvested: p.totalInvested,
            totalEquity: p.totalEquity,
            winRate: p.winRate,
            wins: p.wins,
            losses: p.losses,
            openTrades: p.openTrades,
            totalTrades: p.totalTrades,
            roi: p.roi,
            chartData: snap.chartData,
            events: snap.events,
            domains: snap.byDomain,
            topOpen: snap.topOpen ?? [],
            bestTrades: snap.bestTrades ?? [],
            worstTrades: snap.worstTrades ?? [],
          } as LiveData
        })
        .then((d) => { if (d) setData(d) })
        .catch(() => null)
        .finally(() => setLoading(false))
    }
    loadData()
  }, [tick])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: COLORS.bg }}>
      <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: COLORS.live, borderTopColor: 'transparent' }} />
    </div>
  )

  if (!data || data.totalTrades === 0) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: COLORS.bg }}>
      <div className="text-center">
        <div className="text-4xl mb-4">🔴</div>
        <h2 className="text-lg font-bold text-white mb-2">Live Trading</h2>
        <p className="text-sm mb-4" style={{ color: COLORS.textMuted }}>
          No live trades yet. Start the live trader to see data here.
        </p>
        <div className="p-4 rounded-xl text-left text-xs font-mono" style={{ background: COLORS.surface, color: COLORS.textMuted }}>
          <div># Dry run (no real orders):</div>
          <div style={{ color: COLORS.teal }}>DRY_RUN=true STARTING_BALANCE=100 npx tsx scripts/live-trader.ts</div>
          <div className="mt-2"># Real money:</div>
          <div style={{ color: COLORS.live }}>STARTING_BALANCE=100 npx tsx scripts/live-trader.ts</div>
        </div>
      </div>
    </div>
  )

  const donutData = data.domains.filter((d) => d.trades > 0).map((d) => ({
    name: d.domain, value: d.trades
  }))

  return (
    <div className="min-h-screen" style={{ background: COLORS.bg, color: COLORS.textLight }}>
      <div className="flex">
        {/* Sidebar */}
        <aside className="hidden lg:flex flex-col w-56 min-h-screen p-5 border-r" style={{ background: COLORS.card, borderColor: COLORS.surface }}>
          <div className="mb-10">
            <h1 className="text-lg font-bold text-white">Copy Trader</h1>
            <p className="text-xs mt-1" style={{ color: COLORS.live }}>
              <span className="inline-block w-2 h-2 rounded-full mr-1 animate-pulse" style={{ background: COLORS.live }} />
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
            <SideLink href="/rules">Rules</SideLink>
            <SideLink href="/settings">Settings</SideLink>
          </nav>
        </aside>

        {/* Main */}
        <main className="flex-1 p-6 lg:p-8">
          {/* Mobile nav */}
          <div className="lg:hidden flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: COLORS.live }} />
              <h1 className="text-lg font-bold text-white">Live Trading</h1>
            </div>
            <div className="flex gap-2">
              <Link href="/" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Paper</Link>
              <Link href="/paper-trading" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Trades</Link>
            </div>
          </div>

          {/* Live banner */}
          <div className="rounded-xl p-4 mb-6 flex items-center gap-3" style={{ background: `${COLORS.live}15`, border: `1px solid ${COLORS.live}40` }}>
            <span className="w-3 h-3 rounded-full animate-pulse" style={{ background: COLORS.live }} />
            <div>
              <span className="text-sm font-medium" style={{ color: COLORS.live }}>Real Money Mode</span>
              <span className="text-xs ml-3" style={{ color: COLORS.textMuted }}>
                Started at ${data.startingBalance.toFixed(0)} | {data.tradingDays.toFixed(1)} days | {data.totalTrades} total trades
              </span>
            </div>
          </div>

          {/* Top stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
            <BigStat
              label="Live Equity"
              value={`$${data.totalEquity.toFixed(2)}`}
              sub={`${(data.roi * 100).toFixed(1)}% ROI`}
              color={COLORS.teal}
            />
            <BigStat
              label="Realized P&L"
              value={pnlStr(data.realizedPnl)}
              sub={data.partialExitsPnl !== 0
                ? `incl. ${pnlStr(data.partialExitsPnl)} partials`
                : `avg hold ${data.avgHoldDays < 1 ? `${(data.avgHoldDays * 24).toFixed(0)}h` : `${data.avgHoldDays.toFixed(1)}d`}`}
              color={data.realizedPnl >= 0 ? COLORS.green : COLORS.red}
            />
            <BigStat
              label="Win Rate"
              value={data.wins + data.losses > 0 ? `${(data.winRate * 100).toFixed(0)}%` : '--'}
              sub={`${data.wins}W / ${data.losses}L`}
              color={COLORS.amber}
            />
            <BigStat
              label="Open Positions"
              value={`${data.openTrades}`}
              sub={`$${data.totalInvested.toFixed(2)} deployed`}
              color={COLORS.blue}
            />
            <BigStat
              label="Unrealized"
              value={pnlStr(data.unrealizedPnl)}
              sub="after 2% exit fee"
              color={data.unrealizedPnl >= 0 ? COLORS.teal : COLORS.red}
            />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            {/* Equity curve */}
            <div className="lg:col-span-2 rounded-xl p-5" style={{ background: COLORS.card }}>
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-sm font-medium" style={{ color: COLORS.textMuted }}>Live Equity Curve</h2>
                <span className="text-lg font-bold" style={{ color: data.realizedPnl >= 0 ? COLORS.teal : COLORS.red }}>
                  ${data.balance.toFixed(2)}
                </span>
              </div>
              <p className="text-xs mb-3" style={{ color: COLORS.textMuted }}>Real money portfolio (started at ${data.startingBalance.toFixed(0)})</p>
              {data.chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={data.chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                    <defs>
                      <linearGradient id="liveEqFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={COLORS.live} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={COLORS.live} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.surface} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fill: COLORS.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `$${v.toFixed(0)}`} tick={{ fill: COLORS.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} width={45} />
                    <Tooltip contentStyle={{ background: COLORS.surface, border: 'none', borderRadius: 8, fontSize: 12 }} formatter={(value) => [`$${(typeof value === 'number' ? value : Number(value ?? 0)).toFixed(2)}`, 'Equity']} />
                    <ReferenceLine y={data.startingBalance} stroke={COLORS.textMuted} strokeDasharray="3 3" />
                    <Area type="monotone" dataKey="equity" stroke={COLORS.live} fill="url(#liveEqFill)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-sm" style={{ color: COLORS.textMuted }}>Chart appears after trades resolve</div>
              )}
            </div>

            {/* Domain donut */}
            <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
              <h2 className="text-sm font-medium mb-3" style={{ color: COLORS.textMuted }}>Domains</h2>
              {donutData.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={130}>
                    <PieChart>
                      <Pie data={donutData} cx="50%" cy="50%" innerRadius={38} outerRadius={58} paddingAngle={3} dataKey="value">
                        {donutData.map((entry) => (
                          <Cell key={entry.name} fill={DOMAIN_PIE_COLORS[entry.name] ?? '#52525b'} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-2 mt-2">
                    {data.domains.slice(0, 6).map((d) => (
                      <div key={d.domain} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ background: DOMAIN_PIE_COLORS[d.domain] ?? '#52525b' }} />
                          <span className="capitalize" style={{ color: COLORS.textLight }}>{d.domain}</span>
                          <span style={{ color: COLORS.textMuted }}>{d.trades}t</span>
                        </div>
                        <span style={{ color: d.pnl >= 0 ? COLORS.teal : COLORS.red }}>{pnlStr(d.pnl)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-sm" style={{ color: COLORS.textMuted }}>No data yet</div>
              )}
            </div>
          </div>

          {/* Daily PnL + Rolling Win Rate */}
          {data.chartData.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
              <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
                <h2 className="text-sm font-medium mb-1" style={{ color: COLORS.textMuted }}>Daily P&L</h2>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={data.chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.surface} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(8)} tick={{ fill: COLORS.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `$${v}`} tick={{ fill: COLORS.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip contentStyle={{ background: COLORS.surface, border: 'none', borderRadius: 8, fontSize: 12 }} />
                    <ReferenceLine y={0} stroke={COLORS.textMuted} />
                    <Bar dataKey="dailyPnl" radius={[3, 3, 0, 0]}>
                      {data.chartData.map((entry, i) => (
                        <Cell key={i} fill={entry.dailyPnl >= 0 ? COLORS.teal : COLORS.red} fillOpacity={0.8} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
                <h2 className="text-sm font-medium mb-1" style={{ color: COLORS.textMuted }}>Win Rate (rolling 20d)</h2>
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={data.chartData} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.surface} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(8)} tick={{ fill: COLORS.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `${v}%`} tick={{ fill: COLORS.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} width={35} domain={[0, 100]} />
                    <Tooltip contentStyle={{ background: COLORS.surface, border: 'none', borderRadius: 8, fontSize: 12 }} />
                    <ReferenceLine y={50} stroke={COLORS.amber} strokeDasharray="3 3" />
                    <Line type="monotone" dataKey="winRate" stroke={COLORS.amber} strokeWidth={2} dot={{ r: 3, fill: COLORS.amber }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Open positions */}
          {data.topOpen.length > 0 && (
            <div className="rounded-xl p-5 mb-8" style={{ background: COLORS.card }}>
              <h2 className="text-sm font-medium mb-4" style={{ color: COLORS.textMuted }}>Open Live Positions</h2>
              <div className="space-y-2">
                {data.topOpen.map((t, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-2 border-b" style={{ borderColor: COLORS.surface }}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{
                          background: t.side === 'YES' ? `${COLORS.green}20` : `${COLORS.red}20`,
                          color: t.side === 'YES' ? COLORS.green : COLORS.red,
                        }}>
                          {t.side}
                        </span>
                        <span className="truncate" style={{ color: COLORS.textLight }}>{t.title}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-3" style={{ color: COLORS.textMuted }}>
                        <span>{t.domain}</span>
                        <span>{t.expert}</span>
                        <span>entry: {(t.entryPrice * 100).toFixed(0)}¢</span>
                        <span>now: {(t.curPrice * 100).toFixed(0)}¢</span>
                      </div>
                    </div>
                    <span className="text-sm font-medium ml-3" style={{ color: t.unrealized >= 0 ? COLORS.teal : COLORS.red }}>
                      {pnlStr(t.unrealized)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Best / Worst trades */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            {data.bestTrades.length > 0 && (
              <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
                <h2 className="text-sm font-medium mb-3" style={{ color: COLORS.textMuted }}>Best Live Trades</h2>
                {data.bestTrades.slice(0, 5).map((t, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-2 border-b" style={{ borderColor: COLORS.surface }}>
                    <div className="flex-1 min-w-0">
                      <span className="truncate block" style={{ color: COLORS.textLight }}>{t.title}</span>
                      <span style={{ color: COLORS.textMuted }}>{t.side} @ {(t.entryPrice * 100).toFixed(0)}¢ | {t.domain}</span>
                    </div>
                    <span className="font-medium ml-2" style={{ color: COLORS.green }}>{pnlStr(t.pnl)}</span>
                  </div>
                ))}
              </div>
            )}
            {data.worstTrades.length > 0 && (
              <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
                <h2 className="text-sm font-medium mb-3" style={{ color: COLORS.textMuted }}>Worst Live Trades</h2>
                {data.worstTrades.slice(0, 5).map((t, i) => (
                  <div key={i} className="flex items-center justify-between text-xs py-2 border-b" style={{ borderColor: COLORS.surface }}>
                    <div className="flex-1 min-w-0">
                      <span className="truncate block" style={{ color: COLORS.textLight }}>{t.title}</span>
                      <span style={{ color: COLORS.textMuted }}>{t.side} @ {(t.entryPrice * 100).toFixed(0)}¢ | {t.domain}</span>
                    </div>
                    <span className="font-medium ml-2" style={{ color: COLORS.red }}>{pnlStr(t.pnl)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Events */}
          <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
            <h2 className="text-sm font-medium mb-4" style={{ color: COLORS.textMuted }}>Live Activity</h2>
            <div className="space-y-3">
              {data.events.length > 0 ? data.events.slice(0, 15).map((e) => (
                <div key={e.id} className="flex gap-3 text-xs py-2 border-b" style={{ borderColor: COLORS.surface }}>
                  <span className="text-base">{e.type.startsWith('live') ? '🔴' : '📋'}</span>
                  <div className="flex-1 min-w-0">
                    <div style={{ color: COLORS.textLight }}>{e.message}</div>
                    {e.detail && <div className="mt-0.5 truncate" style={{ color: COLORS.textMuted }}>{e.detail}</div>}
                  </div>
                  <span style={{ color: COLORS.textMuted }}>{e.createdAt.slice(11, 16)}</span>
                </div>
              )) : (
                <div className="text-sm py-8 text-center" style={{ color: COLORS.textMuted }}>
                  Live activity will appear once the bot starts trading
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

function BigStat({ label, value, sub, color }: {
  label: string; value: string; color: string; sub?: string
}): React.ReactElement {
  return (
    <div className="rounded-xl p-4" style={{ background: COLORS.card }}>
      <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: COLORS.textMuted }}>{label}</div>
      <div className="text-xl font-bold" style={{ color }}>{value}</div>
      {sub && <div className="text-xs mt-1" style={{ color: COLORS.textMuted }}>{sub}</div>}
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
