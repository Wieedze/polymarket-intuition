/**
 * Paper Trading Analytics Report
 * Run: node_modules/.bin/tsx scripts/analytics.ts
 *
 * Includes:
 *   - Bias audit (open trades excluded from WR)
 *   - Profit Factor + Max Consecutive Losses
 *   - Wilson confidence interval on Win Rate
 *   - Daily equity curve
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
  // AUDIT: only closed trades — never open — to avoid bias
  const closed = trades.filter((t) => t.status !== 'open')
  if (closed.length === 0) return 0
  return closed.filter((t) => t.status === 'won').length / closed.length
}

function pnlStr(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`
}

// ── Statistical metrics ──────────────────────────────────────────

/**
 * Profit Factor = gross wins / gross losses
 * > 1.0 = profitable | > 1.3 = good | > 2.0 = excellent
 */
function profitFactor(trades: PaperTrade[]): number {
  let wins = 0
  let losses = 0
  for (const t of trades) {
    if ((t.pnl ?? 0) > 0) wins += t.pnl ?? 0
    else losses += Math.abs(t.pnl ?? 0)
  }
  if (losses === 0) return wins > 0 ? Infinity : 0
  return wins / losses
}

/**
 * Max consecutive losses — key drawdown metric
 */
function maxConsecutiveLosses(trades: PaperTrade[]): number {
  // Sort by resolution date for accurate streak tracking
  const sorted = [...trades].sort((a, b) =>
    (a.resolvedAt ?? a.openedAt).localeCompare(b.resolvedAt ?? b.openedAt)
  )
  let max = 0
  let current = 0
  for (const t of sorted) {
    if (t.status === 'lost') {
      current++
      if (current > max) max = current
    } else {
      current = 0
    }
  }
  return max
}

/**
 * Wilson confidence interval for win rate (95% confidence)
 * Returns [low, high] — the real WR is likely in this range
 * Formula: accounts for small sample sizes unlike naive ± margin
 */
function wilsonCI(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 0]
  const z = 1.96  // 95% confidence
  const p = wins / n
  const center = (p + z * z / (2 * n)) / (1 + z * z / n)
  const margin = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

/**
 * Statistical significance flag
 * < 30 trades = not significant | 30-100 = low | 100-200 = medium | > 200 = high
 */
function significanceLabel(n: number): string {
  if (n < 30) return '⚠️  NOT SIGNIFICANT (<30 trades)'
  if (n < 100) return '🟡 LOW (30-100 trades)'
  if (n < 200) return '🟠 MEDIUM (100-200 trades)'
  return '🟢 HIGH (200+ trades)'
}

/**
 * Average PnL per trade (realized only)
 */
function avgPnlPerTrade(trades: PaperTrade[]): number {
  if (trades.length === 0) return 0
  return pnlOf(trades) / trades.length
}

/**
 * Daily equity curve — maps each day to cumulative realized PnL
 */
function buildEquityCurve(
  closed: PaperTrade[],
  startBal: number
): Array<{ day: string; balance: number; dailyPnl: number; trades: number }> {
  // Group by resolution date
  const byDay = new Map<string, PaperTrade[]>()
  for (const t of closed) {
    const day = (t.resolvedAt ?? t.openedAt).slice(0, 10)
    const existing = byDay.get(day) ?? []
    existing.push(t)
    byDay.set(day, existing)
  }

  const days = [...byDay.keys()].sort()
  let cumulative = startBal

  return days.map((day) => {
    const trades = byDay.get(day)!
    const dailyPnl = pnlOf(trades)
    cumulative += dailyPnl
    return { day, balance: cumulative, dailyPnl, trades: trades.length }
  })
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

  // ── AUDIT: biais check ────────────────────────────────────────
  // Le WR est calculé UNIQUEMENT sur les trades résolus (won/lost)
  // Les trades open sont exclus — sinon le WR serait biaisé positivement
  // (les trades ouverts gagnants comptent mais pas encore perdants)
  const wrBias = open.length > 0
    ? `⚠️  ${open.length} trades open exclus du WR (correct)`
    : '✅ Aucun biais détecté'

  // ── Statistical metrics ───────────────────────────────────────
  const pf = profitFactor(closed)
  const mcl = maxConsecutiveLosses(closed)
  const avgPnl = avgPnlPerTrade(closed)
  const [wrLow, wrHigh] = wilsonCI(won.length, closed.length)
  const sig = significanceLabel(closed.length)

  // Validation gates — seuils avant passage en réel
  const pfOk = pf >= 1.3
  const mclOk = mcl <= 15
  const avgPnlOk = avgPnl >= 5
  const sigOk = closed.length >= 200
  const allGatesOk = pfOk && mclOk && avgPnlOk && sigOk

  console.log('\n╔═══════════════════════════════════════════════════════════════╗')
  console.log('║              PAPER TRADING ANALYTICS REPORT                  ║')
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log(`║  Balance:     $${balance.toFixed(2).padStart(10)}  (started: $${startBal.toFixed(0)})`)
  console.log(`║  Realized:    ${pnlStr(realizedPnl).padStart(11)}`)
  console.log(`║  Unrealized:  ${pnlStr(unrealizedPnl).padStart(11)}`)
  console.log(`║  ROI:         ${((realizedPnl / startBal) * 100).toFixed(2).padStart(10)}%`)
  console.log(`║  Win Rate:    ${closed.length > 0 ? `${(wrOf(closed) * 100).toFixed(0)}%` : '—'.padStart(10)}  (${won.length}W / ${lost.length}L)`)
  console.log(`║  Open:        ${open.length.toString().padStart(10)}  (excluded from WR)`)
  console.log(`║  Total:       ${all.length.toString().padStart(10)}`)
  console.log('╚═══════════════════════════════════════════════════════════════╝')

  // ── AUDIT BIAIS ──────────────────────────────────────────────
  console.log('\n┌─── AUDIT BIAIS ───────────────────────────────────────────────┐')
  console.log(`  ${wrBias}`)
  console.log(`  WR affiché = ${(wrOf(closed) * 100).toFixed(1)}% calculé sur ${closed.length} trades résolus uniquement`)
  if (open.length > 0) {
    const openUnrealized = open.reduce((s, t) => {
      if (t.curPrice == null) return s
      return s + t.shares * (t.curPrice - t.entryPrice)
    }, 0)
    const openWinning = open.filter((t) => t.curPrice != null && t.curPrice > t.entryPrice).length
    console.log(`  Trades open: ${openWinning} en positif / ${open.length - openWinning} en négatif (non résolus)`)
    console.log(`  Si tous résolus maintenant: ${pnlStr(openUnrealized)} unrealized`)
  }
  console.log('└───────────────────────────────────────────────────────────────┘')

  // ── VALIDATION GATES ─────────────────────────────────────────
  console.log('\n┌─── VALIDATION GATES (avant passage en réel) ──────────────────┐')
  console.log(`  ${pfOk ? '✅' : '❌'} Profit Factor:         ${pf === Infinity ? '∞' : pf.toFixed(2).padStart(6)} (seuil: > 1.30)`)
  console.log(`  ${mclOk ? '✅' : '❌'} Max pertes consécutives: ${mcl.toString().padStart(4)} (seuil: ≤ 15)`)
  console.log(`  ${avgPnlOk ? '✅' : '❌'} PnL moyen/trade:       ${pnlStr(avgPnl).padStart(7)} (seuil: > +$5.00)`)
  console.log(`  ${sigOk ? '✅' : '❌'} Trades résolus:         ${closed.length.toString().padStart(4)} (seuil: ≥ 200)`)
  console.log(`  ${allGatesOk ? '🟢 PRÊT POUR LE RÉEL' : '🔴 PAS ENCORE PRÊT — attendre plus de données'}`)
  console.log('└───────────────────────────────────────────────────────────────┘')

  // ── STATISTIQUES AVANCÉES ────────────────────────────────────
  if (closed.length > 0) {
    console.log('\n┌─── STATISTIQUES AVANCÉES ─────────────────────────────────────┐')
    console.log(`  Significativité:  ${sig}`)
    console.log(`  WR intervalle:    [${(wrLow * 100).toFixed(1)}% — ${(wrHigh * 100).toFixed(1)}%] à 95% de confiance`)
    console.log(`  Profit Factor:    ${pf === Infinity ? '∞ (aucune perte)' : pf.toFixed(3)}`)
    console.log(`  Max pertes consécutives: ${mcl}`)
    console.log(`  PnL moyen/trade:  ${pnlStr(avgPnl)}`)

    // PnL distribution
    const pnls = closed.map((t) => t.pnl ?? 0).sort((a, b) => a - b)
    const median = pnls[Math.floor(pnls.length / 2)] ?? 0
    const grossWins = closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0)
    const grossLosses = closed.filter((t) => (t.pnl ?? 0) < 0).reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0)
    console.log(`  PnL médian/trade: ${pnlStr(median)}`)
    console.log(`  Gross wins:       +${grossWins.toFixed(2)}`)
    console.log(`  Gross losses:     -${grossLosses.toFixed(2)}`)
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── COURBE D'ÉQUITÉ ──────────────────────────────────────────
  if (closed.length > 0) {
    const curve = buildEquityCurve(closed, startBal)
    console.log('\n┌─── COURBE D\'ÉQUITÉ (par jour) ────────────────────────────────┐')
    console.log(`  ${'Jour'.padEnd(12)} ${'Balance'.padStart(12)} ${'PnL jour'.padStart(10)} ${'Trades'.padStart(7)}`)
    console.log('  ' + '─'.repeat(43))

    // Bar chart ASCII inline
    const maxAbs = Math.max(...curve.map((d) => Math.abs(d.dailyPnl)), 1)
    for (const d of curve) {
      const barLen = Math.round(Math.abs(d.dailyPnl) / maxAbs * 20)
      const bar = d.dailyPnl >= 0
        ? ('█'.repeat(barLen)).padEnd(20)
        : ('░'.repeat(barLen)).padEnd(20)
      const sign = d.dailyPnl >= 0 ? '+' : ''
      console.log(
        `  ${d.day.padEnd(12)} $${d.balance.toFixed(0).padStart(10)} ${(sign + d.dailyPnl.toFixed(0)).padStart(9)} ${d.trades.toString().padStart(6)}t  ${bar}`
      )
    }

    // Max drawdown
    let peak = startBal
    let maxDrawdown = 0
    for (const d of curve) {
      if (d.balance > peak) peak = d.balance
      const drawdown = (peak - d.balance) / peak
      if (drawdown > maxDrawdown) maxDrawdown = drawdown
    }
    console.log('  ' + '─'.repeat(43))
    console.log(`  Max drawdown: -${(maxDrawdown * 100).toFixed(1)}%`)
    if (curve.length > 1) {
      const bestDay = curve.reduce((best, d) => d.dailyPnl > best.dailyPnl ? d : best)
      const worstDay = curve.reduce((worst, d) => d.dailyPnl < worst.dailyPnl ? d : worst)
      console.log(`  Meilleur jour: ${bestDay.day} (${pnlStr(bestDay.dailyPnl)})`)
      console.log(`  Pire jour:     ${worstDay.day} (${pnlStr(worstDay.dailyPnl)})`)
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── By Domain ────────────────────────────────────────────────
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
      const pf2 = profitFactor(trades)
      console.log(
        `  ${label.padEnd(22)} ${trades.length.toString().padStart(6)} ${w.toString().padStart(5)} ${(wr + '%').padStart(6)} ${pnlStr(pnl).padStart(12)} ${pnlStr(avg).padStart(8)}  PF:${pf2 === Infinity ? '∞' : pf2.toFixed(1)}`
      )
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── By Expert ────────────────────────────────────────────────
  if (closed.length > 0) {
    console.log('\n┌─── PERFORMANCE BY EXPERT ─────────────────────────────────────┐')
    console.log(`  ${'Expert'.padEnd(25)} ${'Trades'.padStart(6)} ${'WR'.padStart(6)} ${'PnL'.padStart(12)} ${'Avg'.padStart(8)} ${'MCL'.padStart(5)}`)
    console.log('  ' + '─'.repeat(62))

    const byExpert = groupBy(closed, (t) => t.copiedLabel ?? t.copiedFrom.slice(0, 10))
    const expertEntries = [...byExpert.entries()]
      .sort((a, b) => pnlOf(b[1]) - pnlOf(a[1]))
      .slice(0, 15)

    for (const [expert, trades] of expertEntries) {
      const w = trades.filter((t) => t.status === 'won').length
      const wr = (w / trades.length * 100).toFixed(0)
      const pnl = pnlOf(trades)
      const avg = pnl / trades.length
      const mcl2 = maxConsecutiveLosses(trades)
      const label = expert.length > 25 ? expert.slice(0, 22) + '...' : expert
      console.log(
        `  ${label.padEnd(25)} ${trades.length.toString().padStart(6)} ${(wr + '%').padStart(6)} ${pnlStr(pnl).padStart(12)} ${pnlStr(avg).padStart(8)} ${mcl2.toString().padStart(5)}`
      )
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── YES vs NO ────────────────────────────────────────────────
  if (closed.length > 0) {
    console.log('\n┌─── YES vs NO ─────────────────────────────────────────────────┐')
    for (const side of ['YES', 'NO']) {
      const trades = closed.filter((t) => t.side === side)
      if (trades.length === 0) continue
      const w = trades.filter((t) => t.status === 'won').length
      const pnl = pnlOf(trades)
      const pf2 = profitFactor(trades)
      console.log(
        `  ${side.padEnd(5)} | ${trades.length} trades | WR ${(w / trades.length * 100).toFixed(0)}% | PnL ${pnlStr(pnl)} | PF ${pf2 === Infinity ? '∞' : pf2.toFixed(2)}`
      )
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── Entry Price Buckets ──────────────────────────────────────
  if (closed.length > 0) {
    console.log('\n┌─── ENTRY PRICE ANALYSIS ──────────────────────────────────────┐')
    const buckets = [
      { label: '15-30¢ (longshot)', min: 0.15, max: 0.30 },
      { label: '30-55¢ (value)',    min: 0.30, max: 0.55 },
      { label: '55-65¢ (border)',   min: 0.55, max: 0.65 },
      { label: '65-90¢ (bloqué)',   min: 0.65, max: 0.90 },
    ]

    for (const b of buckets) {
      const trades = closed.filter((t) => t.entryPrice >= b.min && t.entryPrice < b.max)
      if (trades.length === 0) continue
      const w = trades.filter((t) => t.status === 'won').length
      const pnl = pnlOf(trades)
      const pf2 = profitFactor(trades)
      const [lo, hi] = wilsonCI(w, trades.length)
      console.log(
        `  ${b.label.padEnd(22)} | ${trades.length.toString().padStart(3)} trades | WR ${(w / trades.length * 100).toFixed(0).padStart(3)}% [${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}%] | PnL ${pnlStr(pnl)} | PF ${pf2 === Infinity ? '∞' : pf2.toFixed(1)}`
      )
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── Worst / Best trades ──────────────────────────────────────
  if (closed.length > 0) {
    console.log('\n┌─── TOP 5 WORST TRADES ────────────────────────────────────────┐')
    const worst = [...closed].sort((a, b) => (a.pnl ?? 0) - (b.pnl ?? 0)).slice(0, 5)
    for (const t of worst) {
      console.log(`  ${pnlStr(t.pnl ?? 0).padStart(10)} | ${t.side} @ ${(t.entryPrice * 100).toFixed(0)}¢ | ${t.title.slice(0, 45)}`)
    }
    console.log('└───────────────────────────────────────────────────────────────┘')

    console.log('\n┌─── TOP 5 BEST TRADES ─────────────────────────────────────────┐')
    const best = [...closed].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0)).slice(0, 5)
    for (const t of best) {
      console.log(`  ${pnlStr(t.pnl ?? 0).padStart(10)} | ${t.side} @ ${(t.entryPrice * 100).toFixed(0)}¢ | ${t.title.slice(0, 45)}`)
    }
    console.log('└───────────────────────────────────────────────────────────────┘')
  }

  // ── Open positions ───────────────────────────────────────────
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
