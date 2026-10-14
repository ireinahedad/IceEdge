# Rejeu — avantage numérique en cours (phase 3) contre phase 2

Généré le 2026-10-13 par `server/scripts/replay-live-pp.ts`. 3890 matchs, saisons de test 2023-24, 2024-25, 2025-26 ; facteurs entraînés sur 2018–2022 (`calibrate_live_pp.py`).

**Synthèse** : log-loss cumulée phase 2 32920.8, phase 3 32944.0 (+0.07 %), Δ 23.2 ± 47.8 (1,96 e.t. appariée par match). Seuls les instants où une situation court sont rejoués : ailleurs les deux phases sont identiques.

Phase 2 = effets de score servis, sans la situation ; phase 3 = + facteurs de situation. Δ = somme des écarts de log-loss phase 3 − phase 2 (négatif = phase 3 meilleure).

## fin de la 1re

| Question | n | Log-loss P2 | Log-loss P3 | Δ cumulé |
|---|---:|---:|---:|---:|
| Moneyline domicile | 807 | 0.5694 | 0.5712 | +1.4 ± 2.2 |
| Domicile en 60 min | 807 | 0.5559 | 0.5567 | +0.7 ± 2.2 |
| Visiteur en 60 min | 807 | 0.5449 | 0.5460 | +0.9 ± 2.3 |
| Va en prolongation | 807 | 0.4684 | 0.4696 | +1.0 ± 0.9 ❌ |
| Total > 5.5 | 807 | 0.5545 | 0.5545 | -0.1 ± 0.9 |
| Total > 6.5 | 807 | 0.5694 | 0.5701 | +0.6 ± 1.0 |
| Domicile −1.5 | 807 | 0.5358 | 0.5370 | +1.0 ± 2.2 |
| Visiteur −1.5 | 807 | 0.4985 | 0.4980 | -0.4 ± 2.4 |
| Buts domicile > 2.5 | 807 | 0.5647 | 0.5651 | +0.3 ± 1.9 |
| Buts visiteur > 2.5 | 807 | 0.5650 | 0.5652 | +0.2 ± 1.7 |
| **Toutes** | 8070 | 0.5426 | 0.5433 | +5.6 ± 12.0 |

## fin de la 2e

| Question | n | Log-loss P2 | Log-loss P3 | Δ cumulé |
|---|---:|---:|---:|---:|
| Moneyline domicile | 890 | 0.4392 | 0.4394 | +0.2 ± 2.6 |
| Domicile en 60 min | 890 | 0.3899 | 0.3902 | +0.2 ± 2.9 |
| Visiteur en 60 min | 890 | 0.3821 | 0.3800 | -1.8 ± 2.6 |
| Va en prolongation | 890 | 0.4496 | 0.4506 | +0.9 ± 1.8 |
| Total > 5.5 | 890 | 0.3847 | 0.3842 | -0.5 ± 1.0 |
| Total > 6.5 | 890 | 0.4051 | 0.4047 | -0.3 ± 1.1 |
| Domicile −1.5 | 890 | 0.3671 | 0.3690 | +1.7 ± 2.9 |
| Visiteur −1.5 | 890 | 0.3487 | 0.3493 | +0.6 ± 2.4 |
| Buts domicile > 2.5 | 890 | 0.3976 | 0.3989 | +1.1 ± 2.1 |
| Buts visiteur > 2.5 | 890 | 0.3818 | 0.3816 | -0.2 ± 2.1 |
| **Toutes** | 8900 | 0.3946 | 0.3948 | +1.8 ± 13.2 |

## 5 min restantes

| Question | n | Log-loss P2 | Log-loss P3 | Δ cumulé |
|---|---:|---:|---:|---:|
| Moneyline domicile | 562 | 0.2551 | 0.2528 | -1.3 ± 3.1 |
| Domicile en 60 min | 562 | 0.2200 | 0.2158 | -2.3 ± 2.8 |
| Visiteur en 60 min | 562 | 0.1941 | 0.1909 | -1.8 ± 3.6 |
| Va en prolongation | 562 | 0.3068 | 0.3062 | -0.3 ± 2.4 |
| Total > 5.5 | 562 | 0.2325 | 0.2314 | -0.7 ± 1.4 |
| Total > 6.5 | 562 | 0.2220 | 0.2236 | +0.9 ± 1.5 |
| Domicile −1.5 | 562 | 0.2146 | 0.2117 | -1.7 ± 2.4 |
| Visiteur −1.5 | 562 | 0.2097 | 0.2068 | -1.6 ± 3.2 |
| Buts domicile > 2.5 | 562 | 0.2479 | 0.2480 | +0.1 ± 2.8 |
| Buts visiteur > 2.5 | 562 | 0.2122 | 0.2127 | +0.3 ± 1.9 |
| **Toutes** | 5620 | 0.2315 | 0.2300 | -8.5 ± 14.9 |

## 2 min restantes

| Question | n | Log-loss P2 | Log-loss P3 | Δ cumulé |
|---|---:|---:|---:|---:|
| Moneyline domicile | 458 | 0.2501 | 0.2472 | -1.4 ± 5.0 |
| Domicile en 60 min | 458 | 0.1654 | 0.1596 | -2.6 ± 5.0 |
| Visiteur en 60 min | 458 | 0.1750 | 0.1702 | -2.2 ± 6.5 |
| Va en prolongation | 458 | 0.2691 | 0.2548 | -6.5 ± 6.5 ✅ |
| Total > 5.5 | 458 | 0.1339 | 0.1359 | +0.9 ± 2.1 |
| Total > 6.5 | 458 | 0.1384 | 0.1410 | +1.2 ± 2.9 |
| Domicile −1.5 | 458 | 0.1800 | 0.1893 | +4.3 ± 5.8 |
| Visiteur −1.5 | 458 | 0.1283 | 0.1226 | -2.6 ± 5.5 |
| Buts domicile > 2.5 | 458 | 0.1406 | 0.1462 | +2.6 ± 3.8 |
| Buts visiteur > 2.5 | 458 | 0.1513 | 0.1405 | -4.9 ± 5.1 |
| **Toutes** | 4580 | 0.1732 | 0.1707 | -11.3 ± 25.6 |

## début du 1er avantage (+5 s)

| Question | n | Log-loss P2 | Log-loss P3 | Δ cumulé |
|---|---:|---:|---:|---:|
| Moneyline domicile | 3880 | 0.6265 | 0.6276 | +4.1 ± 6.1 |
| Domicile en 60 min | 3880 | 0.6100 | 0.6112 | +4.9 ± 6.3 |
| Visiteur en 60 min | 3880 | 0.5867 | 0.5871 | +1.7 ± 6.2 |
| Va en prolongation | 3880 | 0.5190 | 0.5194 | +1.3 ± 2.3 |
| Total > 5.5 | 3880 | 0.6250 | 0.6255 | +1.8 ± 2.4 |
| Total > 6.5 | 3880 | 0.6270 | 0.6278 | +3.0 ± 2.3 ❌ |
| Domicile −1.5 | 3880 | 0.5691 | 0.5704 | +5.0 ± 6.1 |
| Visiteur −1.5 | 3880 | 0.5267 | 0.5278 | +4.0 ± 6.0 |
| Buts domicile > 2.5 | 3880 | 0.6029 | 0.6043 | +5.4 ± 5.0 ❌ |
| Buts visiteur > 2.5 | 3880 | 0.6183 | 0.6193 | +4.0 ± 4.8 |
| **Toutes** | 38800 | 0.5911 | 0.5920 | +35.5 ± 32.0 ❌ |

## Par saison

| Saison | n | Log-loss P2 | Log-loss P3 | Δ cumulé |
|---|---:|---:|---:|---:|
| 2023-24 | 22110 | 0.4940 | 0.4945 | +10.5 ± 25.8 |
| 2024-25 | 21720 | 0.5016 | 0.5013 | -5.7 ± 30.0 |
| 2025-26 | 22140 | 0.5016 | 0.5024 | +18.4 ± 26.9 |

