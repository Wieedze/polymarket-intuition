'use client'

import { useState, useEffect } from 'react'
import { useRefresh } from './providers'
import {
  ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts'

// ── Types (matching on-chain API responses) ─────────────────────

type OpenPosition = {
  title: string; side: string; size: number; avgPrice: number
  curPrice: number; value: number; cost: number; pnl: number; pnlPct: number; resolved: boolean
}
type ClosedTrade = { title: string; side: string; result: 'won' | 'lost'; totalTraded: number; amountWon: number; pnl: number }
type DomainInfo = { domain: string; pnl: number; trades: number; won: number; winRate: number; avgPnl: number }
type SideInfo = { trades: number; won: number; winRate: number; pnl: number }
type BotEvent = { id: number; type: string; message: string; detail: string | null; createdAt: string }

type WalletData = {
  totalEquity: number; usdc: number; positionsValue: number
  realizedPnl: number; unrealizedPnl: number
  wins: number; losses: number; winRate: number; totalTrades: number
  startingBalance: number; roi: number
  openPositions: OpenPosition[]
  pendingRedeem: OpenPosition[]
  pendingRedeemValue: number
  closedTrades: ClosedTrade[]
  domains: DomainInfo[]
  bySide: { yes: SideInfo; no: SideInfo }
  bestTrades: ClosedTrade[]
  worstTrades: ClosedTrade[]
  risk: { topConcentration: number; top3Concentration: number; openCount: number; cashPct: number }
}

// ── Palette ─────────────────────────────────────────────────────

const C = {
  bg: '#0F1117',
  card: '#181A20',
  surface: '#1E2028',
  up: '#10B981',
  down: '#EF4444',
  accent: '#6366F1',
  dim: '#6B7084',
  text: '#C9CDD8',
  bright: '#EAECF0',
  border: '#262835',
  warn: '#F59E0B',
}

const DOMAIN_COLORS: Record<string, string> = {
  sports: '#10B981', weather: '#38BDF8', politics: '#818CF8',
  crypto: '#FBBF24', economics: '#A78BFA', science: '#22D3EE',
  culture: '#F9A8D4', 'ai-tech': '#C084FC', geopolitics: '#FB7185',
  unknown: '#52525b',
}

function $(n: number): string { return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}` }
function pct(n: number): string { return `${(n * 100).toFixed(1)}%` }

// ── Page ────────────────────────────────────────────────────────

export default function LiveTrading(): React.ReactElement {
  const [data, setData] = useState<WalletData | null>(null)
  const [events, setEvents] = useState<BotEvent[]>([])
  const [loading, setLoading] = useState(true)
  const { tick } = useRefresh()

  useEffect(() => {
    Promise.all([
      fetch('/api/dashboard').then(r => r.ok ? r.json() : null).catch(() => null),
      fetch('/api/activity?limit=15').then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([d, a]) => {
      if (d && !d.error) setData(d as WalletData)
      if (a?.events) setEvents(a.events as BotEvent[])
    }).finally(() => setLoading(false))
  }, [tick])

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}>
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: C.accent, borderTopColor: 'transparent' }} />
    </div>
  )

  if (!data) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: C.bg }}>
      <div className="text-center">
        <h2 className="text-base font-medium text-white mb-2">Live Trading</h2>
        <p className="text-sm" style={{ color: C.dim }}>No data available.</p>
      </div>
    </div>
  )

  const donutData = data.domains.filter(d => d.trades > 0).map(d => ({ name: d.domain, value: d.trades }))

  return (
    <div className="p-6 lg:p-8 max-w-7xl" style={{ color: C.text }}>

      {/* 1. HEADER BAR */}
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
            started ${data.startingBalance.toFixed(0)} / {data.totalTrades} trades
          </div>
        </div>
        <div className="flex gap-6 text-xs">
          <Metric label="Realized" value={$(data.realizedPnl)} color={data.realizedPnl >= 0 ? C.up : C.down} />
          <Metric label="Unrealized" value={$(data.unrealizedPnl)} color={data.unrealizedPnl >= 0 ? C.up : C.down} />
          <Metric label="Cash" value={`$${data.usdc.toFixed(2)}`} color={C.text} />
          <Metric label="Win Rate" value={`${data.winRate}%`} color={C.text} />
          <Metric label="W / L" value={`${data.wins} / ${data.losses}`} color={C.dim} />
          <Metric label="Open" value={`${data.risk.openCount}`} color={C.accent} />
        </div>
      </div>

      {/* 2. RISK ROW */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
        <Gauge label="Top Pos" value={pct(data.risk.topConcentration)} level={data.risk.topConcentration > 0.30 ? 2 : data.risk.topConcentration > 0.15 ? 1 : 0} />
        <Gauge label="Top 3" value={pct(data.risk.top3Concentration)} level={data.risk.top3Concentration > 0.60 ? 2 : data.risk.top3Concentration > 0.40 ? 1 : 0} />
        <Gauge label="Cash %" value={pct(data.risk.cashPct)} level={data.risk.cashPct < 0.10 ? 2 : data.risk.cashPct < 0.30 ? 1 : 0} />
        <Gauge label="Positions" value={`${data.risk.openCount}`} level={data.risk.openCount > 20 ? 2 : data.risk.openCount > 10 ? 1 : 0} />
      </div>

      {/* 3. POSITIONS + DOMAINS */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
        {/* Open positions */}
        <div className="lg:col-span-3 rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="flex justify-between items-center mb-3">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Open Positions</span>
            <span className="text-[11px]" style={{ color: C.dim }}>{data.openPositions.length} active / ${data.positionsValue.toFixed(2)} deployed</span>
          </div>
          {data.openPositions.length > 0 ? (
            <table className="w-full text-[11px]">
              <thead>
                <tr style={{ color: C.dim }}>
                  <th className="text-left pb-2 font-normal">Market</th>
                  <th className="text-left pb-2 font-normal w-12">Side</th>
                  <th className="text-right pb-2 font-normal">Entry</th>
                  <th className="text-right pb-2 font-normal">Now</th>
                  <th className="text-right pb-2 font-normal">Value</th>
                  <th className="text-right pb-2 font-normal">P&L</th>
                </tr>
              </thead>
              <tbody>
                {data.openPositions.map((p, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td className="py-2 pr-3 max-w-[300px] truncate" style={{ color: C.text }}>{p.title}</td>
                    <td className="py-2">
                      <span className="text-[10px] font-medium" style={{ color: p.side === 'YES' ? C.up : C.down }}>{p.side}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums">{(p.avgPrice * 100).toFixed(0)}c</td>
                    <td className="py-2 text-right tabular-nums">{(p.curPrice * 100).toFixed(0)}c</td>
                    <td className="py-2 text-right tabular-nums">${p.value.toFixed(2)}</td>
                    <td className="py-2 text-right tabular-nums font-medium" style={{ color: p.pnl >= 0 ? C.up : C.down }}>
                      {$(p.pnl)} <span style={{ color: C.dim }}>({p.pnlPct >= 0 ? '+' : ''}{p.pnlPct.toFixed(0)}%)</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-xs py-6 text-center" style={{ color: C.dim }}>No open positions</div>
          )}
        </div>

        {/* Domain pie */}
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

      {/* 4. PENDING REDEEM */}
      {data.pendingRedeem.length > 0 && (
        <div className="rounded-lg p-4 mb-6" style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="flex justify-between items-center mb-3">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Pending Redeem (waiting for oracle)</span>
            <span className="text-[11px]" style={{ color: C.dim }}>{data.pendingRedeem.length} positions / ${data.pendingRedeemValue.toFixed(2)}</span>
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
              {data.pendingRedeem.map((p, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td className="py-2 pr-3 max-w-[300px] truncate" style={{ color: C.text }}>{p.title}</td>
                  <td className="py-2">
                    <span className="text-[10px] font-medium" style={{ color: p.side === 'YES' ? C.up : C.down }}>{p.side}</span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{p.size.toFixed(1)}</td>
                  <td className="py-2 text-right tabular-nums">{(p.curPrice * 100).toFixed(0)}c</td>
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

      {/* 5. YES/NO + CLOSED TRADES */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
        {/* Side breakdown */}
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

        {/* Closed trades */}
        <div className="lg:col-span-3 rounded-lg p-4" style={{ background: C.card, border: `1px solid ${C.border}` }}>
          <div className="flex justify-between items-center mb-3">
            <span className="text-[11px] uppercase tracking-wider" style={{ color: C.dim }}>Closed Trades (from Polymarket)</span>
            <span className="text-[11px]" style={{ color: C.dim }}>{data.wins}W / {data.losses}L</span>
          </div>
          {data.closedTrades.length > 0 ? (
            <table className="w-full text-[11px]">
              <thead>
                <tr style={{ color: C.dim }}>
                  <th className="text-left pb-2 font-normal">Market</th>
                  <th className="text-left pb-2 font-normal w-12">Side</th>
                  <th className="text-right pb-2 font-normal">Traded</th>
                  <th className="text-right pb-2 font-normal">Result</th>
                  <th className="text-right pb-2 font-normal">P&L</th>
                </tr>
              </thead>
              <tbody>
                {data.closedTrades.map((t, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td className="py-2 pr-3 max-w-[300px] truncate" style={{ color: C.text }}>{t.title}</td>
                    <td className="py-2">
                      <span className="text-[10px] font-medium" style={{ color: t.side === 'YES' ? C.up : C.down }}>{t.side}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums" style={{ color: C.dim }}>${t.totalTraded.toFixed(2)}</td>
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
          ) : (
            <div className="text-xs py-6 text-center" style={{ color: C.dim }}>No closed trades yet</div>
          )}
        </div>
      </div>

      {/* 6. BEST / WORST / ACTIVITY */}
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
            {events.length > 0 ? events.slice(0, 8).map((e) => (
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

// ── Components ──────────────────────────────────────────────────

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
