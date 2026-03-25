# /validate-classifier

Teste le classifier sur 50 marchés Polymarket réels.

## Ce que ça fait
1. Fetch 50 marchés résolus récents depuis Polymarket
2. Classifie chacun via `classifyMarket()`
3. Compare avec classification manuelle de référence
4. Affiche précision par domaine

## Critère de passage
- Précision globale > 90%
- Aucun domaine en dessous de 85%

## Output attendu
```
🔍 Validation sur 50 marchés

PRÉCISION GLOBALE : 94%

Par domaine :
  ai-tech     : 96% (23/24) ✅
  politics    : 92% (11/12) ✅
  crypto      : 100% (8/8)  ✅
  weather     : 100% (6/6)  ✅
  economics   : 83% (5/6)   ⚠️ à améliorer
  sports      : 100% (3/3)  ✅

CAS AMBIGUS : 3 loggés dans classifier-ambiguous.log

✅ Critère atteint — ready pour Phase 3
```
