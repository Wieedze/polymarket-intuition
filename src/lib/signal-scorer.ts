import { getWalletStats, type WalletDomainStats } from './db'
import { keywordClassify } from './classifier'

// ── Types ─────────────────────────────────────────────────────────

export type SignalScore = {
  score: number           // 0-100, overall signal quality
  domainMatch: boolean    // is this expert's best domain?
  expertCalibration: number
  expertWinRate: number
  expertImplicitEdge: number  // beats market by X points
  expertTrades: number
  betSizeSignal: number   // how big is this bet vs expert's usual
  domain: string | null
  reasons: string[]       // human-readable reasons
}

// ── Config ────────────────────────────────────────────────────────

const MIN_SIGNAL_SCORE = 40  // minimum score to copy

/**
 * Get a domain signal multiplier based on the expert's own track record in that domain.
 * Uses wallet_stats from SQLite instead of our paper portfolio performance.
 *
 * This avoids penalizing valid signals because we had bad copies in that domain.
 * The expert's calibration and win rate in THIS domain is the real signal quality indicator.
 */
function getDomainPerformanceMultiplier(domain: string | null, expertWallet: string): number {
  if (!domain) return 0  // skip unknown domains entirely

  try {
    const expertStats = getWalletStats(expertWallet)
    if (expertStats.length === 0) return 1.0  // no data yet — neutral

    const domainStats = expertStats.find((s) => s.domain === domain)
    if (!domainStats) return 0.7  // expert has no history in this domain — cautious

    // Expert is excellent in this domain → boost
    if (domainStats.calibration >= 0.75 && domainStats.winRate >= 0.55) return 1.5
    if (domainStats.calibration >= 0.65 && domainStats.winRate >= 0.50) return 1.2

    // Expert is mediocre in this domain → penalize
    if (domainStats.calibration < 0.55 || domainStats.winRate < 0.35) return 0.5

    return 1.0
  } catch {
    return 1.0  // DB unavailable, neutral
  }
}

// Domains with negative edge — skip entirely based on paper trading data
const BLOCKED_DOMAINS = new Set(['pm-domain/crypto'])

// Markets that are pure noise — skip entirely
const NOISE_PATTERNS = [
  /up or down.*\d+:\d+[ap]m/i,        // "Bitcoin Up or Down - 10:20AM-10:25AM"
  /\d+:\d+[ap]m.*\d+:\d+[ap]m/i,      // any 5-min time window
  /close at \$[\d,]+[-–].*on the final day/i,  // narrow price range bets
  /close at \$[\d,]+[-–]\$[\d,]+ on/i, // "close at $290-$295 on..."
]

// ── Signal scoring ───────────────────────────────────────────────

/**
 * Score a trading signal from an expert.
 *
 * A signal is strong when:
 * - The expert has proven track record in THIS domain
 * - The expert has high calibration and win rate in this domain
 * - The expert's bet size is significant (skin in the game)
 * - The entry price is in a good range (not a longshot, not a sure thing)
 */
export function scoreSignal(params: {
  expertWallet: string
  marketTitle: string
  entryPrice: number
  positionSize: number   // shares held by expert
}): SignalScore {
  const { expertWallet, marketTitle, entryPrice, positionSize } = params

  const classification = keywordClassify(marketTitle)
  const domain = classification?.domain ?? null
  const reasons: string[] = []

  // Filter noise markets first (5-min crypto, narrow price ranges)
  // Must run before domain blocking so noise titles are always caught
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(marketTitle)) {
      return {
        score: 0, domainMatch: false, expertCalibration: 0,
        expertWinRate: 0, expertTrades: 0, betSizeSignal: 0,
        expertImplicitEdge: 0, domain, reasons: ['Noise market filtered'],
      }
    }
  }

  // Block domains with proven negative edge
  if (domain && BLOCKED_DOMAINS.has(domain)) {
    return {
      score: 0, domainMatch: false, expertCalibration: 0,
      expertWinRate: 0, expertTrades: 0, betSizeSignal: 0,
      expertImplicitEdge: 0, domain, reasons: [`Domain ${domain} blocked — negative edge`],
    }
  }

  // Penalize/boost based on expert's track record in this specific domain
  const domainMultiplier = getDomainPerformanceMultiplier(domain, expertWallet)
  if (domainMultiplier === 0) {
    return {
      score: 0, domainMatch: false, expertCalibration: 0,
      expertWinRate: 0, expertTrades: 0, betSizeSignal: 0,
      expertImplicitEdge: 0, domain, reasons: ['Unknown domain — skipped'],
    }
  }

  // Get expert's stats across all domains
  const allStats = getWalletStats(expertWallet)

  if (allStats.length === 0) {
    return {
      score: 0, domainMatch: false, expertCalibration: 0,
      expertWinRate: 0, expertTrades: 0, betSizeSignal: 0,
      expertImplicitEdge: 0, domain, reasons: ['No historical data for this expert'],
    }
  }

  // Find expert's stats for THIS domain
  const domainStats = domain
    ? allStats.find((s) => s.domain === domain)
    : null

  // Find expert's BEST domain
  const bestDomain = allStats.reduce((best, s) =>
    (s.tradesCount > (best?.tradesCount ?? 0) && s.calibration > 0.6) ? s : best,
    null as WalletDomainStats | null
  )

  // ── Score components (0-100 each) ──

  // 1. Domain match (30 points max)
  let domainScore = 0
  const domainMatch = domainStats !== undefined && domainStats !== null
  if (domainMatch) {
    // Expert has history in this exact domain
    if (bestDomain && bestDomain.domain === domain) {
      domainScore = 30  // this IS their best domain
      reasons.push(`Expert's #1 domain`)
    } else if (domainStats.tradesCount >= 10) {
      domainScore = 20  // strong history in this domain
      reasons.push(`${domainStats.tradesCount} trades in domain`)
    } else if (domainStats.tradesCount >= 5) {
      domainScore = 10  // some history
      reasons.push(`${domainStats.tradesCount} trades in domain (limited)`)
    }
  } else {
    reasons.push(`No history in ${domain ?? 'unknown'} domain`)
  }

  // 2. Calibration (20 points max) — how well-calibrated is the expert in this domain?
  let calibrationScore = 0
  const cal = domainStats?.calibration ?? bestDomain?.calibration ?? 0
  if (cal >= 0.80) { calibrationScore = 20; reasons.push(`Excellent calibration: ${(cal * 100).toFixed(0)}%`) }
  else if (cal >= 0.70) { calibrationScore = 14; reasons.push(`Good calibration: ${(cal * 100).toFixed(0)}%`) }
  else if (cal >= 0.60) { calibrationScore = 8 }
  else { reasons.push(`Low calibration: ${(cal * 100).toFixed(0)}%`) }

  // 3. Implicit edge (15 points max) — beats market implied probability by X points
  // This is the KEY metric for 0/1 markets: does the wallet systematically
  // find bets where the market underestimates the real probability?
  let implicitEdgeScore = 0
  const ie = domainStats?.implicitEdge ?? bestDomain?.implicitEdge ?? 0
  if (ie >= 0.15) { implicitEdgeScore = 15; reasons.push(`Strong implicit edge: +${(ie * 100).toFixed(0)}pts`) }
  else if (ie >= 0.08) { implicitEdgeScore = 11; reasons.push(`Good implicit edge: +${(ie * 100).toFixed(0)}pts`) }
  else if (ie >= 0.03) { implicitEdgeScore = 7; reasons.push(`Positive implicit edge: +${(ie * 100).toFixed(0)}pts`) }
  else if (ie >= -0.03) { implicitEdgeScore = 3 } // neutral — market-rate
  else { reasons.push(`Negative edge: ${(ie * 100).toFixed(0)}pts (worse than market)`) }

  // 4. Win rate (10 points max) — still useful but less important than implicit edge
  let winRateScore = 0
  const wr = domainStats?.winRate ?? bestDomain?.winRate ?? 0
  if (wr >= 0.60) { winRateScore = 10; reasons.push(`Strong WR: ${(wr * 100).toFixed(0)}%`) }
  else if (wr >= 0.50) { winRateScore = 7 }
  else if (wr >= 0.40) { winRateScore = 4 }

  // 4. Entry price quality (15 points max)
  // Data shows: 15-30¢ = +$2370, 30-55¢ = +$2844, >65¢ = -$3752
  // Hard block above 65¢ — no edge, pure favorite territory
  let entryScore = 0
  if (entryPrice > 0.65) {
    return {
      score: 0, domainMatch: false, expertCalibration: 0,
      expertWinRate: 0, expertTrades: 0, betSizeSignal: 0,
      expertImplicitEdge: 0, domain, reasons: [`Entry ${(entryPrice * 100).toFixed(0)}¢ blocked — favorites destroy bankroll`],
    }
  } else if (entryPrice >= 0.15 && entryPrice <= 0.30) {
    entryScore = 15  // longshot sweet spot — best historical P&L
    reasons.push(`Longshot entry: ${(entryPrice * 100).toFixed(0)}¢`)
  } else if (entryPrice > 0.30 && entryPrice <= 0.55) {
    entryScore = 12  // value zone
    reasons.push(`Value entry: ${(entryPrice * 100).toFixed(0)}¢`)
  } else if (entryPrice > 0.55 && entryPrice <= 0.65) {
    entryScore = 3   // marginal — penalized
    reasons.push(`Marginal entry: ${(entryPrice * 100).toFixed(0)}¢`)
  } else {
    reasons.push(`Extreme longshot: ${(entryPrice * 100).toFixed(0)}¢`)
  }

  // 5. Bet size signal (10 points max) — bigger position = more conviction
  let betSizeSignal = 0
  if (positionSize > 50000) { betSizeSignal = 10; reasons.push(`Whale-size: ${(positionSize / 1000).toFixed(0)}K shares`) }
  else if (positionSize > 10000) { betSizeSignal = 7 }
  else if (positionSize > 1000) { betSizeSignal = 4 }
  else { betSizeSignal = 1 }

  const rawScore = domainScore + calibrationScore + implicitEdgeScore + winRateScore + entryScore + betSizeSignal

  // Apply domain performance multiplier (boost profitable domains, penalize losing ones)
  const totalScore = Math.round(rawScore * domainMultiplier)

  if (domainMultiplier !== 1.0) {
    reasons.push(domainMultiplier > 1 ? `Domain boost ${domainMultiplier}x` : `Domain penalty ${domainMultiplier}x`)
  }

  return {
    score: totalScore,
    domainMatch,
    expertCalibration: cal,
    expertWinRate: wr,
    expertImplicitEdge: ie,
    expertTrades: domainStats?.tradesCount ?? 0,
    betSizeSignal,
    domain,
    reasons,
  }
}

/**
 * Should we copy this signal?
 */
export function shouldCopySignal(signal: SignalScore): boolean {
  return signal.score >= MIN_SIGNAL_SCORE
}

/**
 * Check if a new trade would contradict an existing open trade.
 * E.g., buying YES on "TSLA above $400" while holding NO on same market.
 */
export function isContradictory(
  conditionId: string,
  side: string,
  openTrades: Array<{ conditionId: string; side: string; title: string }>
): boolean {
  for (const t of openTrades) {
    if (t.conditionId === conditionId && t.side !== side) {
      return true // opposite side on same market
    }
  }
  return false
}

/**
 * How much to bet based on signal quality (multiplier on base bet)
 * Score 40-59 → 0.5x (half bet, cautious)
 * Score 60-79 → 1.0x (standard)
 * Score 80+   → 1.5x (high conviction)
 */
export function signalBetMultiplier(signal: SignalScore): number {
  if (signal.score >= 80) return 1.5
  if (signal.score >= 60) return 1.0
  return 0.5
}

/**
 * Kelly Criterion simplified — optimal bet fraction.
 *
 * f* = (p × b - q) / b
 * where p = win probability (winRate), q = 1-p, b = net odds (payout ratio)
 *
 * For Polymarket: b = (1/entryPrice) - 1
 * E.g., entry at 0.40 → b = 1.5 (you risk $0.40 to win $0.60)
 *
 * Returns fraction of bankroll to bet (0-1), capped at 0.25 (quarter Kelly for safety).
 * Returns 0 if no edge (negative Kelly).
 */
export function kellyBetFraction(
  winRate: number,
  entryPrice: number
): number {
  if (winRate <= 0 || entryPrice <= 0 || entryPrice >= 1) return 0

  const b = (1 / entryPrice) - 1  // net odds
  const q = 1 - winRate
  const kelly = (winRate * b - q) / b

  if (kelly <= 0) return 0

  // Quarter Kelly for safety (full Kelly is too aggressive)
  return Math.min(kelly * 0.25, 0.25)
}
