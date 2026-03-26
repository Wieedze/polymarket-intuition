/**
 * Paper Trading Analytics Report
 * Run: node_modules/.bin/tsx scripts/analytics.ts
 */

import { getAllPaperTrades, getPortfolioSetting, type PaperTrade } from '../src/lib/db'

// ── Helpers ──────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of arr) {
    const k = key(item)
    const existing = map.get(k) ?? []
    existing.push(item)
    map.set(k, existing)
  }
  return map
}

function pnlOf(trades: PaperTrade[]): number {
  return trades.reduce((s, t) => s + (t.pnl ?? 0), 0)
}

function wrOf(trades: PaperTrade[]): number {
  const closed = trades.filter((t) => t.status !== 'open')
  if (closed.length === 0) return 0
  return closed.filter((t) => t.status === 'won').length / closed.length
}

function pad(s: string, n: number): string {
  return s.padEnd(n)
}

function rpad(s: string, n: number): string {
  return s.padStart(n)
}

function pnlStr(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`
}

// ── Main ─────────────────────────────────────────────────────────

function main(): void {
  const all = getAllPaperTrades()
  const open = all.filter((t) => t.status === 'open')
  const closed = all.filter((t) => t.status !== 'open')
  const won = closed.filter((t) => t.status === 'won')
  const lost = closed.filter((t) => t.status === 'lost')

  const startBal = parseFloat(getPortfolioSetting('starting_balance', '10000'))
  const realizedPnl = pnlOf(closed)
  const unrealizedPnl = open.reduce((s, t) => {
    if (t.curPrice == null) return s
    return s + t.shares * (t.curPrice - t.entryPrice)
  }, 0)
  const balance = startBal + realizedPnl

  console.log('\n╔═══════════════════════════════════════════════════════════════╗')
  console.log('║              PAPER TRADING ANALYTICS REPORT                  ║')
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log(`║  Balance:     $${balance.toFixed(2).padStart(10)}  (started: $${startBal.toFixed(0)})`)
  console.log(`║  Realized:    ${pnlStr(realizedPnl).padStart(11)}`)
  console.log(`║  Unrealized:  ${pnlStr(unrealizedPnl).padStart(11)}`)
  console.log(`║  ROI:         ${((realizedPnl / startBal) * 100).toFixed(2).padStart(10)}%`)
  console.log(`║  Win Rate:    ${closed.length > 0 ? `${(wrOf(closed) * 100).toFixed(0)}%` : '—'.padStart(10)}  (${won.length}W / ${lost.length}L)`)
  console.log(`║  Open:        ${open.length.toString().padStart(10)}`)
  console.log(`║  Total:       ${all.length.toString().padStart(10)}`)
  console.log('╚═══════════════════════════════════════════════════════════════╝')

  // ── By Domain ──
  if (closed.length > 0) {
    console.log('\n┌─── PERFORMANCE BY DOMAIN ─────────────────────────────────────┐')
    console.log(`  ${'Domain'.padEnd(22)} ${'Trades'.padStart(6)} ${'Won'.padStart(5)} ${'WR'.padStart(6)} ${'PnL'.padStart(12)} ${'Avg'.padStart(8)}`)
    console.log('  ' + '─'.repeat(59))

    const byDomain = groupBy(closed, (t) => t.domain ?? 'unknown')
    const domainEntries = [...byDomain.entries()]
      .sort((a, b) => pnlOf(b[1]) - pnlOf(a[1]))

    for (const [domain, trades] of domainEntries) {
      const label = domain.replace('pm-domain/', '')
      const w = trades.filter((t) => t.status === 'won').length
      const wr = (w / trades.length * 100).toFixed(0)
      const pnl = pnlOf(trades)
      const avg = pnl / trades.length
      console.log(
        `  ${label.padEnd(22)} ${trades.length.toString().padStart(6)} ${w.toString().padStart(5)} ${(wr + '%').padStart(6)} ${pnlStr(pnl).padStart(12)} ${pnlStr(avg).padStart(8)}`
      )
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── By Expert ──
  if (closed.length > 0) {
    console.log('\n┌─── PERFORMANCE BY EXPERT ─────────────────────────────────────┐')
    console.log(`  ${'Expert'.padEnd(25)} ${'Trades'.padStart(6)} ${'WR'.padStart(6)} ${'PnL'.padStart(12)} ${'Avg'.padStart(8)}`)
    console.log('  ' + '─'.repeat(57))

    const byExpert = groupBy(closed, (t) => t.copiedLabel ?? t.copiedFrom.slice(0, 10))
    const expertEntries = [...byExpert.entries()]
      .sort((a, b) => pnlOf(b[1]) - pnlOf(a[1]))
      .slice(0, 15)

    for (const [expert, trades] of expertEntries) {
      const w = trades.filter((t) => t.status === 'won').length
      const wr = (w / trades.length * 100).toFixed(0)
      const pnl = pnlOf(trades)
      const avg = pnl / trades.length
      const label = expert.length > 25 ? expert.slice(0, 22) + '...' : expert
      console.log(
        `  ${label.padEnd(25)} ${trades.length.toString().padStart(6)} ${(wr + '%').padStart(6)} ${pnlStr(pnl).padStart(12)} ${pnlStr(avg).padStart(8)}`
      )
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── By Side (YES vs NO) ──
  if (closed.length > 0) {
    console.log('\n┌─── YES vs NO ─────────────────────────────────────────────────┐')
    for (const side of ['YES', 'NO']) {
      const trades = closed.filter((t) => t.side === side)
      if (trades.length === 0) continue
      const w = trades.filter((t) => t.status === 'won').length
      const pnl = pnlOf(trades)
      console.log(
        `  ${side.padEnd(5)} | ${trades.length} trades | WR ${(w / trades.length * 100).toFixed(0)}% | PnL ${pnlStr(pnl)}`
      )
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── Entry Price Buckets ──
  if (closed.length > 0) {
    console.log('\n┌─── ENTRY PRICE ANALYSIS ──────────────────────────────────────┐')
    const buckets = [
      { label: '15-30¢ (longshot)', min: 0.15, max: 0.30 },
      { label: '30-50¢ (value)',    min: 0.30, max: 0.50 },
      { label: '50-70¢ (mid)',      min: 0.50, max: 0.70 },
      { label: '70-90¢ (favorite)', min: 0.70, max: 0.90 },
    ]

    for (const b of buckets) {
      const trades = closed.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max)
      if (trades.length === 0) continue
      const w = trades.filter((t) => t.status === 'won').length
      const pnl = pnlOf(trades)
      console.log(
        `  ${b.label.padEnd(22)} | ${trades.length.toString().padStart(3)} trades | WR ${(w / trades.length * 100).toFixed(0).padStart(3)}% | PnL ${pnlStr(pnl)}`
      )
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── Consensus vs Single ──
  if (closed.length > 0) {
    console.log('\n┌─── BET SIZE ANALYSIS (proxy for consensus) ───────────────────┐')
    const small = closed.filter((t) => t.simulatedUsdc <= 100)
    const big = closed.filter((t) => t.simulatedUsdc > 100)

    if (small.length > 0) {
      const pnl = pnlOf(small)
      const w = small.filter((t) => t.status === 'won').length
      console.log(`  Standard ($100)  | ${small.length} trades | WR ${(w / small.length * 100).toFixed(0)}% | PnL ${pnlStr(pnl)}`)
    }
    if (big.length > 0) {
      const pnl = pnlOf(big)
      const w = big.filter((t) => t.status === 'won').length
      console.log(`  Consensus (>$100)| ${big.length} trades | WR ${(w / big.length * 100).toFixed(0)}% | PnL ${pnlStr(pnl)}`)
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── Worst trades ──
  if (closed.length > 0) {
    console.log('\n┌─── TOP 5 WORST TRADES ────────────────────────────────────────┐')
    const worst = [...closed].sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0)).slice(0, 5)
    for (const t of worst) {
      console.log(`  ${pnlStr(t.pnl ?? 0).padStart(10)} | ${t.side} @ ${(t.entryPrice * 100).toFixed(0)}¢ | ${t.title.slice(0, 45)}`)
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── Best trades ──
  if (closed.length > 0) {
    console.log('\n┌─── TOP 5 BEST TRADES ─────────────────────────────────────────┐')
    const best = [...closed].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)).slice(0, 5)
    for (const t of best) {
      console.log(`  ${pnlStr(t.pnl ?? 0).padStart(10)} | ${t.side} @ ${(t.entryPrice * 100).toFixed(0)}¢ | ${t.title.slice(0, 45)}`)
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── Open positions unrealized ──
  if (open.length > 0) {
    console.log('\n┌─── OPEN POSITIONS (top 10 by unrealized PnL) ─────────────────┐')
    const sorted = [...open]
      .map((t) => ({
        ...t,
        unrealized: t.curPrice != null ? t.shares * (t.curPrice - t.entryPrice) : 0,
      }))
      .sort((a, b) => b.unrealized - a.unrealized)
      .slice(0, 10)

    for (const t of sorted) {
      console.log(
        `  ${pnlStr(t.unrealized).padStart(10)} | ${t.side} @ ${(t.entryPrice * 100).toFixed(0)}¢ → ${((t.curPrice ?? 0) * 100).toFixed(0)}¢ | ${t.title.slice(0, 40)}`
      )
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  console.log('')
}

main()
