# POLYMARKET COPY TRADER — CLAUDE.md
> Briefing complet pour Claude Code. Lire entièrement avant chaque session.

---

## Vision du projet

Un bot de copy-trading papier (simulation) sur Polymarket.
Il indexe les trades résolus des meilleurs wallets, les classe par domaine, calcule un score de signal pour chaque opportunité, et simule des positions avec gestion des risques (Kelly sizing, stop-loss, near-resolution exit).

**Ce que ça fait concrètement :**
- Indexe ~400 trades/jour depuis l'API Polymarket
- Classe chaque marché dans un des 9 domaines (sports, crypto, politique...)
- Évalue chaque expert par domaine (win rate, calibration, implicit edge)
- Score chaque signal 0–100 avant de copier
- Simule des positions paper trading avec exits automatiques
- Dashboard web temps réel avec refresh auto toutes les 30s
- Leaderboard des meilleurs wallets avec score de copiabilité

**Décisions importantes déjà prises :**
- Pas d'attestations Intuition on-chain (supprimé)
- Pas de Trust MCP / AgentRank (supprimé)
- Pas de fallback LLM dans le classifier (pure keyword, deterministe)
- Gate "prêt pour le réel" : 4000 trades résolus minimum

---

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Framework | Next.js 14 App Router + TypeScript strict |
| UI | Tailwind CSS + inline styles (design system COLORS) |
| Base de données | SQLite (better-sqlite3, WAL mode) |
| Tests | Vitest |
| Deploy | VPS + PM2 |

**Règle TypeScript** : pas de `any`, jamais. Chaque fonction a un return type explicite.

**Design system** : toutes les pages utilisent le même objet COLORS :
```typescript
const COLORS = {
  bg: '#171821', card: '#21222D', surface: '#2B2B36',
  teal: '#A9DFD8', amber: '#FCB859', pink: '#F2C8ED',
  red: '#EA1701', green: '#029F04', blue: '#28AEF3',
  textMuted: '#87888C', textLight: '#D2D2D2',
}
```

---

## APIs externes

```
Polymarket Data   : https://data-api.polymarket.com
Polymarket Gamma  : https://gamma-api.polymarket.com
```

---

## Structure du projet

```
polymarket-intuition/
├── .claude/
│   ├── CLAUDE.md                     ← CE FICHIER
│   └── commands/
│       ├── index-wallet.md           ← /index-wallet [address]
│       ├── check-profile.md          ← /check-profile [address]
│       ├── run-tests.md              ← /run-tests
│       └── validate-classifier.md   ← /validate-classifier
│
├── src/
│   ├── app/
│   │   ├── page.tsx                  ← Dashboard principal (equity curve, stats)
│   │   ├── analytics/page.tsx        ← Analytics avancés (gates, by domain/expert)
│   │   ├── paper-trading/page.tsx    ← Liste des trades paper (open/closed)
│   │   ├── leaderboard/page.tsx      ← Leaderboard copyabilité (chargement manuel)
│   │   ├── settings/page.tsx         ← Gestion des wallets surveillés
│   │   ├── profile/[address]/
│   │   │   └── page.tsx              ← Page profil publique wallet
│   │   └── api/
│   │       ├── dashboard/route.ts    ← Stats portfolio + equity curve
│   │       ├── analytics/route.ts    ← Analytics détaillés + validation gates
│   │       ├── paper-trading/route.ts← CRUD trades paper + actions refresh/resolve
│   │       ├── leaderboard/route.ts  ← Calcul leaderboard (cache 30min)
│   │       ├── settings/wallets/route.ts ← CRUD watched_wallets
│   │       ├── polymarket/
│   │       │   ├── trades/route.ts
│   │       │   └── classify/route.ts
│   │       └── intuition/
│   │           └── reputation/route.ts
│   │
│   ├── lib/
│   │   ├── atoms.ts                  ← Constantes domaines (DOMAIN_ATOMS)
│   │   ├── polymarket.ts             ← Client API Polymarket (fetch trades)
│   │   ├── classifier.ts             ← Marché → domaine (keyword scoring pur)
│   │   ├── scorer.ts                 ← Win rate, calibration, Kelly, implicit edge
│   │   ├── signal-scorer.ts          ← Score 0-100 pour chaque signal à copier
│   │   ├── exit-strategy.ts          ← Stop-loss, near-resolution, trailing, partial
│   │   ├── expert-trust.ts           ← Phases observation/evaluation/proven par expert
│   │   ├── position-tracker.ts       ← Suivi des positions ouvertes (prix live)
│   │   ├── real-trader.ts            ← Fichiers wallets experts réels surveillés
│   │   ├── indexer.ts                ← Orchestration : fetch → classify → save stats
│   │   └── db.ts                     ← SQLite : toutes les queries
│   │
│   ├── components/
│   │   ├── ReputationProfile.tsx
│   │   ├── DomainCard.tsx
│   │   └── SearchBar.tsx
│   │
│   └── types/
│       ├── polymarket.ts             ← ResolvedTrade, WalletTrades
│       ├── attestation.ts            ← DomainAtom (type only, pas d'on-chain)
│       └── reputation.ts             ← DomainReputation, WalletReputation
│
├── scripts/
│   ├── auto-trader.ts                ← Bot principal (PM2) : poll → score → copy
│   ├── bulk-index.ts                 ← Indexe une liste de wallets
│   ├── bulk-index-all.ts             ← Indexe tous les wallets watched_wallets
│   ├── live-trader.ts                ← Variante trader en temps réel
│   ├── monitor.ts                    ← Monitoring console du bot
│   ├── analytics.ts                  ← Analytics CLI
│   └── debug-*.ts                    ← Scripts de debug
│
└── tests/
    └── lib/
        ├── classifier.test.ts        ← 100% précision sur 45 cas réels
        ├── indexer.test.ts
        ├── polymarket.test.ts
        ├── scorer.test.ts
        └── signal-scorer.test.ts
```

---

## Base de données SQLite

Tables principales :
- `trades` — tous les trades résolus indexés (avec domain, classifier_confidence)
- `wallet_stats` — stats agrégées par (wallet, domain) : win_rate, calibration, implicit_edge, decay_factor...
- `paper_trades` — positions paper trading simulées
- `paper_portfolio` — balance, starting_balance, bet_size
- `watched_wallets` — wallets experts à surveiller (avec label, active flag)
- `position_snapshots` — snapshot prix live des positions ouvertes
- `leaderboard_cache` — cache leaderboard Polymarket (TTL 30min via `leaderboard_results_cache`)
- `update_queue` — file de mise à jour prioritaire des wallets

---

## Flux principal (auto-trader)

```
[PM2] auto-trader.ts toutes les N minutes
  → fetchPositionSnapshots() — prix live des experts
  → pour chaque expert actif :
      → fetchResolvedTrades() → indexWallet() → wallet_stats à jour
      → detectNewPositions() → signaux potentiels
      → scoreSignal() → 0-100 (domain match + calibration + winRate + entryPrice + betSize)
      → si score >= seuil → simulateCopy() → paper_trades
  → checkExits() — stop-loss / near-resolution / trailing / stale
  → logBotEvent()
```

---

## Signal scoring (signal-scorer.ts)

Score 0–100 composé de :
- **Domain performance** (×1.0–2.0) : calibration + winRate de l'expert dans ce domaine
- **Entry price edge** : longshots 15–30¢ ont le meilleur edge observé
- **Bet size** : consensus (>$100) légèrement favorisé
- **Decay factor** : pénalise les experts inactifs

---

## Exit strategy (exit-strategy.ts)

Config `DEFAULT_CONFIG` :
- `stopLossPct: 0.5` — exit si perte > 50% de la mise
- `nearResolutionThreshold: 0.85` — YES exit à >=85¢, NO exit à <=15¢
- `staleAfterDays: 30` — ferme les positions trop vieilles
- Partial exits à +100% et +150% de profit (improvements branch)

---

## Validation gates (analytics)

Pour valider que le système est prêt à passer en réel :
- Profit Factor ≥ 1.30
- Max pertes consécutives ≤ 15
- PnL moyen/trade > +$5
- **Trades résolus ≥ 4000** (≈10 jours à 400/jour)

Significance statistique du win rate : < 100 = non significatif, 100–1000 = low, 1000–4000 = medium, 4000+ = high.

---

## Variables d'environnement

```bash
POLYMARKET_API_URL=https://gamma-api.polymarket.com
POLYMARKET_DATA_URL=https://data-api.polymarket.com
```

---

## Commands disponibles

- `/index-wallet [address]` — indexe un wallet complet
- `/check-profile [address]` — affiche réputation actuelle
- `/run-tests` — lance vitest run
- `/validate-classifier` — teste précision sur marchés réels

---

## Règles absolues

1. Pas de `any` TypeScript — jamais
2. Return type explicite sur chaque fonction
3. Pas de fallback LLM dans le classifier
4. Pas d'attestations on-chain ni Trust MCP
5. Toutes les constantes de domaine dans `atoms.ts`
6. Lire ce CLAUDE.md au début de chaque session
