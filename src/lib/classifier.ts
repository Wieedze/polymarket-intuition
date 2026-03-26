import { DOMAIN_ATOMS, type DomainAtomValue } from './atoms'

// ── Types ─────────────────────────────────────────────────────────

export type ClassificationResult = {
  domain: DomainAtomValue
  confidence: number
} | null

// ── Weighted keyword dictionaries ─────────────────────────────────

type WeightedKeyword = { kw: string; weight: number }

const KEYWORD_MAP: Record<DomainAtomValue, WeightedKeyword[]> = {
  [DOMAIN_ATOMS.AI_TECH]: [
    ...['gpt', 'llm', 'claude', 'openai', 'anthropic', 'gemini', 'chatgpt',
      'artificial intelligence', 'machine learning'].map(kw => ({ kw, weight: 3 })),
    ...['ai model', 'benchmark', 'nvidia', 'chip', 'semiconductor', 'robot',
      'automation', 'ipo', 'tech', 'software', 'app', 'startup', 'release model',
      'cloudflare', 'incident'].map(kw => ({ kw, weight: 2 })),
    ...['technology', 'computer', 'digital', 'algorithm'].map(kw => ({ kw, weight: 1 })),
  ],
  [DOMAIN_ATOMS.POLITICS]: [
    ...['election', 'prime minister', 'president', 'chancellor', 'parliament',
      'congress', 'senate', 'referendum', 'resign', 'impeach',
      'nominate', 'nomination'].map(kw => ({ kw, weight: 3 })),
    ...['vote', 'poll', 'party', 'candidate', 'democrat', 'republican',
      'cabinet', 'minister', 'governor', 'mayor', 'seat',
      'maduro', 'netanyahu', 'zelensky', 'macron', 'biden', 'trump',
      'starmer', 'modi', 'bolsonaro', 'lula', 'machado',
      'runoff', 'drop out', 'margin of victory', 'rcv'].map(kw => ({ kw, weight: 2 })),
    ...['political', 'government', 'administration', 'coalition',
      'out by', 'win by', 'becomes law'].map(kw => ({ kw, weight: 1 })),
  ],
  [DOMAIN_ATOMS.CRYPTO]: [
    ...['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'blockchain',
      'defi', 'nft', 'solana', 'sol', 'binance', 'coinbase'].map(kw => ({ kw, weight: 3 })),
    ...['token', 'etf', 'halving', 'wallet', 'stablecoin', 'usdc',
      'layer 2', 'polygon', 'arbitrum', 'base', 'sec crypto',
      'fdv', 'market cap', 'mcap', 'public sale'].map(kw => ({ kw, weight: 2 })),
    ...['cryptocurrency', 'coin', 'decentralized', 'web3'].map(kw => ({ kw, weight: 1 })),
  ],
  [DOMAIN_ATOMS.SPORTS]: [
    ...['nba', 'nfl', 'mlb', 'nhl', 'world cup', 'super bowl', 'champions league',
      'premier league', 'wimbledon', 'fide', 'chess tournament', 'grand slam',
      'tour de france', 'formula 1', 'f1', 'ufc', 'nascar', 'la liga',
      'serie a', 'bundesliga', 'ligue 1', 'mls', 'afl', 'pga',
      'us open', 'davis cup', 'counter-strike', 'dota', 'valorant',
      'league of legends'].map(kw => ({ kw, weight: 3 })),
    ...['championship', 'playoff', 'finals', 'tournament', 'match', 'game',
      'season', 'league', 'cup', 'medal', 'gold medal', 'olympics',
      'spread:', 'o/u', 'vs.', ' vs ', '(bo3)', '(bo5)'].map(kw => ({ kw, weight: 2 })),
    ...['patriots', 'chiefs', 'eagles', 'bills', 'ravens', 'lions',
      'cowboys', 'dolphins', 'jets', 'packers', 'vikings', 'bears',
      'colts', 'bengals', 'rams', 'chargers', 'seahawks', 'cardinals',
      'broncos', 'raiders', 'buccaneers', 'commanders', 'steelers',
      'jaguars', '49ers', 'giants', 'saints', 'falcons', 'titans',
      'texans', 'panthers', 'browns'].map(kw => ({ kw, weight: 2 })),
    ...['lakers', 'celtics', 'warriors', 'bucks', 'nuggets', 'cavaliers',
      'clippers', '76ers', 'knicks', 'pistons', 'timberwolves', 'heat',
      'nets', 'rockets', 'suns', 'spurs', 'thunder', 'grizzlies',
      'pelicans', 'raptors', 'wizards', 'hornets', 'blazers',
      'mavericks', 'hawks', 'pacers', 'kings', 'jazz', 'magic'].map(kw => ({ kw, weight: 2 })),
    ...['golden knights', 'devils', 'blackhawks', 'kraken', 'penguins',
      'bruins', 'rangers', 'maple leafs', 'oilers', 'avalanche',
      'hurricanes', 'panthers', 'flames', 'canucks', 'capitals',
      'red wings', 'blue jackets', 'senators', 'islanders'].map(kw => ({ kw, weight: 2 })),
    ...['barcelona', 'madrid', 'panathinaikos', 'liverpool', 'chelsea',
      'arsenal', 'man city', 'manchester', 'bayern', 'juventus',
      'inter', 'psg', 'dortmund', 'atletico', 'roma', 'napoli',
      'milan', 'tottenham', 'benfica', 'porto'].map(kw => ({ kw, weight: 2 })),
    ...['oregon', 'virginia', 'tulane', 'north texas', 'alabama',
      'michigan', 'ohio state', 'georgia', 'clemson', 'texas'].map(kw => ({ kw, weight: 1 })),
    ...['sport', 'athlete', 'team', 'player', 'coach', 'win the',
      'win on'].map(kw => ({ kw, weight: 1 })),
  ],
  [DOMAIN_ATOMS.ECONOMICS]: [
    ...['cpi', 'inflation', 'fed ', 'federal reserve', 'interest rate', 'gdp',
      'nfp', 'fomc', 'recession', 'unemployment', 'bls', 'pce'].map(kw => ({ kw, weight: 3 })),
    ...['rate cut', 'rate hike', 'tariff', 'trade war', 'debt ceiling',
      'treasury', 'yield', 'bond', 'stock market', 's&p', 'dow jones',
      'earnings', 'quarterly'].map(kw => ({ kw, weight: 2 })),
    ...['economy', 'economic', 'market', 'financial', 'fiscal', 'monetary'].map(kw => ({ kw, weight: 1 })),
  ],
  [DOMAIN_ATOMS.SCIENCE]: [
    ...['earthquake', 'magnitude', 'seismic', 'fda', 'vaccine', 'clinical trial',
      'nasa', 'spacex', 'rocket launch', 'mars', 'moon landing', 'cancer',
      'hottest year', 'record temperature', 'global temperature',
      'megaquake', 'meteor'].map(kw => ({ kw, weight: 3 })),
    ...['drug approval', 'study', 'research', 'discovery', 'virus', 'pandemic',
      'asteroid', 'satellite', 'space', 'climate record', 'sea level',
      'hottest on record', 'measles', 'outbreak', 'cases in the u.s'].map(kw => ({ kw, weight: 2 })),
    ...['scientific', 'biology', 'physics', 'chemistry', 'medical'].map(kw => ({ kw, weight: 1 })),
  ],
  [DOMAIN_ATOMS.CULTURE]: [
    ...['oscar', 'grammy', 'emmy', 'golden globe', 'box office', 'billboard',
      'spotify streams', 'album', 'tour', 'concert', 'film', 'movie release',
      'netflix', 'streaming'].map(kw => ({ kw, weight: 3 })),
    ...['celebrity', 'award', 'chart', 'single', 'tv show', 'series',
      'ticket sales', 'mrbeast', 'youtube',
      'movie', 'grossing', 'domestic gross'].map(kw => ({ kw, weight: 2 })),
    ...['entertainment', 'music', 'pop culture', 'viral'].map(kw => ({ kw, weight: 1 })),
  ],
  [DOMAIN_ATOMS.WEATHER]: [
    ...['temperature', 'celsius', 'fahrenheit', 'highest temp', 'lowest temp',
      'hurricane', 'typhoon', 'cyclone', 'tornado', 'flood', 'wildfire',
      'snow', 'rainfall', 'drought'].map(kw => ({ kw, weight: 3 })),
    ...['storm', 'heatwave', 'heat wave', 'cold wave', 'blizzard',
      'precipitation', 'forecast', 'weather'].map(kw => ({ kw, weight: 2 })),
    ...['climate', 'atmospheric', 'degrees'].map(kw => ({ kw, weight: 1 })),
  ],
  [DOMAIN_ATOMS.GEOPOLITICS]: [
    ...['war', 'invasion', 'ceasefire', 'nato', 'sanctions', 'airstrike',
      'troops', 'military', 'missile', 'nuclear', 'coup', 'annexation'].map(kw => ({ kw, weight: 3 })),
    ...['russia', 'ukraine', 'china', 'taiwan', 'iran', 'israel', 'north korea',
      'conflict', 'treaty', 'diplomatic', 'alliance'].map(kw => ({ kw, weight: 2 })),
    ...['geopolitical', 'foreign policy', 'international relations'].map(kw => ({ kw, weight: 1 })),
  ],
}

// ── Priority order for tie-breaking ──────────────────────────────

const DOMAIN_PRIORITY: DomainAtomValue[] = [
  DOMAIN_ATOMS.GEOPOLITICS,
  DOMAIN_ATOMS.POLITICS,
  DOMAIN_ATOMS.SCIENCE,
  DOMAIN_ATOMS.ECONOMICS,
  DOMAIN_ATOMS.CRYPTO,
  DOMAIN_ATOMS.AI_TECH,
  DOMAIN_ATOMS.SPORTS,
  DOMAIN_ATOMS.CULTURE,
  DOMAIN_ATOMS.WEATHER,
]

// ── Keyword classifier ────────────────────────────────────────────

function keywordClassify(text: string): ClassificationResult {
  const lower = ` ${text.toLowerCase()} `

  let bestDomain: DomainAtomValue | null = null
  let bestScore = 0
  let bestPriority = Infinity

  for (const [domain, keywords] of Object.entries(KEYWORD_MAP) as Array<[DomainAtomValue, WeightedKeyword[]]>) {
    let score = 0
    for (const { kw, weight } of keywords) {
      if (lower.includes(kw)) {
        score += weight
      }
    }

    if (score === 0) continue

    const priority = DOMAIN_PRIORITY.indexOf(domain)

    if (score > bestScore || (score === bestScore && priority < bestPriority)) {
      bestDomain = domain
      bestScore = score
      bestPriority = priority
    }
  }

  if (!bestDomain) return null

  const confidence = Math.min(bestScore / 3, 1)

  return { domain: bestDomain, confidence }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Classify a prediction market question into a domain.
 * Pure keyword scoring — deterministic, no external calls.
 */
export async function classifyMarket(
  question: string,
  _category?: string
): Promise<ClassificationResult> {
  return keywordClassify(question)
}

// Exported for testing
export { keywordClassify }
