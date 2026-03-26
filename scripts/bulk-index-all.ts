import { indexWallet } from '../src/lib/indexer'
import { saveLeaderboardEntry, addWatchedWallet, getWalletStats } from '../src/lib/db'

type LeaderboardEntry = {
  rank: string
  proxyWallet: string
  userName: string
  vol: number
  pnl: number
}

const CATEGORIES = [
  'CRYPTO',
  'POLITICS',
  'CULTURE',
  'TECH',
  'WEATHER',
  'ECONOMICS',
  'FINANCE',
]

const PER_CATEGORY = parseInt(process.argv[2] ?? '10', 10)
const PERIOD = process.argv[3] ?? 'MONTH'
const WATCH = process.argv.includes('--watch')

async function main(): Promise<void> {
  const seenWallets = new Set<string>()
  let totalIndexed = 0
  let totalWallets = 0

  for (const category of CATEGORIES) {
    console.log(`\n══════════════════════════════════════`)
    console.log(`  ${category} — Top ${PER_CATEGORY} (${PERIOD})`)
    console.log(`══════════════════════════════════════\n`)

    const res = await fetch(
      `https://data-api.polymarket.com/v1/leaderboard?limit=${PER_CATEGORY}&timePeriod=${PERIOD}&orderBy=PNL&category=${category}`
    )
    if (!res.ok) {
      console.log(`  ERROR: ${res.status}`)
      continue
    }
    const entries = (await res.json()) as LeaderboardEntry[]

    for (const [i, entry] of entries.entries()) {
      // Skip already-indexed wallets from other categories
      if (seenWallets.has(entry.proxyWallet)) {
        const name = entry.userName || entry.proxyWallet.slice(0, 10)
        console.log(`[${(i + 1).toString().padStart(2)}/${entries.length}] ${name.padEnd(25)} SKIP (already indexed)`)
        continue
      }
      seenWallets.add(entry.proxyWallet)

      const name = entry.userName || entry.proxyWallet.slice(0, 10)
      process.stdout.write(
        `[${(i + 1).toString().padStart(2)}/${entries.length}] ${name.padEnd(25)} `
      )

      saveLeaderboardEntry({
        wallet: entry.proxyWallet,
        userName: entry.userName || '',
        rank: parseInt(entry.rank, 10),
        pnl: entry.pnl,
        volume: entry.vol,
        period: `${PERIOD}-${category}`,
        fetchedAt: new Date().toISOString(),
      })

      const result = await indexWallet(entry.proxyWallet)

      const stats = getWalletStats(entry.proxyWallet)
      let topCopyability = 0
      let topDomain = '—'
      for (const s of stats) {
        const approxScore = (
          Math.min(s.winRate / 0.7, 1) * 0.25 +
          Math.min(Math.max((s.calibration - 0.5) / 0.5, 0), 1) * 0.25 +
          Math.min(s.tradesCount / 20, 1) * 0.20 +
          0.30
        )
        if (approxScore > topCopyability && s.tradesCount >= 5) {
          topCopyability = approxScore
          topDomain = s.domain
        }
      }

      if (WATCH && topCopyability > 0.5) {
        addWatchedWallet(entry.proxyWallet, `${name} [${category}] (copy:${(topCopyability * 100).toFixed(0)}%)`)
      }

      console.log(
        `${result.tradesIndexed.toString().padStart(4)} idx | ` +
        `${result.tradesSkipped.toString().padStart(4)} skip | ` +
        `copy: ${(topCopyability * 100).toFixed(0)}% ${topDomain}`
      )

      totalIndexed += result.tradesIndexed
      totalWallets++

      await new Promise((r) => setTimeout(r, 1500))
    }
  }

  console.log('\n═══════════════════════════════════════════════')
  console.log('  ALL CATEGORIES COMPLETE')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Categories: ${CATEGORIES.length}`)
  console.log(`  Unique wallets: ${totalWallets}`)
  console.log(`  Total trades indexed: ${totalIndexed}`)
  if (WATCH) console.log(`  Auto-watched wallets with copyability > 50%`)
  console.log('')
}

main().catch(console.error)
