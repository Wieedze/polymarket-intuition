# /init-atoms

Crée les atomes Intuition dans le graphe s'ils n'existent pas.
À lancer UNE SEULE FOIS au démarrage du projet.

## Atomes à créer

### 9 domaines
- pm-domain/ai-tech
- pm-domain/politics
- pm-domain/crypto
- pm-domain/sports
- pm-domain/economics
- pm-domain/science
- pm-domain/culture
- pm-domain/weather
- pm-domain/geopolitics

### 3 prédicats
- predicted-correctly-in
- predicted-incorrectly-in
- has-prediction-reputation-in

## Ce que tu fais

1. Pour chaque atome → vérifie s'il existe via `search-atoms` dans le graphe Intuition
2. S'il n'existe pas → crée-le via le SDK Intuition
3. Stocke son ID dans `ATOM_IDS` dans `src/lib/atoms.ts`
4. Log chaque résultat

## Règles
- Ne jamais recréer un atome qui existe déjà
- Si création échoue → throw avec message clair
- Mettre à jour ATOM_IDS avec les vrais IDs on-chain

## Output attendu
```
✅ pm-domain/ai-tech      → ID: 0x...
✅ pm-domain/politics     → ID: 0x...
✅ predicted-correctly-in → ID: 0x...
...
🎉 12 atomes prêts
```
