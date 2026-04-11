// ── Sports signal generation: Polymarket vs bookmaker consensus ──

import { kellyBetFraction } from './signal-scorer'
import { findGameMatch } from './team-matcher'
import type { SportsMarketRow } from './db'
import type { NoVigGame } from './odds-api'

// ── Config ───────────────────────────────────────────────────────

const MIN_EDGE = 0.04          // 4 points minimum edge to consider
const MIN_KELLY = 0.005        // minimum Kelly fraction (0.5%)
const SPORTS_DOMAIN_BOOST = 10 // always-on boost for sports (bookmaker odds are reliable)

// ── Types ─────────────────────────────────────────────────────────

export type SportsSignal = {
  conditionId: string
  title: string
  side: 'YES' | 'NO'
  yesTokenId: string
  noTokenId: string
  negRisk: boolean
  polymarketPrice: number       // current YES price on Polymarket (0-1)
  bookmakerNoVigProb: number    // consensus no-vig prob for the YES outcome (0-1)
  edge: number                  // positive = we have edge (buy this side)
  kellyFraction: number
  signalScore: number           // 0-100
  sport: string
  marketType: string
  reasons: string[]
}

// ── Score calculation ────────────────────────────────────────────

export function calculateSportsSignalScore(
  edge: number,
  kellyFraction: number,
  liquidity: number | null
): number {
  // Edge component (40 pts max)
  const edgePts = edge >= 0.15 ? 40
    : edge >= 0.10 ? 30
    : edge >= 0.07 ? 20
    : edge >= 0.04 ? 10
    : 0

  // Kelly component (30 pts max)
  const kellyPts = kellyFraction >= 0.15 ? 30
    : kellyFraction >= 0.10 ? 20
    : kellyFraction >= 0.05 ? 10
    : kellyFraction >= 0.005 ? 5
    : 0

  // Liquidity component (20 pts max)
  const liq = liquidity ?? 0
  const liqPts = liq >= 5000 ? 20
    : liq >= 2000 ? 15
    : liq >= 1000 ? 10
    : liq >= 500 ? 5
    : 0

  return Math.min(edgePts + kellyPts + liqPts + SPORTS_DOMAIN_BOOST, 100)
}

// ── Signal generation ────────────────────────────────────────────

export function generateSportsSignals(
  markets: SportsMarketRow[],
  noVigGames: NoVigGame[]
): SportsSignal[] {
  const signals: SportsSignal[] = []

  for (const market of markets) {
    if (!market.polymarketPrice || !market.yesTokenId || !market.noTokenId) continue
    if (!market.homeTeam || !market.awayTeam) continue

    // Find matching game in bookmaker data
    const matched = findGameMatch(
      market.homeTeam,
      market.awayTeam,
      noVigGames
    )
    if (!matched) continue

    // Find the right market type
    const oddsMarketKey = market.marketType === 'moneyline' ? 'h2h'
      : market.marketType === 'spread' ? 'spreads'
      : market.marketType === 'total' ? 'totals'
      : null
    if (!oddsMarketKey) continue

    const oddsMarket = matched.markets.find((m) => m.type === oddsMarketKey)
    if (!oddsMarket || oddsMarket.outcomes.length < 2) continue

    // For moneyline: find the home team outcome (= YES on Polymarket for "Away vs Home")
    // Polymarket convention: title = "Away vs. Home", YES = first team (away) wins
    // the-odds-api: home_team = home, away_team = away
    // We need to map which Polymarket side corresponds to which bookmaker outcome

    let yesProb: number | null = null

    if (oddsMarketKey === 'h2h') {
      // The YES token on Polymarket = the first team listed (typically away)
      // Match the Polymarket away team to the odds API outcome
      const awayOutcome = oddsMarket.outcomes.find((o) =>
        o.name.toLowerCase().includes(matched.matchInfo.awayTeam.toLowerCase().split(' ').pop() ?? '')
      )
      if (awayOutcome) {
        // Polymarket YES = away team wins = awayOutcome.noVigProb
        yesProb = awayOutcome.noVigProb
      } else {
        // Fallback: first outcome = home, second = away
        // Polymarket YES = first listed team (away in "Away vs Home")
        // odds-api home_team outcome is typically first
        const homeOutcome = oddsMarket.outcomes.find((o) =>
          o.name.toLowerCase().includes(matched.matchInfo.homeTeam.toLowerCase().split(' ').pop() ?? '')
        )
        if (homeOutcome) {
          yesProb = 1 - homeOutcome.noVigProb
        }
      }
    } else if (oddsMarketKey === 'totals') {
      // O/U: YES = Over on Polymarket
      const overOutcome = oddsMarket.outcomes.find((o) => o.name === 'Over')
      if (overOutcome) {
        // Check line matches
        if (market.lineValue != null && overOutcome.point != null && market.lineValue !== overOutcome.point) {
          continue // different line, skip
        }
        yesProb = overOutcome.noVigProb
      }
    } else if (oddsMarketKey === 'spreads') {
      // Spread: YES = the team covers
      // Need to match the spread line too
      const teamOutcome = oddsMarket.outcomes[0] // first outcome
      if (teamOutcome && market.lineValue != null && teamOutcome.point != null) {
        if (Math.abs(market.lineValue - teamOutcome.point) > 0.5) continue // different line
        yesProb = teamOutcome.noVigProb
      }
    }

    if (yesProb == null || yesProb <= 0 || yesProb >= 1) continue

    const polyPrice = market.polymarketPrice

    // Check YES edge: bookmaker says higher prob than Polymarket price
    const yesEdge = yesProb - polyPrice
    if (yesEdge >= MIN_EDGE) {
      const kelly = kellyBetFraction(yesProb, polyPrice)
      if (kelly >= MIN_KELLY) {
        const score = calculateSportsSignalScore(yesEdge, kelly, null)
        signals.push({
          conditionId: market.conditionId,
          title: market.title,
          side: 'YES',
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          negRisk: true,
          polymarketPrice: polyPrice,
          bookmakerNoVigProb: yesProb,
          edge: yesEdge,
          kellyFraction: kelly,
          signalScore: score,
          sport: market.sportKey ?? 'unknown',
          marketType: market.marketType ?? 'unknown',
          reasons: [
            `Edge: +${(yesEdge * 100).toFixed(1)}pts`,
            `Book: ${(yesProb * 100).toFixed(0)}% vs Poly: ${(polyPrice * 100).toFixed(0)}%`,
            `Kelly: ${(kelly * 100).toFixed(1)}%`,
          ],
        })
      }
    }

    // Check NO edge: bookmaker says lower prob than Polymarket price
    const noProb = 1 - yesProb
    const noPolyPrice = 1 - polyPrice
    const noEdge = noProb - noPolyPrice
    if (noEdge >= MIN_EDGE) {
      const kelly = kellyBetFraction(noProb, noPolyPrice)
      if (kelly >= MIN_KELLY) {
        const score = calculateSportsSignalScore(noEdge, kelly, null)
        signals.push({
          conditionId: market.conditionId,
          title: market.title,
          side: 'NO',
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          negRisk: true,
          polymarketPrice: noPolyPrice,
          bookmakerNoVigProb: noProb,
          edge: noEdge,
          kellyFraction: kelly,
          signalScore: score,
          sport: market.sportKey ?? 'unknown',
          marketType: market.marketType ?? 'unknown',
          reasons: [
            `Edge: +${(noEdge * 100).toFixed(1)}pts (NO side)`,
            `Book NO: ${(noProb * 100).toFixed(0)}% vs Poly NO: ${(noPolyPrice * 100).toFixed(0)}%`,
            `Kelly: ${(kelly * 100).toFixed(1)}%`,
          ],
        })
      }
    }
  }

  return signals
}

// ── Ranking ──────────────────────────────────────────────────────

export function rankSignals(signals: SportsSignal[], maxSignals: number = 20): SportsSignal[] {
  return signals
    .sort((a, b) => b.signalScore - a.signalScore || b.edge - a.edge)
    .slice(0, maxSignals)
}
