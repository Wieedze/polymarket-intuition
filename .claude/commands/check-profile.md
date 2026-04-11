# /check-profile [address]

Affiche le profil complet d'un wallet expert. Mode lecture seule.

## Usage
```
/check-profile 0xf2f6af4f27ec2dcf4072095ab804016e14cd5817
```

## Etapes

1. Lire `wallet_stats` depuis la DB pour le wallet $ARGUMENTS
2. Lire `watched_wallets` pour le label et copyability_score
3. Compter les trades resolus dans `trades` table
4. Calculer le trust via `evaluateExpertTrust(address)`
5. Afficher un resume complet

## Output attendu
```
--- Expert: sovereign2013 (0xf2f6...) ---

Copyability: 86%  |  Trust: active (0.92x)  |  Phase: proven

Domaines (par trades):
  sports      → WR 62% | calib 0.81 | edge +0.09 | 47 trades
  politics    → WR 58% | calib 0.74 | edge +0.05 | 23 trades
  economics   → WR 55% | calib 0.68 | edge +0.02 | 12 trades

Total: 312 trades resolus | PnL: +$230

Watched: oui (actif) | Last polled: 2026-04-11T15:30:00
```

## Regles
- Ne rien ecrire en DB, lecture seule
- Si le wallet n'est pas dans watched_wallets, indiquer "non surveille"
- Afficher les domaines tries par nombre de trades decroissant
