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

type PaperTrade = {
  id: string
  conditionId: string
  title: string
  domain: string | null
  side: string
  entryPrice: number
  simulatedUsdc: number
  shares: number
  copiedFrom: string
  copiedLabel: string | null
  status: 'open' | 'won' | 'lost'
  curPrice: number | null
  exitPrice: number | null
  pnl: number | null
  openedAt: string
  resolvedAt: string | null
}

type Portfolio = {
  startingBalance: number
  currentBalance: number
  realizedPnl: number
  unrealizedPnl: number
  totalInvested: number
  betSizeUsdc: number
  totalTrades: number
  openTrades: number
  closedTrades: number
  wins: number
  losses: number
  winRate: number
  roi: number
}

type PaperTradingData = {
  portfolio: Portfolio
  trades: PaperTrade[]
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
  'pm-domain/geopolitics': 'Geo',
}

const DOMAIN_COLORS: Record<string, string> = {
  'pm-domain/ai-tech': '#8b5cf6',
  'pm-domain/politics': '#28AEF3',
  'pm-domain/crypto': '#FCB859',
  'pm-domain/sports': '#A9DFD8',
  'pm-domain/economics': '#eab308',
  'pm-domain/science': '#06b6d4',
  'pm-domain/culture': '#F2C8ED',
  'pm-domain/weather': '#28AEF3',
  'pm-domain/geopolitics': '#EA1701',
}

function truncAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr
}

function pnlColor(n: number): string {
  return n >= 0 ? COLORS.teal : COLORS.red
}

function pnlStr(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`
}

export default function PaperTradingPage(): React.ReactElement {
  const [data, setData] = useState<PaperTradingData | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'open' | 'closed' | 'all'>('open')
  const [betSize, setBetSize] = useState('100')
  const [startBal, setStartBal] = useState('10000')

  async function fetchData(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/paper-trading')
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const result = (await res.json()) as PaperTradingData
      setData(result)
      setBetSize(result.portfolio.betSizeUsdc.toString())
      setStartBal(result.portfolio.startingBalance.toString())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  async function refreshPrices(): Promise<void> {
    setRefreshing(true)
    await fetch('/api/paper-trading?action=refresh')
    await fetchData()
    setRefreshing(false)
  }

  async function checkResolutions(): Promise<void> {
    setResolving(true)
    await fetch('/api/paper-trading?action=resolve')
    await fetchData()
    setResolving(false)
  }

  async function saveSetting(): Promise<void> {
    await fetch('/api/paper-trading', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'configure',
        startingBalance: parseFloat(startBal),
        betSizeUsdc: parseFloat(betSize),
      }),
    })
    await fetchData()
  }

  useEffect(() => { void fetchData() }, [])

  const p = data?.portfolio
  const trades = data?.trades ?? []
  const filtered = tab === 'open'
    ? trades.filter((t) => t.status === 'open')
    : tab === 'closed'
    ? trades.filter((t) => t.status !== 'open')
    : trades

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
            <SideLink href="/paper-trading" active>Trades</SideLink>
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
              <Link href="/" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Dashboard</Link>
              <Link href="/analytics" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Analytics</Link>
            </div>
          </div>

          {/* Header */}
          <div className="flex items-center justify-between mb-8">
            <div>
              <h2 className="text-2xl font-bold text-white">Paper Trading</h2>
              <p className="mt-1 text-sm" style={{ color: COLORS.textMuted }}>Simulated copy trading — test your strategy with fake money</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => void refreshPrices()}
                disabled={refreshing}
                className="px-4 py-2 text-sm rounded-lg transition-colors"
                style={{
                  background: refreshing ? COLORS.surface : COLORS.surface,
                  color: refreshing ? COLORS.textMuted : COLORS.textLight,
                  border: `1px solid ${COLORS.surface}`,
                }}
              >
                {refreshing ? 'Refreshing...' : 'Refresh Prices'}
              </button>
              <button
                onClick={() => void checkResolutions()}
                disabled={resolving}
                className="px-4 py-2 text-sm font-medium rounded-lg transition-colors"
                style={{
                  background: resolving ? COLORS.surface : COLORS.teal,
                  color: resolving ? COLORS.textMuted : COLORS.bg,
                }}
              >
                {resolving ? 'Checking...' : 'Check Resolutions'}
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-6 text-sm" style={{ color: COLORS.red }}>{error}</div>
          )}

          {/* Portfolio stats */}
          {p && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
              <div className="p-4 rounded-xl" style={{ background: COLORS.card }}>
                <div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: COLORS.textMuted }}>Balance</div>
                <div className="text-xl font-bold" style={{ color: p.currentBalance >= p.startingBalance ? COLORS.teal : COLORS.red }}>
                  ${p.currentBalance.toFixed(0)}
                </div>
                <div className="text-xs mt-1" style={{ color: COLORS.textMuted }}>Started: ${p.startingBalance.toFixed(0)}</div>
              </div>
              <div className="p-4 rounded-xl" style={{ background: COLORS.card }}>
                <div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: COLORS.textMuted }}>Realized P&L</div>
                <div className="text-xl font-bold" style={{ color: pnlColor(p.realizedPnl) }}>
                  {pnlStr(p.realizedPnl)}
                </div>
                <div className="text-xs mt-1" style={{ color: COLORS.textMuted }}>
                  Unrealized: {pnlStr(p.unrealizedPnl)}
                </div>
              </div>
              <div className="p-4 rounded-xl" style={{ background: COLORS.card }}>
                <div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: COLORS.textMuted }}>Win Rate</div>
                <div className="text-xl font-bold text-white">
                  {p.closedTrades > 0 ? `${Math.round(p.winRate * 100)}%` : '—'}
                </div>
                <div className="text-xs mt-1" style={{ color: COLORS.textMuted }}>{p.wins}W / {p.losses}L</div>
              </div>
              <div className="p-4 rounded-xl" style={{ background: COLORS.card }}>
                <div className="text-[11px] uppercase tracking-wider mb-1" style={{ color: COLORS.textMuted }}>ROI</div>
                <div className="text-xl font-bold" style={{ color: pnlColor(p.roi) }}>
                  {p.closedTrades > 0 ? `${(p.roi * 100).toFixed(1)}%` : '—'}
                </div>
                <div className="text-xs mt-1" style={{ color: COLORS.textMuted }}>{p.openTrades} open / {p.totalTrades} total</div>
              </div>
            </div>
          )}

          {/* Settings row */}
          <div className="flex flex-wrap items-center gap-3 mb-6 p-4 rounded-xl" style={{ background: COLORS.card }}>
            <span className="text-xs font-medium" style={{ color: COLORS.textMuted }}>Settings</span>
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: COLORS.textMuted }}>Bet size:</span>
              <input
                type="number"
                value={betSize}
                onChange={(e) => setBetSize(e.target.value)}
                className="w-20 px-2 py-1 text-sm rounded"
                style={{ background: COLORS.surface, border: `1px solid ${COLORS.surface}`, color: COLORS.textLight }}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: COLORS.textMuted }}>Balance:</span>
              <input
                type="number"
                value={startBal}
                onChange={(e) => setStartBal(e.target.value)}
                className="w-24 px-2 py-1 text-sm rounded"
                style={{ background: COLORS.surface, border: `1px solid ${COLORS.surface}`, color: COLORS.textLight }}
              />
            </div>
            <button
              onClick={() => void saveSetting()}
              className="px-3 py-1 text-xs rounded-lg transition-colors"
              style={{ background: COLORS.surface, color: COLORS.textLight }}
            >
              Save
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-2 mb-4">
            {(['open', 'closed', 'all'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="px-4 py-1.5 text-sm rounded-lg border transition-colors"
                style={{
                  background: tab === t ? COLORS.surface : 'transparent',
                  borderColor: tab === t ? COLORS.teal : COLORS.surface,
                  color: tab === t ? COLORS.teal : COLORS.textMuted,
                }}
              >
                {t === 'open' ? `Open (${trades.filter((x) => x.status === 'open').length})` :
                 t === 'closed' ? `Closed (${trades.filter((x) => x.status !== 'open').length})` :
                 `All (${trades.length})`}
              </button>
            ))}
          </div>

          {/* Loading */}
          {loading && (
            <div className="text-center py-16">
              <div className="inline-block w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: COLORS.teal, borderTopColor: 'transparent' }} />
            </div>
          )}

          {/* Trades list */}
          {!loading && filtered.length === 0 ? (
            <div className="text-center py-16 border rounded-xl" style={{ borderColor: COLORS.surface }}>
              <p style={{ color: COLORS.textMuted }}>No paper trades yet</p>
              <p className="mt-2 text-sm" style={{ color: COLORS.surface }}>
                Trades are auto-copied by the bot. Check{' '}
                <Link href="/analytics" style={{ color: COLORS.teal }}>Analytics</Link>{' '}
                for performance breakdown.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((t) => {
                const unrealized = t.curPrice != null ? t.shares * (t.curPrice - t.entryPrice) : 0
                const displayPnl = t.status === 'open' ? unrealized : (t.pnl ?? 0)
                const statusColor = t.status === 'open' ? COLORS.blue : t.status === 'won' ? COLORS.teal : COLORS.red

                return (
                  <div
                    key={t.id}
                    className="px-4 py-3 rounded-xl border"
                    style={{
                      background: COLORS.card,
                      borderColor: t.status === 'open' ? COLORS.surface : t.status === 'won' ? `${COLORS.teal}33` : `${COLORS.red}33`,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      {/* Status badge */}
                      <span
                        className="text-xs font-medium px-2 py-0.5 rounded"
                        style={{ background: `${statusColor}22`, color: statusColor }}
                      >
                        {t.status.toUpperCase()}
                      </span>

                      {/* Domain */}
                      {t.domain && (
                        <span
                          className="text-[10px] px-2 py-0.5 rounded-full"
                          style={{
                            background: `${DOMAIN_COLORS[t.domain] ?? COLORS.textMuted}22`,
                            color: DOMAIN_COLORS[t.domain] ?? COLORS.textMuted,
                          }}
                        >
                          {DOMAIN_LABELS[t.domain] ?? '?'}
                        </span>
                      )}

                      {/* Side */}
                      <span className="text-xs font-medium" style={{ color: t.side === 'YES' ? COLORS.teal : COLORS.red }}>
                        {t.side}
                      </span>

                      {/* Title */}
                      <span className="text-sm flex-1 truncate" style={{ color: COLORS.textLight }}>{t.title}</span>

                      {/* Prices */}
                      <div className="text-xs text-right" style={{ color: COLORS.textMuted }}>
                        <span>{(t.entryPrice * 100).toFixed(0)}¢</span>
                        <span style={{ color: COLORS.surface }}> → </span>
                        <span style={{ color: t.status === 'open'
                          ? ((t.curPrice ?? 0) > t.entryPrice ? COLORS.teal : COLORS.red)
                          : (t.status === 'won' ? COLORS.teal : COLORS.red)
                        }}>
                          {(((t.status === 'open' ? t.curPrice : t.exitPrice) ?? 0) * 100).toFixed(0)}¢
                        </span>
                      </div>

                      {/* PnL */}
                      <div className="text-sm font-medium w-20 text-right" style={{ color: pnlColor(displayPnl) }}>
                        {pnlStr(displayPnl)}
                      </div>

                      {/* Copied from */}
                      <span className="text-[10px] w-20 text-right truncate" style={{ color: COLORS.textMuted }}>
                        {t.copiedLabel ?? truncAddr(t.copiedFrom)}
                      </span>
                    </div>
                  </div>
                )
              })}
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
