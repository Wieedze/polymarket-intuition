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
  `)
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
