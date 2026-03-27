import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { setDb, closeDb } from '../../src/lib/db'
import type { ResolvedTrade, WalletTrades } from '../../src/types/polymarket'

// ── Mock setup (must be before imports that use mocked modules) ───

vi.mock('../../src/lib/polymarket', () => ({
  fetchResolvedTrades: vi.fn(),
}))

vi.mock('../../src/lib/classifier', () => ({
  classifyMarket: vi.fn(),
}))

import { indexWallet } from '../../src/lib/indexer'
import { fetchResolvedTrades } from '../../src/lib/polymarket'
import { classifyMarket } from '../../src/lib/classifier'
import { getWalletStats } from '../../src/lib/db'

// ── Helpers ───────────────────────────────────────────────────────

const WALLET = '0xTestWallet'

function makeTrade(i: number, overrides: Partial<ResolvedTrade> = {}): ResolvedTrade {
  return {
    id: `trade-${i}`,
    marketId: `market-${i}`,
    marketQuestion: `Will something happen #${i}?`,
    side: 'YES',
    entryPrice: 0.7,
    size: 100,
    outcome: i % 3 === 0 ? 'lost' : 'won',
    pnl: i % 3 === 0 ? -30 : 30,
    resolvedAt: '2025-06-01T00:00:00Z',
    transactionHash: `0xtx${i}`,
    ...overrides,
  }
}

function makeWalletTrades(count: number): WalletTrades {
  const trades = Array.from({ length: count }, (_, i) => makeTrade(i))
  return {
    address: WALLET,
    trades,
    totalTrades: count,
    totalPositions: count + 5,
    totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
  }
}

// ── Test lifecycle ────────────────────────────────────────────────

let db: Database.Database

beforeEach(() => {
  // In-memory SQLite for each test
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      wallet TEXT NOT NULL,
      market_id TEXT NOT NULL,
      market_question TEXT NOT NULL,
      domain TEXT,
      classifier_confidence REAL,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      size REAL NOT NULL,
      outcome TEXT NOT NULL,
      pnl REAL NOT NULL,
      resolved_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wallet_stats (
      wallet TEXT NOT NULL,
      domain TEXT NOT NULL,
      win_rate REAL NOT NULL,
      calibration REAL NOT NULL,
      trades_count INTEGER NOT NULL,
      avg_conviction REAL NOT NULL,
      total_pnl REAL NOT NULL,
      implicit_edge REAL DEFAULT 0,
      decay_factor REAL NOT NULL,
      last_trade_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attested_on_chain INTEGER DEFAULT 0,
      PRIMARY KEY (wallet, domain)
    );
    CREATE TABLE IF NOT EXISTS update_queue (
      wallet TEXT PRIMARY KEY,
      priority INTEGER DEFAULT 1,
      reason TEXT,
      queued_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_wallet_domain ON trades(wallet, domain);
    CREATE TABLE IF NOT EXISTS leaderboard_cache (
      wallet TEXT NOT NULL, user_name TEXT, rank INTEGER NOT NULL,
      pnl REAL NOT NULL, volume REAL NOT NULL, period TEXT NOT NULL,
      fetched_at TEXT NOT NULL, PRIMARY KEY (wallet, period)
    );
    CREATE TABLE IF NOT EXISTS watched_wallets (
      wallet TEXT PRIMARY KEY, label TEXT, added_at TEXT NOT NULL,
      last_polled_at TEXT, active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS position_snapshots (
      wallet TEXT NOT NULL, condition_id TEXT NOT NULL, outcome_index INTEGER NOT NULL,
      title TEXT NOT NULL, size REAL NOT NULL, avg_price REAL NOT NULL,
      cur_price REAL NOT NULL, snapshot_at TEXT NOT NULL,
      PRIMARY KEY (wallet, condition_id, outcome_index)
    );
    CREATE TABLE IF NOT EXISTS paper_trades (
      id TEXT PRIMARY KEY, condition_id TEXT NOT NULL, title TEXT NOT NULL,
      domain TEXT, side TEXT NOT NULL, entry_price REAL NOT NULL,
      simulated_usdc REAL NOT NULL, shares REAL NOT NULL,
      copied_from TEXT NOT NULL, copied_label TEXT,
      status TEXT NOT NULL DEFAULT 'open', cur_price REAL, peak_price REAL,
      exit_price REAL, pnl REAL, opened_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS paper_portfolio (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
  `)
  setDb(db)

  vi.mocked(fetchResolvedTrades).mockReset()
  vi.mocked(classifyMarket).mockReset()
})

afterEach(() => {
  closeDb()
  db.close()
})

// ── Tests ─────────────────────────────────────────────────────────

describe('indexWallet', () => {
  it('indexes 10 trades into SQLite', async () => {
    vi.mocked(fetchResolvedTrades).mockResolvedValue(makeWalletTrades(10))
    vi.mocked(classifyMarket).mockResolvedValue({
      domain: 'pm-domain/crypto',
      confidence: 0.92,
    })

    const result = await indexWallet(WALLET)

    expect(result.tradesIndexed).toBe(10)
    expect(result.tradesSkipped).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('is idempotent — re-indexing skips already-indexed trades', async () => {
    vi.mocked(fetchResolvedTrades).mockResolvedValue(makeWalletTrades(10))
    vi.mocked(classifyMarket).mockResolvedValue({
      domain: 'pm-domain/crypto',
      confidence: 0.92,
    })

    // First run
    await indexWallet(WALLET)

    // Second run — same trades
    const result = await indexWallet(WALLET)

    expect(result.tradesIndexed).toBe(0)
    expect(result.tradesSkipped).toBe(10)
  })

  it('skips trades that classifier returns null for', async () => {
    vi.mocked(fetchResolvedTrades).mockResolvedValue(makeWalletTrades(5))
    vi.mocked(classifyMarket).mockResolvedValue(null) // unclassifiable

    const result = await indexWallet(WALLET)

    // Trades are saved (domain=null) but counted as skipped
    expect(result.tradesSkipped).toBe(5)
    expect(result.tradesIndexed).toBe(0)
  })

  it('does not save wallet stats if < 1 trade in a domain', async () => {
    vi.mocked(fetchResolvedTrades).mockResolvedValue(makeWalletTrades(3))
    vi.mocked(classifyMarket).mockResolvedValue(null) // all unclassified

    await indexWallet(WALLET)

    const stats = getWalletStats(WALLET)
    expect(stats).toHaveLength(0)
  })

  it('saves wallet stats when >= 1 classified trade exists', async () => {
    vi.mocked(fetchResolvedTrades).mockResolvedValue(makeWalletTrades(7))
    vi.mocked(classifyMarket).mockResolvedValue({
      domain: 'pm-domain/ai-tech',
      confidence: 0.95,
    })

    const result = await indexWallet(WALLET)

    expect(result.tradesIndexed).toBe(7)
    const stats = getWalletStats(WALLET)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.domain).toBe('pm-domain/ai-tech')
    expect(stats[0]!.tradesCount).toBe(7)
  })

  it('saves wallet stats to SQLite', async () => {
    vi.mocked(fetchResolvedTrades).mockResolvedValue(makeWalletTrades(6))
    vi.mocked(classifyMarket).mockResolvedValue({
      domain: 'pm-domain/crypto',
      confidence: 0.9,
    })

    await indexWallet(WALLET)

    const stats = getWalletStats(WALLET)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.domain).toBe('pm-domain/crypto')
    expect(stats[0]!.tradesCount).toBe(6)
    expect(stats[0]!.winRate).toBeGreaterThan(0)
    expect(stats[0]!.calibration).toBeGreaterThan(0)
  })

  it('handles fetch errors gracefully', async () => {
    vi.mocked(fetchResolvedTrades).mockRejectedValue(
      new Error('Polymarket API error: 503')
    )

    const result = await indexWallet(WALLET)

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Failed to fetch trades')
    expect(result.tradesIndexed).toBe(0)
  })

  it('continues indexing if a single trade fails classification', async () => {
    const trades = makeWalletTrades(5)
    vi.mocked(fetchResolvedTrades).mockResolvedValue(trades)

    let callCount = 0
    vi.mocked(classifyMarket).mockImplementation(async () => {
      callCount++
      if (callCount === 3) throw new Error('classifier timeout')
      return { domain: 'pm-domain/sports' as const, confidence: 0.88 }
    })

    const result = await indexWallet(WALLET)

    // 4 classified + 1 errored
    expect(result.tradesIndexed).toBe(4)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('classifier timeout')
  })

  it('classifies trades into multiple domains correctly', async () => {
    const trades: WalletTrades = {
      address: WALLET,
      trades: [
        ...Array.from({ length: 5 }, (_, i) =>
          makeTrade(i, { marketQuestion: `Crypto question #${i}` })
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          makeTrade(i + 5, { marketQuestion: `Sports question #${i}` })
        ),
      ],
      totalTrades: 8,
      totalPositions: 12,
      totalPnl: 100,
    }

    vi.mocked(fetchResolvedTrades).mockResolvedValue(trades)
    vi.mocked(classifyMarket).mockImplementation(async (question: string) => {
      if (question.includes('Crypto')) {
        return { domain: 'pm-domain/crypto' as const, confidence: 0.95 }
      }
      return { domain: 'pm-domain/sports' as const, confidence: 0.9 }
    })

    await indexWallet(WALLET)

    const stats = getWalletStats(WALLET)
    expect(stats).toHaveLength(2)
    const cryptoStats = stats.find((s) => s.domain === 'pm-domain/crypto')
    const sportsStats = stats.find((s) => s.domain === 'pm-domain/sports')
    expect(cryptoStats!.tradesCount).toBe(5)
    expect(sportsStats!.tradesCount).toBe(3)
  })
})
