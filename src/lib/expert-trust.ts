import { getAllPaperTrades, type PaperTrade } from './db'

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
    if (resolved.length >= 5 && pnl < -300) {
      return { ...base, phase: 'observation', trustLevel: 0, status: 'paused',
        reason: `Paused early: ${resolved.length} trades, PnL ${pnl.toFixed(0)}` }
    }
    if (resolved.length >= 3 && pnl < -100) {
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
    if (resolved.length >= EVALUATION_TRADES && recentPnl < -200 && recentWR < 0.30) {
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
    if (recentPnl < -100 || (recentWR < 0.35 && pnl < 0)) {
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

  // Even proven experts get paused if recent performance is terrible
  if (recentPnl < -300 && recentWR < 0.25) {
    return {
      ...base,
      phase: 'proven',
      trustLevel: 0,
      status: 'paused',
      reason: `Paused: slump detected, WR ${(recentWR * 100).toFixed(0)}% (last 20)`,
    }
  }

  // Reduce if losing money recently, BUT profitable longshot traders stay active
  if (recentPnl < -100 || (recentWR < 0.35 && pnl < 0)) {
    return {
      ...base,
      phase: 'proven',
      trustLevel: 0.4,
      status: 'reduced',
      reason: `Reduced: recent slump WR ${(recentWR * 100).toFixed(0)}% (last 20)`,
    }
  }

  // Performing well → high trust, scaled by consistency
  // Combine overall + recent for stability
  const overallFactor = Math.min(winRate / 0.5, 1)
  const recentFactor = Math.min(recentWR / 0.5, 1)
  const trust = Math.min(0.6 + (overallFactor * 0.3 + recentFactor * 0.7) * 0.6, 1.5)

  return {
    ...base,
    phase: 'proven',
    trustLevel: trust,
    status: 'active',
    reason: `Proven: WR ${(winRate * 100).toFixed(0)}% overall, ${(recentWR * 100).toFixed(0)}% recent`,
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
    if (resolved.length >= 5 && pnl < -300) {
      return { ...base, phase: 'observation', trustLevel: 0, status: 'paused',
        reason: `Paused early: ${resolved.length} trades, PnL ${pnl.toFixed(0)}` }
    }
    if (resolved.length >= 3 && pnl < -100) {
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
    if (resolved.length >= EVALUATION_TRADES && recentPnl < -200 && recentWR < 0.30) {
      return { ...base, phase: 'evaluation', trustLevel: 0, status: 'paused',
        reason: `Paused: last 15 trades WR ${(recentWR * 100).toFixed(0)}%, PnL ${recentPnl.toFixed(0)}` }
    }
    if (recentPnl < -100 || (recentWR < 0.35 && pnl < 0)) {
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
  if (recentPnl < -300 && recentWR < 0.25) {
    return { ...base, phase: 'proven', trustLevel: 0, status: 'paused',
      reason: `Paused: slump detected, WR ${(recentWR * 100).toFixed(0)}% (last 20)` }
  }
  if (recentPnl < -100 || (recentWR < 0.35 && pnl < 0)) {
    return { ...base, phase: 'proven', trustLevel: 0.4, status: 'reduced',
      reason: `Reduced: recent slump WR ${(recentWR * 100).toFixed(0)}% (last 20)` }
  }
  const overallFactor = Math.min(winRate / 0.5, 1)
  const recentFactor = Math.min(recentWR / 0.5, 1)
  const trust = Math.min(0.6 + (overallFactor * 0.3 + recentFactor * 0.7) * 0.6, 1.5)
  return { ...base, phase: 'proven', trustLevel: trust, status: 'active',
    reason: `Proven: WR ${(winRate * 100).toFixed(0)}% overall, ${(recentWR * 100).toFixed(0)}% recent` }
}
