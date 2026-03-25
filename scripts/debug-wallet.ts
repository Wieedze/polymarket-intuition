import { fetchResolvedTrades } from '../src/lib/polymarket'
import { keywordClassify } from '../src/lib/classifier'
import { classifyMarket } from '../src/lib/classifier'

const WALLET = process.argv[2] ?? '0xf2f6af4f27ec2dcf4072095ab804016e14cd5817'

async function main(): Promise<void> {
  console.log(`\n=== Debugging wallet: ${WALLET} ===\n`)

  const result = await fetchResolvedTrades(WALLET)
  console.log(`Total positions: ${result.totalPositions}`)
  console.log(`Resolved trades: ${result.trades.length}`)
  console.log(`Total PnL: $${result.totalPnl.toFixed(2)}\n`)

  // ── BUG 2: Check won/lost distribution ──
  const won = result.trades.filter(t => t.outcome === 'won')
  const lost = result.trades.filter(t => t.outcome === 'lost')
  console.log(`=== WIN/LOSS DISTRIBUTION ===`)
  console.log(`Won: ${won.length} (${(won.length / result.trades.length * 100).toFixed(1)}%)`)
  console.log(`Lost: ${lost.length} (${(lost.length / result.trades.length * 100).toFixed(1)}%)`)
  console.log(`Won PnL: $${won.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`)
  console.log(`Lost PnL: $${lost.reduce((s, t) => s + t.pnl, 0).toFixed(2)}\n`)

  // Show first 10 trades with details
  console.log(`=== FIRST 10 TRADES (raw) ===`)
  for (const trade of result.trades.slice(0, 10)) {
    console.log(`  [${trade.outcome.toUpperCase().padEnd(4)}] side=${trade.side} entry=${trade.entryPrice.toFixed(3)} size=${trade.size.toFixed(1)} pnl=$${trade.pnl.toFixed(2)} | ${trade.marketQuestion.slice(0, 80)}`)
  }

  // ── BUG 1: Check classification rate ──
  let classified = 0
  let unclassified = 0
  const unclassifiedTitles: string[] = []
  const domainCounts: Record<string, number> = {}

  for (const trade of result.trades) {
    const kw = keywordClassify(trade.marketQuestion)
    if (kw && kw.confidence >= 0.70) {
      classified++
      domainCounts[kw.domain] = (domainCounts[kw.domain] ?? 0) + 1
    } else {
      unclassified++
      if (unclassifiedTitles.length < 30) {
        const conf = kw ? ` (kw: ${kw.domain} @ ${kw.confidence.toFixed(2)})` : ''
        unclassifiedTitles.push(`${trade.marketQuestion}${conf}`)
      }
    }
  }

  console.log(`\n=== CLASSIFICATION (keyword only, threshold >= 0.70) ===`)
  console.log(`Classified: ${classified} (${(classified / result.trades.length * 100).toFixed(1)}%)`)
  console.log(`Unclassified: ${unclassified}`)
  console.log(`\nDomain distribution:`)
  for (const [domain, count] of Object.entries(domainCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${domain}: ${count}`)
  }
  console.log(`\n=== FIRST 30 UNCLASSIFIED TITLES ===`)
  for (const title of unclassifiedTitles) {
    console.log(`  - ${title}`)
  }

  // Check if ANTHROPIC_API_KEY is set for LLM fallback
  console.log(`\n=== LLM FALLBACK STATUS ===`)
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET'}`)
}

main().catch(console.error)
