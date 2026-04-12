/**
 * Expert Scanner — Signal producer for the live-trader pipeline
 *
 * Polls watched expert wallets for new positions, scores each signal (0-100),
 * and writes to the unified `signals` table. Does NOT place orders.
 *
 * The live-trader reads signals from the DB and executes them.
 *
 * Extracted from live-trader.ts Phase 1+2 (wallet polling + signal scoring).
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/expert-scanner.ts
 *
 * Required env:
 *   DB_PATH=data/live.db
 *   SHARED_DB_PATH=data/polymarket.db
 *
 * Optional env:
 *   POLL_INTERVAL_MS=60000          # 60s poll cycle
 *   MIN_SIGNAL_SCORE_LIVE=50        # minimum score to emit signal
 *   MIN_ENTRY_PRICE=0.05
 *   MAX_ENTRY_PRICE=0.50
 *   ODDS_API_KEY                    # bookmaker edge bonus (optional)
 */

import {
  getActiveWatchedWallets,
  positionExistsForCondition,
  getPendingOrders,
  getWalletStats,
  updateWalletCopyability,
  insertSignal,
  expireOldSignals,
  logBotEvent,
} from '../src/lib/db'
import { indexWallet } from '../src/lib/indexer'
import { calculateCopyabilityFromStats } from '../src/lib/scorer'
import { pollWallet, type PositionAlert } from '../src/lib/position-tracker'
import { keywordClassify } from '../src/lib/classifier'
import { fetchMarketMetadata } from '../src/lib/polymarket'
import { scoreSignal, kellyBetFraction } from '../src/lib/signal-scorer'
import { evaluateExpertTrust } from '../src/lib/expert-trust'
import { getNoVigConsensus } from '../src/lib/odds-api'
import { detectSportKey, parseMarketTitle } from '../src/lib/sports-scanner'
import { findGameMatch } from '../src/lib/team-matcher'

// ── Config ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '60000', 10)
const MIN_SIGNAL_SCORE = parseInt(process.env.MIN_SIGNAL_SCORE_LIVE ?? '50', 10)
const MIN_ENTRY = parseFloat(process.env.MIN_ENTRY_PRICE ?? '0.05')
const MAX_ENTRY = parseFloat(process.env.MAX_ENTRY_PRICE ?? '0.50')
const ODDS_API_KEY = process.env.ODDS_API_KEY ?? ''

// ── Consensus tracking ───────────────────────────────────────────
// Tracks how many experts enter the same market/side in the same poll cycle.
// More experts = signal is "late" / crowded → lower value for the buyer.

type ConsensusEntry = {
  conditionId: string
  title: string
  side: string
  price: number
  experts: Array<{ wallet: string; label: string | null; size: number }>
}

const consensusMap = new Map<string, ConsensusEntry>()

function trackConsensus(alert: PositionAlert): void {
  if (alert.type !== 'NEW_POSITION') return
  const key = alert.position.conditionId
  const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
  const existing = consensusMap.get(key)
  if (existing) {
    if (existing.side === side) {
      existing.experts.push({ wallet: alert.wallet, label: alert.walletLabel, size: alert.position.size })
    }
  } else {
    consensusMap.set(key, {
      conditionId: key, title: alert.position.title, side, price: alert.position.curPrice,
      experts: [{ wallet: alert.wallet, label: alert.walletLabel, size: alert.position.size }],
    })
  }
}

function getConsensusCount(conditionId: string): number {
  return consensusMap.get(conditionId)?.experts.length ?? 1
}

// ── Signal eligibility check ─────────────────────────────────────

function shouldEmitSignal(alert: PositionAlert): boolean {
  if (alert.type !== 'NEW_POSITION') return false

  const price = alert.position.curPrice
  if (price < MIN_ENTRY || price > MAX_ENTRY) {
    console.log(`  [SCANNER] SKIP price ${(price * 100).toFixed(0)}¢ out of ${(MIN_ENTRY * 100).toFixed(0)}-${(MAX_ENTRY * 100).toFixed(0)}¢ | ${alert.position.title.slice(0, 40)}`)
    return false
  }

  // Already have an open position or recent trade for this market
  if (positionExistsForCondition(alert.position.conditionId)) return false

  // Already have a pending buy order for this market
  const pendingOrders = getPendingOrders()
  if (pendingOrders.some(po => po.conditionId === alert.position.conditionId)) return false

  return true
}

// ── Bookmaker odds lookup (bonus points, never blocks) ───────────

async function getBookmakerEdgeBonus(
  title: string,
  curPrice: number,
  outcomeIndex: number
): Promise<{ bonus: number; noVigProb: number | null }> {
  if (!ODDS_API_KEY) return { bonus: 0, noVigProb: null }

  const titleClass = keywordClassify(title)
  if (titleClass?.domain !== 'pm-domain/sports') return { bonus: 0, noVigProb: null }

  const sportKey = detectSportKey(title)
  if (!sportKey) return { bonus: 0, noVigProb: null }

  try {
    const parsed = parseMarketTitle(title)
    const noVigGames = await getNoVigConsensus(sportKey, ODDS_API_KEY)
    const matched = findGameMatch(parsed.homeTeam, parsed.awayTeam, noVigGames)
    if (!matched) return { bonus: 0, noVigProb: null }

    const oddsKey = parsed.marketType === 'total' ? 'totals'
      : parsed.marketType === 'spread' ? 'spreads' : 'h2h'
    const oddsMarket = matched.markets.find((m) => m.type === oddsKey)
    if (!oddsMarket || oddsMarket.outcomes.length < 2) return { bonus: 0, noVigProb: null }

    const side = outcomeIndex === 0 ? 'YES' : 'NO'
    const lastWord = matched.matchInfo.awayTeam.toLowerCase().split(' ').pop() ?? ''
    const awayOutcome = oddsMarket.outcomes.find((o) => o.name.toLowerCase().includes(lastWord))
    if (!awayOutcome) return { bonus: 0, noVigProb: null }

    const yesProb = awayOutcome.noVigProb
    const prob = side === 'YES' ? yesProb : 1 - yesProb
    const polyPrice = side === 'YES' ? curPrice : 1 - curPrice
    const edge = prob - polyPrice

    const bonus = edge >= 0.15 ? 25
      : edge >= 0.10 ? 18
      : edge >= 0.07 ? 12
      : edge >= 0.04 ? 6
      : 0

    return { bonus, noVigProb: prob }
  } catch {
    return { bonus: 0, noVigProb: null }
  }
}

// ── Score and emit signal ────────────────────────────────────────

async function scoreAndEmitSignal(alert: PositionAlert): Promise<boolean> {
  // Check expert trust
  const trust = evaluateExpertTrust(alert.wallet, alert.walletLabel)
  if (trust.status === 'paused') {
    console.log(`  [SCANNER] PAUSED ${alert.walletLabel ?? alert.wallet.slice(0, 10)} | ${trust.reason}`)
    return false
  }

  // Bookmaker edge bonus (optional, non-blocking)
  const { bonus: bookmakerEdgeBonus, noVigProb: bookmakerNoVigProb } =
    await getBookmakerEdgeBonus(alert.position.title, alert.position.curPrice, alert.position.outcomeIndex)

  // Score signal
  const signal = scoreSignal({
    expertWallet: alert.wallet,
    marketTitle: alert.position.title,
    entryPrice: alert.position.curPrice,
    positionSize: alert.position.size,
    bookmakerEdgeBonus,
    bookmakerNoVigProb: bookmakerNoVigProb ?? undefined,
  })

  if (signal.score < MIN_SIGNAL_SCORE) {
    if (signal.score > 0) {
      const oddsTag = bookmakerEdgeBonus > 0 ? ` | book:+${bookmakerEdgeBonus}pts` : ''
      console.log(`  [SCANNER] LOW (${signal.score}/${MIN_SIGNAL_SCORE}) | ${signal.reasons[0]}${oddsTag} | ${alert.position.title.slice(0, 50)}`)
    }
    return false
  }

  // Fetch market metadata for token IDs
  const metadata = await fetchMarketMetadata(alert.position.conditionId)
  if (!metadata || !metadata.active) {
    console.log(`  [SCANNER] NO METADATA or CLOSED | ${alert.position.title.slice(0, 45)}`)
    return false
  }

  const domain = keywordClassify(alert.position.title)
  const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
  const kelly = kellyBetFraction(trust.winRate, alert.position.curPrice)

  // Write signal to DB
  insertSignal({
    id: `sig-expert-${alert.position.conditionId}-${Date.now()}`,
    source: 'expert-copy',
    conditionId: alert.position.conditionId,
    title: alert.position.title,
    domain: domain?.domain ?? null,
    side,
    entryPrice: alert.position.curPrice,
    signalScore: signal.score,
    kellyFraction: kelly,
    expertWallet: alert.wallet,
    expertLabel: alert.walletLabel,
    expertTrustLevel: trust.trustLevel,
    consensusCount: getConsensusCount(alert.position.conditionId),
    positionSize: alert.position.size,
    sportKey: null,
    bookmakerProb: bookmakerNoVigProb,
    edge: null,
    yesTokenId: metadata.yesTokenId,
    noTokenId: metadata.noTokenId,
    negRisk: metadata.negRisk,
    reasons: signal.reasons,
    createdAt: new Date().toISOString(),
  })

  const scoreTag = signal.score >= 80 ? '++' : signal.score >= 60 ? '+' : ''
  const trustTag = trust.status === 'reduced' ? ' (reduced)' : ''
  const oddsTag = bookmakerEdgeBonus > 0 ? ` | book:+${bookmakerEdgeBonus}pts` : ''
  const domainTag = domain ? `[${domain.domain.replace('pm-domain/', '')}]` : ''

  console.log(`  [SCANNER] SIGNAL ${scoreTag}${signal.score}/100 | ${side} @ ${(alert.position.curPrice * 100).toFixed(0)}¢ | ${alert.walletLabel ?? alert.wallet.slice(0, 10)}${trustTag}${oddsTag} | ${alert.position.title.slice(0, 45)} ${domainTag}`)
  logBotEvent('signal-emitted', `${side} @ ${(alert.position.curPrice * 100).toFixed(0)}¢ score:${signal.score} | ${alert.position.title}`, `expert:${alert.walletLabel ?? alert.wallet.slice(0, 10)}`)

  return true
}

// ── 24h wallet re-index ──────────────────────────────────────────

async function reindexAllWallets(): Promise<void> {
  const wallets = getActiveWatchedWallets()
  const time = new Date().toISOString().slice(11, 19)
  console.log(`\n[${time}] [SCANNER] DAILY RE-INDEX — ${wallets.length} wallets`)

  let indexed = 0
  let errors = 0

  for (const { wallet, label } of wallets) {
    try {
      const result = await indexWallet(wallet)
      indexed += result.tradesIndexed
      if (result.errors.length > 0) errors++

      const stats = getWalletStats(wallet)
      const newScore = calculateCopyabilityFromStats(stats)
      if (newScore > 0) updateWalletCopyability(wallet, newScore)

      if (result.tradesIndexed > 0) {
        console.log(`  [SCANNER] ${(label ?? wallet.slice(0, 12)).padEnd(24)} +${result.tradesIndexed} trades (copy:${(newScore * 100).toFixed(0)}%)`)
      }
    } catch {
      errors++
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  console.log(`  [SCANNER] Re-index done: +${indexed} trades, ${errors} errors`)
  logBotEvent('scanner-reindex', `+${indexed} trades, ${errors} errors`, `${wallets.length} wallets`)
}

// ── Poll loop ────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const wallets = getActiveWatchedWallets()
  const time = new Date().toISOString().slice(11, 19)

  console.log(`[${time}] [SCANNER] Polling ${wallets.length} expert wallets...`)

  // ── Phase 1: Collect new positions & build consensus ──
  consensusMap.clear()
  const allNewAlerts: PositionAlert[] = []
  const copyScoreMap = new Map<string, number>()
  for (const w of wallets) {
    if (w.copyabilityScore != null) copyScoreMap.set(w.wallet, w.copyabilityScore)
  }

  for (const { wallet, label } of wallets) {
    try {
      const alerts = await pollWallet(wallet, label)
      for (const alert of alerts) {
        if (alert.type === 'NEW_POSITION') {
          trackConsensus(alert)
          allNewAlerts.push(alert)
        }
      }
    } catch {
      // Skip failed wallet
    }
    await new Promise((r) => setTimeout(r, 800))
  }

  // Log new positions
  for (const alert of allNewAlerts) {
    const side = alert.position.outcomeIndex === 0 ? 'YES' : 'NO'
    const consensus = consensusMap.get(alert.position.conditionId)
    const expertCount = consensus?.experts.length ?? 1
    const consensusTag = expertCount > 1 ? ` [${expertCount} experts]` : ''
    const copyScore = copyScoreMap.get(alert.wallet)
    const copyTag = copyScore != null ? ` (copy:${(copyScore * 100).toFixed(0)}%)` : ''
    console.log(`  [SCANNER] NEW | ${alert.walletLabel ?? alert.wallet.slice(0, 10)}${copyTag} | ${side} @ ${(alert.position.curPrice * 100).toFixed(0)}¢${consensusTag} | ${alert.position.title}`)
  }

  // Log consensus
  for (const [, entry] of consensusMap) {
    if (entry.experts.length >= 2) {
      const names = entry.experts.map((e) => e.label?.split(' ')[0] ?? e.wallet.slice(0, 8)).join(', ')
      console.log(`  [SCANNER] CONSENSUS ${entry.experts.length}x | ${entry.side} @ ${(entry.price * 100).toFixed(0)}¢ | ${entry.title} | by: ${names}`)
    }
  }

  // ── Phase 2: Score eligible alerts and write signals ──
  let emitted = 0
  const emittedConditions = new Set<string>()

  for (const alert of allNewAlerts) {
    if (emittedConditions.has(alert.position.conditionId)) continue
    if (!shouldEmitSignal(alert)) continue

    const success = await scoreAndEmitSignal(alert)
    if (success) {
      emitted++
      emittedConditions.add(alert.position.conditionId)
    }
  }

  // Expire old signals (older than 60 minutes)
  const expired = expireOldSignals(60)

  console.log(`  [SCANNER] → ${allNewAlerts.length} new positions | ${emitted} signals emitted | ${expired} expired`)
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wallets = getActiveWatchedWallets()
  if (wallets.length === 0) {
    console.error('[SCANNER] No watched wallets. Run bulk-index first.')
    process.exit(1)
  }

  console.log('═══════════════════════════════════════════════')
  console.log('  [EXPERT-SCANNER] Signal Producer')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Wallets:     ${wallets.length}`)
  console.log(`  Poll:        ${POLL_INTERVAL_MS / 1000}s`)
  console.log(`  Min score:   ${MIN_SIGNAL_SCORE}/100`)
  console.log(`  Entry range: ${(MIN_ENTRY * 100).toFixed(0)}¢ - ${(MAX_ENTRY * 100).toFixed(0)}¢`)
  console.log(`  Odds API:    ${ODDS_API_KEY ? 'ON' : 'OFF'}`)
  console.log('═══════════════════════════════════════════════\n')

  // First poll
  console.log('Starting first poll...\n')
  await pollOnce()

  // Poll loop
  setInterval(() => {
    pollOnce().catch((err) => {
      console.error(`[SCANNER] Poll error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, POLL_INTERVAL_MS)

  // Re-index every 24h
  const REINDEX_INTERVAL_MS = 24 * 60 * 60 * 1000
  setInterval(() => {
    reindexAllWallets().catch((err) => {
      console.error(`[SCANNER] Re-index error: ${err instanceof Error ? err.message : String(err)}`)
    })
  }, REINDEX_INTERVAL_MS)
}

main().catch((err) => {
  console.error('[SCANNER] Fatal:', err)
  process.exit(1)
})
