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
  implicitEdge: number   // beats market by X points on average (0/1 markets)
  decayFactor: number
  lastTradeAt: string
  updatedAt: string
  attestedOnChain: boolean
}

// ── Database init ─────────────────────────────────────────────────
//
// Dual-DB architecture for live trading:
//   DB_PATH       = instance DB (paper: polymarket.db, live: live.db) — owns trades, portfolio, events
//   SHARED_DB_PATH = shared DB (always polymarket.db) — owns experts, stats, snapshots, metadata
//
// For paper trading: both point to the same file (polymarket.db) — no change.
// For live trading:  DB_PATH=live.db, SHARED_DB_PATH=polymarket.db

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'polymarket.db')
const SHARED_DB_PATH = process.env.SHARED_DB_PATH ?? path.join(process.cwd(), 'data', 'polymarket.db')

let _db: Database.Database | null = null
let _sharedDb: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

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

/**
 * Get the shared DB (expert intelligence).
 * For paper trading, this is the same as getDb().
 * For live trading, this reads from polymarket.db while getDb() writes to live.db.
 */
export function getSharedDb(): Database.Database {
  if (SHARED_DB_PATH === DB_PATH) return getDb()
  if (_sharedDb) return _sharedDb

  if (!fs.existsSync(SHARED_DB_PATH)) {
    throw new Error(`Shared DB not found: ${SHARED_DB_PATH}`)
  }

  _sharedDb = new Database(SHARED_DB_PATH, { readonly: true })
  return _sharedDb
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
  if (_sharedDb) {
    _sharedDb.close()
    _sharedDb = null
  }
}

/**
 * Open a specific DB file (read-only). Used by dashboard to read live.db.
 * Returns null if the file doesn't exist.
 */
export function openReadonlyDb(dbPath: string): Database.Database | null {
  try {
    if (!fs.existsSync(dbPath)) return null
    const db = new Database(dbPath, { readonly: true })
    return db
  } catch {
    return null
  }
}

/**
 * Get all paper trades from a specific DB file.
 * Used by dashboard to read live trades from live.db.
 */
export function getAllPositionsFromDb(dbPath: string): Position[] {
  const db = openReadonlyDb(dbPath)
  if (!db) return []
  try {
    const rows = db.prepare('SELECT * FROM positions ORDER BY opened_at DESC').all()
    return mapPositionRows(rows)
  } catch {
    return []
  } finally {
    db.close()
  }
}

/** @deprecated Use getAllPositionsFromDb */
export const getAllPaperTradesFromDb = getAllPositionsFromDb

/**
 * Get a portfolio setting from a specific DB file.
 */
export function getPortfolioSettingFromDb(dbPath: string, key: string, fallback: string): string {
  const db = openReadonlyDb(dbPath)
  if (!db) return fallback
  try {
    const row = db.prepare('SELECT value FROM portfolio_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? fallback
  } catch {
    return fallback
  } finally {
    db.close()
  }
}

/**
 * Get recent bot events from a specific DB file.
 */
export function getRecentBotEventsFromDb(dbPath: string, limit: number = 20): Array<{ id: number; type: string; message: string; detail: string | null; createdAt: string }> {
  const db = openReadonlyDb(dbPath)
  if (!db) return []
  try {
    return db.prepare('SELECT id, type, message, detail, created_at as createdAt FROM bot_events ORDER BY id DESC LIMIT ?').all(limit) as Array<{ id: number; type: string; message: string; detail: string | null; createdAt: string }>
  } catch {
    return []
  } finally {
    db.close()
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

    CREATE TABLE IF NOT EXISTS positions (
      id TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      size_usdc REAL NOT NULL,
      shares REAL NOT NULL,
      source_ref TEXT NOT NULL,
      source_label TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      cur_price REAL,
      peak_price REAL,
      exit_price REAL,
      pnl REAL,
      opened_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS portfolio_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bot_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leaderboard_results_cache (
      period TEXT PRIMARY KEY,
      results_json TEXT NOT NULL,
      computed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_metadata (
      condition_id TEXT PRIMARY KEY,
      yes_token_id TEXT NOT NULL,
      no_token_id TEXT NOT NULL,
      end_date TEXT,
      title TEXT,
      liquidity REAL,
      active INTEGER DEFAULT 1,
      neg_risk INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_orders (
      order_id TEXT PRIMARY KEY,
      condition_id TEXT NOT NULL,
      title TEXT,
      domain TEXT,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      size_usdc REAL NOT NULL,
      source_ref TEXT,
      source_label TEXT,
      placed_at TEXT NOT NULL,
      order_type TEXT NOT NULL DEFAULT 'BUY',
      exit_price REAL,
      partial_fraction REAL,
      exit_reason TEXT
    );
  `)

  // Migration: add peak_price column if missing
  try {
    db.exec('ALTER TABLE positions ADD COLUMN peak_price REAL')
  } catch {
    // Column already exists — ignore
  }

  // Migration: partial exits support
  try {
    db.exec('ALTER TABLE positions ADD COLUMN shares_remaining REAL')
  } catch {}
  try {
    db.exec("ALTER TABLE positions ADD COLUMN partial_exits TEXT NOT NULL DEFAULT '[]'")
  } catch {}

  // Migration: implicit edge in wallet_stats
  try {
    db.exec('ALTER TABLE wallet_stats ADD COLUMN implicit_edge REAL NOT NULL DEFAULT 0')
  } catch {}

  // Migration: neg_risk in market_metadata
  try {
    db.exec('ALTER TABLE market_metadata ADD COLUMN neg_risk INTEGER NOT NULL DEFAULT 0')
  } catch {}

  // Migration: copyability score as dedicated column in watched_wallets
  try {
    db.exec('ALTER TABLE watched_wallets ADD COLUMN copyability_score REAL')
  } catch {}

  // Migration: pending_orders sell support (for DBs created before these columns were in CREATE TABLE)
  try { db.exec("ALTER TABLE pending_orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'BUY'") } catch {}
  try { db.exec('ALTER TABLE pending_orders ADD COLUMN exit_price REAL') } catch {}
  try { db.exec('ALTER TABLE pending_orders ADD COLUMN partial_fraction REAL') } catch {}
  try { db.exec('ALTER TABLE pending_orders ADD COLUMN exit_reason TEXT') } catch {}

  // ── Migration: rename paper_trades → positions, paper_portfolio → portfolio_settings ──
  // Check if migration is needed (table paper_trades still exists but positions doesn't)
  const hasPaperTrades = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_trades'").get()
  const hasPositions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='positions'").get()
  if (hasPaperTrades && !hasPositions) {
    db.exec('ALTER TABLE paper_trades RENAME TO positions')
    db.exec('ALTER TABLE positions RENAME COLUMN simulated_usdc TO size_usdc')
    db.exec('ALTER TABLE positions RENAME COLUMN copied_from TO source_ref')
    db.exec('ALTER TABLE positions RENAME COLUMN copied_label TO source_label')
  }
  const hasPaperPortfolio = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_portfolio'").get()
  const hasPortfolioSettings = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_settings'").get()
  if (hasPaperPortfolio && !hasPortfolioSettings) {
    db.exec('ALTER TABLE paper_portfolio RENAME TO portfolio_settings')
  }

  // ── Migration: rename pending_orders columns ──
  try {
    db.exec('ALTER TABLE pending_orders RENAME COLUMN simulated_usdc TO size_usdc')
    db.exec('ALTER TABLE pending_orders RENAME COLUMN copied_from TO source_ref')
    db.exec('ALTER TABLE pending_orders RENAME COLUMN copied_label TO source_label')
  } catch {
    // Already renamed or columns don't exist
  }

  // ── Signals table (unified signal pipeline) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      condition_id TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT,
      side TEXT NOT NULL,
      entry_price REAL NOT NULL,
      signal_score INTEGER NOT NULL,
      kelly_fraction REAL,
      expert_wallet TEXT,
      expert_label TEXT,
      expert_trust_level REAL,
      consensus_count INTEGER,
      position_size REAL,
      sport_key TEXT,
      bookmaker_prob REAL,
      edge REAL,
      yes_token_id TEXT,
      no_token_id TEXT,
      neg_risk INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT,
      processed_at TEXT,
      reasons_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(source, condition_id, side)
    );
    CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
    CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
  `)

  // Sports arbitrage tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS sports_markets (
      condition_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      yes_token_id TEXT,
      no_token_id TEXT,
      polymarket_price REAL,
      end_date TEXT,
      sport_key TEXT,
      home_team TEXT,
      away_team TEXT,
      market_type TEXT,
      line_value REAL,
      last_scanned_at TEXT NOT NULL,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS sports_odds_cache (
      sport_key TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      market_type TEXT NOT NULL,
      outcome_name TEXT NOT NULL,
      no_vig_prob REAL NOT NULL,
      raw_odds_json TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (sport_key, home_team, away_team, market_type, outcome_name)
    );
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
    implicitEdge: number
    decayFactor: number
    lastTradeAt: string
  }
): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO wallet_stats
     (wallet, domain, win_rate, calibration, trades_count, avg_conviction,
      total_pnl, implicit_edge, decay_factor, last_trade_at, updated_at, attested_on_chain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       COALESCE((SELECT attested_on_chain FROM wallet_stats WHERE wallet = ? AND domain = ?), 0))`
  ).run(
    wallet,
    domain,
    stats.winRate,
    stats.calibration,
    stats.tradesCount,
    stats.avgConviction,
    stats.totalPnl,
    stats.implicitEdge,
    stats.decayFactor,
    stats.lastTradeAt,
    new Date().toISOString(),
    wallet,
    domain
  )
}

export function getWalletStats(wallet: string): WalletDomainStats[] {
  const db = getSharedDb()  // expert stats are shared intelligence
  const rows = db
    .prepare(
      `SELECT wallet, domain, win_rate, calibration, trades_count,
              avg_conviction, total_pnl, implicit_edge, decay_factor, last_trade_at,
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
    implicit_edge: number
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
      implicitEdge: r.implicit_edge ?? 0,
      decayFactor: r.decay_factor,
      lastTradeAt: r.last_trade_at,
      updatedAt: r.updated_at,
      attestedOnChain: r.attested_on_chain === 1,
    })
  )
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

// ── Watched wallets operations ──────────────────────────────────

export function addWatchedWallet(wallet: string, label?: string): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO watched_wallets (wallet, label, added_at, active)
     VALUES (?, ?, ?, 1)`
  ).run(wallet, label ?? null, new Date().toISOString())
}

export function getActiveWatchedWallets(): Array<{ wallet: string; label: string | null; copyabilityScore: number | null }> {
  const db = getSharedDb()  // experts are shared intelligence
  return (db
    .prepare('SELECT wallet, label, copyability_score FROM watched_wallets WHERE active = 1')
    .all() as Array<{ wallet: string; label: string | null; copyability_score: number | null }>
  ).map((r) => ({ wallet: r.wallet, label: r.label, copyabilityScore: r.copyability_score }))
}

export function updateWalletCopyability(wallet: string, score: number): void {
  const db = getDb()
  db.prepare('UPDATE watched_wallets SET copyability_score = ? WHERE wallet = ?').run(score, wallet)
}

export function updateWalletPolledAt(wallet: string): void {
  // Write to shared DB (paper DB tracks polling state)
  if (SHARED_DB_PATH !== DB_PATH) {
    // Live mode: don't write to readonly shared DB, skip
    return
  }
  const db = getDb()
  db.prepare(
    'UPDATE watched_wallets SET last_polled_at = ? WHERE wallet = ?'
  ).run(new Date().toISOString(), wallet)
}

// ── Sports market operations ────────────────────────────────────

export type SportsMarketRow = {
  conditionId: string
  title: string
  yesTokenId: string | null
  noTokenId: string | null
  polymarketPrice: number | null
  endDate: string | null
  sportKey: string | null
  homeTeam: string | null
  awayTeam: string | null
  marketType: string | null
  lineValue: number | null
  lastScannedAt: string
  active: boolean
}

export type SportsOddsRow = {
  sportKey: string
  homeTeam: string
  awayTeam: string
  marketType: string
  outcomeName: string
  noVigProb: number
  fetchedAt: string
}

export function saveSportsMarket(market: SportsMarketRow): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO sports_markets
    (condition_id, title, yes_token_id, no_token_id, polymarket_price, end_date,
     sport_key, home_team, away_team, market_type, line_value, last_scanned_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    market.conditionId, market.title, market.yesTokenId, market.noTokenId,
    market.polymarketPrice, market.endDate, market.sportKey,
    market.homeTeam, market.awayTeam, market.marketType, market.lineValue,
    market.lastScannedAt, market.active ? 1 : 0
  )
}

export function getActiveSportsMarkets(): SportsMarketRow[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM sports_markets WHERE active = 1').all() as Array<Record<string, unknown>>
  return rows.map((r): SportsMarketRow => ({
    conditionId: r.condition_id as string,
    title: r.title as string,
    yesTokenId: r.yes_token_id as string | null,
    noTokenId: r.no_token_id as string | null,
    polymarketPrice: r.polymarket_price as number | null,
    endDate: r.end_date as string | null,
    sportKey: r.sport_key as string | null,
    homeTeam: r.home_team as string | null,
    awayTeam: r.away_team as string | null,
    marketType: r.market_type as string | null,
    lineValue: r.line_value as number | null,
    lastScannedAt: r.last_scanned_at as string,
    active: true,
  }))
}

export function upsertSportsOdds(entry: SportsOddsRow): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO sports_odds_cache
    (sport_key, home_team, away_team, market_type, outcome_name, no_vig_prob, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entry.sportKey, entry.homeTeam, entry.awayTeam, entry.marketType, entry.outcomeName, entry.noVigProb, entry.fetchedAt)
}

export function getSportsOddsForGame(sportKey: string, homeTeam: string, awayTeam: string): SportsOddsRow[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM sports_odds_cache WHERE sport_key = ? AND home_team = ? AND away_team = ?'
  ).all(sportKey, homeTeam, awayTeam) as Array<Record<string, unknown>>
  return rows.map((r): SportsOddsRow => ({
    sportKey: r.sport_key as string,
    homeTeam: r.home_team as string,
    awayTeam: r.away_team as string,
    marketType: r.market_type as string,
    outcomeName: r.outcome_name as string,
    noVigProb: r.no_vig_prob as number,
    fetchedAt: r.fetched_at as string,
  }))
}

export function deactivateOldSportsMarkets(maxAgeHours: number = 48): void {
  const db = getDb()
  db.prepare(
    `UPDATE sports_markets SET active = 0
     WHERE last_scanned_at < datetime('now', '-' || ? || ' hours')`
  ).run(maxAgeHours)
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
  const db = getSharedDb()  // position snapshots are shared (written by paper auto-trader)
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
  // In live mode, paper auto-trader handles snapshots — skip writes from live-trader
  if (SHARED_DB_PATH !== DB_PATH) return
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

export type PartialExit = {
  pct: number       // fraction sold (0.5 = 50%)
  price: number     // exit price at time of partial exit
  pnl: number       // realized PnL from this partial exit
  at: string        // ISO timestamp
}

export type Position = {
  id: string
  conditionId: string
  title: string
  domain: string | null
  side: string
  entryPrice: number
  sizeUsdc: number
  shares: number
  sharesRemaining: number | null  // null = 100% (pre-migration rows)
  sourceRef: string
  sourceLabel: string | null
  status: 'open' | 'won' | 'lost'
  curPrice: number | null
  peakPrice: number | null
  exitPrice: number | null
  pnl: number | null
  partialExits: PartialExit[]     // history of partial exits
  openedAt: string
  resolvedAt: string | null
}

/** @deprecated Use Position instead */
export type PaperTrade = Position

export function getPortfolioSetting(key: string, defaultValue: string): string {
  const db = getDb()
  const row = db.prepare('SELECT value FROM portfolio_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? defaultValue
}

export function setPortfolioSetting(key: string, value: string): void {
  const db = getDb()
  db.prepare('INSERT OR REPLACE INTO portfolio_settings (key, value) VALUES (?, ?)').run(key, value)
}

// ── Pending orders (survive restarts) ────────────────────────────

export type PendingOrderRow = {
  orderId: string
  conditionId: string
  title: string
  domain: string | null
  side: string
  entryPrice: number
  sizeUsdc: number
  sourceRef: string
  sourceLabel: string | null
  placedAt: string
  orderType: 'BUY' | 'SELL'
  exitPrice: number | null
  partialFraction: number | null
  exitReason: string | null
}

export function savePendingOrder(order: PendingOrderRow): void {
  const db = getDb()
  db.prepare(
    `INSERT OR REPLACE INTO pending_orders
     (order_id, condition_id, title, domain, side, entry_price, size_usdc, source_ref, source_label, placed_at, order_type, exit_price, partial_fraction, exit_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    order.orderId, order.conditionId, order.title, order.domain,
    order.side, order.entryPrice, order.sizeUsdc,
    order.sourceRef, order.sourceLabel, order.placedAt,
    order.orderType, order.exitPrice, order.partialFraction, order.exitReason
  )
}

export function getPendingOrders(): PendingOrderRow[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM pending_orders').all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    orderId: r.order_id as string,
    conditionId: r.condition_id as string,
    title: (r.title as string) ?? '',
    domain: (r.domain as string) ?? null,
    side: r.side as string,
    entryPrice: r.entry_price as number,
    sizeUsdc: r.size_usdc as number,
    sourceRef: (r.source_ref as string) ?? '',
    sourceLabel: (r.source_label as string) ?? null,
    placedAt: r.placed_at as string,
    orderType: (r.order_type as 'BUY' | 'SELL') ?? 'BUY',
    exitPrice: (r.exit_price as number) ?? null,
    partialFraction: (r.partial_fraction as number) ?? null,
    exitReason: (r.exit_reason as string) ?? null,
  }))
}

export function removePendingOrder(orderId: string): void {
  const db = getDb()
  db.prepare('DELETE FROM pending_orders WHERE order_id = ?').run(orderId)
}

// Polymarket taker fee — charged on buy AND early sell, not on resolution redemption
const POLYMARKET_FEE = 0.02

export function openPosition(trade: {
  conditionId: string
  title: string
  domain: string | null
  side: string
  entryPrice: number
  sizeUsdc: number
  sourceRef: string
  sourceLabel: string | null
}): Position {
  const db = getDb()
  // Entry fee: spend $100 but only get 98¢ worth of shares
  const shares = (trade.sizeUsdc * (1 - POLYMARKET_FEE)) / trade.entryPrice
  const id = `pos-${trade.conditionId}-${Date.now()}`
  const now = new Date().toISOString()

  db.prepare(
    `INSERT INTO positions
     (id, condition_id, title, domain, side, entry_price, size_usdc, shares,
      source_ref, source_label, status, cur_price, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(
    id,
    trade.conditionId,
    trade.title,
    trade.domain,
    trade.side,
    trade.entryPrice,
    trade.sizeUsdc,
    shares,
    trade.sourceRef,
    trade.sourceLabel,
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
    sizeUsdc: trade.sizeUsdc,
    shares,
    sourceRef: trade.sourceRef,
    sourceLabel: trade.sourceLabel,
    status: 'open',
    curPrice: trade.entryPrice,
    peakPrice: trade.entryPrice,
    exitPrice: null,
    pnl: null,
    openedAt: now,
    resolvedAt: null,
    sharesRemaining: null,
    partialExits: [],
  }
}

/** @deprecated Use openPosition */
export const openPaperTrade = openPosition

export function getOpenPositions(): Position[] {
  const db = getDb()
  return mapPositionRows(
    db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC").all()
  )
}

export function getAllPositions(): Position[] {
  const db = getDb()
  return mapPositionRows(
    db.prepare('SELECT * FROM positions ORDER BY opened_at DESC').all()
  )
}

/**
 * Get all positions from the shared DB (for expert trust evaluation).
 * In paper mode: same as getAllPositions().
 * In live mode: reads from polymarket.db so trust has full paper trading history.
 */
export function getSharedPositions(): Position[] {
  const db = getSharedDb()
  try {
    // Try new table name first
    return mapPositionRows(
      db.prepare('SELECT * FROM positions ORDER BY opened_at DESC').all()
    )
  } catch {
    // Fallback to old name (shared DB may not be migrated yet)
    return mapPositionRows(
      db.prepare('SELECT * FROM paper_trades ORDER BY opened_at DESC').all()
    )
  }
}

/** @deprecated Use getOpenPositions */
export const getOpenPaperTrades = getOpenPositions
/** @deprecated Use getAllPositions */
export const getAllPaperTrades = getAllPositions
/** @deprecated Use getSharedPositions */
export const getSharedPaperTrades = getSharedPositions

export function updatePositionPrice(conditionId: string, curPrice: number): void {
  const db = getDb()
  db.prepare(
    `UPDATE positions SET cur_price = ?,
     peak_price = MAX(COALESCE(peak_price, cur_price), ?)
     WHERE condition_id = ? AND status = 'open'`
  ).run(curPrice, curPrice, conditionId)
}

/** @deprecated Use updatePositionPrice */
export const updatePaperTradePrice = updatePositionPrice

export function resolvePosition(
  conditionId: string,
  exitPrice: number
): void {
  if (!conditionId || exitPrice == null || isNaN(exitPrice)) return

  const db = getDb()
  const rows = db.prepare(
    "SELECT id, entry_price, shares, shares_remaining, size_usdc, side FROM positions WHERE condition_id = ? AND status = 'open'"
  ).all(conditionId) as Array<Record<string, unknown>>

  for (const row of rows) {
    const entryPrice = row.entry_price as number
    const shares = row.shares as number
    const sharesRemaining = (row.shares_remaining as number | null) ?? shares
    const sizeUsdc = row.size_usdc as number
    const side = row.side as string
    const id = row.id as string
    const fraction = sharesRemaining / shares

    let pnl: number
    let status: string
    if (exitPrice > 0.95) {
      if (side === 'YES') {
        pnl = sharesRemaining * (1 - entryPrice)
        status = 'won'
      } else {
        pnl = -(sizeUsdc * fraction)
        status = 'lost'
      }
    } else if (exitPrice < 0.05) {
      if (side === 'NO') {
        pnl = sharesRemaining * (1 - entryPrice)
        status = 'won'
      } else {
        pnl = -(sizeUsdc * fraction)
        status = 'lost'
      }
    } else {
      const netProceeds = sharesRemaining * exitPrice * (1 - POLYMARKET_FEE)
      pnl = netProceeds - sizeUsdc * fraction
      status = pnl > 0 ? 'won' : 'lost'
    }

    db.prepare(
      `UPDATE positions SET status = ?, exit_price = ?, pnl = ?, resolved_at = ?
       WHERE id = ?`
    ).run(status, exitPrice, pnl, new Date().toISOString(), id)
  }
}

/** @deprecated Use resolvePosition */
export const resolvePaperTrade = resolvePosition

/**
 * Partial exit — sells a fraction of the position and keeps the rest open.
 *
 * @param conditionId - market to partially exit
 * @param exitPriceFraction - fraction of shares to sell (0.5 = 50%)
 * @param curPrice - current market price
 * @returns realized PnL from this partial exit, or null if trade not found
 */
export function partialExitPosition(
  conditionId: string,
  exitPriceFraction: number,
  curPrice: number
): number | null {
  const db = getDb()

  const row = db.prepare(
    "SELECT * FROM positions WHERE condition_id = ? AND status = 'open'"
  ).get(conditionId) as Record<string, unknown> | undefined

  if (!row) return null

  const entryPrice = row.entry_price as number
  const totalShares = row.shares as number
  const sharesRemaining = (row.shares_remaining as number | null) ?? totalShares
  const existingExits: PartialExit[] = JSON.parse((row.partial_exits as string | null) ?? '[]')

  // Shares to sell in this partial exit
  const sharesToSell = sharesRemaining * exitPriceFraction

  // PnL on the sold portion (selling early = taker fee applies on proceeds)
  // entryPrice and curPrice are always the token's own price (YES or NO), so the
  // formula is identical for both sides: profit when curPrice > entryPrice.
  const costBasis = sharesToSell * entryPrice
  const netProceeds = sharesToSell * curPrice * (1 - POLYMARKET_FEE)
  const pnl = netProceeds - costBasis

  const newSharesRemaining = sharesRemaining - sharesToSell

  const partialExit: PartialExit = {
    pct: exitPriceFraction,
    price: curPrice,
    pnl,
    at: new Date().toISOString(),
  }

  const updatedExits = [...existingExits, partialExit]

  db.prepare(
    `UPDATE positions
     SET shares_remaining = ?,
         partial_exits = ?,
         peak_price = MAX(COALESCE(peak_price, cur_price), ?)
     WHERE condition_id = ? AND status = 'open'`
  ).run(
    newSharesRemaining,
    JSON.stringify(updatedExits),
    curPrice,
    conditionId
  )

  return pnl
}

/** @deprecated Use partialExitPosition */
export const partialExitPaperTrade = partialExitPosition

export function positionExistsForCondition(conditionId: string): boolean {
  const db = getDb()
  const openRow = db.prepare(
    "SELECT 1 FROM positions WHERE condition_id = ? AND status = 'open'"
  ).get(conditionId)
  if (openRow) return true

  const recentRow = db.prepare(
    `SELECT 1 FROM positions WHERE condition_id = ? AND status != 'open'
     AND resolved_at > datetime('now', '-24 hours')`
  ).get(conditionId)
  return recentRow !== undefined
}

/** @deprecated Use positionExistsForCondition */
export const paperTradeExistsForCondition = positionExistsForCondition

// ── Bot events operations ───────────────────────────────────────

export type BotEvent = {
  id: number
  type: string
  message: string
  detail: string | null
  createdAt: string
}

export function logBotEvent(type: string, message: string, detail?: string): void {
  try {
    const db = getDb()
    db.prepare(
      'INSERT INTO bot_events (type, message, detail, created_at) VALUES (?, ?, ?, ?)'
    ).run(type, message, detail ?? null, new Date().toISOString())
    // Keep only last 200 events
    db.prepare(
      'DELETE FROM bot_events WHERE id NOT IN (SELECT id FROM bot_events ORDER BY id DESC LIMIT 200)'
    ).run()
  } catch {
    // Ignore DB errors for logging
  }
}

export function getRecentBotEvents(limit: number = 30): BotEvent[] {
  try {
    const db = getDb()
    return (db.prepare(
      'SELECT id, type, message, detail, created_at FROM bot_events ORDER BY id DESC LIMIT ?'
    ).all(limit) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as number,
      type: r.type as string,
      message: r.message as string,
      detail: r.detail as string | null,
      createdAt: r.created_at as string,
    }))
  } catch {
    return []
  }
}

// ── Leaderboard results cache ───────────────────────────────────

const LEADERBOARD_CACHE_TTL_MS = 30 * 60 * 1000 // 30 minutes

export function getLeaderboardResultsCache(period: string): unknown[] | null {
  try {
    const db = getDb()
    const row = db.prepare(
      'SELECT results_json, computed_at FROM leaderboard_results_cache WHERE period = ?'
    ).get(period) as { results_json: string; computed_at: string } | undefined

    if (!row) return null

    const age = Date.now() - new Date(row.computed_at).getTime()
    if (age > LEADERBOARD_CACHE_TTL_MS) return null

    return JSON.parse(row.results_json) as unknown[]
  } catch {
    return null
  }
}

export function setLeaderboardResultsCache(period: string, results: unknown[]): void {
  try {
    const db = getDb()
    db.prepare(
      `INSERT OR REPLACE INTO leaderboard_results_cache (period, results_json, computed_at)
       VALUES (?, ?, ?)`
    ).run(period, JSON.stringify(results), new Date().toISOString())
  } catch {
    // Non-critical — ignore cache write errors
  }
}

// ── Paper trade row mapper ──────────────────────────────────────

function mapPositionRows(rows: unknown[]): Position[] {
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    conditionId: r.condition_id as string,
    title: r.title as string,
    domain: r.domain as string | null,
    side: r.side as string,
    entryPrice: r.entry_price as number,
    sizeUsdc: r.size_usdc as number,
    shares: r.shares as number,
    sharesRemaining: r.shares_remaining as number | null,
    sourceRef: r.source_ref as string,
    sourceLabel: r.source_label as string | null,
    status: r.status as 'open' | 'won' | 'lost',
    curPrice: r.cur_price as number | null,
    peakPrice: r.peak_price as number | null,
    exitPrice: r.exit_price as number | null,
    pnl: r.pnl as number | null,
    partialExits: JSON.parse((r.partial_exits as string | null) ?? '[]') as PartialExit[],
    openedAt: r.opened_at as string,
    resolvedAt: r.resolved_at as string | null,
  }))
}

// ── Market metadata cache ────────────────────────────────────────

export type MarketMetadata = {
  conditionId: string
  yesTokenId: string
  noTokenId: string
  endDate: string | null
  title: string | null
  liquidity: number | null
  active: boolean
  negRisk: boolean
  fetchedAt: string
}

const METADATA_TTL_MS = 24 * 60 * 60 * 1000  // 24h cache

export function getMarketMetadata(conditionId: string): MarketMetadata | null {
  const db = getDb()
  const row = db.prepare(
    'SELECT * FROM market_metadata WHERE condition_id = ?'
  ).get(conditionId) as Record<string, unknown> | undefined

  if (!row) return null

  // Check TTL
  const fetchedAt = row.fetched_at as string
  if (Date.now() - new Date(fetchedAt).getTime() > METADATA_TTL_MS) return null

  return {
    conditionId: row.condition_id as string,
    yesTokenId: row.yes_token_id as string,
    noTokenId: row.no_token_id as string,
    endDate: row.end_date as string | null,
    title: row.title as string | null,
    liquidity: row.liquidity as number | null,
    active: (row.active as number) === 1,
    negRisk: (row.neg_risk as number) === 1,
    fetchedAt,
  }
}

export function saveMarketMetadata(meta: MarketMetadata): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO market_metadata
    (condition_id, yes_token_id, no_token_id, end_date, title, liquidity, active, neg_risk, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    meta.conditionId,
    meta.yesTokenId,
    meta.noTokenId,
    meta.endDate,
    meta.title,
    meta.liquidity,
    meta.active ? 1 : 0,
    meta.negRisk ? 1 : 0,
    meta.fetchedAt,
  )
}

// ── Signals pipeline operations ────────────────────────────────

export type SignalRow = {
  id: string
  source: string               // 'expert-copy' | 'sports-arb'
  conditionId: string
  title: string
  domain: string | null
  side: string                 // 'YES' | 'NO'
  entryPrice: number
  signalScore: number          // 0-100
  kellyFraction: number | null
  // Expert-copy fields
  expertWallet: string | null
  expertLabel: string | null
  expertTrustLevel: number | null
  consensusCount: number | null
  positionSize: number | null
  // Sports-arb fields
  sportKey: string | null
  bookmakerProb: number | null
  edge: number | null
  // Token info
  yesTokenId: string | null
  noTokenId: string | null
  negRisk: boolean
  // Processing
  status: string               // 'pending' | 'taken' | 'rejected' | 'expired'
  rejectReason: string | null
  processedAt: string | null
  reasons: string[]
  createdAt: string
}

export function insertSignal(signal: Omit<SignalRow, 'status' | 'rejectReason' | 'processedAt'>): void {
  const db = getDb()
  db.prepare(`
    INSERT OR REPLACE INTO signals
    (id, source, condition_id, title, domain, side, entry_price, signal_score, kelly_fraction,
     expert_wallet, expert_label, expert_trust_level, consensus_count, position_size,
     sport_key, bookmaker_prob, edge,
     yes_token_id, no_token_id, neg_risk,
     status, reasons_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    signal.id, signal.source, signal.conditionId, signal.title, signal.domain,
    signal.side, signal.entryPrice, signal.signalScore, signal.kellyFraction,
    signal.expertWallet, signal.expertLabel, signal.expertTrustLevel,
    signal.consensusCount, signal.positionSize,
    signal.sportKey, signal.bookmakerProb, signal.edge,
    signal.yesTokenId, signal.noTokenId, signal.negRisk ? 1 : 0,
    JSON.stringify(signal.reasons), signal.createdAt,
  )
}

export function getPendingSignals(minScore: number = 0): SignalRow[] {
  const db = getDb()
  const rows = db.prepare(
    `SELECT * FROM signals WHERE status = 'pending' AND signal_score >= ?
     ORDER BY signal_score DESC, created_at ASC`
  ).all(minScore) as Array<Record<string, unknown>>
  return rows.map(mapSignalRow)
}

export function getRecentSignals(limit: number = 50): SignalRow[] {
  const db = getDb()
  const rows = db.prepare(
    'SELECT * FROM signals ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as Array<Record<string, unknown>>
  return rows.map(mapSignalRow)
}

export function markSignalTaken(id: string): void {
  const db = getDb()
  db.prepare(
    "UPDATE signals SET status = 'taken', processed_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), id)
}

export function markSignalRejected(id: string, reason: string): void {
  const db = getDb()
  db.prepare(
    "UPDATE signals SET status = 'rejected', reject_reason = ?, processed_at = ? WHERE id = ?"
  ).run(reason, new Date().toISOString(), id)
}

export function expireOldSignals(maxAgeMinutes: number = 60): number {
  const db = getDb()
  const result = db.prepare(
    `UPDATE signals SET status = 'expired'
     WHERE status = 'pending' AND created_at < datetime('now', '-' || ? || ' minutes')`
  ).run(maxAgeMinutes)
  return result.changes
}

function mapSignalRow(r: Record<string, unknown>): SignalRow {
  return {
    id: r.id as string,
    source: r.source as string,
    conditionId: r.condition_id as string,
    title: r.title as string,
    domain: r.domain as string | null,
    side: r.side as string,
    entryPrice: r.entry_price as number,
    signalScore: r.signal_score as number,
    kellyFraction: r.kelly_fraction as number | null,
    expertWallet: r.expert_wallet as string | null,
    expertLabel: r.expert_label as string | null,
    expertTrustLevel: r.expert_trust_level as number | null,
    consensusCount: r.consensus_count as number | null,
    positionSize: r.position_size as number | null,
    sportKey: r.sport_key as string | null,
    bookmakerProb: r.bookmaker_prob as number | null,
    edge: r.edge as number | null,
    yesTokenId: r.yes_token_id as string | null,
    noTokenId: r.no_token_id as string | null,
    negRisk: (r.neg_risk as number) === 1,
    status: r.status as string,
    rejectReason: r.reject_reason as string | null,
    processedAt: r.processed_at as string | null,
    reasons: JSON.parse((r.reasons_json as string | null) ?? '[]') as string[],
    createdAt: r.created_at as string,
  }
}
