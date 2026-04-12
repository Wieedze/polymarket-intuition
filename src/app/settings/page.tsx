'use client'

import { useState, useEffect } from 'react'

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
    <div className="p-6 lg:p-8 max-w-7xl" style={{ color: '#C9CDD8' }}>
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
    </div>
  )
}
