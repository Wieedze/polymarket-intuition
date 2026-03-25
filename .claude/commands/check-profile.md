# /check-profile [address]

Mode lecture seule. Aucune écriture on-chain.

## Usage
```
/check-profile 0xf2f6af4f27ec2dcf4072095ab804016e14cd5817
```

## Ce qu'il affiche

1. Trades Polymarket bruts (count + P&L total)
2. Attestations existantes dans le graphe Intuition
3. Scores Trust MCP (composite, agentrank)
4. Preview du profil tel qu'il apparaîtra sur la page

## Output attendu
```
👤 Wallet: 0xf2f6...

📊 POLYMARKET
  Trades résolus : 312
  P&L total      : +$47,230

🔗 INTUITION
  Attestations L1 : 287
  Attestations L2 : 3 domaines

📈 TRUST SCORES
  ai-tech   → composite: 0.84 | rank: #12
  politics  → composite: 0.71 | rank: #34

🔗 /profile/0xf2f6...
```
