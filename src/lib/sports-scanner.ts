import { keywordClassify } from './classifier'
import { fetchMarketMetadata } from './polymarket'
import { saveSportsMarket, deactivateOldSportsMarkets, type SportsMarketRow } from './db'

// ── Types ─────────────────────────────────────────────────────────

export type ParsedMarket = {
  homeTeam: string | null
  awayTeam: string | null
  marketType: 'moneyline' | 'spread' | 'total' | 'btts' | 'prop' | 'unknown'
  lineValue: number | null
}

type GammaMarket = {
  conditionId: string
  question: string
  clobTokenIds: string | string[]
  outcomePrices: string | string[]
  liquidity: string
  endDate?: string
  active: boolean
  closed: boolean
}

// ── Sport key detection ──────────────────────────────────────────

const LEAGUE_TO_SPORT_KEY: Array<[RegExp, string]> = [
  // US sports
  [/\bnba\b/i, 'basketball_nba'],
  [/\bwnba\b/i, 'basketball_wnba'],
  [/\bnfl\b/i, 'americanfootball_nfl'],
  [/\bmlb\b/i, 'baseball_mlb'],
  [/\bnhl\b/i, 'icehockey_nhl'],
  [/\bufc\b/i, 'mma_mixed_martial_arts'],
  [/\bmma\b/i, 'mma_mixed_martial_arts'],
  [/\bnascar\b/i, 'motorsport_nascar'],
  [/\bformula 1\b|\bf1\b/i, 'motorsport_formula1'],
  [/\bmls\b/i, 'soccer_usa_mls'],
  // European soccer
  [/\bpremier league\b|\bepl\b/i, 'soccer_epl'],
  [/\bla liga\b/i, 'soccer_spain_la_liga'],
  [/\bserie a\b/i, 'soccer_italy_serie_a'],
  [/\bbundesliga\b/i, 'soccer_germany_bundesliga'],
  [/\bligue 1\b/i, 'soccer_france_ligue_one'],
  [/\bchampions league\b|\bucl\b/i, 'soccer_uefa_champions_league'],
  [/\beuropa league\b/i, 'soccer_uefa_europa_league'],
  // Fallback sport detection from team names
  [/\b(lakers|celtics|warriors|bucks|nuggets|cavaliers|clippers|76ers|knicks|heat|nets|rockets|suns|spurs|thunder|grizzlies|pelicans|raptors|wizards|hornets|blazers|mavericks|hawks|pacers|kings|jazz|magic|pistons|timberwolves)\b/i, 'basketball_nba'],
  [/\b(chiefs|eagles|bills|ravens|lions|cowboys|dolphins|jets|packers|vikings|bears|colts|bengals|rams|chargers|seahawks|cardinals|broncos|raiders|buccaneers|commanders|steelers|jaguars|49ers|giants|saints|falcons|titans|texans|panthers|browns|patriots)\b/i, 'americanfootball_nfl'],
  [/\b(yankees|dodgers|astros|braves|phillies|mets|cubs|red sox|padres|orioles|guardians|rangers|mariners|twins|blue jays|brewers|diamondbacks|rays|reds|white sox|pirates|nationals|royals|angels|tigers|rockies|marlins|athletics)\b/i, 'baseball_mlb'],
  [/\b(oilers|golden knights|panthers|avalanche|bruins|rangers|hurricanes|maple leafs|devils|penguins|flames|canucks|capitals|red wings|blackhawks|kraken|senators|islanders|blue jackets)\b/i, 'icehockey_nhl'],
  [/\b(barcelona|real madrid|liverpool|chelsea|arsenal|man city|manchester city|bayern|juventus|inter|psg|dortmund|atletico|roma|napoli|milan|tottenham|benfica|porto)\b/i, 'soccer_epl'],
]

export function detectSportKey(title: string): string | null {
  for (const [pattern, key] of LEAGUE_TO_SPORT_KEY) {
    if (pattern.test(title)) return key
  }
  return null
}

// ── Title parsing ────────────────────────────────────────────────

const OVER_UNDER_RE = /^(.+?)\s+vs\.?\s+(.+?):\s+O\/U\s+([\d.]+)$/i
const SPREAD_RE = /^Spread:\s+(.+?)\s+\(([+-]?\d+\.?\d*)\)$/i
const BTTS_RE = /^(.+?)\s+vs\.?\s+(.+?):\s+Both Teams to Score$/i
const MONEYLINE_RE = /^(.+?)\s+vs\.?\s+(.+?)$/i

export function parseMarketTitle(title: string): ParsedMarket {
  // Order matters — most specific first
  const ou = title.match(OVER_UNDER_RE)
  if (ou) return { awayTeam: ou[1].trim(), homeTeam: ou[2].trim(), marketType: 'total', lineValue: parseFloat(ou[3]) }

  const spread = title.match(SPREAD_RE)
  if (spread) return { homeTeam: null, awayTeam: null, marketType: 'spread', lineValue: parseFloat(spread[2]) }

  const btts = title.match(BTTS_RE)
  if (btts) return { awayTeam: btts[1].trim(), homeTeam: btts[2].trim(), marketType: 'btts', lineValue: null }

  const ml = title.match(MONEYLINE_RE)
  if (ml) return { awayTeam: ml[1].trim(), homeTeam: ml[2].trim(), marketType: 'moneyline', lineValue: null }

  return { homeTeam: null, awayTeam: null, marketType: 'unknown', lineValue: null }
}

// ── Gamma API scanning ───────────────────────────────────────────

const GAMMA_API = 'https://gamma-api.polymarket.com'

export async function scanSportsMarkets(): Promise<SportsMarketRow[]> {
  const markets: SportsMarketRow[] = []
  const now = new Date().toISOString()

  // Fetch active markets from Gamma API (paginated)
  let offset = 0
  const limit = 100
  const maxPages = 5

  for (let page = 0; page < maxPages; page++) {
    const url = `${GAMMA_API}/markets?active=true&closed=false&limit=${limit}&offset=${offset}`
    let batch: GammaMarket[]
    try {
      const res = await fetch(url)
      if (!res.ok) break
      batch = await res.json() as GammaMarket[]
    } catch {
      break
    }
    if (batch.length === 0) break

    for (const m of batch) {
      // Filter: only sports markets
      const classification = keywordClassify(m.question)
      if (!classification || classification.domain !== 'pm-domain/sports') continue

      const sportKey = detectSportKey(m.question)
      const parsed = parseMarketTitle(m.question)

      // Parse token IDs (Gamma sometimes returns JSON strings)
      let tokenIds: string[] = []
      if (typeof m.clobTokenIds === 'string') {
        try { tokenIds = JSON.parse(m.clobTokenIds) as string[] } catch { continue }
      } else {
        tokenIds = m.clobTokenIds ?? []
      }
      if (tokenIds.length < 2) continue

      // Parse prices
      let prices: number[] = []
      if (typeof m.outcomePrices === 'string') {
        try { prices = (JSON.parse(m.outcomePrices) as string[]).map(Number) } catch { prices = [] }
      } else if (Array.isArray(m.outcomePrices)) {
        prices = m.outcomePrices.map(Number)
      }

      markets.push({
        conditionId: m.conditionId,
        title: m.question,
        yesTokenId: tokenIds[0],
        noTokenId: tokenIds[1],
        polymarketPrice: prices[0] ?? null,
        endDate: m.endDate ?? null,
        sportKey,
        homeTeam: parsed.homeTeam,
        awayTeam: parsed.awayTeam,
        marketType: parsed.marketType,
        lineValue: parsed.lineValue,
        lastScannedAt: now,
        active: true,
      })
    }

    offset += limit
    if (batch.length < limit) break
  }

  // Persist to DB
  for (const market of markets) {
    saveSportsMarket(market)
  }
  deactivateOldSportsMarkets(48) // mark markets older than 48h as inactive

  return markets
}

export function getActiveSportKeys(markets: SportsMarketRow[]): string[] {
  const keys = new Set<string>()
  for (const m of markets) {
    if (m.sportKey) keys.add(m.sportKey)
  }
  return [...keys]
}
