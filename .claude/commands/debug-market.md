# /debug-market [question ou conditionId]

Debug un marche specifique : classification, prix, experts qui le tradent.

## Usage
```
/debug-market Minnesota Twins vs Toronto Blue Jays
/debug-market 0x1234abcd...
```

## Etapes

1. Si $ARGUMENTS ressemble a un conditionId (hex) :
   - Chercher dans `trades` et `paper_trades` par condition_id
2. Sinon chercher par titre (LIKE %$ARGUMENTS%)

3. Pour le marche trouve, afficher :
   - Classification domaine (appeler `keywordClassify(title)` en direct)
   - Keywords matches et scores par domaine
   - Tous les trades dans `trades` pour ce marche (quels experts, quel side, quel PnL)
   - Paper trades actifs sur ce marche
   - Position snapshots des experts

4. Si c'est un paper trade ouvert :
   - Entry price, current price, PnL%
   - Quel exit trigger est le plus proche ?
   - Expert still holding ?

## Output attendu
```
--- Market Debug ---

Title: Minnesota Twins vs. Toronto Blue Jays: O/U 12.5
ConditionId: 0x1234...

Classification: pm-domain/sports (confidence: 1.00)
  Keywords matched: "twins" (w=2), "blue jays" (w=2), "o/u" (w=3)

Expert trades (3):
  sovereign2013 → YES @ 47c | size: 2500 shares
  RN1           → NO  @ 53c | size: 1200 shares
  swisstony     → YES @ 45c | size: 800 shares

Paper trade: YES @ 49c (slippage from 47c) | $2.50 | +12%
  Closest exit: near-resolution at 85c (currently 53c — 32c away)
  Expert holding: YES (sovereign2013 still in)
```
