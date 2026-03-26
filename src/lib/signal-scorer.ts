import { getWalletStats, type WalletDomainStats } from './db'
import { keywordClassify } from './classifier'

// ── Types ─────────────────────────────────────────────────────────

export type SignalScore = {
  score: number           // 0-100, overall signal quality
  domainMatch: boolean    // is this expert's best domain?
  expertCalibration: number
  expertWinRate: number
  expertTrades: number
  betSizeSignal: number   // how big is this bet vs expert's usual
  domain: string | null
  reasons: string[]       // human-readable reasons
}

// ── Config ────────────────────────────────────────────────────────

const MIN_SIGNAL_SCORE = 40  // minimum score to copy

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

  // Filter noise markets (5-min crypto, narrow price ranges)
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(marketTitle)) {
      return {
        score: 0, domainMatch: false, expertCalibration: 0,
        expertWinRate: 0, expertTrades: 0, betSizeSignal: 0,
        domain, reasons: ['Noise market filtered'],
      }
    }
  }

  // Get expert's stats across all domains
  const allStats = getWalletStats(expertWallet)

  if (allStats.length === 0) {
    return {
      score: 0, domainMatch: false, expertCalibration: 0,
      expertWinRate: 0, expertTrades: 0, betSizeSignal: 0,
      domain, reasons: ['No historical data for this expert'],
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

  // 2. Calibration (25 points max) — how well-calibrated is the expert in this domain?
  let calibrationScore = 0
  const cal = domainStats?.calibration ?? bestDomain?.calibration ?? 0
  if (cal >= 0.80) { calibrationScore = 25; reasons.push(`Excellent calibration: ${(cal * 100).toFixed(0)}%`) }
  else if (cal >= 0.70) { calibrationScore = 18; reasons.push(`Good calibration: ${(cal * 100).toFixed(0)}%`) }
  else if (cal >= 0.60) { calibrationScore = 10 }
  else { reasons.push(`Low calibration: ${(cal * 100).toFixed(0)}%`) }

  // 3. Win rate (20 points max) — domain-specific win rate
  let winRateScore = 0
  const wr = domainStats?.winRate ?? bestDomain?.winRate ?? 0
  if (wr >= 0.60) { winRateScore = 20; reasons.push(`Strong WR: ${(wr * 100).toFixed(0)}%`) }
  else if (wr >= 0.50) { winRateScore = 14 }
  else if (wr >= 0.40) { winRateScore = 8 }

  // 4. Entry price quality (15 points max) — sweet spot is 0.25-0.75
  let entryScore = 0
  if (entryPrice >= 0.25 && entryPrice <= 0.75) {
    entryScore = 15  // good range: not a longshot, not a sure thing
    reasons.push(`Good entry: ${(entryPrice * 100).toFixed(0)}¢`)
  } else if (entryPrice >= 0.15 && entryPrice <= 0.85) {
    entryScore = 8
  } else {
    reasons.push(`Extreme entry: ${(entryPrice * 100).toFixed(0)}¢`)
  }

  // 5. Bet size signal (10 points max) — bigger position = more conviction
  let betSizeSignal = 0
  if (positionSize > 50000) { betSizeSignal = 10; reasons.push(`Whale-size: ${(positionSize / 1000).toFixed(0)}K shares`) }
  else if (positionSize > 10000) { betSizeSignal = 7 }
  else if (positionSize > 1000) { betSizeSignal = 4 }
  else { betSizeSignal = 1 }

  const totalScore = domainScore + calibrationScore + winRateScore + entryScore + betSizeSignal

  return {
    score: totalScore,
    domainMatch,
    expertCalibration: cal,
    expertWinRate: wr,
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
