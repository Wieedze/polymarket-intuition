# /run-tests

Lance tous les tests Vitest du projet.

## Commande
```bash
npm run test
```

## Ordre d'importance des tests
1. `tests/lib/classifier.test.ts` — le plus critique, > 90% précision requise
2. `tests/lib/scorer.test.ts`
3. `tests/lib/polymarket.test.ts`
4. `tests/lib/trust-mcp.test.ts`

## Critère de passage
Tous les tests passent. Zéro test skippé.
Si un test échoue → corriger avant de passer à la phase suivante.
