'use client'

import { useState } from 'react'
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
  'pm-domain/ai-tech': '#8b5cf6',
  'pm-domain/politics': COLORS.blue,
  'pm-domain/crypto': COLORS.amber,
  'pm-domain/sports': COLORS.teal,
  'pm-domain/economics': '#eab308',
  'pm-domain/science': '#06b6d4',
  'pm-domain/culture': COLORS.pink,
  'pm-domain/weather': COLORS.blue,
  'pm-domain/geopolitics': COLORS.red,
}

const PERIODS = [
  { value: 'WEEK', label: 'This Week' },
  { value: 'MONTH', label: 'This Month' },
  { value: 'ALL', label: 'All Time' },
]

function copyabilityColor(score: number): string {
  if (score >= 0.6) return COLORS.teal
  if (score >= 0.4) return COLORS.amber
  return COLORS.red
}

function copyabilityBg(score: number): string {
  if (score >= 0.6) return COLORS.teal
  if (score >= 0.4) return COLORS.amber
  return COLORS.red
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
            <SideLink href="/analytics">Analytics</SideLink>
            <SideLink href="/paper-trading">Trades</SideLink>
            <SideLink href="/activity">Activity</SideLink>
            <SideLink href="/leaderboard" active>Leaderboard</SideLink>
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
              <Link href="/analytics" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Analytics</Link>
            </div>
          </div>

          {/* Header */}
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white">Copy Trade Leaderboard</h2>
            <p className="mt-2 text-sm" style={{ color: COLORS.textMuted }}>
              Top Polymarket traders ranked by copyability — who to follow with a small account
            </p>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-3 mb-8">
            {PERIODS.map((p) => (
              <button
                key={p.value}
                onClick={() => setPeriod(p.value)}
                className="px-4 py-2 text-sm rounded-lg border transition-colors"
                style={{
                  background: period === p.value ? COLORS.surface : 'transparent',
                  borderColor: period === p.value ? COLORS.teal : COLORS.surface,
                  color: period === p.value ? COLORS.teal : COLORS.textMuted,
                }}
              >
                {p.label}
              </button>
            ))}
            <select
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value, 10))}
              className="px-3 py-2 text-sm rounded-lg border"
              style={{ background: COLORS.card, borderColor: COLORS.surface, color: COLORS.textLight }}
            >
              <option value={5}>Top 5</option>
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
            </select>
            <button
              onClick={() => void fetchLeaderboard()}
              disabled={loading}
              className="px-6 py-2 text-sm font-medium rounded-lg transition-colors"
              style={{
                background: loading ? COLORS.surface : COLORS.teal,
                color: loading ? COLORS.textMuted : COLORS.bg,
              }}
            >
              {loading ? 'Computing...' : 'Load Leaderboard'}
            </button>
          </div>

          {loading && (
            <div className="text-center py-20">
              <div className="inline-block w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: COLORS.teal, borderTopColor: 'transparent' }} />
              <p className="mt-4" style={{ color: COLORS.textMuted }}>
                Fetching leaderboard & computing copyability scores...
              </p>
              <p className="mt-2 text-sm" style={{ color: COLORS.surface }}>
                This may take a minute — analyzing trades for each wallet
              </p>
            </div>
          )}

          {error && (
            <div className="text-center py-8" style={{ color: COLORS.red }}>{error}</div>
          )}

          {data && !loading && (
            <div className="space-y-3">
              {data.wallets.map((w, idx) => (
                <div
                  key={w.address}
                  className="rounded-xl border transition-colors"
                  style={{ background: COLORS.card, borderColor: COLORS.surface }}
                >
                  {/* Main row */}
                  <button
                    onClick={() => setExpanded(expanded === w.address ? null : w.address)}
                    className="w-full px-5 py-4 flex items-center gap-4 text-left"
                  >
                    {/* Rank */}
                    <span className="text-2xl font-bold w-8 text-right" style={{ color: COLORS.surface }}>
                      {idx + 1}
                    </span>

                    {/* Copyability score */}
                    <div className="w-16 text-center">
                      <div className="text-xl font-bold" style={{ color: copyabilityColor(w.topCopyability) }}>
                        {Math.round(w.topCopyability * 100)}
                      </div>
                      <div className="text-[10px] uppercase" style={{ color: COLORS.textMuted }}>Copy</div>
                    </div>

                    {/* Name + address */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white truncate">{w.userName}</span>
                        <span className="font-mono text-xs" style={{ color: COLORS.textMuted }}>{truncateAddress(w.address)}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: COLORS.textMuted }}>
                        <span>{w.resolvedTrades} trades</span>
                        {w.bestDomain && (
                          <>
                            <span>&middot;</span>
                            <span style={{ color: DOMAIN_COLORS[w.bestDomain.domain] ?? COLORS.textMuted }}>
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

                    {/* PnL */}
                    <div className="text-right">
                      <div className="font-medium" style={{ color: w.pnl >= 0 ? COLORS.teal : COLORS.red }}>
                        {w.pnl >= 0 ? '+' : ''}{(w.pnl / 1000).toFixed(0)}K
                      </div>
                      <div className="text-[10px]" style={{ color: COLORS.textMuted }}>PnL ({data.period})</div>
                    </div>

                    {/* Expand */}
                    <span className="text-sm" style={{ color: COLORS.textMuted }}>
                      {expanded === w.address ? '▲' : '▼'}
                    </span>
                  </button>

                  {/* Expanded domain details */}
                  {expanded === w.address && w.domains.length > 0 && (
                    <div className="px-5 pb-4 border-t" style={{ borderColor: COLORS.surface }}>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
                        {w.domains.map((d) => (
                          <div key={d.domain} className="p-3 rounded-lg" style={{ background: COLORS.surface }}>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-medium" style={{ color: DOMAIN_COLORS[d.domain] ?? COLORS.textLight }}>
                                {DOMAIN_LABELS[d.domain] ?? d.domain}
                              </span>
                              <span className="text-sm font-bold" style={{ color: copyabilityColor(d.copyabilityScore) }}>
                                {Math.round(d.copyabilityScore * 100)}%
                              </span>
                            </div>
                            <div className="h-1.5 rounded-full overflow-hidden mb-2" style={{ background: COLORS.card }}>
                              <div
                                className="h-full rounded-full transition-all"
                                style={{
                                  width: `${Math.round(d.copyabilityScore * 100)}%`,
                                  background: copyabilityBg(d.copyabilityScore),
                                }}
                              />
                            </div>
                            <div className="grid grid-cols-3 gap-1 text-[11px]">
                              <div>
                                <span style={{ color: COLORS.textMuted }}>WR </span>
                                <span style={{ color: COLORS.textLight }}>{Math.round(d.winRate * 100)}%</span>
                              </div>
                              <div>
                                <span style={{ color: COLORS.textMuted }}>PF </span>
                                <span style={{ color: d.profitFactor >= 1.5 ? COLORS.teal : COLORS.textLight }}>
                                  {pfLabel(d.profitFactor)}
                                </span>
                              </div>
                              <div>
                                <span style={{ color: COLORS.textMuted }}>MaxL </span>
                                <span style={{ color: d.maxConsecutiveLosses <= 5 ? COLORS.textLight : COLORS.red }}>
                                  {d.maxConsecutiveLosses}
                                </span>
                              </div>
                              <div>
                                <span style={{ color: COLORS.textMuted }}>Cal </span>
                                <span style={{ color: COLORS.textLight }}>{Math.round(d.calibration * 100)}%</span>
                              </div>
                              <div>
                                <span style={{ color: COLORS.textMuted }}>Avg </span>
                                <span style={{ color: d.avgPnlPerTrade >= 0 ? COLORS.teal : COLORS.red }}>
                                  {d.avgPnlPerTrade >= 0 ? '+' : ''}{d.avgPnlPerTrade.toFixed(0)}
                                </span>
                              </div>
                              <div>
                                <span style={{ color: COLORS.textMuted }}>{d.trades}t </span>
                                <span style={{ color: COLORS.textMuted }}>{d.tradingStyle}</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="mt-3 text-center">
                        <Link
                          href={`/profile/${w.address}`}
                          className="text-sm transition-colors"
                          style={{ color: COLORS.teal }}
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

          {!data && !loading && !error && (
            <div className="text-center py-20 border rounded-xl" style={{ borderColor: COLORS.surface }}>
              <p className="text-lg mb-2" style={{ color: COLORS.textMuted }}>Ready to compute</p>
              <p className="text-sm" style={{ color: COLORS.textMuted }}>Select a period and click Load Leaderboard</p>
            </div>
          )}
        </main>
      </div>
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
