/**
 * Signal Audit — Investigate what we trade vs what we skip.
 *
 * Run on VPS:
 *   cd /opt/polymarket-intuition
 *   node_modules/.bin/tsx scripts/signal-audit.ts
 *
 * Optional env:
 *   DAYS=7 (default 7) — window to analyze
 */

import { getDb, getSharedDb } from '../src/lib/db'

const DAYS = parseInt(process.env.DAYS ?? '7', 10)
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString()

type TradeRow = {
  condition_id: string
  title: string
  side: string
  entry_price: number
  size_usdc: number
  status: string
  pnl: number | null
  opened_at: string
  source_ref: string
  source_label: string | null
}

type SignalRow = {
  condition_id: string
  title: string
  side: string
  entry_price: number
  signal_score: number
  status: string
  reject_reason: string | null
  expert_label: string | null
  domain: string | null
  created_at: string
}

function bucket(price: number): string {
  if (price < 0.10) return '<10¢'
  if (price < 0.20) return '10-20¢'
  if (price < 0.30) return '20-30¢'
  if (price < 0.40) return '30-40¢'
  if (price < 0.50) return '40-50¢'
  if (price < 0.70) return '50-70¢'
  return '70¢+'
}

function scoreBucket(score: number): string {
  if (score < 50) return '<50'
  if (score < 65) return '50-64'
  if (score < 75) return '65-74'
  if (score < 85) return '75-84'
  return '85+'
}

function fmt(n: number, w = 8): string {
  return (n >= 0 ? '+' + n.toFixed(2) : n.toFixed(2)).padStart(w)
}

function main(): void {
  const db = getDb()
  const shared = getSharedDb()

  // ── 1. Taken trades breakdown ──
  console.log('═'.repeat(70))
  console.log(`SIGNAL AUDIT — last ${DAYS} days (since ${SINCE.slice(0, 10)})`)
  console.log('═'.repeat(70))

  // Auto-detect table name: old DBs use "paper_trades", migrated use "positions"
  const tableName = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('positions','paper_trades') ORDER BY name='positions' DESC LIMIT 1"
  ).get() as { name: string } | undefined
  const table = tableName?.name ?? 'positions'

  // Old schema used simulated_usdc/copied_from/copied_label; migrated uses size_usdc/source_ref/source_label
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  const colNames = new Set(cols.map(c => c.name))
  const sizeCol = colNames.has('size_usdc') ? 'size_usdc' : 'simulated_usdc'
  const refCol = colNames.has('source_ref') ? 'source_ref' : 'copied_from'
  const labelCol = colNames.has('source_label') ? 'source_label' : 'copied_label'

  const trades = db.prepare(`
    SELECT condition_id, title, side, entry_price, ${sizeCol} AS size_usdc,
           status, pnl, opened_at, ${refCol} AS source_ref, ${labelCol} AS source_label
    FROM ${table}
    WHERE opened_at >= ?
  `).all(SINCE) as TradeRow[]

  console.log(`\n📊 TRADES TAKEN: ${trades.length}`)
  const closed = trades.filter(t => t.status === 'won' || t.status === 'lost')
  const open = trades.filter(t => t.status === 'open')
  console.log(`   Open: ${open.length}  |  Closed: ${closed.length}`)
  if (closed.length > 0) {
    const wins = closed.filter(t => t.status === 'won').length
    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0)
    console.log(`   WR: ${(wins / closed.length * 100).toFixed(0)}% (${wins}W/${closed.length - wins}L)  |  PnL: ${fmt(totalPnl, 0)}`)
  }

  // ── 2. By side ──
  console.log('\n┌─ By SIDE ──────────────────────────────────────────────────┐')
  console.log('│ Side │ Taken │ Closed │  WR  │   Won PnL │  Lost PnL │  Net  │')
  console.log('├──────┼───────┼────────┼──────┼───────────┼───────────┼───────┤')
  for (const side of ['YES', 'NO']) {
    const arr = trades.filter(t => t.side === side)
    const cl = arr.filter(t => t.status === 'won' || t.status === 'lost')
    const won = cl.filter(t => t.status === 'won')
    const lost = cl.filter(t => t.status === 'lost')
    const wr = cl.length > 0 ? (won.length / cl.length * 100).toFixed(0) : '--'
    const wonPnl = won.reduce((s, t) => s + (t.pnl ?? 0), 0)
    const lostPnl = lost.reduce((s, t) => s + (t.pnl ?? 0), 0)
    console.log(`│ ${side.padEnd(4)} │ ${arr.length.toString().padStart(5)} │ ${cl.length.toString().padStart(6)} │ ${wr.padStart(3)}% │ ${fmt(wonPnl, 9)} │ ${fmt(lostPnl, 9)} │ ${fmt(wonPnl + lostPnl, 5)} │`)
  }
  console.log('└──────┴───────┴────────┴──────┴───────────┴───────────┴───────┘')

  // ── 3. By entry price bucket ──
  console.log('\n┌─ By ENTRY PRICE BUCKET ────────────────────────────────────┐')
  console.log('│ Bucket   │ Taken │ Closed │  WR  │   Net PnL │')
  console.log('├──────────┼───────┼────────┼──────┼───────────┤')
  const buckets = ['<10¢', '10-20¢', '20-30¢', '30-40¢', '40-50¢', '50-70¢', '70¢+']
  for (const b of buckets) {
    const arr = trades.filter(t => bucket(t.entry_price) === b)
    if (arr.length === 0) continue
    const cl = arr.filter(t => t.status !== 'open')
    const won = cl.filter(t => t.status === 'won').length
    const wr = cl.length > 0 ? (won / cl.length * 100).toFixed(0) : '--'
    const pnl = cl.reduce((s, t) => s + (t.pnl ?? 0), 0)
    console.log(`│ ${b.padEnd(8)} │ ${arr.length.toString().padStart(5)} │ ${cl.length.toString().padStart(6)} │ ${wr.padStart(3)}% │ ${fmt(pnl, 9)} │`)
  }
  console.log('└──────────┴───────┴────────┴──────┴───────────┘')

  // ── 4. By expert ──
  console.log('\n┌─ TOP 10 EXPERTS (by trades taken) ─────────────────────────┐')
  const byExpert = new Map<string, TradeRow[]>()
  for (const t of trades) {
    const k = t.source_label ?? t.source_ref.slice(0, 12)
    byExpert.set(k, [...(byExpert.get(k) ?? []), t])
  }
  const sortedExperts = [...byExpert.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
  console.log('│ Expert                        │ Taken │  WR  │   PnL   │')
  console.log('├───────────────────────────────┼───────┼──────┼─────────┤')
  for (const [label, arr] of sortedExperts) {
    const cl = arr.filter(t => t.status !== 'open')
    const won = cl.filter(t => t.status === 'won').length
    const wr = cl.length > 0 ? (won / cl.length * 100).toFixed(0) : '--'
    const pnl = cl.reduce((s, t) => s + (t.pnl ?? 0), 0)
    console.log(`│ ${(label.slice(0, 29)).padEnd(29)} │ ${arr.length.toString().padStart(5)} │ ${wr.padStart(3)}% │ ${fmt(pnl, 7)} │`)
  }
  console.log('└───────────────────────────────┴───────┴──────┴─────────┘')

  // ── 5. Signals: taken vs rejected ──
  console.log('\n═ SIGNALS LAYER ═'.padEnd(70, '═'))
  const signals = shared.prepare(`
    SELECT condition_id, title, side, entry_price, signal_score,
           status, reject_reason, expert_label, domain, created_at
    FROM signals
    WHERE created_at >= ?
  `).all(SINCE) as SignalRow[]

  console.log(`\n📡 SIGNALS EMITTED: ${signals.length}`)
  const byStatus = new Map<string, number>()
  for (const s of signals) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1)
  for (const [status, count] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${status.padEnd(15)} ${count}`)
  }

  // ── 6. Rejection reasons ──
  console.log('\n┌─ REJECTION REASONS ────────────────────────────────────────┐')
  const rejects = signals.filter(s => s.status === 'rejected')
  const byReason = new Map<string, SignalRow[]>()
  for (const s of rejects) {
    const r = (s.reject_reason ?? 'unknown').split(':')[0]
    byReason.set(r, [...(byReason.get(r) ?? []), s])
  }
  console.log('│ Reason                    │ Count │ Avg Score │ Side Mix   │')
  console.log('├───────────────────────────┼───────┼───────────┼────────────┤')
  for (const [reason, arr] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const avgScore = (arr.reduce((s, x) => s + x.signal_score, 0) / arr.length).toFixed(0)
    const yes = arr.filter(x => x.side === 'YES').length
    const no = arr.length - yes
    console.log(`│ ${reason.slice(0, 25).padEnd(25)} │ ${arr.length.toString().padStart(5)} │ ${avgScore.padStart(9)} │ ${yes}Y / ${no}N     │`)
  }
  console.log('└───────────────────────────┴───────┴───────────┴────────────┘')

  // ── 7. Score distribution: taken vs rejected ──
  console.log('\n┌─ SCORE DISTRIBUTION ───────────────────────────────────────┐')
  console.log('│ Score  │ Taken │ Rejected │ Taken%  │')
  console.log('├────────┼───────┼──────────┼─────────┤')
  for (const b of ['<50', '50-64', '65-74', '75-84', '85+']) {
    const inBucket = signals.filter(s => scoreBucket(s.signal_score) === b)
    const taken = inBucket.filter(s => s.status === 'taken').length
    const rejected = inBucket.filter(s => s.status === 'rejected').length
    const total = taken + rejected
    const takenPct = total > 0 ? (taken / total * 100).toFixed(0) : '--'
    console.log(`│ ${b.padEnd(6)} │ ${taken.toString().padStart(5)} │ ${rejected.toString().padStart(8)} │ ${takenPct.padStart(6)}% │`)
  }
  console.log('└────────┴───────┴──────────┴─────────┘')

  // ── 8. Side mix of signals ──
  console.log('\n┌─ SIDE MIX (signals emitted) ───────────────────────────────┐')
  for (const side of ['YES', 'NO']) {
    const arr = signals.filter(s => s.side === side)
    const taken = arr.filter(s => s.status === 'taken').length
    const rejected = arr.filter(s => s.status === 'rejected').length
    console.log(`│ ${side.padEnd(4)}  │  signals=${arr.length.toString().padStart(4)}  │  taken=${taken.toString().padStart(3)}  │  rejected=${rejected.toString().padStart(4)}  │`)
  }
  console.log('└────────────────────────────────────────────────────────────┘')

  console.log('\n' + '═'.repeat(70))
  console.log('Done. Interpret:')
  console.log('  - YES taken >> NO taken? Filters block NO disproportionately.')
  console.log('  - WR by entry bucket: where is the money leaking?')
  console.log('  - Score 85+ WR vs 65-74 WR: is the score predictive?')
  console.log('  - Expert with >5 trades and <30% WR: consider pausing.')
  console.log('═'.repeat(70))
}

main()
