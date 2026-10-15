# explore_shots — piste 3 : les tirs attendus comme deuxième quantité d'équipe

Document de référence : « ICEEDGE — Des buts attendus à tous les paris » (Claude Docs), piste 3.

Le modèle de production est entraîné et mesuré par `ml/python/train_shots.py`. Ce dossier contient la mesure qui a été rejetée : les tirs d'un patineur tirés des tirs de son équipe.

    python train_shots.py                    # shots_model.json + shots_report.json
    python explore_shots/shots_players.py    # tirs d'un patineur : top-down vs modèle joueur

## Résultats (test de mars 2023 à octobre 2026, règles posées avant le run)

| Mesure | Contre | Δ log-vraisemblance en test | z | Verdict |
|---|---|---|---|---|
| Tirs d'équipe (λ_tirs) | règle tirs pour × tirs contre / ligue | +0,036 | 9,3 | adopté |
| Arrêts du gardien partant | règle de `playerRates.ts` | +0,061 | 11,8 | adopté |
| Recalage de niveau des tirs dans la saison | λ_tirs brut | +0,005 | — | adopté |
| Tirs d'un patineur, part des tirs de l'équipe | modèle joueur | −0,001 | −5,1 | rejeté |

Calibration des arrêts en test, aux lignes servies :

| Ligne | Observé | Règle actuelle | Modèle |
|---|---|---|---|
| Plus de 24,5 | 53 % | 43 % | 54 % |
| Plus de 27,5 | 37 % | 29 % | 37 % |
| Plus de 29,5 | 27 % | 22 % | 26 % |

Le coefficient du partant (0,970) est ajusté sur la validation. Il corrige le fait que le partant ne finit pas toujours le match : en test, seuls 79,5 % des partants jouent tout le match.

## À suivre

La variante « contrôle » des tirs de patineur (part × λ_tirs recalé, même dispersion) fait mieux que le modèle joueur en test (z +4) mais pas en validation (z +0,5). Elle n'était pas la candidate prévue, donc elle n'est pas adoptée. Elle suggère que le modèle joueur surestime un peu le niveau de tirs récent : 1,63 prévu contre 1,61 observé par patineur-match. Un recalage de niveau propre au modèle joueur serait la piste à mesurer.
