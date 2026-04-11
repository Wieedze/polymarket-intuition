# /run-tests

Lance les tests Vitest + verification TypeScript.

## Commandes
```bash
npx vitest run
npx tsc --noEmit
```

## Ordre d'importance des tests
1. `tests/lib/classifier.test.ts` — classification domaines
2. `tests/lib/signal-scorer.test.ts` — scoring + thresholds
3. `tests/lib/scorer.test.ts` — metriques stats
4. `tests/lib/indexer.test.ts` — pipeline indexation
5. `tests/lib/polymarket.test.ts` — client API

## Critere de passage
- Tous les tests passent, zero skip
- `tsc --noEmit` zero erreur
- Si un test echoue : diagnostiquer et corriger avant de continuer
