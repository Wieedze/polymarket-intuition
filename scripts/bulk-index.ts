import { indexWallet } from '../src/lib/indexer'
import { saveLeaderboardEntry, addWatchedWallet, getWalletStats } from '../src/lib/db'
import {
  calculateCopyabilityScore,
  calculateProfitFactor,
} from '../src/lib/scorer'
import type { ResolvedTrade } from '../src/types/polymarket'

type LeaderboardEntry = {
  rank: string
  proxyWallet: string
  userName: string
  vol: number
  pnl: number
}

const LIMIT = parseInt(process.argv[2] ?? '20', 10)
const PERIOD = process.argv[3] ?? 'MONTH'
const WATCH = process.argv.includes('--watch')

async function main(): Promise<void> {
  console.log(`\n🔍 Fetching top ${LIMIT} wallets (${PERIOD})...\n`)

  const res = await fetch(
    `https://data-api.polymarket.com/v1/leaderboard?limit=${LIMIT}&timePeriod=${PERIOD}&orderBy=PNL`
  )
  if (!res.ok) throw new Error(`Leaderboard API: ${res.status}`)
  const entries = (await res.json()) as LeaderboardEntry[]

  console.log(`Found ${entries.length} wallets. Starting indexation...\n`)

  const results: Array<{
    name: string
    wallet: string
    indexed: number
    skipped: number
    topCopyability: number
    topDomain: string
  }> = []

  for (const [i, entry] of entries.entries()) {
    const name = entry.userName || entry.proxyWallet.slice(0, 10)
    process.stdout.write(
      `[${(i + 1).toString().padStart(2)}/${entries.length}] ${name.padEnd(25)} `
    )

    // Save leaderboard metadata
    saveLeaderboardEntry({
      wallet: entry.proxyWallet,
      userName: entry.userName || '',
      rank: parseInt(entry.rank, 10),
      pnl: entry.pnl,
      volume: entry.vol,
      period: PERIOD,
      fetchedAt: new Date().toISOString(),
    })

    // Index trades
    const result = await indexWallet(entry.proxyWallet, false)

    // Compute best copyability from stored stats
    const stats = getWalletStats(entry.proxyWallet)
    let topCopyability = 0
    let topDomain = '—'

    for (const s of stats) {
      // We need the raw trades to compute copyability, but we can approximate
      // from wallet_stats. For now use a simplified version.
      const approxScore = (
        Math.min(s.winRate / 0.7, 1) * 0.25 +
        Math.min(Math.max((s.calibration - 0.5) / 0.5, 0), 1) * 0.25 +
        Math.min(s.tradesCount / 20, 1) * 0.20 +
        0.30 // profit factor placeholder
      )
      if (approxScore > topCopyability && s.tradesCount >= 5) {
        topCopyability = approxScore
        topDomain = s.domain
      }
    }

    // Auto-watch if high copyability
    if (WATCH && topCopyability > 0.5) {
      addWatchedWallet(entry.proxyWallet, `${name} (copy:${(topCopyability * 100).toFixed(0)}%)`)
    }

    console.log(
      `${result.tradesIndexed.toString().padStart(4)} indexed | ` +
      `${result.tradesSkipped.toString().padStart(4)} skip | ` +
      `${result.errors.length} err | ` +
      `copy: ${(topCopyability * 100).toFixed(0)}% ${topDomain}`
    )

    results.push({
      name,
      wallet: entry.proxyWallet,
      indexed: result.tradesIndexed,
      skipped: result.tradesSkipped,
      topCopyability,
      topDomain,
    })

    // Rate limit
    await new Promise((r) => setTimeout(r, 1500))
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════')
  console.log('  BULK INDEX COMPLETE')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Wallets: ${results.length}`)
  console.log(`  Total indexed: ${results.reduce((s, r) => s + r.indexed, 0)}`)
  console.log(`  Total skipped: ${results.reduce((s, r) => s + r.skipped, 0)}`)

  const copiable = results
    .filter((r) => r.topCopyability > 0.5)
    .sort((a, b) => b.topCopyability - a.topCopyability)

  if (copiable.length > 0) {
    console.log(`\n  TOP COPYABLE WALLETS:`)
    for (const r of copiable.slice(0, 10)) {
      console.log(
        `    ${(r.topCopyability * 100).toFixed(0)}% | ${r.name.padEnd(20)} | ${r.topDomain}`
      )
    }
  }

  if (WATCH) {
    console.log(`\n  Auto-watched: ${copiable.length} wallets (copyability > 50%)`)
  }

  console.log('')
}

main().catch(console.error)
