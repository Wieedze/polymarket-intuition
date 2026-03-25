import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import type { ResolvedTrade } from '../types/polymarket'

// ── Types ─────────────────────────────────────────────────────────

export type TradeRow = ResolvedTrade & {
  wallet: string
  domain: string | null
  classifierConfidence: number
  indexedAt: string
}

export type WalletDomainStats = {
  wallet: string
  domain: string
  winRate: number
  calibration: number
  tradesCount: number
  avgConviction: number
  totalPnl: number
  decayFactor: number
  lastTradeAt: string
  updatedAt: string
  attestedOnChain: boolean
}

// ── Database init ─────────────────────────────────────────────────

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'polymarket.db')

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  // Ensure data directory exists
  const dir = path.dirname(DB_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  _db = new Database(DB_PATH)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  initTables(_db)
  return _db
}

/** Allow injecting a custom db instance (for tests) */
export function setDb(db: Database.Database): void {
  _db = db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

function initTables(db: Database.Database): void {
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
      wallet TEXT NOT NULL,
      user_name TEXT,
      rank INTEGER NOT NULL,
      pnl REAL NOT NULL,
      volume REAL NOT NULL,
      period TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (wallet, period)
    );

    CREATE TABLE IF NOT EXISTS watched_wallets (
      wallet TEXT PRIMARY KEY,
      label TEXT,
      added_at TEXT NOT NULL,
      last_polled_at TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS position_snapshots (
      wallet TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      outcome_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      size REAL NOT NULL,
      avg_price REAL NOT NULL,
      cur_price REAL NOT NULL,
      snapshot_at TEXT NOT NULL,
      PRIMARY KEY (wallet, condition_id, outcome_index)
    );

    CREATE TABLE IF NOT EXISTS paper_trades (
      id TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      simulated_usdc REAL NOT NULL,
      shares REAL NOT NULL,
      copied_from TEXT NOT NULL,
      copied_label TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      cur_price REAL,
      peak_price REAL,
      exit_price REAL,
      pnl REAL,
      opened_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS paper_portfolio (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  // Migration: add peak_price column if missing
  try {
    db.exec('ALTER TABLE paper_trades ADD COLUMN peak_price REAL')
  } catch {
    // Column already exists — ignore
  }
}

// ── Trade operations ──────────────────────────────────────────────

export function saveTrade(
  trade: ResolvedTrade & {
    wallet: string
    domain: string | null
    confidence: number
  }
): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO trades
     (id, wallet, market_id, market_question, domain, classifier_confidence,
      side, entry_price, size, outcome, pnl, resolved_at, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    trade.id,
    trade.wallet,
    trade.marketId,
    trade.marketQuestion,
    trade.domain,
    trade.confidence,
    trade.side,
    trade.entryPrice,
    trade.size,
    trade.outcome,
    trade.pnl,
    trade.resolvedAt,
    new Date().toISOString()
  )
}

export function tradeExists(id: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT 1 FROM trades WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row !== undefined
}

export function getTradesByDomain(
  wallet: string,
  domain: string
): ResolvedTrade[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, market_id, market_question, side, entry_price, size,
              outcome, pnl, resolved_at, wallet
       FROM trades
       WHERE wallet = ? AND domain = ?
       ORDER BY resolved_at DESC`
    )
    .all(wallet, domain) as Array<{
    id: string
    market_id: string
    market_question: string
    side: string
    entry_price: number
    size: number
    outcome: string
    pnl: number
    resolved_at: string
  }>

  return rows.map(
    (r): ResolvedTrade => ({
      id: r.id,
      marketId: r.market_id,
      marketQuestion: r.market_question,
      side: r.side as 'YES' | 'NO',
      entryPrice: r.entry_price,
      size: r.size,
      outcome: r.outcome as 'won' | 'lost',
      pnl: r.pnl,
      resolvedAt: r.resolved_at,
      transactionHash: '',
    })
  )
}

// ── Wallet stats operations ───────────────────────────────────────

export function saveWalletStats(
  wallet: string,
  domain: string,
  stats: {
    winRate: number
    calibration: number
    tradesCount: number
    avgConviction: number
    totalPnl: number
    decayFactor: number
    lastTradeAt: string
  }
): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO wallet_stats
     (wallet, domain, win_rate, calibration, trades_count, avg_conviction,
      total_pnl, decay_factor, last_trade_at, updated_at, attested_on_chain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       COALESCE((SELECT attested_on_chain FROM wallet_stats WHERE wallet = ? AND domain = ?), 0))`
  ).run(
    wallet,
    domain,
    stats.winRate,
    stats.calibration,
    stats.tradesCount,
    stats.avgConviction,
    stats.totalPnl,
    stats.decayFactor,
    stats.lastTradeAt,
    new Date().toISOString(),
    wallet,
    domain
  )
}

export function getWalletStats(wallet: string): WalletDomainStats[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT wallet, domain, win_rate, calibration, trades_count,
              avg_conviction, total_pnl, decay_factor, last_trade_at,
              updated_at, attested_on_chain
       FROM wallet_stats
       WHERE wallet = ?
       ORDER BY trades_count DESC`
    )
    .all(wallet) as Array<{
    wallet: string
    domain: string
    win_rate: number
    calibration: number
    trades_count: number
    avg_conviction: number
    total_pnl: number
    decay_factor: number
    last_trade_at: string
    updated_at: string
    attested_on_chain: number
  }>

  return rows.map(
    (r): WalletDomainStats => ({
      wallet: r.wallet,
      domain: r.domain,
      winRate: r.win_rate,
      calibration: r.calibration,
      tradesCount: r.trades_count,
      avgConviction: r.avg_conviction,
      totalPnl: r.total_pnl,
      decayFactor: r.decay_factor,
      lastTradeAt: r.last_trade_at,
      updatedAt: r.updated_at,
      attestedOnChain: r.attested_on_chain === 1,
    })
  )
}

export type ExpertRow = {
  wallet: string
  calibration: number
  tradesCount: number
  avgConviction: number
}

export function getExpertsByDomain(
  domain: string,
  minCalibration: number,
  minTrades: number
): ExpertRow[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT wallet, calibration, trades_count, avg_conviction
       FROM wallet_stats
       WHERE domain = ? AND calibration >= ? AND trades_count >= ?
       ORDER BY calibration DESC`
    )
    .all(domain, minCalibration, minTrades) as Array<{
    wallet: string
    calibration: number
    trades_count: number
    avg_conviction: number
  }>

  return rows.map(
    (r): ExpertRow => ({
      wallet: r.wallet,
      calibration: r.calibration,
      tradesCount: r.trades_count,
      avgConviction: r.avg_conviction,
    })
  )
}

export function markAttestedOnChain(wallet: string, domain: string): void {
  const db = getDb()
  db.prepare(
    `UPDATE wallet_stats SET attested_on_chain = 1 WHERE wallet = ? AND domain = ?`
  ).run(wallet, domain)
}

// ── Leaderboard cache operations ────────────────────────────────

export type LeaderboardRow = {
  wallet: string
  userName: string
  rank: number
  pnl: number
  volume: number
  period: string
  fetchedAt: string
}

export function saveLeaderboardEntry(entry: LeaderboardRow): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO leaderboard_cache
     (wallet, user_name, rank, pnl, volume, period, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.wallet,
    entry.userName,
    entry.rank,
    entry.pnl,
    entry.volume,
    entry.period,
    entry.fetchedAt
  )
}

export function getLeaderboard(period: string): Array<LeaderboardRow & { stats: WalletDomainStats[] }> {
  const db = getDb()
  const entries = db
    .prepare(
      `SELECT wallet, user_name, rank, pnl, volume, period, fetched_at
       FROM leaderboard_cache
       WHERE period = ?
       ORDER BY rank ASC`
    )
    .all(period) as Array<{
    wallet: string
    user_name: string
    rank: number
    pnl: number
    volume: number
    period: string
    fetched_at: string
  }>

  return entries.map((e) => ({
    wallet: e.wallet,
    userName: e.user_name,
    rank: e.rank,
    pnl: e.pnl,
    volume: e.volume,
    period: e.period,
    fetchedAt: e.fetched_at,
    stats: getWalletStats(e.wallet),
  }))
}

// ── Watched wallets operations ──────────────────────────────────

export function addWatchedWallet(wallet: string, label?: string): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO watched_wallets (wallet, label, added_at, active)
     VALUES (?, ?, ?, 1)`
  ).run(wallet, label ?? null, new Date().toISOString())
}

export function getActiveWatchedWallets(): Array<{ wallet: string; label: string | null }> {
  const db = getDb()
  return db
    .prepare('SELECT wallet, label FROM watched_wallets WHERE active = 1')
    .all() as Array<{ wallet: string; label: string | null }>
}

export function updateWalletPolledAt(wallet: string): void {
  const db = getDb()
  db.prepare(
    'UPDATE watched_wallets SET last_polled_at = ? WHERE wallet = ?'
  ).run(new Date().toISOString(), wallet)
}

// ── Position snapshot operations ────────────────────────────────

export type PositionSnapshotRow = {
  conditionId: string
  outcomeIndex: number
  title: string
  size: number
  avgPrice: number
  curPrice: number
}

export function getPositionSnapshot(wallet: string): Map<string, PositionSnapshotRow> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT condition_id, outcome_index, title, size, avg_price, cur_price
       FROM position_snapshots WHERE wallet = ?`
    )
    .all(wallet) as Array<{
    condition_id: string
    outcome_index: number
    title: string
    size: number
    avg_price: number
    cur_price: number
  }>

  const map = new Map<string, PositionSnapshotRow>()
  for (const r of rows) {
    map.set(`${r.condition_id}-${r.outcome_index}`, {
      conditionId: r.condition_id,
      outcomeIndex: r.outcome_index,
      title: r.title,
      size: r.size,
      avgPrice: r.avg_price,
      curPrice: r.cur_price,
    })
  }
  return map
}

export function savePositionSnapshot(
  wallet: string,
  positions: Array<{ conditionId: string; outcomeIndex: number; title: string; size: number; avgPrice: number; curPrice: number }>
): void {
  const db = getDb()
  // Clear old snapshot
  db.prepare('DELETE FROM position_snapshots WHERE wallet = ?').run(wallet)
  // Insert new
  const stmt = db.prepare(
    `INSERT INTO position_snapshots
     (wallet, condition_id, outcome_index, title, size, avg_price, cur_price, snapshot_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const now = new Date().toISOString()
  for (const p of positions) {
    stmt.run(wallet, p.conditionId, p.outcomeIndex, p.title, p.size, p.avgPrice, p.curPrice, now)
  }
}

// ── Paper trading operations ────────────────────────────────────

export type PaperTrade = {
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
  peakPrice: number | null
  exitPrice: number | null
  pnl: number | null
  openedAt: string
  resolvedAt: string | null
}

export function getPortfolioSetting(key: string, defaultValue: string): string {
  const db = getDb()
  const row = db.prepare('SELECT value FROM paper_portfolio WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? defaultValue
}

export function setPortfolioSetting(key: string, value: string): void {
  const db = getDb()
  db.prepare('INSERT OR REPLACE INTO paper_portfolio (key, value) VALUES (?, ?)').run(key, value)
}

export function openPaperTrade(trade: {
  conditionId: string
  title: string
  domain: string | null
  side: string
  entryPrice: number
  simulatedUsdc: number
  copiedFrom: string
  copiedLabel: string | null
}): PaperTrade {
  const db = getDb()
  const shares = trade.simulatedUsdc / trade.entryPrice
  const id = `paper-${trade.conditionId}-${Date.now()}`
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO paper_trades
     (id, condition_id, title, domain, side, entry_price, simulated_usdc, shares,
      copied_from, copied_label, status, cur_price, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(
    id,
    trade.conditionId,
    trade.title,
    trade.domain,
    trade.side,
    trade.entryPrice,
    trade.simulatedUsdc,
    shares,
    trade.copiedFrom,
    trade.copiedLabel,
    trade.entryPrice,
    now
  )

  return {
    id,
    conditionId: trade.conditionId,
    title: trade.title,
    domain: trade.domain,
    side: trade.side,
    entryPrice: trade.entryPrice,
    simulatedUsdc: trade.simulatedUsdc,
    shares,
    copiedFrom: trade.copiedFrom,
    copiedLabel: trade.copiedLabel,
    status: 'open',
    curPrice: trade.entryPrice,
    peakPrice: trade.entryPrice,
    exitPrice: null,
    pnl: null,
    openedAt: now,
    resolvedAt: null,
  }
}

export function getOpenPaperTrades(): PaperTrade[] {
  const db = getDb()
  return mapPaperRows(
    db.prepare("SELECT * FROM paper_trades WHERE status = 'open' ORDER BY opened_at DESC").all()
  )
}

export function getAllPaperTrades(): PaperTrade[] {
  const db = getDb()
  return mapPaperRows(
    db.prepare('SELECT * FROM paper_trades ORDER BY opened_at DESC').all()
  )
}

export function updatePaperTradePrice(conditionId: string, curPrice: number): void {
  const db = getDb()
  // Update cur_price and peak_price (track highest favorable price)
  db.prepare(
    `UPDATE paper_trades SET cur_price = ?,
     peak_price = MAX(COALESCE(peak_price, cur_price), ?)
     WHERE condition_id = ? AND status = 'open'`
  ).run(curPrice, curPrice, conditionId)
}

export function resolvePaperTrade(
  conditionId: string,
  exitPrice: number
): void {
  if (!conditionId || exitPrice == null || isNaN(exitPrice)) return

  const db = getDb()
  const rows = db.prepare(
    "SELECT id, entry_price, shares, side FROM paper_trades WHERE condition_id = ? AND status = 'open'"
  ).all(conditionId) as Array<Record<string, unknown>>

  for (const row of rows) {
    const entryPrice = row.entry_price as number
    const shares = row.shares as number
    const side = row.side as string
    const id = row.id as string

    // PnL calculation: if YES side and market resolves YES (exitPrice ≈ 1) → win
    let pnl: number
    let status: string
    if (exitPrice > 0.95) {
      // Market resolved YES
      if (side === 'YES') {
        pnl = shares * (1 - entryPrice)
        status = 'won'
      } else {
        pnl = -(shares * entryPrice)
        status = 'lost'
      }
    } else if (exitPrice < 0.05) {
      // Market resolved NO
      if (side === 'NO') {
        pnl = shares * (1 - entryPrice)
        status = 'won'
      } else {
        pnl = -(shares * entryPrice)
        status = 'lost'
      }
    } else {
      // Not fully resolved — paper exit at current price
      pnl = shares * (exitPrice - entryPrice)
      status = pnl > 0 ? 'won' : 'lost'
    }

    db.prepare(
      `UPDATE paper_trades SET status = ?, exit_price = ?, pnl = ?, resolved_at = ?
       WHERE id = ?`
    ).run(status, exitPrice, pnl, new Date().toISOString(), id)
  }
}

export function paperTradeExistsForCondition(conditionId: string): boolean {
  const db = getDb()
  const row = db.prepare(
    "SELECT 1 FROM paper_trades WHERE condition_id = ? AND status = 'open'"
  ).get(conditionId)
  return row !== undefined
}

function mapPaperRows(rows: unknown[]): PaperTrade[] {
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    conditionId: r.condition_id as string,
    title: r.title as string,
    domain: r.domain as string | null,
    side: r.side as string,
    entryPrice: r.entry_price as number,
    simulatedUsdc: r.simulated_usdc as number,
    shares: r.shares as number,
    copiedFrom: r.copied_from as string,
    copiedLabel: r.copied_label as string | null,
    status: r.status as 'open' | 'won' | 'lost',
    curPrice: r.cur_price as number | null,
    peakPrice: r.peak_price as number | null,
    exitPrice: r.exit_price as number | null,
    pnl: r.pnl as number | null,
    openedAt: r.opened_at as string,
    resolvedAt: r.resolved_at as string | null,
  }))
}
