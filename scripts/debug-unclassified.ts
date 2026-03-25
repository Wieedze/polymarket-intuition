import { fetchResolvedTrades } from '../src/lib/polymarket'
import { keywordClassify } from '../src/lib/classifier'

const WALLET = process.argv[2] ?? '0xf2f6af4f27ec2dcf4072095ab804016e14cd5817'

async function main(): Promise<void> {
  const result = await fetchResolvedTrades(WALLET)
  const unclassified: string[] = []

  for (const trade of result.trades) {
    const c = keywordClassify(trade.marketQuestion)
    if (!c) unclassified.push(trade.marketQuestion)
  }

  console.log(`Total: ${result.trades.length} | Classified: ${result.trades.length - unclassified.length} | Unclassified: ${unclassified.length}\n`)

  // Count common words in unclassified titles
  const wordFreq: Record<string, number> = {}
  for (const title of unclassified) {
    const words = title.toLowerCase().split(/\s+/)
    const seen = new Set<string>()
    for (const w of words) {
      if (w.length < 3) continue
      if (seen.has(w)) continue
      seen.add(w)
      wordFreq[w] = (wordFreq[w] ?? 0) + 1
    }
  }

  console.log('=== TOP 30 WORDS IN UNCLASSIFIED TITLES ===')
  const sorted = Object.entries(wordFreq).sort((a, b) => b[1] - a[1]).slice(0, 30)
  for (const [word, count] of sorted) {
    console.log(`  ${count.toString().padStart(3)}x  ${word}`)
  }

  console.log('\n=== FIRST 40 UNCLASSIFIED TITLES ===')
  for (const title of unclassified.slice(0, 40)) {
    console.log(`  - ${title}`)
  }
}

main().catch(console.error)
