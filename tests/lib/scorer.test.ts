import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  calculateWinRate,
  calculateCalibration,
  calculateConvictionScore,
  detectTradingStyle,
  calculateProfitFactor,
  calculateAvgPnlPerTrade,
  calculateMaxConsecutiveLosses,
  calculateCopyabilityScore,
  calculateDecayFactor,
  calculateImplicitEdge,
  MIN_TRADES_FOR_ATTESTATION,
} from '../../src/lib/scorer'
import type { ResolvedTrade } from '../../src/types/polymarket'

// ── Helpers ───────────────────────────────────────────────────────

function makeTrade(
  overrides: Partial<ResolvedTrade> = {}
): ResolvedTrade {
  return {
    id: 'test-id',
    marketId: 'market-1',
    marketQuestion: 'Test question?',
    side: 'YES',
    entryPrice: 0.7,
    size: 100,
    outcome: 'won',
    pnl: 30,
    resolvedAt: '2025-01-01T00:00:00Z',
    transactionHash: '0x123',
    ...overrides,
  }
}

// ── calculateWinRate ──────────────────────────────────────────────

describe('calculateWinRate', () => {
  it('returns 0 for empty array', () => {
    expect(calculateWinRate([])).toBe(0)
  })

  it('returns 1.0 for all wins', () => {
    const trades = [
      makeTrade({ outcome: 'won' }),
      makeTrade({ outcome: 'won' }),
    ]
    expect(calculateWinRate(trades)).toBe(1)
  })

  it('returns 0.0 for all losses', () => {
    const trades = [
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'lost' }),
    ]
    expect(calculateWinRate(trades)).toBe(0)
  })

  it('returns correct ratio for mixed results', () => {
    const trades = [
      makeTrade({ outcome: 'won' }),
      makeTrade({ outcome: 'won' }),
      makeTrade({ outcome: 'lost' }),
    ]
    expect(calculateWinRate(trades)).toBeCloseTo(0.6667, 3)
  })

  it('returns 0.5 for even split', () => {
    const trades = [
      makeTrade({ outcome: 'won' }),
      makeTrade({ outcome: 'lost' }),
    ]
    expect(calculateWinRate(trades)).toBe(0.5)
  })
})

// ── calculateCalibration ──────────────────────────────────────────

describe('calculateCalibration', () => {
  it('returns 0 for empty array', () => {
    expect(calculateCalibration([])).toBe(0)
  })

  it('returns near 1.0 for perfect calibration (YES at 0.9, won)', () => {
    const trades = [
      makeTrade({ side: 'YES', entryPrice: 0.9, outcome: 'won' }),
    ]
    // predictedProb = 0.9, outcome = 1
    // brier = (0.9 - 1)^2 = 0.01
    // calibration = 1 - 0.01 = 0.99
    expect(calculateCalibration(trades)).toBeCloseTo(0.99, 2)
  })

  it('returns near 1.0 for perfect calibration (NO at 0.1, won)', () => {
    // NO side at entryPrice 0.1 → predictedProb = 1 - 0.1 = 0.9
    // Won → outcome = 1
    // brier = (0.9 - 1)^2 = 0.01
    const trades = [
      makeTrade({ side: 'NO', entryPrice: 0.1, outcome: 'won' }),
    ]
    expect(calculateCalibration(trades)).toBeCloseTo(0.99, 2)
  })

  it('returns < 0.75 for worse-than-chance (YES at 0.9, lost)', () => {
    const trades = [
      makeTrade({ side: 'YES', entryPrice: 0.9, outcome: 'lost' }),
    ]
    // predictedProb = 0.9, outcome = 0
    // brier = (0.9 - 0)^2 = 0.81
    // calibration = 1 - 0.81 = 0.19
    expect(calculateCalibration(trades)).toBeLessThan(0.75)
    expect(calculateCalibration(trades)).toBeCloseTo(0.19, 2)
  })

  it('returns ~0.75 for random calibration (50/50 at 0.5)', () => {
    const trades = [
      makeTrade({ side: 'YES', entryPrice: 0.5, outcome: 'won' }),
      makeTrade({ side: 'YES', entryPrice: 0.5, outcome: 'lost' }),
    ]
    // Trade 1: (0.5 - 1)^2 = 0.25
    // Trade 2: (0.5 - 0)^2 = 0.25
    // brier = (0.25 + 0.25) / 2 = 0.25
    // calibration = 1 - 0.25 = 0.75
    expect(calculateCalibration(trades)).toBeCloseTo(0.75, 2)
  })

  it('handles mixed sides correctly', () => {
    const trades = [
      makeTrade({ side: 'YES', entryPrice: 0.8, outcome: 'won' }),
      makeTrade({ side: 'NO', entryPrice: 0.2, outcome: 'won' }),
    ]
    // Trade 1: YES @ 0.8, won → (0.8 - 1)^2 = 0.04
    // Trade 2: NO @ 0.2, won → pred = 0.8, (0.8 - 1)^2 = 0.04
    // brier = 0.04, calibration = 0.96
    expect(calculateCalibration(trades)).toBeCloseTo(0.96, 2)
  })
})

// ── calculateConvictionScore ─────────────────────────────────────

describe('calculateConvictionScore', () => {
  it('returns 0 for empty array', () => {
    expect(calculateConvictionScore([])).toBe(0)
  })

  it('returns 0 when all trades have entryPrice < 0.10 (filtered)', () => {
    const trades = [
      makeTrade({ entryPrice: 0.05, outcome: 'won' }),
      makeTrade({ entryPrice: 0.08, outcome: 'won' }),
      makeTrade({ entryPrice: 0.09, outcome: 'lost' }),
    ]
    expect(calculateConvictionScore(trades)).toBe(0)
  })

  it('includes longshots >= 0.10 in conviction score (threshold lowered from 0.25)', () => {
    const trades = [
      makeTrade({ entryPrice: 0.20, outcome: 'won' }),
      makeTrade({ entryPrice: 0.15, outcome: 'won' }),
    ]
    // Both trades qualify now (>= 0.10), avg = (0.20 + 0.15) / 2 = 0.175
    expect(calculateConvictionScore(trades)).toBeCloseTo(0.175, 2)
  })

  it('returns ~0.70 for a single won trade at 0.70', () => {
    const trades = [makeTrade({ entryPrice: 0.70, outcome: 'won' })]
    expect(calculateConvictionScore(trades)).toBeCloseTo(0.70, 2)
  })

  it('returns 0 for a single lost trade at 0.70', () => {
    const trades = [makeTrade({ entryPrice: 0.70, outcome: 'lost' })]
    expect(calculateConvictionScore(trades)).toBe(0)
  })

  it('averages correctly with mixed results', () => {
    const trades = [
      makeTrade({ entryPrice: 0.80, outcome: 'won' }),  // 0.80 × 1 = 0.80
      makeTrade({ entryPrice: 0.60, outcome: 'lost' }), // 0.60 × 0 = 0
    ]
    // mean = 0.80 / 2 = 0.40
    expect(calculateConvictionScore(trades)).toBeCloseTo(0.40, 2)
  })
})

// ── detectTradingStyle ──────────────────────────────────────────

describe('detectTradingStyle', () => {
  it('returns "mixed" for empty array', () => {
    expect(detectTradingStyle([])).toBe('mixed')
  })

  it('returns "longshot-hunter" for avgPrice 0.05', () => {
    const trades = [
      makeTrade({ entryPrice: 0.03 }),
      makeTrade({ entryPrice: 0.05 }),
      makeTrade({ entryPrice: 0.07 }),
    ]
    expect(detectTradingStyle(trades)).toBe('longshot-hunter')
  })

  it('returns "directional" for avgPrice 0.60', () => {
    const trades = [
      makeTrade({ entryPrice: 0.55, outcome: 'won' }),
      makeTrade({ entryPrice: 0.65, outcome: 'lost' }),
    ]
    expect(detectTradingStyle(trades)).toBe('directional')
  })

  it('returns "value-trader" for avgPrice 0.32 with high convictionScore', () => {
    const trades = [
      makeTrade({ entryPrice: 0.32, outcome: 'won' }),
      makeTrade({ entryPrice: 0.35, outcome: 'won' }),
      makeTrade({ entryPrice: 0.28, outcome: 'won' }),
    ]
    // avgPrice = 0.3167, convictionScore = mean(0.32, 0.35, 0.28) = 0.3167 > 0.3
    expect(detectTradingStyle(trades)).toBe('value-trader')
  })

  it('returns "mixed" for avgPrice 0.30 with low convictionScore', () => {
    const trades = [
      makeTrade({ entryPrice: 0.30, outcome: 'lost' }),
      makeTrade({ entryPrice: 0.35, outcome: 'lost' }),
      makeTrade({ entryPrice: 0.25, outcome: 'lost' }),
    ]
    // avgPrice = 0.30, convictionScore = 0 (all lost)
    expect(detectTradingStyle(trades)).toBe('mixed')
  })
})

// ── calculateProfitFactor ──────────────────────────────────────────

describe('calculateProfitFactor', () => {
  it('returns 0 for empty array', () => {
    expect(calculateProfitFactor([])).toBe(0)
  })

  it('returns Infinity for all wins (no losses)', () => {
    const trades = [
      makeTrade({ pnl: 50 }),
      makeTrade({ pnl: 30 }),
    ]
    expect(calculateProfitFactor(trades)).toBe(Infinity)
  })

  it('returns 0 for all break-even trades', () => {
    const trades = [
      makeTrade({ pnl: 0 }),
      makeTrade({ pnl: 0 }),
    ]
    expect(calculateProfitFactor(trades)).toBe(0)
  })

  it('returns correct ratio for mixed results', () => {
    const trades = [
      makeTrade({ pnl: 100 }),   // gross win = 100
      makeTrade({ pnl: -50 }),   // gross loss = 50
      makeTrade({ pnl: 50 }),    // gross win = 50
      makeTrade({ pnl: -25 }),   // gross loss = 25
    ]
    // grossWins = 150, grossLosses = 75
    // profitFactor = 150 / 75 = 2.0
    expect(calculateProfitFactor(trades)).toBeCloseTo(2.0, 2)
  })

  it('returns < 1 for net losers', () => {
    const trades = [
      makeTrade({ pnl: 20 }),
      makeTrade({ pnl: -100 }),
    ]
    // 20 / 100 = 0.2
    expect(calculateProfitFactor(trades)).toBeCloseTo(0.2, 2)
  })
})

// ── calculateAvgPnlPerTrade ────────────────────────────────────────

describe('calculateAvgPnlPerTrade', () => {
  it('returns 0 for empty array', () => {
    expect(calculateAvgPnlPerTrade([])).toBe(0)
  })

  it('returns positive for profitable trader', () => {
    const trades = [
      makeTrade({ pnl: 100 }),
      makeTrade({ pnl: -30 }),
      makeTrade({ pnl: 50 }),
    ]
    // (100 - 30 + 50) / 3 = 40
    expect(calculateAvgPnlPerTrade(trades)).toBeCloseTo(40, 2)
  })

  it('returns negative for losing trader', () => {
    const trades = [
      makeTrade({ pnl: -100 }),
      makeTrade({ pnl: -50 }),
    ]
    expect(calculateAvgPnlPerTrade(trades)).toBeCloseTo(-75, 2)
  })
})

// ── calculateMaxConsecutiveLosses ──────────────────────────────────

describe('calculateMaxConsecutiveLosses', () => {
  it('returns 0 for empty array', () => {
    expect(calculateMaxConsecutiveLosses([])).toBe(0)
  })

  it('returns 0 for all wins', () => {
    const trades = [
      makeTrade({ outcome: 'won' }),
      makeTrade({ outcome: 'won' }),
    ]
    expect(calculateMaxConsecutiveLosses(trades)).toBe(0)
  })

  it('counts consecutive losses correctly', () => {
    const trades = [
      makeTrade({ outcome: 'won' }),
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'won' }),
      makeTrade({ outcome: 'lost' }),
    ]
    expect(calculateMaxConsecutiveLosses(trades)).toBe(3)
  })

  it('handles all losses', () => {
    const trades = [
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'lost' }),
    ]
    expect(calculateMaxConsecutiveLosses(trades)).toBe(4)
  })

  it('picks the longest streak when multiple exist', () => {
    const trades = [
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'won' }),
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'lost' }),
      makeTrade({ outcome: 'won' }),
    ]
    expect(calculateMaxConsecutiveLosses(trades)).toBe(3)
  })
})

// ── calculateCopyabilityScore ──────────────────────────────────────

describe('calculateCopyabilityScore', () => {
  it('returns 0 for empty array', () => {
    expect(calculateCopyabilityScore([])).toBe(0)
  })

  it('returns 0 for < 5 trades (not enough data)', () => {
    const trades = [
      makeTrade({ outcome: 'won', pnl: 50 }),
      makeTrade({ outcome: 'won', pnl: 50 }),
      makeTrade({ outcome: 'won', pnl: 50 }),
    ]
    expect(calculateCopyabilityScore(trades)).toBe(0)
  })

  it('returns high score for excellent trader', () => {
    // 80% win rate, good calibration, high profit factor, no losing streaks
    const trades = [
      makeTrade({ side: 'YES', entryPrice: 0.70, outcome: 'won', pnl: 100 }),
      makeTrade({ side: 'YES', entryPrice: 0.65, outcome: 'won', pnl: 80 }),
      makeTrade({ side: 'YES', entryPrice: 0.60, outcome: 'won', pnl: 60 }),
      makeTrade({ side: 'YES', entryPrice: 0.75, outcome: 'won', pnl: 120 }),
      makeTrade({ side: 'YES', entryPrice: 0.55, outcome: 'lost', pnl: -40 }),
    ]
    const score = calculateCopyabilityScore(trades)
    expect(score).toBeGreaterThan(0.6)
  })

  it('returns low score for bad trader', () => {
    // 20% win rate, bad calibration, low profit factor, long losing streaks
    const trades = [
      makeTrade({ side: 'YES', entryPrice: 0.80, outcome: 'lost', pnl: -80 }),
      makeTrade({ side: 'YES', entryPrice: 0.75, outcome: 'lost', pnl: -75 }),
      makeTrade({ side: 'YES', entryPrice: 0.90, outcome: 'lost', pnl: -90 }),
      makeTrade({ side: 'YES', entryPrice: 0.85, outcome: 'lost', pnl: -85 }),
      makeTrade({ side: 'YES', entryPrice: 0.60, outcome: 'won', pnl: 20 }),
    ]
    const score = calculateCopyabilityScore(trades)
    expect(score).toBeLessThan(0.35)
  })

  it('penalizes longshot hunters (low copyability)', () => {
    // Typical longshot pattern: 14% win rate, huge losing streaks
    const trades = [
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'lost', pnl: -5 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'won', pnl: 30 }),
      makeTrade({ side: 'YES', entryPrice: 0.05, outcome: 'won', pnl: 30 }),
    ]
    const score = calculateCopyabilityScore(trades)
    // 14% win rate, 12 consecutive losses — low copyability for small accounts
    expect(score).toBeLessThan(0.45)
  })
})

// ── calculateDecayFactor ──────────────────────────────────────────

describe('calculateDecayFactor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns 1.0 for recent trade (< 90 days)', () => {
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    expect(calculateDecayFactor(recent)).toBe(1.0)
  })

  it('returns 0.75 for trade between 90–180 days ago', () => {
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
    expect(calculateDecayFactor(old)).toBe(0.75)
  })

  it('returns 0.5 for trade > 180 days ago', () => {
    const veryOld = new Date(
      Date.now() - 200 * 24 * 60 * 60 * 1000
    ).toISOString()
    expect(calculateDecayFactor(veryOld)).toBe(0.5)
  })

  it('returns 1.0 for trade today', () => {
    expect(calculateDecayFactor(new Date().toISOString())).toBe(1.0)
  })
})

// ── calculateImplicitEdge ─────────────────────────────────────────

describe('calculateImplicitEdge', () => {
  it('returns 0 for empty trades', () => {
    expect(calculateImplicitEdge([])).toBe(0)
  })

  it('returns positive edge when wallet beats market probability', () => {
    // Wallet bets YES at 30¢ (market says 30% chance) and wins
    // edge = 1 - 0.30 = +0.70 per trade
    const trades = [
      makeTrade({ entryPrice: 0.30, side: 'YES', outcome: 'won' }),
      makeTrade({ entryPrice: 0.30, side: 'YES', outcome: 'won' }),
    ]
    expect(calculateImplicitEdge(trades)).toBeCloseTo(0.70, 2)
  })

  it('returns negative edge when wallet loses on high-probability bets', () => {
    // Wallet bets YES at 80¢ and loses — worse than market
    // edge = 0 - 0.80 = -0.80
    const trades = [
      makeTrade({ entryPrice: 0.80, side: 'YES', outcome: 'lost' }),
    ]
    expect(calculateImplicitEdge(trades)).toBeCloseTo(-0.80, 2)
  })

  it('returns ~0 when wallet wins exactly as often as the market predicts', () => {
    // At 50¢, market says 50/50. Wallet wins half the time → edge ≈ 0
    const trades = [
      makeTrade({ entryPrice: 0.50, side: 'YES', outcome: 'won' }),
      makeTrade({ entryPrice: 0.50, side: 'YES', outcome: 'lost' }),
    ]
    // edge = ((1-0.5) + (0-0.5)) / 2 = (0.5 - 0.5) / 2 = 0
    expect(calculateImplicitEdge(trades)).toBeCloseTo(0, 2)
  })

  it('handles NO side correctly', () => {
    // Wallet bets NO at 70¢ → marketProb for NO = 1 - 0.70 = 0.30
    // If NO wins (outcome='won'): edge = 1 - 0.30 = +0.70
    const trades = [
      makeTrade({ entryPrice: 0.70, side: 'NO', outcome: 'won' }),
    ]
    expect(calculateImplicitEdge(trades)).toBeCloseTo(0.70, 2)
  })

  it('computes correct average across mixed trades', () => {
    // Trade 1: YES @30¢, won → edge = +0.70
    // Trade 2: YES @30¢, lost → edge = -0.30
    // Trade 3: YES @30¢, won → edge = +0.70
    // avg = (0.70 - 0.30 + 0.70) / 3 = 1.10/3 ≈ +0.367
    const trades = [
      makeTrade({ entryPrice: 0.30, side: 'YES', outcome: 'won' }),
      makeTrade({ entryPrice: 0.30, side: 'YES', outcome: 'lost' }),
      makeTrade({ entryPrice: 0.30, side: 'YES', outcome: 'won' }),
    ]
    expect(calculateImplicitEdge(trades)).toBeCloseTo(1.10 / 3, 2)
  })
})

// ── Constants ─────────────────────────────────────────────────────

describe('MIN_TRADES_FOR_ATTESTATION', () => {
  it('is 5', () => {
    expect(MIN_TRADES_FOR_ATTESTATION).toBe(5)
  })
})
