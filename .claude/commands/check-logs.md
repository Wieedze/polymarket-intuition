# /check-logs [process] [lines]

Analyse les logs PM2 d'un process. Par defaut : live-trader, 100 lignes.

## Usage
```
/check-logs                      → live-trader, 100 lignes
/check-logs live-trader 200      → live-trader, 200 lignes
/check-logs auto-trader 50       → auto-trader, 50 lignes
```

## Etapes

1. Lire les logs via : `pm2 logs $0 --lines $1 --nostream 2>&1`
   - Si $0 vide : utiliser `live-trader`
   - Si $1 vide : utiliser `100`
2. Analyser et resumer :
   - Nombre de polls effectues
   - Signaux detectes (🔔 NEW) et copies (📋 COPY / FILLED)
   - Exits executes (type + raison)
   - Erreurs ou warnings
   - Experts paused/reduced
   - Balance actuelle et PnL
   - Etat WebSocket (market + user)
3. Signaler tout comportement anormal :
   - WS deconnecte
   - Zero trades copies sur plusieurs cycles
   - Erreurs repetees
   - Daily loss limit ou drawdown breaker active

## Output attendu
```
--- Live-trader logs (derniers 100 lignes) ---

Polls: 12 cycles analyses
Balance: $125.42 | PnL: +$2.10 | Open: 3 trades

Signaux: 28 detectes | 2 copies | 18 skips (score < 65)
Exits: 1 partial-100%, 1 stop-loss

Experts: 19 actifs | 6 reduced | 7 paused
WS: market 🟢 | user 🟢 | 8 tokens subscribed

⚠️ Anomalies: aucune
```
