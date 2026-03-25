# /index-wallet [address]

Indexe un wallet Polymarket complet.

## Usage
```
/index-wallet 0xf2f6af4f27ec2dcf4072095ab804016e14cd5817
```

## Étapes

1. `fetchResolvedTrades(address)` → tous les trades résolus
2. Pour chaque trade → `classifyMarket(question)` → domaine
3. Skip si confiance < 0.70
4. `calculateWinRate` + `calculateCalibration` par domaine
5. Crée attestation niveau 1 pour chaque trade qualifié
6. Crée attestation niveau 2 pour chaque domaine (min 5 trades)

## Règles
- Idempotent : vérifie `attestationExists` avant chaque création
- Continue si un trade échoue (ne pas crasher)
- Logger chaque erreur
- Minimum 5 trades dans un domaine pour créer l'attestation agrégée

## Output attendu
```
📊 Wallet: 0xf2f6...
📈 Trades résolus: 312

🏷️  Classification...
  ✅ 287 trades classifiés
  ⏭️  25 trades skippés (confiance < 0.70)

📝 Attestations niveau 1 : 287 créées
📊 Attestations niveau 2 :
  ai-tech     → win: 84% | calib: 0.91 | trades: 47
  politics    → win: 71% | calib: 0.78 | trades: 23

🔗 Profil: /profile/0xf2f6...
```
