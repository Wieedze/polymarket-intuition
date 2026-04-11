# /portfolio

Affiche l'etat complet du portfolio live et paper.

## Etapes

1. Lire la DB live (`data/live.db` si elle existe, sinon `data/polymarket.db`)
2. Recuperer :
   - `paper_portfolio` : starting_balance
   - `paper_trades` WHERE status = 'open' : positions ouvertes
   - `paper_trades` WHERE status IN ('won','lost') : trades resolus
   - `bot_events` : derniers evenements
3. Calculer :
   - Balance = starting_balance + sum(pnl des trades resolus)
   - Unrealized PnL = sum(shares_remaining * cur_price * 0.98 - simulated_usdc * fraction) pour les open trades
   - Win rate = won / (won + lost)
   - Profit factor = gross wins / gross losses
   - Capital deploye = sum(simulated_usdc) des trades open
4. Afficher un resume

## Output attendu
```
--- Portfolio ---

Balance:    $127.50  (start: $125.00)
Realized:   +$2.50
Unrealized: +$1.20  (3 open trades)
Cash:       $118.30

Performance:
  Win rate:      58% (23W / 17L)
  Profit factor: 1.45
  Avg PnL/trade: +$0.06
  Max consec L:  4

Open positions:
  YES @ 32c | $2.50 | +15% | Spread: Mets (-1.5)
  NO  @ 45c | $1.80 | -8%  | Oilers vs Kings O/U 5.5
  YES @ 28c | $3.00 | +42% | UFC: Costa vs Murzakanov

Recent events (5 derniers):
  [14:30] COPY YES @ 32c $2.50 | Spread: Mets
  [14:15] EXIT stop-loss -40% | Bitcoin Up or Down
  ...
```

## Regles
- Lecture seule, aucune ecriture
- Utiliser getSharedDb() pour les donnees partagees si en mode live
- Arrondir les montants a 2 decimales
