import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  getCompositeScore,
  getTopPredictors,
  getTrustPath,
  type TrustScore,
} from '../../src/lib/trust-mcp'

// ── Helpers ───────────────────────────────────────────────────────

const VALID_SCORE: TrustScore = {
  compositeScore: 0.87,
  agentRank: 42,
  eigenTrust: 0.91,
  lastComputed: '2025-06-01T00:00:00Z',
}

function mockMcpResponse(result: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok,
        status: ok ? 200 : 404,
        json: () => Promise.resolve({ result }),
      })
    )
  )
}

function mockMcpError(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Network error')))
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

// ── getCompositeScore ─────────────────────────────────────────────

describe('getCompositeScore', () => {
  it('returns TrustScore when MCP responds successfully', async () => {
    mockMcpResponse(VALID_SCORE)

    const result = await getCompositeScore('0xWallet', 'pm-domain/ai-tech')

    expect(result).not.toBeNull()
    expect(result!.compositeScore).toBe(0.87)
    expect(result!.agentRank).toBe(42)
    expect(result!.eigenTrust).toBe(0.91)
    expect(result!.lastComputed).toBe('2025-06-01T00:00:00Z')
  })

  it('returns null when MCP responds 404', async () => {
    mockMcpResponse(null, false)

    const result = await getCompositeScore('0xUnknown', 'pm-domain/crypto')

    expect(result).toBeNull()
  })

  it('returns null on network error', async () => {
    mockMcpError()

    const result = await getCompositeScore('0xWallet', 'pm-domain/sports')

    expect(result).toBeNull()
  })
})

// ── getTopPredictors ──────────────────────────────────────────────

describe('getTopPredictors', () => {
  it('returns sorted list of predictors by composite score', async () => {
    mockMcpResponse([
      {
        address: '0xLow',
        score: { ...VALID_SCORE, compositeScore: 0.5 },
        trades: 10,
      },
      {
        address: '0xHigh',
        score: { ...VALID_SCORE, compositeScore: 0.95 },
        trades: 20,
      },
      {
        address: '0xMid',
        score: { ...VALID_SCORE, compositeScore: 0.75 },
        trades: 15,
      },
    ])

    const result = await getTopPredictors('pm-domain/ai-tech')

    expect(result).toHaveLength(3)
    expect(result[0]!.address).toBe('0xHigh')
    expect(result[1]!.address).toBe('0xMid')
    expect(result[2]!.address).toBe('0xLow')
  })

  it('filters by minTrades when specified', async () => {
    mockMcpResponse([
      {
        address: '0xFew',
        score: { ...VALID_SCORE, compositeScore: 0.99 },
        trades: 3,
      },
      {
        address: '0xMany',
        score: { ...VALID_SCORE, compositeScore: 0.8 },
        trades: 20,
      },
    ])

    const result = await getTopPredictors('pm-domain/crypto', 5)

    expect(result).toHaveLength(1)
    expect(result[0]!.address).toBe('0xMany')
  })

  it('returns empty array on MCP error', async () => {
    mockMcpError()

    const result = await getTopPredictors('pm-domain/economics')

    expect(result).toEqual([])
  })
})

// ── getTrustPath ──────────────────────────────────────────────────

describe('getTrustPath', () => {
  it('returns array of intermediate wallets', async () => {
    mockMcpResponse({ path: ['0xA', '0xB', '0xC', '0xD'] })

    const result = await getTrustPath('0xA', '0xD')

    expect(result).toEqual(['0xA', '0xB', '0xC', '0xD'])
    expect(result).toHaveLength(4)
  })

  it('returns empty array when no path exists', async () => {
    mockMcpResponse({ path: [] })

    const result = await getTrustPath('0xIsolated', '0xOther')

    expect(result).toEqual([])
  })

  it('returns empty array on MCP error', async () => {
    mockMcpError()

    const result = await getTrustPath('0xA', '0xB')

    expect(result).toEqual([])
  })
})
