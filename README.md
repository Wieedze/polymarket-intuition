# Polymarket Copy Trader

Bot de copy-trading papier sur Polymarket. Indexe les trades des meilleurs wallets, classe chaque marché par domaine, score les signaux et simule des positions avec gestion des risques.

## Stack

- **Next.js 14** App Router + TypeScript strict
- **SQLite** (better-sqlite3, WAL mode)
- **PM2** pour le bot en production
- **Vitest** pour les tests

## Pages

| URL | Description |
|-----|-------------|
| `/` | Dashboard — equity curve, stats, activity feed |
| `/analytics` | Analytics avancés — gates, by domain/expert, confidence interval |
| `/paper-trading` | Liste des trades simulés (open / closed) |
| `/leaderboard` | Top wallets classés par score de copiabilité |
| `/settings` | Gestion des wallets experts à surveiller |
| `/profile/[address]` | Profil public d'un wallet |

Toutes les pages se rafraîchissent automatiquement toutes les **30 secondes**.

## Architecture

```
Polymarket API
    ↓
indexWallet()          — fetch trades → classify → save wallet_stats
    ↓
auto-trader (PM2)      — poll experts → score signals → copy paper trades
    ↓
exit-strategy          — stop-loss / near-resolution / trailing / stale
    ↓
Dashboard / Analytics  — lecture SQLite en temps réel
```

## Classifier

Classification pure par keyword scoring (déterministe, 100% précision sur 45 cas de test).
9 domaines : `ai-tech`, `politics`, `crypto`, `sports`, `economics`, `science`, `culture`, `weather`, `geopolitics`.

## Signal scoring (0–100)

- Performance de l'expert dans le domaine (calibration + win rate)
- Edge du prix d'entrée (longshots 15–30¢ historiquement meilleurs)
- Taille du bet (consensus >$100 favorisé)
- Decay factor (pénalise les experts inactifs)

## Exit strategy

- Stop-loss à -50% de la mise
- Near-resolution : YES ≥85¢ ou NO ≤15¢ → exit
- Stale après 30 jours
- Partial exits à +100% et +150%

## Validation gates (avant passage en réel)

- Profit Factor ≥ 1.30
- Max pertes consécutives ≤ 15
- PnL moyen/trade > +$5
- **4000 trades résolus** (≈10 jours à 400/jour)

## Dev

```bash
npm run dev          # Next.js dev server
npx vitest run       # Tests (177 tests, ~750ms)
```

## Prod (VPS)

```bash
git pull && npm run build && pm2 restart all
```

## Variables d'environnement

```bash
POLYMARKET_API_URL=https://gamma-api.polymarket.com
POLYMARKET_DATA_URL=https://data-api.polymarket.com
```
