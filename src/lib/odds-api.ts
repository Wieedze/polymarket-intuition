// ── the-odds-api.com client with in-memory cache ─────────────────
// Budget: $50/month = 50,000 requests. Cache aggressively.

// ── Types ─────────────────────────────────────────────────────────

export type OddsApiOutcome = {
  name: string
  price: number    // American odds (e.g., -110, +150)
  point?: number   // spread/total line value
}

export type OddsApiMarket = {
  key: string      // 'h2h', 'spreads', 'totals'
  outcomes: OddsApiOutcome[]
}

export type OddsApiBookmaker = {
  key: string      // 'draftkings', 'fanduel', 'pinnacle', etc.
  markets: OddsApiMarket[]
}

export type OddsApiGame = {
  id: string
  sport_key: string
  home_team: string
  away_team: string
  commence_time: string
  bookmakers: OddsApiBookmaker[]
}

export type NoVigOutcome = {
  name: string
  noVigProb: number   // 0-1, fair probability after vig removal
  point?: number       // spread/total line
}

export type NoVigGame = {
  sportKey: string
  homeTeam: string
  awayTeam: string
  commenceTime: string
  markets: Array<{
    type: string       // 'h2h', 'spreads', 'totals'
    outcomes: NoVigOutcome[]
  }>
}

// ── Cache ─────────────────────────────────────────────────────────

type CacheEntry = {
  data: OddsApiGame[]
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = parseInt(process.env.ODDS_CACHE_TTL_MS ?? '300000', 10)  // 5 min default, 2h for free tier
const MIN_FETCH_INTERVAL_MS = 3 * 60 * 1000 // hard minimum 3 min between fetches per sport

let lastBudgetWarning = 0
let requestsRemaining = -1

// ── Math utilities ───────────────────────────────────────────────

export function americanToImplied(americanOdds: number): number {
  if (americanOdds > 0) return 100 / (americanOdds + 100)
  return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100)
}

export function removeVig(probabilities: number[]): number[] {
  const total = probabilities.reduce((sum, p) => sum + p, 0)
  if (total === 0) return probabilities
  return probabilities.map((p) => p / total)
}

// ── API client ───────────────────────────────────────────────────

const BASE_URL = 'https://api.the-odds-api.com/v4'

export async function fetchOddsForSport(
  sportKey: string,
  apiKey: string
): Promise<OddsApiGame[]> {
  // Check cache
  const cached = cache.get(sportKey)
  const now = Date.now()
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data
  }

  // Hard minimum between fetches (budget protection)
  if (cached && now - cached.fetchedAt < MIN_FETCH_INTERVAL_MS) {
    return cached.data
  }

  const url = `${BASE_URL}/sports/${sportKey}/odds?apiKey=${apiKey}&regions=us,eu&markets=h2h,spreads,totals&oddsFormat=american`

  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.log(`  [odds-api] Error ${res.status} for ${sportKey}`)
      return cached?.data ?? []
    }

    // Monitor budget
    const remaining = res.headers.get('x-requests-remaining')
    if (remaining) {
      requestsRemaining = parseInt(remaining, 10)
      if (requestsRemaining < 100 && now - lastBudgetWarning > 3600000) {
        console.log(`  ⚠️  [odds-api] Budget low: ${requestsRemaining} requests remaining`)
        lastBudgetWarning = now
      }
    }

    const data = (await res.json()) as OddsApiGame[]
    cache.set(sportKey, { data, fetchedAt: now })
    return data
  } catch (err) {
    console.log(`  [odds-api] Fetch error for ${sportKey}: ${err instanceof Error ? err.message : String(err)}`)
    return cached?.data ?? []
  }
}

export function getRequestsRemaining(): number {
  return requestsRemaining
}

// ── No-vig consensus computation ─────────────────────────────────

export function computeNoVigForGame(game: OddsApiGame): NoVigGame {
  const marketTypes = ['h2h', 'spreads', 'totals'] as const
  const markets: NoVigGame['markets'] = []

  for (const mType of marketTypes) {
    // Collect outcomes across all bookmakers for this market type
    const outcomeMap = new Map<string, { probs: number[]; point?: number }>()

    for (const bm of game.bookmakers) {
      const market = bm.markets.find((m) => m.key === mType)
      if (!market) continue

      for (const outcome of market.outcomes) {
        const key = outcome.name
        const implied = americanToImplied(outcome.price)
        const existing = outcomeMap.get(key)
        if (existing) {
          existing.probs.push(implied)
          if (outcome.point != null) existing.point = outcome.point
        } else {
          outcomeMap.set(key, { probs: [implied], point: outcome.point })
        }
      }
    }

    if (outcomeMap.size === 0) continue

    // Average implied probs across bookmakers, then remove vig
    const avgProbs: number[] = []
    const names: string[] = []
    const points: (number | undefined)[] = []

    for (const [name, entry] of outcomeMap) {
      names.push(name)
      avgProbs.push(entry.probs.reduce((s, p) => s + p, 0) / entry.probs.length)
      points.push(entry.point)
    }

    const noVigProbs = removeVig(avgProbs)

    markets.push({
      type: mType,
      outcomes: names.map((name, i) => ({
        name,
        noVigProb: noVigProbs[i] ?? 0,
        point: points[i],
      })),
    })
  }

  return {
    sportKey: game.sport_key,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    commenceTime: game.commence_time,
    markets,
  }
}

export async function getNoVigConsensus(
  sportKey: string,
  apiKey: string
): Promise<NoVigGame[]> {
  const games = await fetchOddsForSport(sportKey, apiKey)
  return games.map(computeNoVigForGame)
}
