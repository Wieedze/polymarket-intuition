import { describe, it, expect, vi, beforeEach } from 'vitest'
import { scoreSignal, shouldCopySignal, signalBetMultiplier, isContradictory, kellyBetFraction } from '../../src/lib/signal-scorer'

// Mock db module
vi.mock('../../src/lib/db', () => ({
  getWalletStats: vi.fn(),
}))

import { getWalletStats } from '../../src/lib/db'

beforeEach(() => {
  vi.mocked(getWalletStats).mockReset()
})

describe('scoreSignal', () => {
  it('returns 0 for noise market (5-min crypto)', () => {
    vi.mocked(getWalletStats).mockReturnValue([])
    const signal = scoreSignal({
      expertWallet: '0xtest',
      marketTitle: 'Bitcoin Up or Down - March 25, 10:20AM-10:25AM ET',
      entryPrice: 0.50,
      positionSize: 1000,
    })
    expect(signal.score).toBe(0)
    expect(signal.reasons[0]).toContain('Noise')
  })

  it('returns 0 for narrow price range noise', () => {
    vi.mocked(getWalletStats).mockReturnValue([])
    const signal = scoreSignal({
      expertWallet: '0xtest',
      marketTitle: 'Will Google (GOOGL) close at $290-$295 on the final day of trading?',
      entryPrice: 0.50,
      positionSize: 1000,
    })
    expect(signal.score).toBe(0)
  })

  it('returns 0 for expert with no history', () => {
    vi.mocked(getWalletStats).mockReturnValue([])
    const signal = scoreSignal({
      expertWallet: '0xtest',
      marketTitle: 'Will there be a US government shutdown in 2025?',
      entryPrice: 0.50,
      positionSize: 1000,
    })
    expect(signal.score).toBe(0)
    expect(signal.reasons[0]).toContain('No historical data')
  })

  it('scores high for expert in their best domain', () => {
    vi.mocked(getWalletStats).mockReturnValue([
      {
        wallet: '0xtest', domain: 'pm-domain/politics',
        winRate: 0.65, calibration: 0.82, tradesCount: 30,
        avgConviction: 0.5, totalPnl: 5000, decayFactor: 1,
        lastTradeAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        attestedOnChain: false,
      },
    ])
    const signal = scoreSignal({
      expertWallet: '0xtest',
      marketTitle: 'Will there be a US government shutdown in 2025?',
      entryPrice: 0.45,
      positionSize: 50000,
    })
    // domain match (30) + calibration 82% (25) + WR 65% (20) + entry 45¢ (15) + whale (10) = 100
    expect(signal.score).toBeGreaterThanOrEqual(80)
    expect(signal.domainMatch).toBe(true)
  })

  it('scores low for expert outside their domain', () => {
    vi.mocked(getWalletStats).mockReturnValue([
      {
        wallet: '0xtest', domain: 'pm-domain/sports',
        winRate: 0.80, calibration: 0.85, tradesCount: 50,
        avgConviction: 0.5, totalPnl: 10000, decayFactor: 1,
        lastTradeAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        attestedOnChain: false,
      },
    ])
    const signal = scoreSignal({
      expertWallet: '0xtest',
      marketTitle: 'Will Bitcoin reach $100K?',  // crypto, not sports
      entryPrice: 0.50,
      positionSize: 1000,
    })
    // No domain match (0) + calibration from best domain (25) + WR from best (20) + entry (15) + small bet (4) = ~64
    // But domain score is 0 because no crypto history
    expect(signal.domainMatch).toBe(false)
    expect(signal.score).toBeLessThan(70)
  })

  it('gives better score for good entry price range', () => {
    vi.mocked(getWalletStats).mockReturnValue([
      {
        wallet: '0xtest', domain: 'pm-domain/sports',
        winRate: 0.55, calibration: 0.70, tradesCount: 10,
        avgConviction: 0.5, totalPnl: 1000, decayFactor: 1,
        lastTradeAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        attestedOnChain: false,
      },
    ])
    const goodEntry = scoreSignal({
      expertWallet: '0xtest',
      marketTitle: 'Will the Kansas City Chiefs win the Super Bowl?',
      entryPrice: 0.40,
      positionSize: 5000,
    })
    const badEntry = scoreSignal({
      expertWallet: '0xtest',
      marketTitle: 'Will the Kansas City Chiefs win the Super Bowl?',
      entryPrice: 0.88,
      positionSize: 5000,
    })
    expect(goodEntry.score).toBeGreaterThan(badEntry.score)
  })
})

describe('shouldCopySignal', () => {
  it('returns true for score >= 40', () => {
    expect(shouldCopySignal({ score: 40 } as ReturnType<typeof scoreSignal>)).toBe(true)
    expect(shouldCopySignal({ score: 80 } as ReturnType<typeof scoreSignal>)).toBe(true)
  })

  it('returns false for score < 40', () => {
    expect(shouldCopySignal({ score: 39 } as ReturnType<typeof scoreSignal>)).toBe(false)
    expect(shouldCopySignal({ score: 0 } as ReturnType<typeof scoreSignal>)).toBe(false)
  })
})

describe('signalBetMultiplier', () => {
  it('returns 0.5x for low signal', () => {
    expect(signalBetMultiplier({ score: 40 } as ReturnType<typeof scoreSignal>)).toBe(0.5)
  })

  it('returns 1.0x for medium signal', () => {
    expect(signalBetMultiplier({ score: 65 } as ReturnType<typeof scoreSignal>)).toBe(1.0)
  })

  it('returns 1.5x for high signal', () => {
    expect(signalBetMultiplier({ score: 85 } as ReturnType<typeof scoreSignal>)).toBe(1.5)
  })
})

describe('isContradictory', () => {
  it('returns true when opposite side on same market', () => {
    const openTrades = [
      { conditionId: 'abc123', side: 'YES', title: 'Test' },
    ]
    expect(isContradictory('abc123', 'NO', openTrades)).toBe(true)
  })

  it('returns false when same side', () => {
    const openTrades = [
      { conditionId: 'abc123', side: 'YES', title: 'Test' },
    ]
    expect(isContradictory('abc123', 'YES', openTrades)).toBe(false)
  })

  it('returns false when different market', () => {
    const openTrades = [
      { conditionId: 'abc123', side: 'YES', title: 'Test' },
    ]
    expect(isContradictory('xyz789', 'NO', openTrades)).toBe(false)
  })

  it('returns false for empty open trades', () => {
    expect(isContradictory('abc123', 'YES', [])).toBe(false)
  })
})

describe('kellyBetFraction', () => {
  it('returns 0 for no edge (50% WR at 50¢)', () => {
    // b = 1, kelly = (0.5*1 - 0.5)/1 = 0 → no edge
    expect(kellyBetFraction(0.50, 0.50)).toBe(0)
  })

  it('returns positive for good edge (60% WR at 50¢)', () => {
    // b = 1, kelly = (0.6*1 - 0.4)/1 = 0.2, quarter = 0.05
    const fraction = kellyBetFraction(0.60, 0.50)
    expect(fraction).toBeGreaterThan(0)
    expect(fraction).toBeLessThanOrEqual(0.25)
  })

  it('returns higher fraction for stronger edge', () => {
    const weak = kellyBetFraction(0.55, 0.50)
    const strong = kellyBetFraction(0.75, 0.40)
    expect(strong).toBeGreaterThan(weak)
  })

  it('returns 0 for negative edge (30% WR at 70¢)', () => {
    // Buying at 70¢ with only 30% win rate → losing proposition
    expect(kellyBetFraction(0.30, 0.70)).toBe(0)
  })

  it('caps at 0.25 even for huge edge', () => {
    expect(kellyBetFraction(0.95, 0.20)).toBeLessThanOrEqual(0.25)
  })

  it('returns 0 for invalid inputs', () => {
    expect(kellyBetFraction(0, 0.50)).toBe(0)
    expect(kellyBetFraction(0.50, 0)).toBe(0)
    expect(kellyBetFraction(0.50, 1)).toBe(0)
  })
})
