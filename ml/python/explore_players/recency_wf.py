"""
recency_wf.py — chantier 3, mesure décisive : le déploiement récent du joueur
(temps de glace et d'AN des tout derniers matchs) AJOUTÉ au modèle réentraîné
sur les saisons récentes (chantier 2), en validation « marchante ».

    python explore_players/retrain.py      # d'abord (cache du cadre)
    python explore_players/lineup.py       # d'abord (mesure sur découpage fixe)
    python explore_players/recency_wf.py   # écrit ../models/player_recency_report.json

lineup.py a montré, sur le découpage fixe (≤ 2021 / 2022 / 2023-26), un gain
pour points, tirs, mises en échec, tirs bloqués et points en AN. Presque tout le
gain vient de trois variables connues sans l'alignement du soir (toi_pp_avg_3,
toi_last1, toi_pp_last1) ; les absents du soir ne pèsent rien (< 0,5 % du gain).
Le candidat de mise en service est donc R = ces trois variables seules : aucune
dépendance à l'alignement publié.

Pour chaque saison de test S ∈ {2023-24, 2024-25, 2025-26} : entraîner 2010 →
S−2, arrêt précoce sur S−1, réentraîner 2010 → S−1 (politique de retrain.py),
prédire S. B = features servies ; BR = B + R.

Règle (posée avant le run, 2026-10-15) : BR remplace B pour une stat si Δ > 0
sur les trois saisons regroupées, z ≥ 2, et Δ > 0 dans au moins 2 saisons sur 3.
Information : la même mesure pour buts et passes (juste sous le seuil sur le
découpage fixe), qui ne seraient adoptés que par cette même règle — face au
modèle servi pour ces stats (fixe pour les buts, réentraîné pour les passes).
"""
from __future__ import annotations
import json, os, sys, time
import numpy as np
import pandas as pd
import xgboost as xgb

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.dirname(HERE)
sys.path.insert(0, PY)
sys.path.insert(0, HERE)
import train_player as TP                    # noqa: E402
from retrain import verdict, BASE, TEST      # noqa: E402

MODELS = TP.MODELS_DIR
OUT = os.path.join(HERE, "out")
RECENCY = ["toi_last1", "toi_pp_last1", "toi_pp_avg_3"]
TRY = ["points", "shots", "hits", "blocks", "ppPoints", "assists", "goals"]


def main():
    t0 = time.time()
    df = pd.read_pickle(os.path.join(OUT, "retrain_frame.pkl"))
    lf = pd.read_pickle(os.path.join(OUT, "lineup_feats.pkl"))
    df = pd.concat([df, lf[RECENCY]], axis=1)
    TE = df[df.season.isin(TEST)].sort_values(["date", "gameId"]).reset_index(drop=True)
    yrs = TE.season.values
    rep_p = json.load(open(os.path.join(MODELS, "player_retrain_report.json")))
    feats_rep = json.load(open(os.path.join(MODELS, "player_report.json")))
    print(f"⛸️  {len(df)} patineur-matchs ({time.time()-t0:.0f}s)", flush=True)

    def walk(feats, y, frozen):
        mono = {f"vs_lift_{x}": 1 for x in TP.STATS if f"vs_lift_{x}" in feats}
        p = dict(BASE, monotone_constraints=mono) if mono else BASE
        mu, ks = np.zeros(len(TE)), np.zeros(len(TE))
        for S in TEST:
            if frozen:      # modèle figé : ≤ 2021, arrêt sur 2022, comme le modèle servi
                tr, va = df[df.season <= 2021], df[df.season == 2022]
            else:
                tr, va = df[df.season <= S - 2], df[df.season == S - 1]
            dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
            b0 = xgb.train(p, xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats), 2000,
                           evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
            R = b0.best_iteration + 1
            k = TP.fit_k(va[y].values, b0.predict(dva, iteration_range=(0, R)))
            if frozen:
                b1 = b0[:R]
            else:
                full = df[df.season <= S - 1]
                b1 = xgb.train(p, xgb.DMatrix(full[feats], label=full[y], feature_names=feats), R,
                               verbose_eval=False)
            ts = TE[TE.season == S]
            mu[ts.index.values] = b1.predict(xgb.DMatrix(ts[feats], feature_names=feats))
            ks[ts.index.values] = k
            if frozen:      # le modèle figé ne dépend pas de S
                for S2 in TEST:
                    if S2 != S:
                        t2 = TE[TE.season == S2]
                        mu[t2.index.values] = b1.predict(xgb.DMatrix(t2[feats], feature_names=feats))
                        ks[t2.index.values] = k
                break
        out = np.empty(len(TE))
        yt = TE[y].values.astype(float)
        for k in np.unique(ks):
            m = ks == k
            out[m] = TP.nb_ll(yt[m], mu[m], k)
        return out

    out = {"generated": time.strftime("%Y-%m-%d"), "recency": RECENCY,
           "rule": "BR remplace le modèle servi si Δ > 0, z ≥ 2 et Δ > 0 dans ≥ 2 saisons sur 3",
           "stats": {}}
    for s in TRY:
        y = f"y_{s}"
        feats = feats_rep["stats"][s]["features"]
        frozen = rep_p["stats"][s]["kept"] == "A"
        llB = walk(feats, y, frozen)
        llR = walk(feats + RECENCY, y, frozen)
        r = verdict(llR - llB, yrs)
        r["policy"] = "figé" if frozen else "récent"
        out["stats"][s] = r
        print(f"   {s:9s} ({r['policy']}) BR−B {r['dll']:+.6f} (z {r['z']:+.1f}) {r['by_season']} → "
              f"{'ADOPTER' if r['pass'] else 'non'}  ({time.time()-t0:.0f}s)", flush=True)
        json.dump(out, open(os.path.join(MODELS, "player_recency_report.json"), "w"), indent=1, ensure_ascii=False)
    print(f"✅ models/player_recency_report.json ({time.time()-t0:.0f}s)")


if __name__ == "__main__":
    main()
