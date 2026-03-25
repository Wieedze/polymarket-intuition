import { describe, it, expect } from 'vitest'
import { classifyMarket, keywordClassify } from '../../src/lib/classifier'

// ── Keyword classifier unit tests ─────────────────────────────────

describe('keywordClassify', () => {
  it('classifies AI/tech questions', () => {
    const result = keywordClassify('Will OpenAI release GPT-5 before July?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/ai-tech')
  })

  it('classifies politics questions', () => {
    const result = keywordClassify('Will Trump win the 2024 presidential election?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/politics')
  })

  it('classifies crypto questions', () => {
    const result = keywordClassify('Will Bitcoin ETF be approved by the SEC?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/crypto')
  })

  it('classifies sports questions', () => {
    const result = keywordClassify('Who will win the NBA championship 2025?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/sports')
  })

  it('classifies economics questions', () => {
    const result = keywordClassify('Will the Fed cut interest rates at the next FOMC meeting?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/economics')
  })

  it('classifies science questions', () => {
    const result = keywordClassify('Will FDA approve the new Alzheimer drug in clinical trial?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/science')
  })

  it('classifies culture questions', () => {
    const result = keywordClassify('Will Oppenheimer win the Oscar for Best Picture?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/culture')
  })

  it('classifies weather questions', () => {
    const result = keywordClassify('Will the highest temperature in Phoenix exceed 120 fahrenheit?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/weather')
  })

  it('classifies geopolitics questions', () => {
    const result = keywordClassify('Will Russia and Ukraine reach a ceasefire before 2025?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/geopolitics')
  })

  it('returns null for unclassifiable questions', () => {
    const result = keywordClassify('Will my cat learn to fly?')
    expect(result).toBeNull()
  })

  it('breaks ties using domain priority', () => {
    // "China sanctions AI chip" → matches geopolitics (china, sanctions) and ai-tech (ai, chip)
    const result = keywordClassify('Will China impose sanctions on AI chip exports?')
    expect(result).not.toBeNull()
    // geopolitics has higher priority than ai-tech
    expect(result!.domain).toBe('pm-domain/geopolitics')
  })

  it('is case insensitive', () => {
    const result = keywordClassify('WILL BITCOIN HIT $100K?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/crypto')
  })

  it('handles multi-word keywords', () => {
    const result = keywordClassify('Will the interest rate be raised next quarter?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/economics')
  })

  // ── Pattern-based classification (matchups, spreads, teams) ───
  it('classifies "Team vs. Team" matchups as sports', () => {
    expect(keywordClassify('Jets vs. Patriots')!.domain).toBe('pm-domain/sports')
    expect(keywordClassify('Bucks vs. Cavaliers')!.domain).toBe('pm-domain/sports')
    expect(keywordClassify('Golden Knights vs. Devils')!.domain).toBe('pm-domain/sports')
  })

  it('classifies spread bets as sports', () => {
    expect(keywordClassify('Spread: Pistons (-9.5)')!.domain).toBe('pm-domain/sports')
    expect(keywordClassify('Spread: Lakers (-7.5)')!.domain).toBe('pm-domain/sports')
  })

  it('classifies O/U bets as sports', () => {
    expect(keywordClassify('Bills vs. Steelers: O/U 45.5')!.domain).toBe('pm-domain/sports')
  })

  it('classifies esports as sports', () => {
    expect(keywordClassify('Counter-Strike: Passion UA vs Liquid (BO3)')!.domain).toBe('pm-domain/sports')
  })

  it('classifies soccer matchups as sports', () => {
    expect(keywordClassify('Barcelona vs. Madrid')!.domain).toBe('pm-domain/sports')
  })

  it('classifies "Maduro out by" as politics', () => {
    expect(keywordClassify('Maduro out by March 31, 2026?')!.domain).toBe('pm-domain/politics')
  })

  it('classifies "Netanyahu out by" as politics', () => {
    expect(keywordClassify('Netanyahu out by March 31?')!.domain).toBe('pm-domain/politics')
  })

  it('classifies Trump nominate as politics', () => {
    expect(keywordClassify('Will Trump nominate no one before 2027?')!.domain).toBe('pm-domain/politics')
  })

  it('classifies top grossing movie as culture', () => {
    expect(keywordClassify('Will Lilo & Stitch be the top grossing movie of 2025?')!.domain).toBe('pm-domain/culture')
  })

  it('classifies FDV/market cap as crypto', () => {
    expect(keywordClassify('Lighter FDV above $3B one day after launch?')!.domain).toBe('pm-domain/crypto')
  })

  it('classifies "Will Kazakhstan win on" as sports', () => {
    expect(keywordClassify('Will Kazakhstan win on 2025-10-10?')!.domain).toBe('pm-domain/sports')
  })

  it('classifies "US Open" tennis as sports', () => {
    expect(keywordClassify('US Open: Jiri Lehecka vs Carlos Alcaraz')!.domain).toBe('pm-domain/sports')
  })
})

// ── classifyMarket (full pipeline) ────────────────────────────────

describe('classifyMarket', () => {
  it('classifies FIDE Candidates Tournament → sports', async () => {
    const result = await classifyMarket('Will Anish Giri win the 2026 FIDE Candidates Tournament?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/sports')
  })

  it('classifies earthquakes → science', async () => {
    const result = await classifyMarket('Will there be between 8 and 10 earthquakes of magnitude 7.0?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/science')
  })

  it('classifies hottest year → science', async () => {
    const result = await classifyMarket('Will 2026 be the hottest year on record?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/science')
  })

  it('classifies temperature in city → weather', async () => {
    const result = await classifyMarket('Highest temperature in Seoul on March 25?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/weather')
  })

  it('classifies GPT-5 release → ai-tech', async () => {
    const result = await classifyMarket('Will GPT-5 release before June 2026?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/ai-tech')
  })

  it('classifies Fed rate cut → economics', async () => {
    const result = await classifyMarket('Will the Fed cut rates in March?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/economics')
  })

  it('classifies Russia invasion → geopolitics', async () => {
    const result = await classifyMarket('Will Russia invade another country?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/geopolitics')
  })

  it('classifies Bitcoin 100K → crypto', async () => {
    const result = await classifyMarket('Will Bitcoin reach $100K?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/crypto')
  })

  it('classifies World Cup → sports', async () => {
    const result = await classifyMarket('Will France win the World Cup 2026?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/sports')
  })

  it('classifies earthquake magnitude 8 → science', async () => {
    const result = await classifyMarket('Will there be an earthquake of magnitude 8.0?')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/science')
  })

  it('returns null for unknown titles', async () => {
    const result = await classifyMarket('Will the number 42 be chosen?')
    expect(result).toBeNull()
  })

  it('accepts optional category hint parameter', async () => {
    const result = await classifyMarket('Will Bitcoin hit $200K?', 'Crypto')
    expect(result).not.toBeNull()
    expect(result!.domain).toBe('pm-domain/crypto')
  })
})

// ── Real-world market questions (precision benchmark) ─────────────

describe('classifier precision on real markets', () => {
  const testCases: Array<{ question: string; expected: string }> = [
    // AI / Tech
    { question: 'Will ChatGPT have 500M users by end of 2025?', expected: 'pm-domain/ai-tech' },
    { question: 'Will Nvidia stock price exceed $200?', expected: 'pm-domain/ai-tech' },
    { question: 'Will Apple release a new AI chip in 2025?', expected: 'pm-domain/ai-tech' },
    { question: 'Will Google Gemini surpass GPT-4 on benchmarks?', expected: 'pm-domain/ai-tech' },
    { question: 'Will Anthropic Claude 4 be released?', expected: 'pm-domain/ai-tech' },

    // Politics
    { question: 'Will Joe Biden run for president in 2028?', expected: 'pm-domain/politics' },
    { question: 'Will Republicans win the Senate in 2026?', expected: 'pm-domain/politics' },
    { question: 'Will Trump be the Republican nominee?', expected: 'pm-domain/politics' },
    { question: 'Will the UK Prime Minister resign before 2026?', expected: 'pm-domain/politics' },
    { question: 'Will voter turnout exceed 60% in the midterm election?', expected: 'pm-domain/politics' },

    // Crypto
    { question: 'Will Bitcoin price reach $150k in 2025?', expected: 'pm-domain/crypto' },
    { question: 'Will Ethereum ETF be approved by SEC?', expected: 'pm-domain/crypto' },
    { question: 'Will Solana flip Ethereum in daily transactions?', expected: 'pm-domain/crypto' },
    { question: 'Will a new stablecoin surpass USDT in market cap?', expected: 'pm-domain/crypto' },
    { question: 'Will the next Bitcoin halving affect price significantly?', expected: 'pm-domain/crypto' },

    // Sports
    { question: 'Will the Lakers win the NBA Finals?', expected: 'pm-domain/sports' },
    { question: 'Who will win Super Bowl LIX?', expected: 'pm-domain/sports' },
    { question: 'Will Messi play in the 2026 World Cup?', expected: 'pm-domain/sports' },
    { question: 'Will a UFC fighter break the knockout record?', expected: 'pm-domain/sports' },
    { question: 'Will the Premier League have a new champion this season?', expected: 'pm-domain/sports' },

    // Economics
    { question: 'Will the Fed raise rates in March 2025?', expected: 'pm-domain/economics' },
    { question: 'Will US CPI exceed 4% year over year?', expected: 'pm-domain/economics' },
    { question: 'Will GDP growth exceed 3% in Q1 2025?', expected: 'pm-domain/economics' },
    { question: 'Will unemployment rate fall below 3.5%?', expected: 'pm-domain/economics' },
    { question: 'Will the FOMC announce quantitative tightening?', expected: 'pm-domain/economics' },

    // Science
    { question: 'Will FDA approve a new cancer drug in 2025?', expected: 'pm-domain/science' },
    { question: 'Will SpaceX land humans on Mars before 2030?', expected: 'pm-domain/science' },
    { question: 'Will a new pandemic be declared by WHO?', expected: 'pm-domain/science' },
    { question: 'Will NASA Artemis mission reach the Moon?', expected: 'pm-domain/science' },
    { question: 'Will a clinical trial for mRNA vaccine succeed?', expected: 'pm-domain/science' },

    // Culture
    { question: 'Will Barbie 2 win the Oscar for Best Picture?', expected: 'pm-domain/culture' },
    { question: 'Will Taylor Swift release a new album in 2025?', expected: 'pm-domain/culture' },
    { question: 'Will Netflix reach 300M subscribers?', expected: 'pm-domain/culture' },
    { question: 'Will the Grammy for Album of the Year go to a hip-hop artist?', expected: 'pm-domain/culture' },
    { question: 'Will Disney+ surpass Netflix in subscribers?', expected: 'pm-domain/culture' },

    // Weather
    { question: 'Will a Category 5 hurricane hit Florida in 2025?', expected: 'pm-domain/weather' },
    { question: 'Will the temperature in Death Valley exceed 55 celsius?', expected: 'pm-domain/weather' },
    { question: 'Will a major storm cause $10B+ damage?', expected: 'pm-domain/weather' },
    { question: 'Will there be a tornado in Oklahoma this spring?', expected: 'pm-domain/weather' },
    { question: 'Will the drought in California end by winter?', expected: 'pm-domain/weather' },

    // Geopolitics
    { question: 'Will Russia withdraw from Ukraine by 2026?', expected: 'pm-domain/geopolitics' },
    { question: 'Will China invade Taiwan before 2027?', expected: 'pm-domain/geopolitics' },
    { question: 'Will NATO add a new member state?', expected: 'pm-domain/geopolitics' },
    { question: 'Will US impose new sanctions on Iran?', expected: 'pm-domain/geopolitics' },
    { question: 'Will a ceasefire be reached in the Middle East conflict?', expected: 'pm-domain/geopolitics' },
  ]

  const total = testCases.length

  for (const { question, expected } of testCases) {
    it(`classifies: "${question.slice(0, 50)}..." → ${expected}`, () => {
      const result = keywordClassify(question)
      expect(result).not.toBeNull()
      expect(result!.domain).toBe(expected)
    })
  }

  it(`achieves > 90% precision (${total} cases)`, () => {
    let hits = 0
    for (const { question, expected } of testCases) {
      const result = keywordClassify(question)
      if (result && result.domain === expected) {
        hits++
      }
    }
    const precision = hits / total
    console.log(`\n📊 Classifier precision: ${hits}/${total} = ${(precision * 100).toFixed(1)}%\n`)
    expect(precision).toBeGreaterThan(0.9)
  })
})
