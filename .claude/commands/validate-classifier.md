# /validate-classifier

Teste le classifier keyword sur des marches Polymarket reels.

## Ce que ca fait

1. Fetch 50 marches resolus recents via `fetchResolvedTrades` sur un wallet actif
2. Classifie chacun via `keywordClassify(question)` (pas classifyMarket, direct keyword)
3. Affiche les resultats groupes par domaine
4. Identifie les cas non classifies et les classifications douteuses

## Critere de passage
- Precision globale > 90% des marches classifies
- Aucun domaine majeur (sports, politics, economics) en dessous de 85%
- Moins de 15% de marches non classifies

## Output attendu
```
Validation sur 50 marches

Classifies: 43/50 (86%)
Non classifies: 7 (14%)

Par domaine:
  sports      : 18 marches | haute confiance
  politics    :  8 marches | haute confiance
  economics   :  6 marches | confiance moyenne
  geopolitics :  4 marches | haute confiance
  ai-tech     :  3 marches | haute confiance
  culture     :  2 marches | confiance moyenne
  science     :  2 marches | haute confiance

Non classifies (a investiguer):
  "Will XYZ happen by Friday?" — aucun keyword match
  "Special event market #4523" — trop generique

Cas douteux (confiance < 0.5):
  "Fed rate decision impact on crypto" → economics (0.33) — match partiel
```

## Regles
- Lecture seule, aucune ecriture
- Utiliser keywordClassify directement (pas le wrapper async)
- Montrer les keywords qui ont matche pour chaque cas douteux
