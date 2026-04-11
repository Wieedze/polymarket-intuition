# POLYMARKET COPY TRADER — CLAUDE.md
> Briefing complet pour Claude Code. Lire entierement avant chaque session.

---

## Vision du projet

Bot de copy-trading sur Polymarket — paper trading (simulation) ET live trading (real USDC).
Indexe les trades resolus des meilleurs wallets, classe par domaine, score chaque signal 0-100,
et execute des positions avec gestion complete des risques.

**Deux modes :**
- `auto-trader.ts` — paper trading (simulation dans SQLite, slippage simule)
- `live-trader.ts` — live trading (ordres reels CLOB GTC, WebSocket fills, real USDC on Polygon)

**Decisions definitives :**
- Pas d'attestations Intuition on-chain (supprime)
- Pas de Trust MCP / AgentRank (supprime)
- Pas de fallback LLM dans le classifier (pure keyword, deterministe)
- Gate "pret pour le reel" : 4000 trades resolus minimum
- Pas de `any` TypeScript — jamais
- Return type explicite sur chaque fonction

---

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Framework | Next.js 14 App Router + TypeScript strict |
| UI | Tailwind CSS + inline styles (design system COLORS) |
| Base de donnees | SQLite (better-sqlite3, WAL mode, dual-DB en live) |
| Real trading | `@polymarket/clob-client` + `viem` (Polygon) |
| WebSocket | CLOB orderbook (market) + User WS (fill notifications) |
| Tests | Vitest |
| Deploy | VPS + PM2 |

---

## Architecture dual-DB (live mode)

| DB | Chemin | Role |
|----|--------|------|
| Instance DB | `data/live.db` | Trades live, portfolio, pending orders |
| Shared DB | `data/polymarket.db` | Intelligence experts (wallet_stats, watched_wallets, position_snapshots) |

Le paper trader ecrit dans les deux. Le live trader lit les experts depuis shared, ecrit ses trades dans instance.
Cela empeche la contamination des analytics paper par les trades live.

---

## Constantes critiques (production PM2)

| Variable | auto-trader | live-trader | Source |
|----------|-------------|-------------|--------|
| POLL_INTERVAL_MS | 300000 (5min) | 60000 (1min) | ecosystem.config.cjs |
| MIN_SIGNAL_SCORE | 50 (code) | 65 (PM2 env) | env MIN_SIGNAL_SCORE_LIVE |
| STOP_LOSS | 0.40 | 0.40 (default code) | env STOP_LOSS |
| MAX_ENTRY_PRICE | 0.50 | 0.50 | code default |
| MAX_OPEN_TRADES | 50 (PM2) | 100 (code) | env MAX_OPEN_TRADES |
| STARTING_BALANCE | 10000 (paper) | 9 (live) | env STARTING_BALANCE |
| DRY_RUN | - | false | env DRY_RUN |

---

## Flux live-trader (pollOnce)

```
[PM2] live-trader.ts toutes les 60s
  0. Safety checks:
     - checkDailyLossLimit() → 50% du starting_balance → arret total
     - checkDrawdownBreaker() → 20% du high-water mark → arret total
  0.5 checkPendingOrders() → GTC fills/cancels via poll
  0.6 getRealBalance() → log balance on-chain

  1. Phase 1 — Collect signals:
     pour chaque watched wallet:
       pollWallet() → detecter nouvelles positions
       trackConsensus() → grouper par conditionId+side
     Log 🔔 NEW avec copyabilityScore dynamique

  2. Phase 2 — Copy:
     pour chaque signal eligible (en parallele):
       evaluateExpertTrust() → paused/reduced/active
       scoreSignal() → 0-100, skip si < MIN_SIGNAL_SCORE
       kellyBetFraction() * signalMulti * consensusMulti * trustMulti
       placeOrder(GTC) → fill immediat ou savePendingOrder()
       User WS pour fills instantanes

  3. Phase 3 — Exits:
     refreshOpenPrices() → maj prix depuis positions experts
     runExitStrategy() → evaluateExit() par trade
       partial exits: closePosition() + partialExitPaperTrade()
       full exits: closePosition() + resolvePaperTrade()
     resolveCompletedTrades() → marches resolus (prix <5c ou >95c)

  4. printStats() → balance, PnL, WS status, expert trust summary
```

---

## Signal scoring (0-100)

| Composant | Max pts | Seuils |
|-----------|---------|--------|
| Domain match | 30 | Best domain=30, >=10 trades=20, >=5=10 |
| Calibration | 20 | >=0.80=20, >=0.70=14, >=0.60=8 |
| Implicit edge | 15 | >=0.15=15, >=0.08=11, >=0.03=7 |
| Win rate | 10 | >=60%=10, >=50%=7, >=40%=4 |
| Entry price | 15 | 15-30c=15 (sweet spot), 30-50c=10 |
| Bet size signal | 10 | >50K shares=10, >10K=7, >1K=4 |

**Score = 0 automatique si :**
- Entry > 65c (favoris = edge negatif)
- Noise market (5-min crypto, narrow ranges)
- Domaine bloque (crypto, weather)
- Domaine inconnu (classifier null)
- Pas d'historique expert

**Domain multiplier** : 0.5x a 1.5x selon calibration+WR de l'expert dans ce domaine.

---

## Expert trust (3 phases)

Re-evalue a chaque poll. Trust = multiplicateur sur bet size (0 a 1.5x).
Tous les seuils dollar scalent avec bankroll : `base * (starting_balance / 10000)`.

| Phase | Trades resolus | Trust defaut | Pause si | Reduce si |
|-------|---------------|-------------|----------|-----------|
| Observation | < 20 | 0.7x | >=5 trades, PnL < -$300 scaled | >=3 trades, PnL < -$100 scaled |
| Evaluation | 20-59 | calcule | WR < 30% + PnL < -$200 (last 15) | PnL < -$100 OR WR < 35% |
| Proven | 60+ | composite | score < 10 + momentum negatif | score < 20 → 0.15x, < 40 → 0.30x |

Proven composite score : profitFactor (40pts) + drawdownRatio (25pts) + momentum (20pts) + win/loss ratio (15pts).

---

## Sizing (Kelly + multipliers)

```
b = (1/entryPrice) - 1
kelly = (winRate * b - (1-winRate)) / b
betFraction = min(kelly * 0.25, 0.25)   // quarter Kelly

baseBet = clamp(bankroll * betFraction, minBet, maxBet)
finalBet = baseBet * signalMulti * consensusMulti * trustMulti

signalMulti:    score >= 80 → 1.5x, else 1.0x
consensusMulti: 1 expert=1.0x, 2=0.7x, 3+=0.5x, 5+=0.3x (inverse)
trustMulti:     expert trust level (0 a 1.5)
```

**Live cap** : `liveBetAmount = min(finalBet, availableCash * 0.30)` — jamais plus de 30% du cash sur un trade.

---

## Exit strategy

**Ordre de priorite (premier match gagne) :**

1. **Partial exit 150%** : PnL >= +150% → vend 30% du restant
2. **Partial exit 100%** : PnL >= +100% → vend 50% du restant
3. **Near-resolution** : YES >= 85c ou NO <= 15c
4. **Take profit** : desactive (999%)
5. **Stop loss** : PnL <= -40%
6. **Trailing stop** : desactive (999%)
7. **Stale** : > 7 jours, < 3c de mouvement
8. **Expert exit** : l'expert a ferme sa position

**Formule PnL** : `pnlPct = (curPrice - entryPrice) / entryPrice`

**Live exit** : ordres GTC sell. Min 5 shares (CLOB minimum). En dessous, tokens restent on-chain.

---

## Safety mechanisms (live)

| Mecanisme | Seuil | Effet |
|-----------|-------|-------|
| Daily loss limit | 50% starting balance | Arret total pour la journee |
| Drawdown breaker | 20% du HWM | Active apres 10% de croissance |
| Single trade cap | 30% du cash | liveBetAmount cap |
| Max capital deploye | 60-70% equity | Buffer cash pour exits |
| Max open trades | 100 | Cap fixe |
| GTC timeout | 5 minutes | Cancel auto ordres non remplis |
| Min order | 15 shares | Minimum CLOB |

---

## WebSocket

**Market WS** : `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Subscribe par token, best-bid pour pricing exits
- Reconnect auto (backoff 1s → 30s), data stale apres 2min

**User WS** : `wss://ws-subscriptions-clob.polymarket.com/ws/user`
- Auth API key/secret/passphrase
- Fill notifications instantanees (plus rapide que le poll)
- Cancel notifications

---

## Base de donnees SQLite

Tables principales :
- `trades` — trades resolus indexes (wallet, domain, classifier_confidence)
- `wallet_stats` — stats par (wallet, domain) : win_rate, calibration, implicit_edge, decay_factor
- `paper_trades` — positions (open/won/lost), shares_remaining, partial_exits JSON
- `paper_portfolio` — key/value (starting_balance, bet_size)
- `watched_wallets` — experts (label, active, copyability_score)
- `position_snapshots` — positions live des experts
- `pending_orders` — ordres GTC en attente de fill
- `market_metadata` — tokenIds, end dates, neg_risk
- `bot_events` — log rolling (200 derniers)
- `leaderboard_cache` / `leaderboard_results_cache` — cache 30min

---

## APIs externes

```
Polymarket Data : https://data-api.polymarket.com
Polymarket Gamma : https://gamma-api.polymarket.com
Polymarket CLOB : https://clob.polymarket.com (via @polymarket/clob-client)
Polygon RPC     : https://polygon-bor-rpc.publicnode.com (balance USDC.e)
```

---

## Structure du projet

```
polymarket-intuition/
+-- scripts/
|   +-- auto-trader.ts          Paper trading bot (PM2)
|   +-- live-trader.ts          Live trading bot (PM2)
|   +-- bulk-index.ts           Index wallets from leaderboard
|   +-- bulk-index-all.ts       Index all categories
|   +-- monitor.ts              Monitoring console
|   +-- analytics.ts            Analytics CLI
+-- src/
|   +-- lib/
|   |   +-- db.ts                SQLite : toutes les queries + paper trade lifecycle
|   |   +-- signal-scorer.ts     Score 0-100 pour chaque signal
|   |   +-- exit-strategy.ts     Moteur de decisions exit
|   |   +-- expert-trust.ts      3 phases de trust expert
|   |   +-- scorer.ts            Calculs stats (WR, calibration, edge, Kelly)
|   |   +-- classifier.ts        Classifier keyword (9 domaines)
|   |   +-- indexer.ts            Pipeline indexation wallet
|   |   +-- real-trader.ts        Execution ordres CLOB
|   |   +-- orderbook-ws.ts       WebSocket market + user
|   |   +-- position-tracker.ts   Detection positions experts
|   |   +-- polymarket.ts         Client API Polymarket
|   |   +-- atoms.ts              Constantes domaines
|   +-- app/                      Next.js pages + API routes
|   +-- types/                    Types TypeScript
+-- tests/                        Vitest
+-- ecosystem.config.cjs          Config PM2 (3 processes)
```

---

## Regles absolues

1. **Pas de `any` TypeScript** — jamais
2. **Return type explicite** sur chaque fonction
3. **Pas de fallback LLM** dans le classifier — pure keyword, deterministe
4. **Pas d'attestations on-chain** ni Trust MCP
5. **Toutes les constantes domaine** dans `atoms.ts`
6. **Jamais commit/push sans demander** — l'utilisateur gere git manuellement
7. **Jamais lire/afficher/utiliser des cles privees** — demander l'adresse publique
8. **Stabilite d'abord** — le systeme est profitable, pas de nouveaux multiplicateurs ou complexite
9. **Scaler horizontalement** (plus de trades) pas verticalement (plus gros bets)
10. **Tester 2-3 jours** avant de valider tout changement significatif

---

## Bonnes pratiques de dev

- Verifier avec `npx tsc --noEmit` apres chaque modif
- Grep avant de supprimer un export (confirmer zero appelant)
- Les seuils/constantes doivent etre coherents entre scripts et lib (pas de valeurs divergentes)
- Slippage, fees, Kelly, exits : logique metier dans `src/lib/`, pas dans les routes API ni les scripts
- `DEFAULT_CONFIG` dans exit-strategy.ts est la source de verite pour les seuils d'exit
- `EXIT_CONFIG` dans les scripts override via env vars (PM2) — documenter tout override
- Les tests doivent refleter le code production, pas l'inverse

---

## Commands disponibles

- `/index-wallet [address]` — indexe un wallet complet
- `/check-profile [address]` — affiche reputation actuelle
- `/run-tests` — lance vitest run
- `/validate-classifier` — teste precision sur marches reels

---

## Design system

```typescript
const COLORS = {
  bg: '#171821', card: '#21222D', surface: '#2B2B36',
  teal: '#A9DFD8', amber: '#FCB859', pink: '#F2C8ED',
  red: '#EA1701', green: '#029F04', blue: '#28AEF3',
  textMuted: '#87888C', textLight: '#D2D2D2',
}
```
