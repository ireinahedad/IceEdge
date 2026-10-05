# Service ML d'IceEdge

Service FastAPI autonome. Le backend Node l'appelle ; il répond des
probabilités pour les paris NHL. **Explication complète de chaque calcul :
[`../EXPLICATION_ML.md`](../EXPLICATION_ML.md)** . Les commentaires « INCOHERENCES_ML §N » renvoient à
une liste close et supprimée le 2026-10-05 : `git show ad0eba9:ml/INCOHERENCES_ML.md`.

## Lancer en local

```bash
cd ml/python
pip install -r requirements.txt
python ml_service.py          # → http://localhost:8000 (docs : /docs hors production)
```

Les modèles sont lus dans `ml/models/` (variable `MODELS_DIR` dans l'image
Docker, cf. `ml/Dockerfile`).

## Routes

| Méthode | Chemin | Rôle |
|---|---|---|
| POST | `/predict/game/bundle` | Tous les marchés d'un match en une requête (+ cadences du modèle joueur) — la route utilisée par les pages de match, les value bets et les best bets |
| POST | `/predict/game` | Un seul marché d'un match |
| POST | `/predict/player` | Prop joueur : Poisson (ou oui/non pour victoire / blanchissage) sur la cadence envoyée par le serveur |
| POST | `/predict/team` | Futures d'équipe (rang de conférence + ajustements) |
| GET | `/reports` | Rapports d'entraînement et fraîcheur des artefacts |
| GET | `/features` | Schéma des entrées |
| GET | `/health`, `/health/ready` | Sondes (ouvertes) |

## Contrôle d'accès

`/predict/*`, `/features` et `/reports` exigent l'en-tête `X-ML-Token` égal à
`ML_API_TOKEN`. En local, sans `ML_API_TOKEN`, le contrôle est désactivé. En
environnement déployé (`ENVIRONMENT=production` ou Railway), le service
**refuse de démarrer** sans jeton — `ML_AUTH_DISABLED=true` seulement si le
service n'a aucun domaine public. `ML_CORS_ORIGINS` (virgules) autorise des
origines navigateur ; aucune par défaut. Voir `DEPLOYMENT.md` §3.

## Mettre à jour les données et les modèles

```bash
python refresh_data.py                        # chaque semaine : état d'inférence + ELO + recalage de niveau (mêmes modèles)
python measure_level.py                       # mesure du recalage de niveau des buts → level_report.json
python build_dataset.py && python train_score.py && python train.py && python train_player.py   # réentraînement
python backtest_walkforward.py --correction --write-layer    # couche de correction (si ADOPTER)
python backtest_walkforward.py --served       # règles des value bets sur la chaîne servie
```

Le détail de ce que fait chaque script est dans `../EXPLICATION_ML.md` §9 et §11.
