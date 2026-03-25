import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchResolvedTrades } from '../../src/lib/polymarket'

// ── Mock data ─────────────────────────────────────────────────────

// Closed positions: mix of resolved wins, losses, and mid-market (filtered out)
const mockClosedPositions = [
  {
    conditionId: '0xabc111',
    asset: 'token-1',
    title: 'Will Brad Lander win NYC mayor?',
    outcome: 'Yes',
    outcomeIndex: 0,
    size: 200000,
    avgPrice: 0.001,
    initialValue: 200,
    currentValue: 0,
    cashPnl: -200,
    percentPnl: -100,
    curPrice: 0,
    redeemable: true,
  },
  {
    conditionId: '0xabc222',
    asset: 'token-2',
    title: 'Will Bitcoin hit $100K in 2025?',
    outcome: 'Yes',
    outcomeIndex: 0,
    size: 1000,
    avgPrice: 0.60,
    initialValue: 600,
    currentValue: 1000,
    cashPnl: 400,
    percentPnl: 66.7,
    curPrice: 1,
    redeemable: false,
  },
  {
    conditionId: '0xabc333',
    asset: 'token-3',
    title: 'Will Trump win 2024 election?',
    outcome: 'Yes',
    outcomeIndex: 0,
    size: 5000,
    avgPrice: 0.45,
    initialValue: 2250,
    currentValue: 5000,
    cashPnl: 2750,
    percentPnl: 122.2,
    curPrice: 0.98,
    redeemable: false,
  },
  {
    conditionId: '0xabc444',
    asset: 'token-4',
    title: 'Will there be a Category 5 hurricane?',
    outcome: 'No',
    outcomeIndex: 1,
    size: 300,
    avgPrice: 0.80,
    initialValue: 240,
    currentValue: 0,
    cashPnl: -240,
    percentPnl: -100,
    curPrice: 0.02,
    redeemable: true,
  },
  // Mid-market position — should be EXCLUDED (curPrice between 0.05 and 0.95)
  {
    conditionId: '0xactive1',
    asset: 'token-5',
    title: 'Will Kamala Harris win 2028?',
    outcome: 'Yes',
    outcomeIndex: 0,
    size: 302603,
    avgPrice: 0.03,
    initialValue: 9112,
    currentValue: 8926,
    cashPnl: -185,
    percentPnl: -2,
    curPrice: 0.30,
    redeemable: false,
  },
]

// All positions (for totalPositions count)
const mockAllPositions = [
  ...mockClosedPositions,
  {
    conditionId: '0xopen1',
    asset: 'token-open',
    title: 'Some open market',
    outcome: 'Yes',
    outcomeIndex: 0,
    size: 100,
    avgPrice: 0.5,
    initialValue: 50,
    currentValue: 50,
    cashPnl: 0,
    percentPnl: 0,
    curPrice: 0.50,
    redeemable: false,
  },
]

// ── Test helpers ──────────────────────────────────────────────────

function mockFetch(closedData: unknown[], allData: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const data = url.includes('closed=true') ? closedData : allData
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(data),
      })
    })
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────

describe('fetchResolvedTrades', () => {
  it('identifies wins from positive cashPnl', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    const wins = result.trades.filter((t) => t.outcome === 'won')
    expect(wins).toHaveLength(2)
    expect(wins[0]!.pnl).toBe(400)
    expect(wins[1]!.pnl).toBe(2750)
  })

  it('identifies losses from negative cashPnl', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    const losses = result.trades.filter((t) => t.outcome === 'lost')
    expect(losses).toHaveLength(2)
    expect(losses[0]!.pnl).toBe(-200)
    expect(losses[1]!.pnl).toBe(-240)
  })

  it('excludes mid-market positions (curPrice between 0.05 and 0.95)', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    // 5 closed positions, but one has curPrice=0.30 → excluded
    expect(result.trades).toHaveLength(4)
    const harris = result.trades.find((t) => t.marketId === '0xactive1')
    expect(harris).toBeUndefined()
  })

  it('includes positions with curPrice near 1 (> 0.95)', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    const trump = result.trades.find((t) => t.marketId === '0xabc333')
    expect(trump).toBeDefined()
    expect(trump!.outcome).toBe('won')
    // curPrice=0.98 > 0.95 → included
  })

  it('uses avgPrice as entryPrice', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    const btc = result.trades.find((t) => t.marketId === '0xabc222')
    expect(btc!.entryPrice).toBe(0.60)
  })

  it('uses initialValue as size (USDC invested)', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    const btc = result.trades.find((t) => t.marketId === '0xabc222')
    expect(btc!.size).toBe(600)
  })

  it('maps side from outcomeIndex (0=YES, 1=NO)', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    const btcWin = result.trades.find((t) => t.marketId === '0xabc222')
    expect(btcWin!.side).toBe('YES') // outcomeIndex=0

    const hurricane = result.trades.find((t) => t.marketId === '0xabc444')
    expect(hurricane!.side).toBe('NO') // outcomeIndex=1
  })

  it('calculates totalPnl correctly', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    // -200 + 400 + 2750 + -240 = 2710
    expect(result.totalPnl).toBe(2710)
  })

  it('counts totalTrades and totalPositions separately', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    expect(result.totalTrades).toBe(4) // resolved only
    expect(result.totalPositions).toBe(6) // all positions
  })

  it('returns empty trades when no closed positions', async () => {
    mockFetch([], [])

    const result = await fetchResolvedTrades('0xEmpty')
    expect(result.trades).toHaveLength(0)
    expect(result.totalTrades).toBe(0)
    expect(result.totalPnl).toBe(0)
  })

  it('throws on non-200 API response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 429,
          json: () => Promise.resolve({ error: 'rate limited' }),
        })
      )
    )

    await expect(fetchResolvedTrades('0xFail')).rejects.toThrow(
      'Polymarket API error: 429'
    )
  })

  it('sets address on the result', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xAddr')
    expect(result.address).toBe('0xAddr')
  })

  it('produces correct win rate (50% in mock data)', async () => {
    mockFetch(mockClosedPositions, mockAllPositions)

    const result = await fetchResolvedTrades('0xUSER')

    const winRate = result.trades.filter((t) => t.outcome === 'won').length / result.trades.length
    expect(winRate).toBe(0.5)
  })
})
