import type { DomainAtomValue } from './atoms'

// ── Types ─────────────────────────────────────────────────────────

export type TrustScore = {
  compositeScore: number
  agentRank: number
  eigenTrust: number
  lastComputed: string
}

// ── MCP client ────────────────────────────────────────────────────

const MCP_URL = process.env.TRUST_MCP_URL ?? 'https://mcp.intuition.box'
const MCP_ENDPOINT = `${MCP_URL}/api/mcp`

type McpResponse<T> = {
  result?: T
  error?: { message: string }
}

async function mcpCall<T>(
  tool: string,
  params: Record<string, unknown>
): Promise<T | null> {
  try {
    const response = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, params }),
    })

    if (!response.ok) return null

    const json = (await response.json()) as McpResponse<T>
    if (json.error) return null
    return json.result ?? null
  } catch {
    return null
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Composite trust score for a wallet in a specific domain.
 * Returns null if wallet is unknown or MCP errors.
 */
export async function getCompositeScore(
  address: string,
  domain: DomainAtomValue
): Promise<TrustScore | null> {
  return mcpCall<TrustScore>('composite-score', { address, domain })
}

/**
 * Top predictors in a domain, sorted by composite score descending.
 */
export async function getTopPredictors(
  domain: DomainAtomValue,
  minTrades?: number
): Promise<Array<{ address: string; score: TrustScore }>> {
  type RawEntry = { address: string; score: TrustScore; trades?: number }

  const results = await mcpCall<RawEntry[]>('top-predictors', {
    domain,
    limit: 100,
  })

  if (!results) return []

  let filtered = results
  if (minTrades !== undefined) {
    filtered = results.filter((r) => (r.trades ?? 0) >= minTrades)
  }

  return filtered
    .sort((a, b) => b.score.compositeScore - a.score.compositeScore)
    .map(({ address, score }) => ({ address, score }))
}

/**
 * Trust path between two wallets (chain of attestations).
 * Returns empty array if no path exists.
 */
export async function getTrustPath(
  from: string,
  to: string
): Promise<string[]> {
  const result = await mcpCall<{ path: string[] }>('trust-path', { from, to })
  return result?.path ?? []
}
