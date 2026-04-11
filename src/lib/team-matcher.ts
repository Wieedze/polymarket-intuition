// ── Team name matching between Polymarket and the-odds-api ───────

// ── Alias dictionary ─────────────────────────────────────────────
// Key = canonical name (the-odds-api format)
// Values = alternative spellings found on Polymarket

const TEAM_ALIASES: Record<string, string[]> = {
  // ── NBA ──
  'Los Angeles Lakers': ['Lakers', 'LA Lakers'],
  'Los Angeles Clippers': ['Clippers', 'LA Clippers'],
  'Golden State Warriors': ['Warriors', 'GSW'],
  'Boston Celtics': ['Celtics'],
  'Milwaukee Bucks': ['Bucks'],
  'Denver Nuggets': ['Nuggets'],
  'Cleveland Cavaliers': ['Cavaliers', 'Cavs'],
  'Philadelphia 76ers': ['76ers', 'Sixers'],
  'New York Knicks': ['Knicks'],
  'Detroit Pistons': ['Pistons'],
  'Minnesota Timberwolves': ['Timberwolves', 'Wolves'],
  'Miami Heat': ['Heat'],
  'Brooklyn Nets': ['Nets'],
  'Houston Rockets': ['Rockets'],
  'Phoenix Suns': ['Suns'],
  'San Antonio Spurs': ['Spurs'],
  'Oklahoma City Thunder': ['Thunder', 'OKC'],
  'Memphis Grizzlies': ['Grizzlies'],
  'New Orleans Pelicans': ['Pelicans'],
  'Toronto Raptors': ['Raptors'],
  'Washington Wizards': ['Wizards'],
  'Charlotte Hornets': ['Hornets'],
  'Portland Trail Blazers': ['Blazers', 'Trail Blazers'],
  'Dallas Mavericks': ['Mavericks', 'Mavs'],
  'Atlanta Hawks': ['Hawks'],
  'Indiana Pacers': ['Pacers'],
  'Sacramento Kings': ['Kings'],
  'Utah Jazz': ['Jazz'],
  'Orlando Magic': ['Magic'],
  'Chicago Bulls': ['Bulls'],

  // ── NFL ──
  'Kansas City Chiefs': ['Chiefs', 'KC Chiefs'],
  'Philadelphia Eagles': ['Eagles'],
  'Buffalo Bills': ['Bills'],
  'Baltimore Ravens': ['Ravens'],
  'Detroit Lions': ['Lions'],
  'Dallas Cowboys': ['Cowboys'],
  'Miami Dolphins': ['Dolphins'],
  'New York Jets': ['Jets'],
  'Green Bay Packers': ['Packers'],
  'Minnesota Vikings': ['Vikings'],
  'Chicago Bears': ['Bears'],
  'Indianapolis Colts': ['Colts'],
  'Cincinnati Bengals': ['Bengals'],
  'Los Angeles Rams': ['Rams', 'LA Rams'],
  'Los Angeles Chargers': ['Chargers', 'LA Chargers'],
  'Seattle Seahawks': ['Seahawks'],
  'Arizona Cardinals': ['Cardinals'],
  'Denver Broncos': ['Broncos'],
  'Las Vegas Raiders': ['Raiders', 'LV Raiders'],
  'Tampa Bay Buccaneers': ['Buccaneers', 'Bucs'],
  'Washington Commanders': ['Commanders'],
  'Pittsburgh Steelers': ['Steelers'],
  'Jacksonville Jaguars': ['Jaguars', 'Jags'],
  'San Francisco 49ers': ['49ers', 'Niners'],
  'New York Giants': ['Giants'],
  'New Orleans Saints': ['Saints'],
  'Atlanta Falcons': ['Falcons'],
  'Tennessee Titans': ['Titans'],
  'Houston Texans': ['Texans'],
  'Carolina Panthers': ['Panthers'],
  'Cleveland Browns': ['Browns'],
  'New England Patriots': ['Patriots', 'Pats'],

  // ── MLB ──
  'New York Yankees': ['Yankees'],
  'Los Angeles Dodgers': ['Dodgers'],
  'Houston Astros': ['Astros'],
  'Atlanta Braves': ['Braves'],
  'Philadelphia Phillies': ['Phillies'],
  'New York Mets': ['Mets'],
  'Chicago Cubs': ['Cubs'],
  'Boston Red Sox': ['Red Sox'],
  'San Diego Padres': ['Padres'],
  'Baltimore Orioles': ['Orioles'],
  'Cleveland Guardians': ['Guardians'],
  'Texas Rangers': ['Rangers'],
  'Seattle Mariners': ['Mariners'],
  'Minnesota Twins': ['Twins'],
  'Toronto Blue Jays': ['Blue Jays'],
  'Milwaukee Brewers': ['Brewers'],
  'Arizona Diamondbacks': ['Diamondbacks', 'D-backs'],
  'Tampa Bay Rays': ['Rays'],
  'Cincinnati Reds': ['Reds'],
  'Chicago White Sox': ['White Sox'],
  'Pittsburgh Pirates': ['Pirates'],
  'Washington Nationals': ['Nationals', 'Nats'],
  'Kansas City Royals': ['Royals'],
  'Los Angeles Angels': ['Angels', 'LA Angels'],
  'Detroit Tigers': ['Tigers'],
  'Colorado Rockies': ['Rockies'],
  'Miami Marlins': ['Marlins'],
  'Oakland Athletics': ['Athletics', "A's", 'Oakland'],
  'San Francisco Giants': ['SF Giants'],
  'St. Louis Cardinals': ['Cardinals', 'STL Cardinals'],

  // ── NHL ──
  'Vegas Golden Knights': ['Golden Knights', 'VGK'],
  'New Jersey Devils': ['Devils'],
  'Chicago Blackhawks': ['Blackhawks'],
  'Seattle Kraken': ['Kraken'],
  'Pittsburgh Penguins': ['Penguins'],
  'Boston Bruins': ['Bruins'],
  'New York Rangers': ['Rangers', 'NY Rangers'],
  'Toronto Maple Leafs': ['Maple Leafs', 'Leafs'],
  'Edmonton Oilers': ['Oilers'],
  'Colorado Avalanche': ['Avalanche', 'Avs'],
  'Carolina Hurricanes': ['Hurricanes', 'Canes'],
  'Florida Panthers': ['Panthers', 'FL Panthers'],
  'Calgary Flames': ['Flames'],
  'Vancouver Canucks': ['Canucks'],
  'Washington Capitals': ['Capitals', 'Caps'],
  'Detroit Red Wings': ['Red Wings'],
  'Columbus Blue Jackets': ['Blue Jackets'],
  'Ottawa Senators': ['Senators', 'Sens'],
  'New York Islanders': ['Islanders'],
  'Dallas Stars': ['Stars'],
  'Winnipeg Jets': ['Jets', 'WPG Jets'],
  'Nashville Predators': ['Predators', 'Preds'],
  'St. Louis Blues': ['Blues'],
  'Anaheim Ducks': ['Ducks'],
  'Minnesota Wild': ['Wild'],
  'Philadelphia Flyers': ['Flyers'],
  'Montreal Canadiens': ['Canadiens', 'Habs'],
  'San Jose Sharks': ['Sharks'],
  'Buffalo Sabres': ['Sabres'],
  'Tampa Bay Lightning': ['Lightning', 'Bolts'],

  // ── European Soccer ──
  'Manchester City': ['Man City', 'Man. City', 'MCFC'],
  'Manchester United': ['Man United', 'Man Utd', 'MUFC'],
  'Tottenham Hotspur': ['Spurs', 'Tottenham'],
  'Paris Saint-Germain': ['PSG', 'Paris SG'],
  'Borussia Dortmund': ['Dortmund', 'BVB'],
  'FC Barcelona': ['Barcelona', 'Barca'],
  'Real Madrid': ['Madrid', 'Real'],
  'Atletico Madrid': ['Atletico', 'Atleti'],
  'Bayern Munich': ['Bayern', 'Bayern Munchen'],
  'Inter Milan': ['Inter', 'Internazionale'],
  'AC Milan': ['Milan'],
  'AS Roma': ['Roma'],
  'SSC Napoli': ['Napoli'],
  'Juventus': ['Juve'],
  'SL Benfica': ['Benfica'],
  'FC Porto': ['Porto'],
  'Liverpool': ['Liverpool FC'],
  'Chelsea': ['Chelsea FC'],
  'Arsenal': ['Arsenal FC'],
  'RB Leipzig': ['Leipzig'],
  'Bayer Leverkusen': ['Leverkusen'],

  // ── MMA/UFC fighters — add as needed ──
}

// ── Build reverse lookup at module load ──────────────────────────

const reverseLookup = new Map<string, string>()
for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
  const normCanon = normalize(canonical)
  reverseLookup.set(normCanon, canonical)
  for (const alias of aliases) {
    reverseLookup.set(normalize(alias), canonical)
  }
}

// ── Core functions ───────────────────────────────────────────────

function normalize(name: string): string {
  return name.toLowerCase().replace(/[.,\-']/g, '').replace(/\s+/g, ' ').trim()
}

export function normalizeTeamName(name: string): string {
  return normalize(name)
}

export function matchTeamName(polyName: string, oddsApiName: string): boolean {
  const normPoly = normalize(polyName)
  const normOdds = normalize(oddsApiName)

  // 1. Exact match
  if (normPoly === normOdds) return true

  // 2. Alias match — resolve both to canonical and compare
  const canonPoly = reverseLookup.get(normPoly)
  const canonOdds = reverseLookup.get(normOdds)
  if (canonPoly && canonOdds && canonPoly === canonOdds) return true
  if (canonPoly && normalize(canonPoly) === normOdds) return true
  if (canonOdds && normalize(canonOdds) === normPoly) return true

  // 3. Partial match — one name contains the other (e.g., "Timberwolves" in "Minnesota Timberwolves")
  if (normPoly.length >= 4 && normOdds.length >= 4) {
    if (normOdds.includes(normPoly) || normPoly.includes(normOdds)) return true
  }

  return false
}

export type GameMatch = {
  homeTeam: string    // the-odds-api canonical name
  awayTeam: string    // the-odds-api canonical name
  polyHome: string    // original Polymarket name
  polyAway: string    // original Polymarket name
}

export function findGameMatch<T extends { homeTeam: string; awayTeam: string }>(
  polyHome: string | null,
  polyAway: string | null,
  games: T[]
): (T & { matchInfo: GameMatch }) | null {
  if (!polyHome || !polyAway) return null

  for (const game of games) {
    // Try direct mapping: poly.away = odds.away, poly.home = odds.home
    const directHome = matchTeamName(polyHome, game.homeTeam)
    const directAway = matchTeamName(polyAway, game.awayTeam)
    if (directHome && directAway) {
      return { ...game, matchInfo: { homeTeam: game.homeTeam, awayTeam: game.awayTeam, polyHome, polyAway } }
    }

    // Try swapped: Polymarket often lists away first
    const swapHome = matchTeamName(polyAway, game.homeTeam)
    const swapAway = matchTeamName(polyHome, game.awayTeam)
    if (swapHome && swapAway) {
      return { ...game, matchInfo: { homeTeam: game.homeTeam, awayTeam: game.awayTeam, polyHome: polyAway, polyAway: polyHome } }
    }
  }

  return null
}
