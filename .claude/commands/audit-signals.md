# /audit-signals

Analyse la qualite des signaux recents : quels signals sont copies, skips, et pourquoi.

## Etapes

1. Lire les `bot_events` recents (type = 'copy' et 'skip', 50 derniers)
2. Lire les `paper_trades` ouverts et recemment fermes (7 derniers jours)
3. Pour chaque trade copie :
   - Quel score avait le signal ?
   - Quel expert, quel domaine ?
   - Quel trust level au moment du copy ?
   - PnL actuel (si encore ouvert) ou final (si ferme)
4. Analyser les patterns :
   - Score moyen des trades gagnants vs perdants
   - Domaines les plus copies vs les plus profitables
   - Experts les plus copies vs les plus profitables
   - Distribution des entry prices
5. Donner des insights actionables

## Output attendu
```
--- Signal Audit (7 derniers jours) ---

Trades copies: 45 | Won: 24 | Lost: 18 | Open: 3
Avg score (won): 72 | Avg score (lost): 61

Par domaine:
  sports      → 20 trades | WR 65% | avg score 68
  politics    → 12 trades | WR 50% | avg score 71
  economics   → 8 trades  | WR 37% | avg score 58 ⚠️

Par expert (top 5 copies):
  sovereign2013 → 8 trades | WR 75% | PnL +$12
  RN1           → 6 trades | WR 50% | PnL -$2
  bobe2         → 5 trades | WR 40% | PnL -$8 ⚠️

Entry price distribution:
  15-25c: 18 trades | WR 61%
  25-35c: 15 trades | WR 60%
  35-50c: 12 trades | WR 50%

💡 Insights:
  - economics domain underperforming, consider reviewing
  - bobe2 mostly copied for UFC (tagged economics) — possible misclassification
  - 15-30c sweet spot confirmed (WR 61%)
```

## Regles
- Lecture seule
- Baser l'analyse sur les donnees DB, pas sur des suppositions
- Signaler les misclassifications possibles
