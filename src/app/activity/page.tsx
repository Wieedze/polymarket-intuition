'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRefresh } from '../providers'
import Link from 'next/link'

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

type BotEvent = {
  id: number
  type: string
  message: string
  detail: string | null
  createdAt: string
}

type TypeCount = { type: string; count: number }

type ActivityData = {
  events: BotEvent[]
  typeCounts: TypeCount[]
  total: number
}

const EVENT_ICONS: Record<string, string> = {
  copy: '📋',
  exit: '🚪',
  resolve: '✅',
  skip: '⏭',
  error: '❌',
  info: 'ℹ️',
  start: '🟢',
  reindex: '🔄',
}

const EVENT_COLORS: Record<string, string> = {
  copy: COLORS.teal,
  exit: COLORS.amber,
  resolve: COLORS.green,
  skip: COLORS.textMuted,
  error: COLORS.red,
  info: COLORS.blue,
  start: COLORS.green,
  reindex: COLORS.pink,
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffH = Math.floor(diffMs / 3600000)
  const diffD = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffH < 24) return `${diffH}h ago`
  if (diffD < 7) return `${diffD}d ago`
  return d.toLocaleDateString()
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

export default function ActivityPage(): React.ReactElement {
  const [data, setData] = useState<ActivityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeType, setActiveType] = useState<string | null>(null)
  const { tick } = useRefresh()
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [limit, setLimit] = useState(200)
  const [hovered, setHovered] = useState<number | null>(null)

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const loadData = useCallback((): void => {
    const params = new URLSearchParams({ limit: limit.toString() })
    if (activeType) params.set('type', activeType)
    if (debouncedSearch) params.set('search', debouncedSearch)

    fetch(`/api/activity?${params.toString()}`)
      .then(async (res) => res.ok ? (await res.json()) as ActivityData : null)
      .then((d) => { if (d) setData(d) })
      .catch(() => null)
      .finally(() => setLoading(false))
  }, [activeType, debouncedSearch, limit])

  useEffect(() => {
    setLoading(true)
    loadData()
  }, [loadData, tick])

  const allTypes = data?.typeCounts ?? []
  const totalEvents = allTypes.reduce((s, t) => s + t.count, 0)

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
            <SideLink href="/activity" active>Activity</SideLink>
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
              <Link href="/analytics" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Analytics</Link>
            </div>
          </div>

          {/* Header */}
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold text-white">Bot Activity</h2>
              <p className="mt-1 text-sm" style={{ color: COLORS.textMuted }}>
                {totalEvents.toLocaleString()} total events · auto-refreshes every 15s
              </p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 mb-6">
            {/* Search */}
            <input
              type="text"
              placeholder="Search messages..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="px-3 py-1.5 text-sm rounded-lg outline-none"
              style={{
                background: COLORS.card,
                color: COLORS.textLight,
                border: `1px solid ${COLORS.surface}`,
                minWidth: 200,
              }}
            />

            {/* Type filter pills */}
            <button
              onClick={() => setActiveType(null)}
              className="px-3 py-1 text-xs rounded-full transition-colors"
              style={{
                background: activeType === null ? COLORS.teal : COLORS.surface,
                color: activeType === null ? COLORS.bg : COLORS.textMuted,
              }}
            >
              All ({totalEvents})
            </button>
            {allTypes.map((t) => (
              <button
                key={t.type}
                onClick={() => setActiveType(activeType === t.type ? null : t.type)}
                className="px-3 py-1 text-xs rounded-full transition-colors flex items-center gap-1"
                style={{
                  background: activeType === t.type ? (EVENT_COLORS[t.type] ?? COLORS.amber) : COLORS.surface,
                  color: activeType === t.type ? COLORS.bg : COLORS.textMuted,
                }}
              >
                <span>{EVENT_ICONS[t.type] ?? '•'}</span>
                <span>{t.type}</span>
                <span className="opacity-70">({t.count})</span>
              </button>
            ))}
          </div>

          {/* Event feed */}
          <div className="rounded-xl overflow-hidden" style={{ background: COLORS.card }}>
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: COLORS.teal, borderTopColor: 'transparent' }} />
              </div>
            ) : !data || data.events.length === 0 ? (
              <div className="text-center py-20 text-sm" style={{ color: COLORS.textMuted }}>
                No activity yet — bot events will appear here
              </div>
            ) : (
              <div>
                {data.events.map((e, i) => (
                  <div
                    key={e.id}
                    onMouseEnter={() => setHovered(e.id)}
                    onMouseLeave={() => setHovered(null)}
                    className="flex gap-4 px-5 py-3 border-b text-sm transition-colors"
                    style={{
                      borderColor: COLORS.surface,
                      background: hovered === e.id ? COLORS.surface : 'transparent',
                      borderBottom: i === data.events.length - 1 ? 'none' : undefined,
                    }}
                  >
                    {/* Icon */}
                    <span className="text-base shrink-0 mt-0.5">
                      {EVENT_ICONS[e.type] ?? '•'}
                    </span>

                    {/* Type badge */}
                    <span
                      className="text-xs px-2 py-0.5 rounded shrink-0 self-start mt-0.5 uppercase tracking-wide font-medium"
                      style={{
                        background: `${EVENT_COLORS[e.type] ?? COLORS.textMuted}22`,
                        color: EVENT_COLORS[e.type] ?? COLORS.textMuted,
                      }}
                    >
                      {e.type}
                    </span>

                    {/* Message + detail */}
                    <div className="flex-1 min-w-0">
                      <div style={{ color: COLORS.textLight }}>{e.message}</div>
                      {e.detail && (
                        <div className="mt-0.5 text-xs" style={{ color: COLORS.textMuted }}>{e.detail}</div>
                      )}
                    </div>

                    {/* Timestamp */}
                    <div className="shrink-0 text-right text-xs" style={{ color: COLORS.textMuted }}>
                      <div>{formatTime(e.createdAt)}</div>
                      {hovered === e.id && (
                        <div className="mt-0.5 text-[10px]">{formatDate(e.createdAt)}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Load more */}
          {data && data.events.length >= limit && (
            <div className="flex justify-center mt-6">
              <button
                onClick={() => setLimit((l) => l + 200)}
                className="px-6 py-2 text-sm rounded-lg transition-colors"
                style={{ background: COLORS.surface, color: COLORS.textLight }}
              >
                Load more ({limit} shown)
              </button>
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
