# /index-wallet [address]

Indexe un wallet Polymarket complet : fetch trades, classify, compute stats.

## Usage
```
/index-wallet 0xf2f6af4f27ec2dcf4072095ab804016e14cd5817
```

## Etapes

1. `fetchResolvedTrades(address)` depuis l'API Polymarket
2. Pour chaque trade : `classifyMarket(question)` (keyword, pas LLM)
3. `saveTrade()` en DB (idempotent via `tradeExists`)
4. Par domaine : `calculateWinRate`, `calculateCalibration`, `calculateImplicitEdge`
5. `saveWalletStats()` pour chaque domaine
6. `calculateCopyabilityFromStats()` et `updateWalletCopyability()`

## Regles
- Idempotent : verifie `tradeExists(id)` avant chaque insertion
- Continue si un trade echoue (ne pas crasher)
- Logger chaque erreur
- Pas de fallback LLM dans le classifier

## Output attendu
```
Indexing wallet $ARGUMENTS ...

Trades: 312 fetched | 287 classified | 25 skipped (no domain)
Stats updated for 5 domains:
  sports      → WR 62% | calib 0.81 | edge +0.09 | 47 trades
  politics    → WR 58% | calib 0.74 | edge +0.05 | 23 trades

Copyability: 78% (updated in DB)
```
