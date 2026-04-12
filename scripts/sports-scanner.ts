/**
 * Sports Scanner — Signal producer for sports arbitrage
 *
 * Scans Polymarket sports markets, fetches bookmaker consensus odds
 * (via the-odds-api.com), computes edge, and writes scored signals
 * to the unified `signals` table. Does NOT place orders.
 *
 * The live-trader reads signals from the DB and executes them.
 *
 * Extracted from sports-trader.ts (scan + signal generation only).
 *
 * Usage:
 *   node_modules/.bin/tsx scripts/sports-scanner.ts
 *
 * Required env:
 *   ODDS_API_KEY                    # the-odds-api.com API key
 *   DB_PATH=data/live.db
 *   SHARED_DB_PATH=data/polymarket.db
 *
 * Optional env:
 *   POLL_INTERVAL_MS=300000         # 5 min signal generation cycle
 *   SCAN_INTERVAL_MS=3600000        # 1h market rescan on Gamma
 *   MIN_SIGNAL_SCORE_SPORTS=50
 *   MAX_SPORTS=5
 *   ALLOWED_SPORTS=baseball_mlb,icehockey_nhl,basketball_nba,...
 */

import {
  getActiveSportsMarkets,
  positionExistsForCondition,
  insertSignal,
  expireOldSignals,
  logBotEvent,
} from '../src/lib/db'
import { scanSportsMarkets, getActiveSportKeys } from '../src/lib/sports-scanner'
import { getNoVigConsensus, getRequestsRemaining, type NoVigGame } from '../src/lib/odds-api'
import { generateSportsSignals, rankSignals, type SportsSignal } from '../src/lib/sports-signal'

// ── Config ───────────────────────────────────────────────────────

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '300000', 10)  // 5 min
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS ?? '3600000', 10) // 1h
const ODDS_API_KEY = process.env.ODDS_API_KEY ?? ''
const MIN_SIGNAL_SCORE = parseInt(process.env.MIN_SIGNAL_SCORE_SPORTS ?? '50', 10)
const MAX_SPORTS = parseInt(process.env.MAX_SPORTS ?? '10', 10)
const ALLOWED_SPORTS = process.env.ALLOWED_SPORTS?.split(',').filter(Boolean) ?? []

// ── State ────────────────────────────────────────────────────────

let activeSportKeys: string[] = []

// ── Market scan (Gamma API) ─────────────────────────────────────

async function scanMarkets(): Promise<void> {
  const time = new Date().toISOString().slice(11, 19)
  console.log(`\n[${time}] [SPORTS] Scanning Polymarket sports markets...`)

  try {
    const discovered = await scanSportsMarkets()
    let detectedKeys = getActiveSportKeys(discovered)

    if (ALLOWED_SPORTS.length > 0) {
      detectedKeys = detectedKeys.filter((k) => ALLOWED_SPORTS.includes(k))
    }

    activeSportKeys = detectedKeys.slice(0, MAX_SPORTS)

    console.log(`  [SPORTS] Found ${discovered.length} markets | Active leagues: ${activeSportKeys.join(', ') || 'none'}`)
  } catch (err) {
    console.log(`  [SPORTS] Scan error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Emit signal to DB ───────────────────────────────────────────

function emitSportsSignal(signal: SportsSignal): boolean {
  // Skip if already have a position or recent trade
  if (positionExistsForCondition(signal.conditionId)) return false

  insertSignal({
    id: `sig-sports-${signal.conditionId}-${Date.now()}`,
    source: 'sports-arb',
    conditionId: signal.conditionId,
    title: signal.title,
    domain: 'pm-domain/sports',
    side: signal.side,
    entryPrice: signal.polymarketPrice,
    signalScore: signal.signalScore,
    kellyFraction: signal.kellyFraction,
    // No expert fields for sports signals
    expertWallet: null,
    expertLabel: null,
    expertTrustLevel: null,
    consensusCount: null,
    positionSize: null,
    // Sports-specific fields
    sportKey: signal.sport,
    bookmakerProb: signal.bookmakerNoVigProb,
    edge: signal.edge,
    // Token info
    yesTokenId: signal.yesTokenId,
    noTokenId: signal.noTokenId,
    negRisk: signal.negRisk,
    reasons: signal.reasons,
    createdAt: new Date().toISOString(),
  })

  return true
}

// ── Poll loop ────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const time = new Date().toISOString().slice(11, 19)

  if (activeSportKeys.length === 0) {
    console.log(`[${time}] [SPORTS] No active sports — waiting for next scan`)
    return
  }

  console.log(`[${time}] [SPORTS] Polling ${activeSportKeys.length} sports...`)

  // Fetch bookmaker odds
  const allNoVigGames: NoVigGame[] = []
  for (const sportKey of activeSportKeys) {
    try {
      const games = await getNoVigConsensus(sportKey, ODDS_API_KEY)
      allNoVigGames.push(...games)
    } catch (err) {
      console.log(`  [SPORTS] Odds error for ${sportKey}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Get cached Polymarket sports markets
  const sportsMarkets = getActiveSportsMarkets()
  const filteredMarkets = sportsMarkets.filter((m) => m.sportKey && activeSportKeys.includes(m.sportKey))

  // Debug
  const withTeams = filteredMarkets.filter((m) => m.homeTeam && m.awayTeam)
  console.log(`  [SPORTS] Markets: ${filteredMarkets.length} active | ${withTeams.length} with teams | ${allNoVigGames.length} bookmaker games`)

  // Generate signals (compare Polymarket prices vs bookmaker consensus)
  const signals = generateSportsSignals(filteredMarkets, allNoVigGames)
  const ranked = rankSignals(signals)

  // Log top signals
  if (ranked.length > 0) {
    console.log(`  [SPORTS] ${ranked.length} signals | top: ${ranked[0].side} +${(ranked[0].edge * 100).toFixed(1)}pts @ ${(ranked[0].polymarketPrice * 100).toFixed(0)}¢ | ${ranked[0].title.slice(0, 35)}`)
  }

  for (const signal of ranked.slice(0, 5)) {
    console.log(`  [SPORTS] ${signal.side} @ ${(signal.polymarketPrice * 100).toFixed(0)}¢ | edge:+${(signal.edge * 100).toFixed(1)}pts | score:${signal.signalScore} | ${signal.title.slice(0, 45)}`)
  }

  // Emit qualifying signals to DB
  let emitted = 0
  for (const signal of ranked) {
    if (signal.signalScore < MIN_SIGNAL_SCORE) continue

    const success = emitSportsSignal(signal)
    if (success) emitted++
  }

  // Expire old signals
  const expired = expireOldSignals(60)

  const apiRemaining = getRequestsRemaining()
  const apiTag = apiRemaining >= 0 ? ` | API: ${apiRemaining} remaining` : ''
  console.log(`  [SPORTS] → ${allNoVigGames.length} games | ${ranked.length} signals | ${emitted} emitted | ${expired} expired${apiTag}`)
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!ODDS_API_KEY) {
    console.error('[SPORTS] ODDS_API_KEY is required. Get one at https://the-odds-api.com/')
    process.exit(1)
  }

  console.log('═══════════════════════════════════════════════')
  console.log('  [SPORTS-SCANNER] Signal Producer')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Poll:        ${POLL_INTERVAL_MS / 1000}s`)
  console.log(`  Scan:        ${SCAN_INTERVAL_MS / 60000}min`)
  console.log(`  Max sports:  ${MAX_SPORTS}`)
  console.log(`  Sports:      ${ALLOWED_SPORTS.length > 0 ? ALLOWED_SPORTS.join(', ') : 'all'}`)
  console.log(`  Min score:   ${MIN_SIGNAL_SCORE}`)
  console.log('═══════════════════════════════════════════════\n')

  // Initial market scan
  await scanMarkets()

  // First poll
  console.log('Starting first poll...\n')
  await pollOnce()

  // Recurring loops
  setInterval(() => { pollOnce().catch(console.error) }, POLL_INTERVAL_MS)
  setInterval(() => { scanMarkets().catch(console.error) }, SCAN_INTERVAL_MS)
}

main().catch((err) => {
  console.error('[SPORTS] Fatal:', err)
  process.exit(1)
})
