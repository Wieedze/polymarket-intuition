/**
 * Wallet Audit — Analyze each watched wallet's edge and recommend keep/tune/prune.
 *
 * Run on VPS:
 *   DB_PATH=/opt/polymarket-intuition/data/live.db \
 *   SHARED_DB_PATH=/opt/polymarket-intuition/data/polymarket.db \
 *   DAYS=30 \
 *   node_modules/.bin/tsx scripts/wallet-audit.ts
 *
 * Env:
 *   DAYS=30     — lookback window (default 30)
 *   MIN_TRADES=20 — hide wallets with fewer resolved trades
 *   YES_MAX=0.35   — current bot's YES cap (used to simulate what we catch)
 *   NO_MAX=0.80    — current bot's NO cap
 */

import { getSharedDb } from '../src/lib/db'

const DAYS = parseInt(process.env.DAYS ?? '30', 10)
const MIN_TRADES = parseInt(process.env.MIN_TRADES ?? '20', 10)
const YES_MAX = parseFloat(process.env.YES_MAX ?? '0.35')
const NO_MAX = parseFloat(process.env.NO_MAX ?? '0.80')
const SINCE = new Date(Date.now() - DAYS * 86400000).toISOString()

type TradeRow = {
  wallet: string
  side: string
  entry_price: number
  outcome: string
  pnl: number
  domain: string | null
}

type WalletRow = {
  wallet: string
  label: string | null
  active: number
  copyability_score: number | null
}

function bucket(price: number): string {
  if (price < 0.10) return '<10'
  if (price < 0.20) return '10-20'
  if (price < 0.30) return '20-30'
  if (price < 0.40) return '30-40'
  if (price < 0.50) return '40-50'
  if (price < 0.70) return '50-70'
  if (price < 0.90) return '70-90'
  return '90+'
}

function fmt(n: number, w = 7): string {
  return (n >= 0 ? '+' + n.toFixed(0) : n.toFixed(0)).padStart(w)
}

function inFilter(side: string, price: number): boolean {
  return side === 'YES' ? price <= YES_MAX : price <= NO_MAX
}

function main(): void {
  const db = getSharedDb()

  const wallets = db.prepare(`
    SELECT wallet, label, active, copyability_score
    FROM watched_wallets
    ORDER BY active DESC, wallet
  `).all() as WalletRow[]

  console.log('═'.repeat(110))
  console.log(`WALLET AUDIT — ${wallets.length} watched wallets, last ${DAYS}d (min ${MIN_TRADES} trades)`)
  console.log(`Current bot filter: YES ≤ ${(YES_MAX * 100).toFixed(0)}¢  |  NO ≤ ${(NO_MAX * 100).toFixed(0)}¢`)
  console.log('═'.repeat(110))

  type Summary = {
    wallet: string
    label: string
    active: number
    total: number
    wr: number
    pnl: number
    ourCatch: { trades: number; pnl: number; wr: number }
    best: { bucket: string; side: string; pnl: number; wr: number; trades: number }
    worst: { bucket: string; side: string; pnl: number; wr: number; trades: number }
    recommendation: string
  }

  const summaries: Summary[] = []

  for (const w of wallets) {
    const trades = db.prepare(`
      SELECT wallet, side, entry_price, outcome, pnl, domain
      FROM trades
      WHERE wallet = ? AND resolved_at > ?
    `).all(w.wallet, SINCE) as TradeRow[]

    if (trades.length < MIN_TRADES) continue

    const wins = trades.filter(t => t.outcome === 'won').length
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0)
    const wr = wins / trades.length

    // Break down by (bucket, side)
    const byBucket = new Map<string, TradeRow[]>()
    for (const t of trades) {
      const k = `${bucket(t.entry_price)}|${t.side}`
      byBucket.set(k, [...(byBucket.get(k) ?? []), t])
    }

    const bucketStats = [...byBucket.entries()].map(([k, arr]) => {
      const [buck, side] = k.split('|')
      const w = arr.filter(t => t.outcome === 'won').length
      const pnl = arr.reduce((s, t) => s + t.pnl, 0)
      return { bucket: buck, side, trades: arr.length, wr: w / arr.length, pnl }
    })

    const best = bucketStats.filter(s => s.trades >= 5).sort((a, b) => b.pnl - a.pnl)[0]
      ?? { bucket: '-', side: '-', trades: 0, wr: 0, pnl: 0 }
    const worst = bucketStats.filter(s => s.trades >= 5).sort((a, b) => a.pnl - b.pnl)[0]
      ?? { bucket: '-', side: '-', trades: 0, wr: 0, pnl: 0 }

    // What our current filter catches from this wallet
    const ourTrades = trades.filter(t => inFilter(t.side, t.entry_price))
    const ourWins = ourTrades.filter(t => t.outcome === 'won').length
    const ourPnl = ourTrades.reduce((s, t) => s + t.pnl, 0)
    const ourWr = ourTrades.length > 0 ? ourWins / ourTrades.length : 0

    // Recommendation logic
    let rec = ''
    if (totalPnl < 0) {
      rec = 'PRUNE — wallet itself is unprofitable'
    } else if (ourTrades.length < 5) {
      rec = 'MONITOR — too few caught by filter'
    } else if (ourPnl < 0 && totalPnl > 0) {
      rec = `TUNE — profitable but we catch wrong zone (our: ${fmt(ourPnl)})`
    } else if (ourWr < 0.25 && ourTrades.length >= 10) {
      rec = `PRUNE-OR-TUNE — we hit <25% WR (${(ourWr * 100).toFixed(0)}%)`
    } else if (ourPnl > 0 && ourWr > 0.35) {
      rec = 'KEEP — profitable for us'
    } else {
      rec = 'MARGINAL'
    }

    summaries.push({
      wallet: w.wallet,
      label: w.label ?? w.wallet.slice(0, 12),
      active: w.active,
      total: trades.length,
      wr,
      pnl: totalPnl,
      ourCatch: { trades: ourTrades.length, pnl: ourPnl, wr: ourWr },
      best,
      worst,
      recommendation: rec,
    })
  }

  // Sort by recommendation priority then PnL
  const order = ['PRUNE', 'PRUNE-OR-TUNE', 'TUNE', 'MONITOR', 'MARGINAL', 'KEEP']
  summaries.sort((a, b) => {
    const ai = order.findIndex(o => a.recommendation.startsWith(o))
    const bi = order.findIndex(o => b.recommendation.startsWith(o))
    if (ai !== bi) return ai - bi
    return a.ourCatch.pnl - b.ourCatch.pnl
  })

  console.log('\n' + '─'.repeat(110))
  console.log('PER-WALLET DIAGNOSTIC (what THEY do 30d, and what WE catch with current filter)')
  console.log('─'.repeat(110))
  console.log('Label                           │ THEIR 30d          │ OUR CATCH         │ Best zone         │ Worst zone')
  console.log('                                │ Trades  WR    PnL  │ Trades  WR   PnL  │ Buck/Side  PnL    │ Buck/Side  PnL')
  console.log('─'.repeat(110))

  for (const s of summaries) {
    const label = s.label.slice(0, 30).padEnd(30)
    const act = s.active ? ' ' : '✗'
    const theirLine = `${s.total.toString().padStart(5)} ${(s.wr * 100).toFixed(0).padStart(3)}% ${fmt(s.pnl)}`
    const ourLine = `${s.ourCatch.trades.toString().padStart(5)} ${(s.ourCatch.wr * 100).toFixed(0).padStart(3)}% ${fmt(s.ourCatch.pnl)}`
    const bestStr = `${s.best.bucket}¢/${s.best.side[0]} ${fmt(s.best.pnl)}`.padEnd(17)
    const worstStr = `${s.worst.bucket}¢/${s.worst.side[0]} ${fmt(s.worst.pnl)}`.padEnd(17)
    console.log(`${act} ${label} │ ${theirLine} │ ${ourLine} │ ${bestStr} │ ${worstStr}`)
  }

  // ── Aggregate: where does the overall edge live? ──
  console.log('\n' + '═'.repeat(80))
  console.log('AGGREGATE EDGE MAP — sum of all wallets\' PnL per bucket × side')
  console.log('═'.repeat(80))

  const allTrades = db.prepare(`
    SELECT wallet, side, entry_price, outcome, pnl, domain
    FROM trades t
    WHERE t.resolved_at > ?
      AND t.wallet IN (SELECT wallet FROM watched_wallets)
  `).all(SINCE) as TradeRow[]

  const agg = new Map<string, { pnl: number; trades: number; wins: number }>()
  for (const t of allTrades) {
    const k = `${bucket(t.entry_price)}|${t.side}`
    const cur = agg.get(k) ?? { pnl: 0, trades: 0, wins: 0 }
    cur.pnl += t.pnl
    cur.trades += 1
    if (t.outcome === 'won') cur.wins += 1
    agg.set(k, cur)
  }

  console.log('\n┌─────────┬───────────────────────────────┬───────────────────────────────┐')
  console.log('│ Bucket  │            YES                │            NO                 │')
  console.log('│         │ Trades   WR     PnL    InFilt │ Trades   WR     PnL    InFilt │')
  console.log('├─────────┼───────────────────────────────┼───────────────────────────────┤')

  const buckets = ['<10', '10-20', '20-30', '30-40', '40-50', '50-70', '70-90', '90+']
  for (const b of buckets) {
    const y = agg.get(`${b}|YES`) ?? { pnl: 0, trades: 0, wins: 0 }
    const n = agg.get(`${b}|NO`) ?? { pnl: 0, trades: 0, wins: 0 }
    const yWr = y.trades > 0 ? (y.wins / y.trades * 100).toFixed(0) + '%' : '   '
    const nWr = n.trades > 0 ? (n.wins / n.trades * 100).toFixed(0) + '%' : '   '
    // Check if this bucket is within our filter
    const yInFilter = buckets.indexOf(b) <= buckets.findIndex(x => x === bucketForMax(YES_MAX))
    const nInFilter = buckets.indexOf(b) <= buckets.findIndex(x => x === bucketForMax(NO_MAX))
    const yIn = y.trades === 0 ? '   ' : (yInFilter ? ' ✓ ' : ' ✗ ')
    const nIn = n.trades === 0 ? '   ' : (nInFilter ? ' ✓ ' : ' ✗ ')
    console.log(`│ ${b.padEnd(7)} │ ${y.trades.toString().padStart(6)} ${yWr.padStart(4)}  ${fmt(y.pnl, 8)}  ${yIn}   │ ${n.trades.toString().padStart(6)} ${nWr.padStart(4)}  ${fmt(n.pnl, 8)}  ${nIn}   │`)
  }
  console.log('└─────────┴───────────────────────────────┴───────────────────────────────┘')
  console.log('(✓ = currently caught by bot filter, ✗ = blocked)')

  // Coverage summary
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0)
  const caughtPnl = allTrades.filter(t => inFilter(t.side, t.entry_price)).reduce((s, t) => s + t.pnl, 0)
  const caughtTrades = allTrades.filter(t => inFilter(t.side, t.entry_price)).length
  console.log(`\nTotal experts PnL (30d):   ${fmt(totalPnl, 10)}  on ${allTrades.length} trades`)
  console.log(`We catch (via filters):    ${fmt(caughtPnl, 10)}  on ${caughtTrades} trades  (${(caughtPnl / totalPnl * 100).toFixed(0)}% of their profit)`)

  // Summary by recommendation
  console.log('\n' + '═'.repeat(80))
  console.log('RECOMMENDATION SUMMARY')
  console.log('═'.repeat(80))
  const byRec = new Map<string, Summary[]>()
  for (const s of summaries) {
    const key = s.recommendation.split(' ')[0]
    byRec.set(key, [...(byRec.get(key) ?? []), s])
  }
  for (const [rec, arr] of byRec) {
    console.log(`\n${rec} (${arr.length} wallets):`)
    for (const s of arr.slice(0, 5)) {
      console.log(`  - ${s.label.slice(0, 40).padEnd(40)} their:${fmt(s.pnl)}  our:${fmt(s.ourCatch.pnl)}  best:${s.best.bucket}¢/${s.best.side[0]}`)
    }
    if (arr.length > 5) console.log(`  ... and ${arr.length - 5} more`)
  }
}

function bucketForMax(price: number): string {
  if (price < 0.10) return '<10'
  if (price < 0.20) return '10-20'
  if (price < 0.30) return '20-30'
  if (price < 0.40) return '30-40'
  if (price < 0.50) return '40-50'
  if (price < 0.70) return '50-70'
  if (price < 0.90) return '70-90'
  return '90+'
}

main()
