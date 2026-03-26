import { fetchResolvedTrades } from '../src/lib/polymarket'

async function main(): Promise<void> {
  const address = '0x56687bf447db6ffa42ffe2204a05edaa20f55839'
  console.log('Fetching Theo4...')
  const result = await fetchResolvedTrades(address)
  console.log(`Trades: ${result.trades.length}`)
  console.log(`Total positions: ${result.totalPositions}`)
  console.log(`Total PnL: ${result.totalPnl}`)
  for (const t of result.trades.slice(0, 5)) {
    console.log(`  ${t.outcome} | ${t.marketQuestion.slice(0, 50)} | pnl=${t.pnl.toFixed(2)} | entry=${t.entryPrice.toFixed(3)}`)
  }
}

main().catch(console.error)
