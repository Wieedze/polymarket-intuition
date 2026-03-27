'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

const COLORS = {
  bg: '#171821',
  card: '#21222D',
  surface: '#2B2B36',
  teal: '#A9DFD8',
  amber: '#FCB859',
  red: '#EA1701',
  green: '#029F04',
  textMuted: '#87888C',
  textLight: '#D2D2D2',
}

type WatchedWallet = {
  wallet: string
  label: string | null
  addedAt: string
  lastPolledAt: string | null
  active: boolean
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export default function SettingsPage(): React.ReactElement {
  const [wallets, setWallets] = useState<WatchedWallet[]>([])
  const [loading, setLoading] = useState(true)
  const [newAddress, setNewAddress] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function loadWallets(): Promise<void> {
    const res = await fetch('/api/settings/wallets')
    if (res.ok) {
      setWallets((await res.json()) as WatchedWallet[])
    }
    setLoading(false)
  }

  useEffect(() => {
    loadWallets().catch(() => setLoading(false))
  }, [])

  async function addWallet(): Promise<void> {
    if (!newAddress.trim()) return
    setAdding(true)
    setError(null)

    const res = await fetch('/api/settings/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: newAddress.trim(), label: newLabel.trim() || undefined }),
    })

    if (res.ok) {
      setNewAddress('')
      setNewLabel('')
      setSuccess('Wallet added successfully')
      setTimeout(() => setSuccess(null), 3000)
      await loadWallets()
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      setError(body.error ?? 'Failed to add wallet')
    }
    setAdding(false)
  }

  async function toggleWallet(wallet: string, active: boolean): Promise<void> {
    await fetch('/api/settings/wallets', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, active }),
    })
    setWallets((prev) => prev.map((w) => w.wallet === wallet ? { ...w, active } : w))
  }

  async function removeWallet(wallet: string): Promise<void> {
    await fetch(`/api/settings/wallets?wallet=${encodeURIComponent(wallet)}`, { method: 'DELETE' })
    setWallets((prev) => prev.filter((w) => w.wallet !== wallet))
  }

  return (
    <div className="min-h-screen" style={{ background: COLORS.bg, color: COLORS.textLight }}>
      <div className="flex min-h-screen">
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
            <SideLink href="/leaderboard">Leaderboard</SideLink>
            <SideLink href="/settings" active>Settings</SideLink>
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
            <Link href="/" className="text-xs px-3 py-1 rounded-lg" style={{ background: COLORS.surface, color: COLORS.textMuted }}>Dashboard</Link>
          </div>

          <div>
            <div className="mb-8">
              <h2 className="text-2xl font-bold text-white">Settings</h2>
              <p className="mt-1 text-sm" style={{ color: COLORS.textMuted }}>Manage expert wallets to monitor and copy</p>
            </div>

            {/* Add wallet */}
            <div className="rounded-xl p-5 mb-8" style={{ background: COLORS.card }}>
              <h3 className="text-sm font-medium mb-4" style={{ color: COLORS.textMuted }}>ADD EXPERT WALLET</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-xs mb-1 block" style={{ color: COLORS.textMuted }}>Wallet Address</label>
                  <input
                    type="text"
                    value={newAddress}
                    onChange={(e) => setNewAddress(e.target.value)}
                    placeholder="0x..."
                    className="w-full px-3 py-2 rounded-lg text-sm font-mono outline-none"
                    style={{ background: COLORS.surface, color: COLORS.textLight, border: `1px solid ${COLORS.surface}` }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void addWallet() }}
                  />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: COLORS.textMuted }}>Label (optional)</label>
                  <input
                    type="text"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    placeholder="e.g. Top Crypto Trader"
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                    style={{ background: COLORS.surface, color: COLORS.textLight, border: `1px solid ${COLORS.surface}` }}
                    onKeyDown={(e) => { if (e.key === 'Enter') void addWallet() }}
                  />
                </div>
                {error && <p className="text-sm" style={{ color: COLORS.red }}>{error}</p>}
                {success && <p className="text-sm" style={{ color: COLORS.teal }}>{success}</p>}
                <button
                  onClick={() => void addWallet()}
                  disabled={adding || !newAddress.trim()}
                  className="px-5 py-2 text-sm font-medium rounded-lg transition-colors"
                  style={{
                    background: adding || !newAddress.trim() ? COLORS.surface : COLORS.teal,
                    color: adding || !newAddress.trim() ? COLORS.textMuted : COLORS.bg,
                  }}
                >
                  {adding ? 'Adding...' : 'Add Wallet'}
                </button>
              </div>
            </div>

            {/* Wallet list */}
            <div className="rounded-xl p-5" style={{ background: COLORS.card }}>
              <h3 className="text-sm font-medium mb-4" style={{ color: COLORS.textMuted }}>
                WATCHED WALLETS ({wallets.length})
              </h3>

              {loading && (
                <div className="text-center py-8">
                  <div className="inline-block w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: COLORS.teal, borderTopColor: 'transparent' }} />
                </div>
              )}

              {!loading && wallets.length === 0 && (
                <p className="text-sm text-center py-8" style={{ color: COLORS.textMuted }}>
                  No wallets yet. Add an expert wallet above to start copying trades.
                </p>
              )}

              <div className="space-y-2">
                {wallets.map((w) => (
                  <div
                    key={w.wallet}
                    className="flex items-center gap-3 p-3 rounded-lg"
                    style={{ background: COLORS.surface, opacity: w.active ? 1 : 0.5 }}
                  >
                    {/* Active indicator */}
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: w.active ? COLORS.green : COLORS.textMuted }}
                    />

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm" style={{ color: COLORS.textLight }}>
                          {truncateAddress(w.wallet)}
                        </span>
                        {w.label && (
                          <span className="text-xs" style={{ color: COLORS.amber }}>{w.label}</span>
                        )}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: COLORS.textMuted }}>
                        Added {new Date(w.addedAt).toLocaleDateString()}
                        {w.lastPolledAt && ` · Last polled ${new Date(w.lastPolledAt).toLocaleDateString()}`}
                      </div>
                    </div>

                    {/* Toggle active */}
                    <button
                      onClick={() => void toggleWallet(w.wallet, !w.active)}
                      className="text-xs px-2 py-1 rounded"
                      style={{
                        background: w.active ? `${COLORS.teal}22` : `${COLORS.textMuted}22`,
                        color: w.active ? COLORS.teal : COLORS.textMuted,
                      }}
                    >
                      {w.active ? 'Active' : 'Paused'}
                    </button>

                    {/* Remove */}
                    <button
                      onClick={() => void removeWallet(w.wallet)}
                      className="text-xs px-2 py-1 rounded transition-colors"
                      style={{ color: COLORS.textMuted }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = COLORS.red }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = COLORS.textMuted }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
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
