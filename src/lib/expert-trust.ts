import { getAllPaperTrades, getPortfolioSetting, type PaperTrade } from './db'

// ── Types ─────────────────────────────────────────────────────────

export type ExpertTrust = {
  wallet: string
  label: string | null
  totalTrades: number
  resolvedTrades: number
  wins: number
  losses: number
  winRate: number
  pnl: number
  phase: 'observation' | 'evaluation' | 'proven'
  trustLevel: number     // 0-1, multiplier on bet size
  status: 'active' | 'reduced' | 'paused'
  reason: string
}

// ── Config ────────────────────────────────────────────────────────

const OBSERVATION_TRADES = 20   // first 20 trades → observe, no judgment (10 was too low — pure luck range)
const EVALUATION_TRADES = 30    // after 30 → evaluate aggressively
const PROVEN_TRADES = 60        // after 60 → proven track record (40 was statistically weak)

// ── Bankroll scale ──────────────────────────────────────────────
// All dollar thresholds scale proportionally to bankroll.
// $10k base → scale=1.0 | $100 → scale=0.01 | $1k → scale=0.1
// This lets the same trust logic work for €100 live tests and $10k paper.

export function getBankrollScale(): number {
  const startBal = parseFloat(getPortfolioSetting('starting_balance', '10000'))
  return startBal / 10000
}

function scaledDollar(baseAmount: number): number {
  return baseAmount * getBankrollScale()
}

// ── Risk-adjusted scoring (used by proven phase) ────────────────

type RiskMetrics = {
  profitFactor: number       // gross wins / gross losses (>1 = profitable)
  maxDrawdown: number        // worst cumulative loss streak in $
  avgWin: number
  avgLoss: number
  recentMomentum: number     // PnL of last 20 trades
  compositeScore: number     // 0-100 final score
}

function computeRiskMetrics(resolved: PaperTrade[]): RiskMetrics {
  const wins = resolved.filter((t) => (t.pnl ?? 0) > 0)
  const losses = resolved.filter((t) => (t.pnl ?? 0) <= 0)

  const grossWins = wins.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const grossLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0))
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 10 : 0

  const avgWin = wins.length > 0 ? grossWins / wins.length : 0
  const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0

  // Max drawdown: worst peak-to-trough in cumulative PnL
  let peak = 0
  let cumPnl = 0
  let maxDd = 0
  for (const t of resolved) {
    cumPnl += t.pnl ?? 0
    if (cumPnl > peak) peak = cumPnl
    const dd = peak - cumPnl
    if (dd > maxDd) maxDd = dd
  }

  // Recent momentum (last 20)
  const recent = resolved.slice(-20)
  const recentMomentum = recent.reduce((s, t) => s + (t.pnl ?? 0), 0)

  // Composite score 0-100:
  // 40% profit factor, 25% drawdown ratio, 20% recent momentum, 15% win/loss ratio
  const pfScore = Math.min(profitFactor / 2.0, 1) * 40         // PF 2.0+ = max 40pts
  const totalPnl = grossWins - grossLosses
  const ddRatio = totalPnl > 0 ? Math.max(1 - maxDd / (totalPnl + maxDd), 0) : 0
  const ddScore = ddRatio * 25                                   // low DD relative to gains = max 25pts
  const momentumDivisor = scaledDollar(500)
  const momentumScore = recentMomentum > 0 ? Math.min(recentMomentum / momentumDivisor, 1) * 20 : // positive = up to 20pts
    Math.max(recentMomentum / momentumDivisor, -1) * 10                      // negative = down to -10pts penalty
  const wlRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 5 : 0
  const wlScore = Math.min(wlRatio / 3.0, 1) * 15              // ratio 3:1+ = max 15pts

  const compositeScore = Math.max(Math.min(pfScore + ddScore + momentumScore + wlScore, 100), 0)

  return { profitFactor, maxDrawdown: maxDd, avgWin, avgLoss, recentMomentum, compositeScore }
}

// ── Core logic ───────────────────────────────────────────────────

/**
 * Evaluate trust level for an expert based on our paper trading history with them.
 *
 * Re-evaluates on EVERY poll — no fixed schedule.
 * Trust level is a multiplier (0-1.5) applied to bet size.
 *
 * Phases:
 *   observation (< 10 resolved) → trust 0.7 (cautious default)
 *   evaluation (10-40 resolved) → trust based on rolling performance
 *   proven (40+ resolved) → trust based on full history, more stable
 */
export function evaluateExpertTrust(
  wallet: string,
  label: string | null
): ExpertTrust {
  const allTrades = getAllPaperTrades()
  const expertTrades = allTrades.filter((t) => t.copiedFrom === wallet)
  const resolved = expertTrades.filter((t) => t.status !== 'open')
  const wins = resolved.filter((t) => t.status === 'won')
  const losses = resolved.filter((t) => t.status === 'lost')
  const pnl = resolved.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const winRate = resolved.length > 0 ? wins.length / resolved.length : 0

  const base: Omit<ExpertTrust, 'phase' | 'trustLevel' | 'status' | 'reason'> = {
    wallet,
    label,
    totalTrades: expertTrades.length,
    resolvedTrades: resolved.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    pnl,
  }

  // ── Phase 1: Observation ──
  if (resolved.length < OBSERVATION_TRADES) {
    // Early warning: cut trust if losing money fast even with few trades
    if (resolved.length >= 5 && pnl < -scaledDollar(300)) {
      return { ...base, phase: 'observation', trustLevel: 0, status: 'paused',
        reason: `Paused early: ${resolved.length} trades, PnL ${pnl.toFixed(0)}` }
    }
    if (resolved.length >= 3 && pnl < -scaledDollar(100)) {
      return { ...base, phase: 'observation', trustLevel: 0.3, status: 'reduced',
        reason: `Reduced early: ${resolved.length} trades, PnL ${pnl.toFixed(0)}` }
    }
    return {
      ...base,
      phase: 'observation',
      trustLevel: 0.7,
      status: 'active',
      reason: `Observing (${resolved.length}/${OBSERVATION_TRADES} trades)`,
    }
  }

  // ── Phase 2: Evaluation (rolling window) ──
  if (resolved.length < PROVEN_TRADES) {
    // Use last 15 trades for recent performance
    const recent = resolved.slice(-15)
    const recentWR = recent.filter((t) => t.status === 'won').length / recent.length
    const recentPnl = recent.reduce((s, t) => s + (t.pnl ?? 0), 0)

    // Losing badly → pause (both WR and PnL must be bad)
    if (resolved.length >= EVALUATION_TRADES && recentPnl < -scaledDollar(200) && recentWR < 0.30) {
      return {
        ...base,
        phase: 'evaluation',
        trustLevel: 0,
        status: 'paused',
        reason: `Paused: last 15 trades WR ${(recentWR * 100).toFixed(0)}%, PnL ${recentPnl.toFixed(0)}`,
      }
    }

    // Losing moderately → reduce
    // BUT: if overall PnL is positive, WR alone doesn't matter (longshot traders)
    if (recentPnl < -scaledDollar(100) || (recentWR < 0.35 && pnl < 0)) {
      return {
        ...base,
        phase: 'evaluation',
        trustLevel: 0.3,
        status: 'reduced',
        reason: `Reduced: WR ${(recentWR * 100).toFixed(0)}%, PnL ${recentPnl.toFixed(0)} (last 15)`,
      }
    }

    // Doing OK → normal trust, scaled by performance
    const trust = Math.min(0.5 + (recentWR - 0.35) * 2, 1.2)
    return {
      ...base,
      phase: 'evaluation',
      trustLevel: Math.max(trust, 0.3),
      status: 'active',
      reason: `Eval: WR ${(recentWR * 100).toFixed(0)}%, PnL ${recentPnl >= 0 ? '+' : ''}${recentPnl.toFixed(0)} (last 15)`,
    }
  }

  // ── Phase 3: Proven (40+ trades) ──
  // Use both full history and recent window
  const recent = resolved.slice(-20)
  const recentWR = recent.filter((t) => t.status === 'won').length / recent.length
  const recentPnl = recent.reduce((s, t) => s + (t.pnl ?? 0), 0)

  // ── Proven experts: risk-adjusted composite score ──
  // Like real trading firms: Profit Factor + Max Drawdown + Momentum + Win/Loss ratio
  const risk = computeRiskMetrics(resolved)

  // Score 0-100 → trust mapping:
  //   0-10 + negative momentum → paused (truly hopeless + still sinking)
  //   0-20  → reduced at 0.15  (bad, minimal exposure — chance to recover)
  //   20-40 → reduced at 0.3   (mediocre, limited exposure)
  //   40-60 → active           (decent, normal trust)
  //   60+   → active           (strong, high trust)

  // PAUSE only if score is rock-bottom AND still losing recently (no recovery signal)
  if (risk.compositeScore < 10 && risk.recentMomentum < -scaledDollar(200)) {
    return {
      ...base,
      phase: 'proven',
      trustLevel: 0,
      status: 'paused',
      reason: `Paused: score ${risk.compositeScore.toFixed(0)}/100, still sinking (PF ${risk.profitFactor.toFixed(2)}, DD -$${risk.maxDrawdown.toFixed(0)}, momentum ${risk.recentMomentum.toFixed(0)})`,
    }
  }

  // REDUCE (severe) — bad score but might recover
  if (risk.compositeScore < 20) {
    return {
      ...base,
      phase: 'proven',
      trustLevel: 0.15,
      status: 'reduced',
      reason: `Reduced: score ${risk.compositeScore.toFixed(0)}/100 (PF ${risk.profitFactor.toFixed(2)}, DD -$${risk.maxDrawdown.toFixed(0)}, momentum ${risk.recentMomentum >= 0 ? '+' : ''}${risk.recentMomentum.toFixed(0)})`,
    }
  }

  // REDUCE (moderate) — below average, limit exposure
  if (risk.compositeScore < 40) {
    return {
      ...base,
      phase: 'proven',
      trustLevel: 0.3,
      status: 'reduced',
      reason: `Reduced: score ${risk.compositeScore.toFixed(0)}/100 (PF ${risk.profitFactor.toFixed(2)}, DD -$${risk.maxDrawdown.toFixed(0)})`,
    }
  }

  // Active — trust scales linearly with score: 35→0.6, 60→1.0, 80+→1.3-1.5
  const trustFromScore = 0.6 + (risk.compositeScore - 35) * (0.9 / 65)

  return {
    ...base,
    phase: 'proven',
    trustLevel: Math.min(trustFromScore, 1.5),
    status: 'active',
    reason: `Proven: score ${risk.compositeScore.toFixed(0)}/100 (PF ${risk.profitFactor.toFixed(2)}, DD -$${risk.maxDrawdown.toFixed(0)}, momentum ${risk.recentMomentum >= 0 ? '+' : ''}${risk.recentMomentum.toFixed(0)})`,
  }
}

/**
 * Get trust levels for all experts we've copied.
 * Sorted by trustLevel descending.
 */
export function getAllExpertTrust(): ExpertTrust[] {
  return getAllExpertTrustFromTrades(getAllPaperTrades())
}

/**
 * Same as getAllExpertTrust but accepts pre-fetched trades to avoid N+1 DB calls.
 * Used by the unified /api/snapshot endpoint.
 */
export function getAllExpertTrustFromTrades(allTrades: PaperTrade[]): ExpertTrust[] {
  const expertWallets = new Map<string, string | null>()
  for (const t of allTrades) {
    if (!expertWallets.has(t.copiedFrom)) {
      expertWallets.set(t.copiedFrom, t.copiedLabel)
    }
  }

  const trusts: ExpertTrust[] = []
  for (const [wallet, label] of expertWallets) {
    trusts.push(evaluateExpertTrustFromTrades(wallet, label, allTrades))
  }

  return trusts.sort((a, b) => b.trustLevel - a.trustLevel)
}

/**
 * Same as evaluateExpertTrust but accepts pre-fetched trades.
 */
export function evaluateExpertTrustFromTrades(
  wallet: string,
  label: string | null,
  allTrades: PaperTrade[]
): ExpertTrust {
  const expertTrades = allTrades.filter((t) => t.copiedFrom === wallet)
  const resolved = expertTrades.filter((t) => t.status !== 'open')
  const wins = resolved.filter((t) => t.status === 'won')
  const losses = resolved.filter((t) => t.status === 'lost')
  const pnl = resolved.reduce((s, t) => s + (t.pnl ?? 0), 0)
  const winRate = resolved.length > 0 ? wins.length / resolved.length : 0

  const base: Omit<ExpertTrust, 'phase' | 'trustLevel' | 'status' | 'reason'> = {
    wallet, label, totalTrades: expertTrades.length, resolvedTrades: resolved.length,
    wins: wins.length, losses: losses.length, winRate, pnl,
  }

  if (resolved.length < OBSERVATION_TRADES) {
    if (resolved.length >= 5 && pnl < -scaledDollar(300)) {
      return { ...base, phase: 'observation', trustLevel: 0, status: 'paused',
        reason: `Paused early: ${resolved.length} trades, PnL ${pnl.toFixed(0)}` }
    }
    if (resolved.length >= 3 && pnl < -scaledDollar(100)) {
      return { ...base, phase: 'observation', trustLevel: 0.3, status: 'reduced',
        reason: `Reduced early: ${resolved.length} trades, PnL ${pnl.toFixed(0)}` }
    }
    return { ...base, phase: 'observation', trustLevel: 0.7, status: 'active',
      reason: `Observing (${resolved.length}/${OBSERVATION_TRADES} trades)` }
  }

  if (resolved.length < PROVEN_TRADES) {
    const recent = resolved.slice(-15)
    const recentWR = recent.filter((t) => t.status === 'won').length / recent.length
    const recentPnl = recent.reduce((s, t) => s + (t.pnl ?? 0), 0)
    if (resolved.length >= EVALUATION_TRADES && recentPnl < -scaledDollar(200) && recentWR < 0.30) {
      return { ...base, phase: 'evaluation', trustLevel: 0, status: 'paused',
        reason: `Paused: last 15 trades WR ${(recentWR * 100).toFixed(0)}%, PnL ${recentPnl.toFixed(0)}` }
    }
    if (recentPnl < -scaledDollar(100) || (recentWR < 0.35 && pnl < 0)) {
      return { ...base, phase: 'evaluation', trustLevel: 0.3, status: 'reduced',
        reason: `Reduced: WR ${(recentWR * 100).toFixed(0)}%, PnL ${recentPnl.toFixed(0)} (last 15)` }
    }
    const trust = Math.min(0.5 + (recentWR - 0.35) * 2, 1.2)
    return { ...base, phase: 'evaluation', trustLevel: Math.max(trust, 0.3), status: 'active',
      reason: `Eval: WR ${(recentWR * 100).toFixed(0)}%, PnL ${recentPnl >= 0 ? '+' : ''}${recentPnl.toFixed(0)} (last 15)` }
  }

  const recent = resolved.slice(-20)
  const recentWR = recent.filter((t) => t.status === 'won').length / recent.length
  const recentPnl = recent.reduce((s, t) => s + (t.pnl ?? 0), 0)

  // Risk-adjusted composite score (same logic as main function)
  const risk = computeRiskMetrics(resolved)

  if (risk.compositeScore < 10 && risk.recentMomentum < -scaledDollar(200)) {
    return { ...base, phase: 'proven', trustLevel: 0, status: 'paused',
      reason: `Paused: score ${risk.compositeScore.toFixed(0)}/100, still sinking (PF ${risk.profitFactor.toFixed(2)}, DD -$${risk.maxDrawdown.toFixed(0)}, momentum ${risk.recentMomentum.toFixed(0)})` }
  }
  if (risk.compositeScore < 20) {
    return { ...base, phase: 'proven', trustLevel: 0.15, status: 'reduced',
      reason: `Reduced: score ${risk.compositeScore.toFixed(0)}/100 (PF ${risk.profitFactor.toFixed(2)}, DD -$${risk.maxDrawdown.toFixed(0)}, momentum ${risk.recentMomentum >= 0 ? '+' : ''}${risk.recentMomentum.toFixed(0)})` }
  }
  if (risk.compositeScore < 40) {
    return { ...base, phase: 'proven', trustLevel: 0.3, status: 'reduced',
      reason: `Reduced: score ${risk.compositeScore.toFixed(0)}/100 (PF ${risk.profitFactor.toFixed(2)}, DD -$${risk.maxDrawdown.toFixed(0)})` }
  }
  const trustFromScore2 = 0.6 + (risk.compositeScore - 35) * (0.9 / 65)
  return { ...base, phase: 'proven', trustLevel: Math.min(trustFromScore2, 1.5), status: 'active',
    reason: `Proven: score ${risk.compositeScore.toFixed(0)}/100 (PF ${risk.profitFactor.toFixed(2)}, DD -$${risk.maxDrawdown.toFixed(0)}, momentum ${risk.recentMomentum >= 0 ? '+' : ''}${risk.recentMomentum.toFixed(0)})` }
}
