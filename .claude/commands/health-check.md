# /health-check

Verification complete de la sante du systeme : DB, processes, coherence.

## Etapes

1. **DB integrity** :
   - Verifier que `data/polymarket.db` existe et est lisible
   - Verifier que `data/live.db` existe (si live mode)
   - Compter les tables attendues
   - Verifier la colonne `copyability_score` dans watched_wallets (migration)
   - `PRAGMA integrity_check` sur les deux DB

2. **Donnees** :
   - Nombre de watched wallets actifs
   - Nombre de trades indexes (total + 7 derniers jours)
   - Nombre de paper trades (open / won / lost)
   - Wallet stats : combien de wallets ont des stats fraiches (< 48h)
   - Pending orders (devrait etre 0 ou faible)

3. **Coherence** :
   - Trades open sans cur_price (prix jamais mis a jour)
   - Trades open depuis > 30 jours (potentiellement stale)
   - Experts watched mais sans aucun trade indexe
   - wallet_stats avec decay_factor < 0.5 (experts inactifs)

4. **Config** :
   - Verifier ecosystem.config.cjs parseable
   - Lister les env vars critiques (STOP_LOSS, MIN_SIGNAL_SCORE_LIVE, etc.)
   - Verifier que EXIT_CONFIG.stopLossPct dans les scripts match

## Output attendu
```
--- Health Check ---

DB:
  polymarket.db: OK (14.2 MB, 12 tables)
  live.db: OK (2.1 MB, 12 tables)
  Integrity: PASSED

Data:
  Watched wallets: 75 active
  Trades indexed: 12,847 total | 1,203 this week
  Paper trades: 3 open | 245 resolved (142W/103L)
  Pending orders: 0
  Fresh stats (< 48h): 68/75 wallets

Coherence:
  ⚠️ 2 open trades without recent price update
  ⚠️ 7 watched wallets with 0 indexed trades
  ✅ No stale trades > 30 days

Config:
  STOP_LOSS: 0.40 (PM2) / 0.40 (code) ✅
  MIN_SIGNAL_SCORE: 65 (PM2) / 50 (code default) ✅
  All critical env vars present ✅
```
