/**
 * Close All Positions — Sells or redeems every position in the wallet
 *
 * Usage:
 *   export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/close-all.ts
 *   export $(cat secrets/bot-1.env | xargs) && npx tsx scripts/close-all.ts --dry-run
 *
 * For each position:
 *   - Active market (price 5-95¢): place GTC SELL at best bid
 *   - Resolved winner (price > 95¢): redeem shares for $1 each
 *   - Resolved loser (price < 5¢): mark as worthless, skip
 */

import { getRealPositions, getRealBalance, closePosition } from '../src/lib/real-trader'

const DRY_RUN = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  console.log(`\n${'='.repeat(50)}`)
  console.log(`  ${DRY_RUN ? '🏜️  DRY-RUN' : '🔴 LIVE'} — CLOSE ALL POSITIONS`)
  console.log(`${'='.repeat(50)}\n`)

  const balance = await getRealBalance()
  console.log(`  USDC Balance: $${balance.toFixed(2)}`)

  // Fetch ALL positions (including resolved ones — no price filter)
  const { getWalletAddress } = await import('../src/lib/real-trader')
  const address = getWalletAddress().toLowerCase()
  if (!address) {
    console.log('  ERROR: No wallet address — check POLYMARKET_PRIVATE_KEY')
    return
  }

  const res = await fetch(
    `https://data-api.polymarket.com/positions?user=${address}&sizeThreshold=0`
  )
  if (!res.ok) {
    console.log(`  ERROR: Failed to fetch positions (${res.status})`)
    return
  }

  const allPositions = await res.json() as Array<{
    conditionId: string
    asset: string
    outcomeIndex: number
    title: string
    size: number
    avgPrice: number
    curPrice: number
    cashPnl: number
    negativeRisk: boolean
  }>

  const positions = allPositions.filter(p => p.size > 0)
  console.log(`  Found ${positions.length} positions\n`)

  if (positions.length === 0) {
    console.log('  No positions to close.')
    return
  }

  let totalValue = 0
  let sold = 0
  let redeemable = 0
  let worthless = 0
  let failed = 0

  for (const pos of positions) {
    const side = pos.outcomeIndex === 0 ? 'YES' : 'NO'
    const value = pos.size * pos.curPrice
    totalValue += value

    if (pos.curPrice > 0.95) {
      // Resolved winner or near-resolution — try to sell at high price
      console.log(`  🏆 WINNER | ${side} ${pos.size.toFixed(1)} shares @ ${(pos.curPrice * 100).toFixed(0)}¢ | $${value.toFixed(2)} | ${pos.title.slice(0, 50)}`)
      redeemable++

      if (!DRY_RUN) {
        // Sell at slightly below current price to ensure fill
        const sellPrice = Math.max(pos.curPrice - 0.02, 0.01)
        const result = await closePosition(pos.asset, pos.size, sellPrice, pos.negativeRisk ?? false, pos.conditionId)
        if (result.success) {
          console.log(`    ✅ Sell order placed | orderId: ${result.orderId?.slice(0, 12)}`)
          sold++
        } else {
          console.log(`    ❌ Sell failed: ${result.error}`)
          failed++
        }
      }
    } else if (pos.curPrice < 0.05) {
      // Resolved loser — worthless
      console.log(`  💀 LOST   | ${side} ${pos.size.toFixed(1)} shares @ ${(pos.curPrice * 100).toFixed(0)}¢ | $${value.toFixed(2)} | ${pos.title.slice(0, 50)}`)
      worthless++
    } else {
      // Active market — sell at current price
      console.log(`  📋 ACTIVE | ${side} ${pos.size.toFixed(1)} shares @ ${(pos.curPrice * 100).toFixed(0)}¢ | $${value.toFixed(2)} | ${pos.title.slice(0, 50)}`)

      if (!DRY_RUN) {
        // Sell at slightly below current price to fill faster
        const sellPrice = Math.max(pos.curPrice - 0.02, 0.01)
        const result = await closePosition(pos.asset, pos.size, sellPrice, pos.negativeRisk ?? false, pos.conditionId)
        if (result.success) {
          console.log(`    ✅ Sell order placed | orderId: ${result.orderId?.slice(0, 12)}`)
          sold++
        } else {
          console.log(`    ❌ Sell failed: ${result.error}`)
          failed++
        }
      }
    }

    // Rate limit — don't spam the CLOB
    if (!DRY_RUN) await new Promise(r => setTimeout(r, 1000))
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`  Total value: $${totalValue.toFixed(2)}`)
  console.log(`  Winners:  ${redeemable} | Active: ${positions.length - redeemable - worthless} | Lost: ${worthless}`)
  if (!DRY_RUN) {
    console.log(`  Sold: ${sold} | Failed: ${failed}`)
  } else {
    console.log(`  (dry-run — no orders placed)`)
  }
  console.log(`${'='.repeat(50)}\n`)
}

main().catch(console.error)
