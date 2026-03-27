/**
 * Migration: apply 2% Polymarket fee + slippage to existing paper trades.
 *
 * Old trades were opened without fee deduction (shares = usdc / price)
 * and without slippage markup on entry price.
 * This script retroactively corrects shares, entry_price, and pnl.
 *
 * Usage:
 *   npx tsx scripts/migrate-paper-trades.ts            → dry run (preview only)
 *   npx tsx scripts/migrate-paper-trades.ts --apply    → write to DB
 */

import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'polymarket.db')
const DRY_RUN = !process.argv.includes('--apply')
const FEE = 0.02

if (DRY_RUN) {
  console.log('🔍 DRY RUN — no changes will be written. Pass --apply to commit.\n')
} else {
  console.log('✏️  APPLYING migration to DB...\n')
}

// ── Helpers ───────────────────────────────────────────────────────

function estimateSlippage(entryPrice: number, betAmount: number): number {
  const base = entryPrice < 0.20 ? 0.06
             : entryPrice < 0.30 ? 0.05
             : entryPrice < 0.50 ? 0.03
             : 0.02
  const sizeImpact = (betAmount / 100) * 0.005
  return base + sizeImpact
}

type RawTrade = {
  id: string
  status: string
  side: string
  entry_price: number
  exit_price: number | null
  simulated_usdc: number
  shares: number
  shares_remaining: number | null
  partial_exits: string | null
  pnl: number | null
}

type PartialExit = { pct: number; price: number; pnl: number; at: string }

// ── Main ──────────────────────────────────────────────────────────

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

const trades = db.prepare(
  'SELECT id, status, side, entry_price, exit_price, simulated_usdc, shares, shares_remaining, partial_exits, pnl FROM paper_trades'
).all() as RawTrade[]

console.log(`Found ${trades.length} paper trades\n`)

let migrated = 0
let skipped = 0
let totalOldPnl = 0
let totalNewPnl = 0

const updates: Array<{
  id: string
  newEntryPrice: number
  newShares: number
  newSharesRemaining: number | null
  newPnl: number | null
  newPartialExits: string | null
  oldShares: number
  oldPnl: number | null
}> = []

for (const t of trades) {
  // Detect if already migrated:
  // After fee + slippage, shares should be meaningfully less than usdc/price
  const slippage = estimateSlippage(t.entry_price, t.simulated_usdc)
  const adjustedEntry = Math.min(t.entry_price * (1 + slippage), 0.95)
  const expectedNewShares = (t.simulated_usdc * (1 - FEE)) / adjustedEntry
  const expectedOldShares = t.simulated_usdc / t.entry_price

  // If current shares are within 0.5% of the new expected → already migrated
  const diff = Math.abs(t.shares - expectedNewShares) / expectedNewShares
  if (diff < 0.005) {
    skipped++
    continue
  }

  // ── Compute corrected values ──

  const newShares = expectedNewShares

  // Recalculate shares_remaining proportionally
  let newSharesRemaining: number | null = null
  if (t.shares_remaining != null && t.shares > 0) {
    const fraction = t.shares_remaining / t.shares
    newSharesRemaining = newShares * fraction
  }

  // Recalculate pnl for closed trades
  // Note: exit_price in DB = price of the BOUGHT token at exit (YES price for YES trades,
  // NO token price for NO trades). Formula is identical for both sides.
  let newPnl: number | null = t.pnl
  if (t.status !== 'open' && t.exit_price != null) {
    if (t.exit_price >= 0.95) {
      // Token resolved to 1 (win) — no exit fee at resolution
      newPnl = newShares * 1.0 - t.simulated_usdc
    } else if (t.exit_price <= 0.05) {
      // Token resolved to 0 (loss) — no payout
      newPnl = -t.simulated_usdc
    } else {
      // Early exit — exit fee applies (same formula for YES and NO)
      newPnl = newShares * t.exit_price * (1 - FEE) - t.simulated_usdc
    }
  }

  // Recalculate partial exits pnl with new shares
  // e.price = price of the bought token at partial exit (same convention as exit_price)
  let newPartialExits: string | null = t.partial_exits
  if (t.partial_exits && t.partial_exits !== '[]') {
    const exits = JSON.parse(t.partial_exits) as PartialExit[]
    let remainingForCalc = newShares
    const recalculated = exits.map((e) => {
      const sharesToSell = remainingForCalc * e.pct
      const costBasis = sharesToSell * adjustedEntry
      const proceeds = sharesToSell * e.price * (1 - FEE)
      const pnl = proceeds - costBasis
      remainingForCalc -= sharesToSell
      return { ...e, pnl }
    })
    newPartialExits = JSON.stringify(recalculated)
  }

  if (DRY_RUN && migrated < 10) {
    console.log(`Trade ${t.id.slice(0, 8)}… [${t.status}]`)
    console.log(`  entry_price: ${t.entry_price.toFixed(4)} → ${adjustedEntry.toFixed(4)} (+${(slippage * 100).toFixed(1)}% slippage)`)
    console.log(`  shares:      ${t.shares.toFixed(1)} → ${newShares.toFixed(1)}`)
    if (t.pnl != null && newPnl != null) {
      console.log(`  pnl:         ${t.pnl.toFixed(2)} → ${newPnl.toFixed(2)}  (Δ ${(newPnl - t.pnl).toFixed(2)})`)
    }
    console.log()
  }

  totalOldPnl += t.pnl ?? 0
  totalNewPnl += newPnl ?? 0
  migrated++

  updates.push({
    id: t.id,
    newEntryPrice: adjustedEntry,
    newShares,
    newSharesRemaining,
    newPnl,
    newPartialExits,
    oldShares: t.shares,
    oldPnl: t.pnl,
  })
}

// ── Summary ───────────────────────────────────────────────────────

console.log('─'.repeat(50))
console.log(`Trades to migrate:    ${migrated}`)
console.log(`Already up to date:   ${skipped}`)
console.log(`\nP&L impact (closed trades):`)
console.log(`  Before migration:   $${totalOldPnl.toFixed(2)}`)
console.log(`  After migration:    $${totalNewPnl.toFixed(2)}`)
console.log(`  Reduction:          $${(totalOldPnl - totalNewPnl).toFixed(2)} (fees + slippage now reflected)`)
console.log('─'.repeat(50))

if (DRY_RUN) {
  console.log('\n⚠️  Nothing written. Run with --apply to apply changes.')
  process.exit(0)
}

// ── Apply ─────────────────────────────────────────────────────────

const update = db.prepare(
  `UPDATE paper_trades
   SET entry_price = ?, shares = ?, shares_remaining = ?, pnl = ?, partial_exits = ?
   WHERE id = ?`
)

const applyAll = db.transaction(() => {
  for (const u of updates) {
    update.run(u.newEntryPrice, u.newShares, u.newSharesRemaining, u.newPnl, u.newPartialExits, u.id)
  }
})

applyAll()

console.log(`\n✅ Migration complete — ${migrated} trades updated.`)
console.log('Restart the bot (pm2 restart auto-trader) for new numbers to take effect.')
