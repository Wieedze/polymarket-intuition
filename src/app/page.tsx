'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell,
} from 'recharts'

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

// Design system colors from Figma mockup
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

const DOMAIN_PIE_COLORS: Record<string, string> = {
  sports: COLORS.teal,
  weather: COLORS.blue,
  politics: '#6366f1',
  crypto: COLORS.amber,
  economics: '#eab308',
  science: '#06b6d4',
  culture: COLORS.pink,
  'ai-tech': '#8b5cf6',
  geopolitics: COLORS.red,
  unknown: '#52525b',
}

const EVENT_ICONS: Record<string, string> = {
  copy: '📋', exit: '🚪', resolve: '✅',
}

function pnlStr(n: number): string { return `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(0)}` }

export default function Dashboard(): React.ReactElement {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/dashboard')
      .then(async (res) => res.ok ? (await res.json()) as DashboardData : null)
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: COLORS.bg }}>
      <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: COLORS.teal, borderTopColor: 'transparent' }} />
    </div>
  )

  if (!data) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: COLORS.bg, color: COLORS.textMuted }}>
      No data yet — bot is starting up
    </div>
  )

  const donutData = data.domains.filter((d) => d.trades > 0).map((d) => ({
    name: d.domain, value: d.trades
  }))

  return (
    <div className="min-h-screen" style={{ background: COLORS.bg, color: COLORS.textLight }}>
      {/* Sidebar + Main layout */}
      <div className="flex">
        {/* Sidebar */}
        <aside className="hidden lg:flex flex-col w-56 min-h-screen p-5 border-r" style={{ background: COLORS.card, borderColor: COLORS.surface }}>
          <div className="mb-10">
            <h1 className="text-lg font-bold text-white">Copy Trader</h1>
            <p className="text-xs mt-1" style={{ color: COLORS.textMuted }}>Paper simulation</p>
          </div>
          <nav className="flex flex-col gap-1">
            <SideLink href="/" active>Dashboard</SideLink>
            <SideLink href="/analytics">Analytics</SideLink>
            <SideLink href="/paper-trading">Trades</SideLink>
            <SideLink href="/leaderboard">Leaderboard</SideLink>
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
              <Link href="/analytics" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Analytics</Link>
              <Link href="/paper-trading" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Trades</Link>
            </div>
          </div>

          {/* Top stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
            <BigStat label="Total Equity" value={`$${data.totalEquity.toFixed(0)}`} change={data.roi} color={COLORS.teal} />
            <BigStat label="Realized P&L" value={pnlStr(data.realizedPnl)} color={data.realizedPnl >= 0 ? COLORS.green : COLORS.red} />
            <BigStat label="Win Rate" value={data.wins + data.losses > 0 ? `${(data.winRate * 100).toFixed(0)}%` : '—'} sub={`${data.wins}W · ${data.losses}L`} color={COLORS.amber} />
            <BigStat label="Open Trades" value={`${data.openTrades}`} sub={`$${data.totalInvested.toFixed(0)} invested`} color={COLORS.blue} />
            <BigStat label="Unrealized" value={pnlStr(data.unrealizedPnl)} color={data.unrealizedPnl >= 0 ? COLORS.teal : COLORS.red} />
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
            {/* PnL Chart */}
            <div className="lg:col-span-2 rounded-xl p-5" style={{ background: COLORS.card }}>
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-sm font-medium" style={{ color: COLORS.textMuted }}>Performance</h2>
                <span className="text-lg font-bold" style={{ color: data.realizedPnl >= 0 ? COLORS.teal : COLORS.red }}>
                  {pnlStr(data.realizedPnl)}
                </span>
              </div>
              <p className="text-xs mb-4" style={{ color: COLORS.textMuted }}>Cumulative P&L over time</p>
              {data.pnlHistory.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={data.pnlHistory} margin={{ top: 5, right: 10, bottom: 5, left: 10 }}>
                    <defs>
                      <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={COLORS.teal} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={COLORS.teal} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={COLORS.surface} />
                    <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fill: COLORS.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `$${v}`} tick={{ fill: COLORS.textMuted, fontSize: 10 }} axisLine={false} tickLine={false} width={50} />
                    <Tooltip
                      contentStyle={{ background: COLORS.surface, border: 'none', borderRadius: 8, color: '#fff', fontSize: 12 }}
                      formatter={(value: number) => [`$${value.toFixed(2)}`, 'P&L']}
                      labelFormatter={(l: string) => l}
                    />
                    <Area type="monotone" dataKey="pnl" stroke={COLORS.teal} fill="url(#pnlFill)" strokeWidth={2} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[220px] flex items-center justify-center text-sm" style={{ color: COLORS.textMuted }}>
                  Chart appears after trades resolve
                </div>
              )}
            </div>

            {/* Domain donut + list */}
            <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
              <h2 className="text-sm font-medium mb-4" style={{ color: COLORS.textMuted }}>By Domain</h2>
              {donutData.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={140}>
                    <PieChart>
                      <Pie data={donutData} cx="50%" cy="50%" innerRadius={40} outerRadius={60} paddingAngle={3} dataKey="value">
                        {donutData.map((entry) => (
                          <Cell key={entry.name} fill={DOMAIN_PIE_COLORS[entry.name] ?? '#52525b'} />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-2 mt-2">
                    {data.domains.slice(0, 5).map((d) => (
                      <div key={d.domain} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full" style={{ background: DOMAIN_PIE_COLORS[d.domain] ?? '#52525b' }} />
                          <span className="capitalize" style={{ color: COLORS.textLight }}>{d.domain}</span>
                        </div>
                        <span style={{ color: d.pnl >= 0 ? COLORS.teal : COLORS.red }}>{pnlStr(d.pnl)}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="h-[200px] flex items-center justify-center text-sm" style={{ color: COLORS.textMuted }}>
                  No domain data yet
                </div>
              )}
            </div>
          </div>

          {/* Activity feed */}
          <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
            <h2 className="text-sm font-medium mb-4" style={{ color: COLORS.textMuted }}>Recent Activity</h2>
            <div className="space-y-3 max-h-[300px] overflow-y-auto">
              {data.events.length > 0 ? data.events.map((e) => (
                <div key={e.id} className="flex gap-3 text-xs py-2 border-b" style={{ borderColor: COLORS.surface }}>
                  <span className="text-base">{EVENT_ICONS[e.type] ?? '•'}</span>
                  <div className="flex-1 min-w-0">
                    <div style={{ color: COLORS.textLight }}>{e.message}</div>
                    {e.detail && <div className="mt-0.5 truncate" style={{ color: COLORS.textMuted }}>{e.detail}</div>}
                  </div>
                  <span style={{ color: COLORS.textMuted }}>{e.createdAt.slice(11, 16)}</span>
                </div>
              )) : (
                <div className="text-sm py-8 text-center" style={{ color: COLORS.textMuted }}>
                  Activity will appear as the bot copies trades
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

function BigStat({ label, value, sub, color, change }: {
  label: string; value: string; color: string; sub?: string; change?: number
}): React.ReactElement {
  return (
    <div className="rounded-xl p-4" style={{ background: COLORS.card }}>
      <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: COLORS.textMuted }}>{label}</div>
      <div className="text-xl font-bold" style={{ color }}>{value}</div>
      {change !== undefined && (
        <div className="text-xs mt-1" style={{ color: change >= 0 ? COLORS.green : COLORS.red }}>
          {change >= 0 ? '↑' : '↓'} {Math.abs(change * 100).toFixed(1)}% ROI
        </div>
      )}
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
