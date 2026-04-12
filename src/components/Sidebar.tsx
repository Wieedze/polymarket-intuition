'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const C = {
  bg: '#0F1117',
  card: '#181A20',
  surface: '#1E2028',
  accent: '#6366F1',
  dim: '#6B7084',
  text: '#C9CDD8',
  bright: '#EAECF0',
  border: '#262835',
  up: '#10B981',
}

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/activity', label: 'Activity', icon: '📋' },
  { href: '/rules', label: 'Rules', icon: '📏' },
  { href: '/leaderboard', label: 'Leaderboard', icon: '🏆' },
  { href: '/settings', label: 'Settings', icon: '⚙️' },
] as const

export default function Sidebar(): React.ReactElement {
  const pathname = usePathname()

  return (
    <aside
      className="hidden lg:flex flex-col w-56 min-h-screen p-5 border-r shrink-0"
      style={{ background: C.card, borderColor: C.border }}
    >
      <div className="mb-10">
        <h1 className="text-lg font-bold" style={{ color: C.bright }}>Copy Trader</h1>
        <div className="flex items-center gap-1.5 mt-1">
          <span className="w-2 h-2 rounded-full" style={{ background: C.up }} />
          <span className="text-xs" style={{ color: C.dim }}>Live</span>
        </div>
      </div>

      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.map(({ href, label, icon }) => {
          const active = href === '/' ? pathname === '/' : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors"
              style={{
                background: active ? C.surface : 'transparent',
                color: active ? C.bright : C.dim,
              }}
            >
              <span className="text-base">{icon}</span>
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="mt-auto pt-6">
        <div className="text-xs" style={{ color: C.dim }}>
          Pipeline v2
        </div>
      </div>
    </aside>
  )
}
