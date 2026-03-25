# POLYMARKET × INTUITION — CLAUDE.md
> Briefing complet pour Claude Code. Lire entièrement avant chaque session.

---

## Vision du projet

Indexer les résolutions de trades Polymarket et créer des attestations Intuition
on-chain pour chaque wallet — construisant la première couche de réputation
prédictive vérifiable, permanente et composable pour les prediction markets.

**Ce que ça prouve :**
- Un wallet qui trade bien sur les marchés AI → attestation `predicted-correctly-in` → `pm-domain/ai-tech`
- Après N trades → score de réputation calibré par domaine
- Page publique partageable : `/profile/0x...`
- Trust Score MCP (EigenTrust, AgentRank) lisible depuis n'importe quel agent

---

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Framework | Next.js 14 App Router + TypeScript strict |
| UI | Tailwind CSS |
| On-chain | Wagmi v2 + Viem |
| Intuition | @0xintuition/intuition-ts SDK |
| Trust scores | Intuition Trust Score MCP (mcp.intuition.box) |
| Tests | Vitest |
| Deploy | Vercel |

**Règle TypeScript** : pas de `any`, jamais. Chaque fonction a un return type explicite.

---

## APIs externes

```
Polymarket Gamma  : https://gamma-api.polymarket.com
Polymarket Data   : https://data-api.polymarket.com
Intuition Graph   : https://graph.intuition.systems/graphql
Trust Score MCP   : https://mcp.intuition.box
Intuition RPC     : https://rpc.intuition.systems  (chain ID 1155)
```

---

## Structure du projet

```
polymarket-intuition/
├── .claude/
│   ├── CLAUDE.md                     ← CE FICHIER
│   └── commands/
│       ├── init-atoms.md             ← /init-atoms
│       ├── index-wallet.md           ← /index-wallet [address]
│       ├── check-profile.md          ← /check-profile [address]
│       ├── run-tests.md              ← /run-tests
│       └── validate-classifier.md   ← /validate-classifier
│
├── src/
│   ├── app/
│   │   ├── page.tsx                  ← Landing + barre de recherche
│   │   ├── profile/[address]/
│   │   │   └── page.tsx              ← Page profil publique
│   │   └── api/
│   │       ├── polymarket/
│   │       │   ├── trades/route.ts
│   │       │   └── classify/route.ts
│   │       ├── intuition/
│   │       │   ├── attest/route.ts
│   │       │   └── reputation/route.ts
│   │       └── trust/
│   │           └── score/route.ts
│   │
│   ├── lib/
│   │   ├── atoms.ts                  ← Constantes atomes Intuition
│   │   ├── polymarket.ts             ← Client Polymarket API
│   │   ├── classifier.ts             ← Marché → domaine
│   │   ├── scorer.ts                 ← Win rate + calibration
│   │   ├── intuition.ts              ← Client Intuition SDK
│   │   └── trust-mcp.ts             ← Client Trust Score MCP
│   │
│   ├── components/
│   │   ├── ReputationProfile.tsx
│   │   ├── DomainCard.tsx
│   │   ├── TradeHistory.tsx
│   │   ├── TrustBadge.tsx
│   │   └── SearchBar.tsx
│   │
│   └── types/
│       ├── polymarket.ts
│       ├── attestation.ts
│       └── reputation.ts
│
└── tests/
    └── lib/
        ├── polymarket.test.ts
        ├── classifier.test.ts    ← LE PLUS CRITIQUE
        ├── scorer.test.ts
        └── trust-mcp.test.ts
```

---

## Types TypeScript

### src/types/polymarket.ts

```typescript
export type ResolvedTrade = {
  id: string
  marketId: string
  marketQuestion: string
  side: 'YES' | 'NO'
  entryPrice: number
  size: number
  outcome: 'won' | 'lost'
  pnl: number
  resolvedAt: string
  transactionHash: string
}

export type WalletTrades = {
  address: string
  trades: ResolvedTrade[]
  totalTrades: number
  totalPnl: number
}
```

### src/types/attestation.ts

```typescript
export type DomainAtom =
  | 'pm-domain/ai-tech'
  | 'pm-domain/politics'
  | 'pm-domain/crypto'
  | 'pm-domain/sports'
  | 'pm-domain/economics'
  | 'pm-domain/science'
  | 'pm-domain/culture'
  | 'pm-domain/weather'
  | 'pm-domain/geopolitics'

export type PredicateAtom =
  | 'predicted-correctly-in'
  | 'predicted-incorrectly-in'
  | 'has-prediction-reputation-in'

export type AtomicAttestation = {
  subject  : `0x${string}`
  predicate: 'predicted-correctly-in' | 'predicted-incorrectly-in'
  object   : DomainAtom
  metadata : {
    platform             : 'polymarket'
    marketId             : string
    marketQuestion       : string
    conviction           : number
    entryPrice           : number
    resolvedAt           : string
    pnl                  : number
    classifierConfidence : number
  }
}

export type AggregatedAttestation = {
  subject  : `0x${string}`
  predicate: 'has-prediction-reputation-in'
  object   : DomainAtom
  metadata : {
    winRate       : number
    trades        : number
    calibration   : number
    avgConviction : number
    totalPnl      : number
    lastUpdated   : string
    source        : 'polymarket-indexer-v1'
  }
}
```

### src/types/reputation.ts

```typescript
import type { DomainAtom } from './attestation'

export type DomainReputation = {
  domain         : DomainAtom
  winRate        : number
  trades         : number
  calibration    : number
  avgConviction  : number
  totalPnl       : number
  agentRank?     : number
  compositeScore?: number
  lastUpdated    : string
}

export type WalletReputation = {
  address           : string
  domains           : DomainReputation[]
  totalAttestations : number
  computedAt        : string
}
```

---

## src/lib/atoms.ts

```typescript
export const DOMAIN_ATOMS = {
  AI_TECH     : 'pm-domain/ai-tech',
  POLITICS    : 'pm-domain/politics',
  CRYPTO      : 'pm-domain/crypto',
  SPORTS      : 'pm-domain/sports',
  ECONOMICS   : 'pm-domain/economics',
  SCIENCE     : 'pm-domain/science',
  CULTURE     : 'pm-domain/culture',
  WEATHER     : 'pm-domain/weather',
  GEOPOLITICS : 'pm-domain/geopolitics',
} as const

export const PREDICATE_ATOMS = {
  PREDICTED_CORRECTLY  : 'predicted-correctly-in',
  PREDICTED_INCORRECTLY: 'predicted-incorrectly-in',
  HAS_REPUTATION       : 'has-prediction-reputation-in',
} as const

export type DomainAtomKey   = keyof typeof DOMAIN_ATOMS
export type DomainAtomValue = typeof DOMAIN_ATOMS[DomainAtomKey]
export const ATOM_IDS: Partial<Record<DomainAtomValue | string, string>> = {}
```

---

## src/lib/polymarket.ts

- Endpoint : `{POLYMARKET_DATA_URL}/activity?user={address}&limit=500`
- Filtrer : `type === 'TRADE'` ET `outcome !== null`
- Parser side, outcome, entryPrice, size, pnl (tout en string dans l'API → number)
- totalPnl = somme de tous les pnl
- Throw `Error('Polymarket API error: {status}')` si non-200

---

## src/lib/classifier.ts

**LE COMPOSANT LE PLUS CRITIQUE.**

Stratégie : keywords matching → si confiance < 0.85 → LLM fallback → si confiance < 0.70 → null

```typescript
export type ClassificationResult = {
  domain    : DomainAtomValue
  confidence: number
} | null

export async function classifyMarket(
  question: string,
  category?: string
): Promise<ClassificationResult>
```

Keywords par domaine :
- ai-tech : ai, gpt, claude, openai, llm, nvidia, chip, robot, tech, software, ipo
- politics : election, president, congress, vote, trump, prime minister, party
- crypto : bitcoin, btc, ethereum, eth, defi, nft, token, coinbase, etf, halving
- sports : nba, nfl, world cup, super bowl, championship, tournament, match
- economics : fed, cpi, inflation, gdp, interest rate, recession, nfp, fomc
- science : fda, vaccine, nasa, spacex, rocket, mars, clinical trial, disease
- culture : oscar, grammy, movie, album, netflix, spotify, celebrity, award
- weather : temperature, celsius, rain, hurricane, storm, highest temp, forecast
- geopolitics : war, invasion, nato, russia, ukraine, china, taiwan, sanctions

Seuil minimum pour créer une attestation : confiance >= 0.70
Minimum de trades par domaine pour attestation niveau 2 : 5

---

## src/lib/scorer.ts

```typescript
// Win rate simple
export function calculateWinRate(trades: ResolvedTrade[]): number

// Brier Score inversé — calibration
// predictedProb = entryPrice si YES, (1 - entryPrice) si NO
// outcome = 1 si won, 0 si lost
// calibration = 1 - moyenne((predictedProb - outcome)²)
// 1.0 = parfait | 0.75 = aléatoire | <0.75 = pire que hasard
export function calculateCalibration(trades: ResolvedTrade[]): number
```

---

## Flux complet

```
fetchResolvedTrades(address)
  → classifyMarket(question) → domain | null
  → skip si null
  → calculateWinRate + calculateCalibration par domaine
  → createAtomicAttestation() si nouvelle trade
  → createAggregatedAttestation() si >= 5 trades dans domaine
  → getCompositeScore() + getAgentRank() depuis Trust MCP
  → afficher /profile/[address]
```

---

## Variables d'environnement

```bash
POLYMARKET_API_URL=https://gamma-api.polymarket.com
POLYMARKET_DATA_URL=https://data-api.polymarket.com
INTUITION_PRIVATE_KEY=
INTUITION_RPC_URL=https://rpc.intuition.systems
INTUITION_GRAPH_URL=https://graph.intuition.systems/graphql
TRUST_MCP_URL=https://mcp.intuition.box
ANTHROPIC_API_KEY=
```

---

## Phases — ordre strict, pas de saut

```
Phase 1 — polymarket.ts + tests          → Critère : tous les tests passent
Phase 2 — classifier.ts + tests          → Critère : > 90% précision
Phase 3 — scorer.ts + intuition.ts       → Critère : attestations dans le graphe
Phase 4 — trust-mcp.ts + API routes      → Critère : scores cohérents
Phase 5 — UI Next.js + Vercel deploy     → Critère : URL publique partageable
```

---

## Commands disponibles

- `/init-atoms` — crée les 9 atomes de domaine + 3 prédicats dans Intuition
- `/index-wallet [address]` — indexe un wallet complet (trades → attestations)
- `/check-profile [address]` — lecture seule, affiche réputation actuelle
- `/run-tests` — lance vitest run
- `/validate-classifier` — teste précision sur 50 marchés réels

---

## Règles absolues

1. Pas de `any` TypeScript
2. Return type explicite sur chaque fonction
3. Toujours `attestationExists()` avant de créer
4. Ne jamais sauter une phase si les tests échouent
5. Toutes les constantes dans `atoms.ts`
6. Lire ce CLAUDE.md au début de chaque session