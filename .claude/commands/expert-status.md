# /expert-status

Affiche le trust de tous les experts surveilles avec leur performance.

## Etapes

1. `getActiveWatchedWallets()` — tous les wallets actifs
2. Pour chaque wallet :
   - `evaluateExpertTrust(wallet, label)` — phase + trust level + status + reason
   - `getWalletStats(wallet)` — stats par domaine
   - Lire `copyability_score` depuis watched_wallets
3. Trier par : paused d'abord, puis reduced, puis active (par trust decroissant)
4. Afficher tableau complet

## Output attendu
```
--- Expert Status (75 wallets) ---

PAUSED (7):
  ⛔ SwissMiss     | copy:81% | trust:0    | 5 trades, PnL -$35 | Paused: too few trades, deep loss
  ⛔ CamelUp       | copy:74% | trust:0    | 14 trades, PnL -$40 | Paused: WR 28%, PnL -$40
  ⛔ wan123        | copy:81% | trust:0    | 7 trades, PnL -$155 | Paused: massive early loss

REDUCED (6):
  ⚡ bettor42      | copy:65% | trust:0.30 | 25 trades, WR 38% | Reduced: poor recent performance
  ⚡ sharpGuy      | copy:71% | trust:0.15 | 80 trades, score 18/100 | Reduced: proven but poor PF

ACTIVE (19):
  ✅ sovereign2013  | copy:86% | trust:1.20 | 120 trades, WR 62% | Proven: score 72/100
  ✅ RN1            | copy:71% | trust:0.95 | 85 trades, WR 58% | Proven: score 55/100
  ✅ swisstony      | copy:78% | trust:0.70 | 15 trades, WR 53% | Observation
  ...

Summary: 19 active | 6 reduced | 7 paused
Avg trust (active): 0.89 | Avg copyability: 74%
```

## Regles
- Lecture seule
- Utiliser les fonctions de expert-trust.ts et db.ts
- Afficher la raison de pause/reduce pour diagnostiquer
