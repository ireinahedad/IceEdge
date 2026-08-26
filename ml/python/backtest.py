"""
backtest.py (v4)
================
Backtest "value betting" du modèle sur le TEST SET uniquement (jamais vu à
l'entraînement) : on parie quand la proba du modèle diverge assez de la proba
implicite du marché.

Stratégies évaluées :
  • Flat 1u, seuil d'edge variable (1% → 8%)
  • Kelly fractionné (1/4)
Métriques : ROI, nb de paris, hit rate, log-loss comparé au marché.

Deuxième mode, indépendant du premier : `--reliability` compare la CALIBRATION
des deux estimateurs (modèle de score et classifieur) sur la même tranche de
test — probabilité annoncée contre fréquence observée, par bin. Il ne demande
aucune cote, et tourne donc là où le mode ROI ne peut pas.

Usage :
    cd ml/python
    python backtest.py               # utilise le blend si dispo
    python backtest.py --use raw     # modèle calibré sans blend
    python backtest.py --reliability # calibration des 2 modèles (sans cotes)
"""

import argparse
import json

import numpy as np
import pandas as pd
import xgboost as xgb

import train
import train_score
from score_model import (P_OT_HOME, ScoreDistribution, apply_logistic,
                         fit_logistic, logit, p_ot_for, read_ot_model)

DATA   = "../data/nhl_games_v4.csv"
MODELS = "../models"


def _logit(p, eps=1e-7):
    p = np.clip(p, eps, 1 - eps)
    return np.log(p / (1 - p))

def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


# ── Mode fiabilité : les DEUX estimateurs, par bin de probabilité (S4) ───────
#
# POURQUOI CE MODE EXISTE. Depuis S4 ④, six marchés non dérivables sont pricés
# depuis `dist.p_home_win()` du modèle de score au lieu du classifieur. La
# vérification navigateur du 2026-08-26 a montré 11 points d'écart entre les
# deux sur une affiche déséquilibrée (66 % contre 77 %) et zéro sur une affiche
# équilibrée : le modèle de score est plus conservateur dans les extrêmes.
# Personne ne savait lequel a raison — `score_report.json` ne donne qu'une
# moyenne globale (0,5491 prédit / 0,5400 observé), parfaitement compatible avec
# deux queues fausses qui se compensent. Or les affiches déséquilibrées sont
# exactement celles où un edge se détecte et où une mise se pose.
#
# CE QUE ÇA MESURE, ET CE QUE ÇA NE MESURE PAS. C'est un diagramme de fiabilité
# — probabilité prédite contre fréquence observée, par bin — sur les 4 304
# matchs de test qu'AUCUN des deux modèles n'a vus. Ça dit si une probabilité
# annoncée à 70 % se réalise 70 % du temps. Ça ne dit RIEN sur le ROI : un
# modèle parfaitement calibré ne bat pas le marché pour autant.
#
# Aucune dépendance nouvelle : tables console + JSON, comme `sigma_report`.

MIN_BIN_DEFAULT = 50          # sous cet effectif, un bin ne dit rien
RELIABILITY_OUT = f"{MODELS}/reliability_report.json"


def _wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Intervalle de confiance de Wilson à 95 % sur une fréquence.

    Choisi plutôt que l'intervalle normal parce qu'il reste dans [0, 1] et
    garde sa couverture quand le bin est mince — et les bins qui comptent ici,
    ceux des extrêmes, sont précisément les moins peuplés.
    """
    if n <= 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1.0 + z * z / n
    c = p + z * z / (2 * n)
    r = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - r) / d, (c + r) / d)


def _ll_each(y: np.ndarray, p: np.ndarray) -> np.ndarray:
    """Log-loss match par match — nécessaire pour un test APPARIÉ entre modèles."""
    p = np.clip(p, 1e-7, 1 - 1e-7)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def _test_slice():
    """Les tranches de VALIDATION et de TEST, qu'aucun des deux modèles n'a vues.

    La validation sert à ajuster la pente de recalibration hors du test, le test
    à la mesurer. Ajuster et mesurer sur la même tranche donnerait une pente
    flatteuse — la même précaution que `fit_market_blend` prend déjà.

    Les deux scripts d'entraînement découpent le même dataset trié par date à
    80 %, mais après des `dropna` différents : `train.py` sur 3 colonnes,
    `train_score.py` sur 6. Si l'un des deux perdait une ligne, les deux
    tranches ne porteraient plus sur les mêmes matchs et la comparaison serait
    fausse sans rien dire. On reconstruit donc les deux et on vérifie qu'elles
    coïncident — sur `game_id`, jamais sur la position : le tri par date de
    pandas n'est pas stable, donc à date égale l'ordre peut différer d'un frame
    à l'autre.
    """
    df = pd.read_csv(DATA, low_memory=False)
    if "game_id" not in df.columns:
        print("❌ Pas de colonne `game_id` — impossible d'aligner les deux tranches.")
        return None, None, None

    d_clf = df.dropna(subset=["home_win", "total_goals", "date"])
    _, _, test_clf = train.split(d_clf)

    d_sc = df.dropna(subset=["home_reg_score", "away_reg_score", "went_to_ot",
                             "total_goals", "home_win", "date"]).reset_index(drop=True)
    _, _, test_sc = train_score.split(d_sc)

    if set(test_clf["game_id"]) != set(test_sc["game_id"]):
        only_c = len(set(test_clf["game_id"]) - set(test_sc["game_id"]))
        only_s = len(set(test_sc["game_id"]) - set(test_clf["game_id"]))
        print("❌ Les deux tranches de test ne portent PAS sur les mêmes matchs "
              f"({len(test_clf)} vs {len(test_sc)} ; {only_c} et {only_s} en propre).")
        print("   → un `dropna` a bougé dans train.py ou train_score.py. "
              "Comparer les deux modèles sur ces tranches n'aurait aucun sens.")
        return None, None, None, None
    tr_sc, val_sc, _ = train_score.split(d_sc)
    return (tr_sc.reset_index(drop=True), val_sc.reset_index(drop=True),
            test_sc.reset_index(drop=True))


def _p_classifier(test):
    """P(dom) du classifieur, calibrée Platt — telle que `ml_service` la sert.

    Sans blend marché : `training_report.json → baselines.market.blend_weights`
    est absent, et il l'est **par construction** — le découpage est
    chronologique et les cotes SBRO s'arrêtent en 2022-23, donc la tranche de
    test ne contient aucune cote. Rien à ajuster tant qu'A1/A1bis n'a pas
    comblé 2023-2026.
    """
    with open(f"{MODELS}/training_report.json", encoding="utf-8") as fh:
        rep = json.load(fh)
    feats = rep["features"]["game"]
    gr = rep["game_model"]
    b = xgb.Booster()
    b.load_model(f"{MODELS}/game_model.json")
    p_raw = b.predict(xgb.DMatrix(test[feats].values.astype(np.float32),
                                  feature_names=feats, missing=np.nan))
    cal = gr["calibration"]
    p = _sigmoid(cal["a"] * _logit(p_raw) + cal["b"])
    blend = (gr.get("baselines", {}).get("market", {}) or {}).get("blend_weights")
    return np.asarray(p, dtype=float), blend


def _lambdas(df):
    """λ_dom et λ_ext, sans construire les distributions jointes.

    Tout ce qui ne dépend que de l'ÉCART des intensités — la prolongation, la
    jauge de confiance — n'a pas besoin des matrices 14×14. Sur les 14 631
    matchs d'entraînement, c'est la différence entre une prédiction xgboost et
    14 631 objets construits pour rien.
    """
    with open(f"{MODELS}/score_report.json", encoding="utf-8") as fh:
        rep = json.load(fh)
    feats = list(rep.get("features") or [])
    if not feats:
        print("❌ score_report.json sans liste de features.")
        return None
    tau = {int(k): float(v) for k, v in (rep.get("tau_margin") or {}).items()} or None
    p_ot = float(rep.get("p_ot_home", P_OT_HOME))
    b = xgb.Booster()
    b.load_model(f"{MODELS}/score_model.json")
    lam_h, lam_a = train_score.lambdas_for(b, feats, train_score.stack(df), len(df))
    # Le remplaçant du scalaire s'il est en service : la mesure doit décrire ce
    # que `ml_service` sert, pas ce qu'il servait avant. Même lecteur, même
    # formule — `score_model.read_ot_model` / `p_ot_for`.
    return lam_h, lam_a, p_ot, tau, read_ot_model(rep)


def _p_score(test):
    """Les DEUX marchés binaires que la distribution jointe price directement :
    `p_home_win()` (moneyline) et `p_home_cover_minus_15()` (puck line dom −1.5).

    Ils sortent de la **même** matrice `M` du **même** objet — c'est ce qui
    permet de savoir si une compression du moneyline vient de la distribution
    (elle se retrouve alors sur la puck line) ou de la seule prolongation : un
    match qui va en prolongation se termine forcément à un but d'écart, donc
    `p_ot_home` n'entre PAS dans le calcul de la puck line.

    Le moneyline est recalculé en plus par `train_score.p_home_from_lambdas` —
    le chemin d'entraînement — et les deux vecteurs sont comparés : la garantie
    « même code que l'entraînement » est vérifiée au lieu d'être promise.
    """
    got = _lambdas(test)
    if got is None:
        return None
    lam_h, lam_a, p_ot, tau, ot_w = got
    p_ot_vec = np.array([p_ot_for(ot_w, lh, la, p_ot) for lh, la in zip(lam_h, lam_a)])

    p_ml, p_pl, p_tie, p_reg = [], [], [], []
    for lh, la, pot in zip(lam_h, lam_a, p_ot_vec):
        d = ScoreDistribution(float(lh), float(la), float(pot), tau)
        p_ml.append(d.p_home_win())
        p_pl.append(d.p_home_cover_minus_15())
        # Les deux morceaux du moneyline, gardés séparés : `p_home_win` vaut
        # `p_reg + p_tie × p_ot_home`, et c'est le troisième facteur — une
        # constante — qui est suspecté. Les séparer permet de le remplacer sans
        # rien recalculer.
        p_tie.append(d.p_regulation_tie())
        p_reg.append(float(d.M[d._margin > 0].sum()))
    out = {k: np.asarray(v, dtype=float) for k, v in
           (("moneyline", p_ml), ("puckline", p_pl), ("tie", p_tie), ("reg", p_reg))}
    out["lam_h"], out["lam_a"], out["p_ot_const"] = lam_h, lam_a, p_ot
    out["p_ot_used"], out["ot_model"] = p_ot_vec, ot_w

    ref = train_score.p_home_from_lambdas(lam_h, lam_a, p_ot_vec, tau)
    if not np.allclose(out["moneyline"], ref, atol=1e-12):
        print("   ⚠️  divergence avec `train_score.p_home_from_lambdas` "
              f"(max {np.abs(out['moneyline'] - ref).max():.2e}) — un chemin a bougé.")
    rec = out["reg"] + out["tie"] * p_ot_vec
    if not np.allclose(rec, out["moneyline"], atol=1e-9):
        print("   ⚠️  `p_reg + p_tie × p_ot` ne reconstitue pas `p_home_win` — "
              "la décomposition du moneyline est fausse, ne pas lire la suite.")
    return out


def _platt_slope(y, p):
    """Pente de recalibration `a` de `y ~ σ(a·logit(p) + b)` — la compression en UN nombre.

    a > 1 : le modèle est **sous-confiant**, ses probabilités sont écrasées vers
            50 % et il faudrait les étirer.
    a ≈ 1 : calibré.
    a < 1 : sur-confiant.

    C'est le résumé du diagramme de fiabilité, et surtout il est **comparable
    d'un marché à l'autre** : c'est lui qui dit si la compression appartient à
    toute la distribution jointe ou au seul moneyline.

    L'erreur-type vient de l'information de Fisher `(XᵀWX)⁻¹`, `W = p̂(1−p̂)` —
    exacte et instantanée, là où un bootstrap coûterait des minutes pour le même
    chiffre. `fit_logistic`/`apply_logistic` sont ceux de `score_model` : la
    pente mesurée ici est donc exactement celle qu'une couche Platt appliquerait.
    """
    y = np.asarray(y, dtype=float)
    z = logit(np.clip(np.asarray(p, dtype=float), 1e-7, 1 - 1e-7))
    w = fit_logistic(z.reshape(-1, 1), y)
    a, b = float(w[0]), float(w[1])
    ph = np.clip(apply_logistic(z.reshape(-1, 1), w), 1e-7, 1 - 1e-7)
    X = np.column_stack([z, np.ones(len(z))])
    try:
        cov = np.linalg.inv(X.T @ (X * (ph * (1 - ph))[:, None]))
        se = float(np.sqrt(cov[0, 0]))
    except np.linalg.LinAlgError:
        se = float("nan")
    return {"a": round(a, 4), "b": round(b, 4), "se_a": round(se, 4),
            "ic95_a": [round(a - 1.96 * se, 4), round(a + 1.96 * se, 4)],
            "comprime": bool(a - 1.96 * se > 1.0),
            "n": int(len(y))}


def _slope_gap(y_a, p_a, y_b, p_b, n_boot: int, seed: int = 42):
    """Différence de pentes entre deux marchés, par bootstrap APPARIÉ sur les matchs.

    POURQUOI PAS DEUX TESTS SÉPARÉS. Conclure « marché A comprimé, marché B non »
    en regardant si chaque IC contient 1 est le sophisme classique : « non
    significatif » n'est pas « nul », et deux estimations peuvent être d'un côté
    et de l'autre du seuil sans que leur ÉCART soit distinguable de zéro. C'est
    exactement le cas ici — l'IC de la puck line contient la valeur ponctuelle du
    moneyline. Le seul test honnête porte sur la différence.

    Apparié : on rééchantillonne les MATCHS, et chaque tirage refait les deux
    pentes sur les mêmes matchs. Les deux estimations sont fortement corrélées
    (même modèle, mêmes affiches) ; les traiter comme indépendantes gonflerait
    l'erreur-type de l'écart et rendrait tout « non tranché » par construction.
    """
    if n_boot <= 0:
        return None
    rng = np.random.default_rng(seed)
    n = len(y_a)
    gaps = []
    for _ in range(n_boot):
        idx = rng.integers(0, n, n)
        ga = _platt_slope(y_a[idx], p_a[idx])["a"]
        gb = _platt_slope(y_b[idx], p_b[idx])["a"]
        gaps.append(ga - gb)
    gaps = np.array(gaps)
    lo, hi = np.quantile(gaps, [0.025, 0.975])
    return {"n_boot": n_boot,
            "gap_mean": round(float(gaps.mean()), 4),
            "gap_se": round(float(gaps.std(ddof=1)), 4),
            "ic95": [round(float(lo), 4), round(float(hi), 4)],
            "significatif": bool(lo > 0 or hi < 0)}


def _overtime(train_df, test, pt, min_bin):
    """La prolongation est-elle vraiment un pile ou face, quelle que soit l'affiche ?

    `p_home_win = p_reg + p_tie × p_ot_home`, et `p_ot_home` est une CONSTANTE
    (~0,4996) mesurée sur l'entraînement. Un gros favori qui va en prolongation
    est donc traité comme un pile ou face. Si les favoris gagnent en réalité
    plus de la moitié de leurs prolongations, le moneyline est comprimé — et lui
    seul, puisqu'un match allé en prolongation finit forcément à un but d'écart
    et n'entre donc pas dans la puck line.

    Mesure model-free d'abord (taux observé par tranche, IC de Wilson), puis un
    remplaçant ajusté sur l'ENTRAÎNEMENT et appliqué au TEST.

    POURQUOI L'ENTRAÎNEMENT ET PAS LA VALIDATION. `p_ot_home`, τ et les déciles
    de confiance viennent **tous** de l'entraînement : c'est la tranche des
    constantes que le service relit, et le remplaçant doit venir de la même,
    sinon son NIVEAU cesse de s'accorder avec le reste. Mesuré : ajusté sur les
    567 prolongations de la validation, l'ordonnée à l'origine portait le niveau
    à 0,5226 au lieu de 0,4996 — la queue rentrait dans son IC, mais tous les
    autres bins partaient en sur-prédiction et l'ECE empirait (0,0200 → 0,0262).
    L'entraînement en offre ~3 200, et son niveau est déjà celui de la constante
    en service. Le TEST ne sert qu'à juger, dans les deux cas.
    """
    def prep(df, lam_h, lam_a):
        m = df["went_to_ot"].values == 1
        y = (df["home_score"].values > df["away_score"].values)[m].astype(float)
        return m, y, (lam_h - lam_a)[m]

    got = _lambdas(train_df)
    if got is None:
        return {"buckets": [], "fit": None}
    mv, yv, dv = prep(train_df, got[0], got[1])
    en_service = pt.get("ot_model") is not None
    mt, yt, dt = prep(test, pt["lam_h"], pt["lam_a"])
    const = pt["p_ot_const"]
    print(f"\n   ── Prolongation : {int(mt.sum())} matchs du test y sont allés ──")
    if en_service:
        w = pt["ot_model"]
        print(f"   Le service applique désormais σ({w[0]:+.4f}·Δλ {w[1]:+.4f}). "
              f"La colonne ci-dessous teste la CONSTANTE {const:.4f} qu'il a "
              f"remplacée — elle documente pourquoi le remplaçant existe.")
    else:
        print(f"   Le service leur applique une CONSTANTE p_ot_home = {const:.4f}.")
    print(f"   {'tranche (P dom moneyline)':<28} {'n':>5} {'observé OT':>11} "
          f"{'IC 95 %':>19}  vs constante")
    buckets, bands = [], [(0.0, 0.45), (0.45, 0.55), (0.55, 0.65), (0.65, 1.0)]
    pml_ot = pt["moneyline"][mt]
    for lo, hi in bands:
        b = (pml_ot >= lo) & (pml_ot < hi)
        n = int(b.sum())
        if n == 0:
            continue
        k = int(yt[b].sum())
        c_lo, c_hi = _wilson(k, n)
        dedans = c_lo <= const <= c_hi
        buckets.append({"band": [lo, hi], "n": n, "observed": round(k / n, 4),
                        "ci95": [round(c_lo, 4), round(c_hi, 4)],
                        "constante_dans_ic": bool(dedans), "thin": bool(n < min_bin)})
        flag = "compatible" if dedans else "✗ INCOMPATIBLE"
        thin = " ~" if n < min_bin else ""
        print(f"   {lo:>10.2f}–{hi:<15.2f} {n:>5} {k / n:>11.4f} "
              f"[{c_lo:.3f} ; {c_hi:.3f}]  {flag}{thin}")

    if len(yv) < 100 or len(np.unique(yv)) < 2:
        print("   Trop peu de prolongations à l'entraînement pour un remplaçant.")
        return {"buckets": buckets, "fit": None}

    w = fit_logistic(dv.reshape(-1, 1), yv)
    p_ot_test = apply_logistic(dt.reshape(-1, 1), w)
    ll_c = _ll_each(yt, np.full(len(yt), const)).mean()
    ll_f = _ll_each(yt, p_ot_test).mean()
    print(f"\n   Remplaçant ajusté sur l'entraînement ({len(yv)} prolongations) : "
          f"p_ot_home = σ({w[0]:+.4f}·(λdom−λext) {w[1]:+.4f})")
    print(f"   Log-loss sur les {len(yt)} prolongations du test : constante "
          f"{ll_c:.5f} → ajusté {ll_f:.5f} ({ll_f - ll_c:+.5f})")
    return {"buckets": buckets,
            "fit": {"w": [round(float(x), 5) for x in w],
                    "n_train_ot": int(len(yv)), "n_test_ot": int(len(yt)),
                    "logloss_const": round(float(ll_c), 5),
                    "logloss_fitted": round(float(ll_f), 5),
                    "gain": round(float(ll_c - ll_f), 5)},
            "_w": w}


def _bins(y, p, edges, min_bin):
    rows = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (p >= lo) & (p <= hi) if hi >= 1.0 else (p >= lo) & (p < hi)
        n = int(m.sum())
        if n == 0:
            rows.append({"lo": round(lo, 2), "hi": round(hi, 2), "n": 0})
            continue
        k = int(y[m].sum())
        c_lo, c_hi = _wilson(k, n)
        pred, obs = float(p[m].mean()), k / n
        rows.append({"lo": round(lo, 2), "hi": round(hi, 2), "n": n,
                     "p_predicted": round(pred, 4), "p_observed": round(obs, 4),
                     "gap": round(obs - pred, 4),
                     "ci95": [round(c_lo, 4), round(c_hi, 4)],
                     "calibrated": bool(c_lo <= pred <= c_hi),
                     "thin": bool(n < min_bin)})
    return rows


def _print_bins(rows, label):
    print(f"\n   ── {label} ──")
    print(f"   {'bin':>11} {'n':>5} {'prédit':>8} {'observé':>8} {'écart':>7} "
          f"{'IC 95 % observé':>18}   diagramme (0 ─── 1)")
    for r in rows:
        if r["n"] == 0:
            print(f"   {r['lo']:>4.1f}–{r['hi']:<5.1f} {0:>5}   —")
            continue
        W = 40
        lane = ["·"] * W
        cp = min(W - 1, max(0, int(r["p_predicted"] * W)))
        co = min(W - 1, max(0, int(r["p_observed"] * W)))
        lane[cp] = "P"
        lane[co] = "=" if co == cp else "O"
        flag = "~" if r["thin"] else ("✓" if r["calibrated"] else "✗")
        print(f"   {r['lo']:>4.1f}–{r['hi']:<5.1f} {r['n']:>5} "
              f"{r['p_predicted']:>8.4f} {r['p_observed']:>8.4f} {r['gap']:>+7.4f} "
              f"[{r['ci95'][0]:.3f} ; {r['ci95'][1]:.3f}] {flag}  {''.join(lane)}")
    print("   P = prédit · O = observé · ✓ le prédit est dans l'IC · "
          "✗ il en sort · ~ bin trop mince pour conclure")


def _ece(rows, n_total, min_bin):
    """ECE (écart moyen pondéré) et MCE (pire bin), le pire calculé hors bins minces."""
    used = [r for r in rows if r["n"] > 0]
    ece = sum(r["n"] / n_total * abs(r["gap"]) for r in used)
    solid = [r for r in used if r["n"] >= min_bin]
    mce = max((abs(r["gap"]) for r in solid), default=float("nan"))
    worst = max(solid, key=lambda r: abs(r["gap"]), default=None)
    return ece, mce, worst


def _oriented(y, p_s, p_c, mask):
    """Vue « côté favori » — la seule qui ne s'annule pas en moyenne.

    Comparer directement les P(dom) moyennes sur un sous-ensemble mélange les
    matchs où le domicile est favori et ceux où il est outsider : les écarts se
    compensent et la table dit « calibré » sur une population où les deux
    modèles se trompent en sens contraire. On oriente donc tout du côté du
    favori désigné par le CLASSIFIEUR (l'estimateur historique, la référence),
    et on regarde si ce favori gagne aussi souvent que chacun le prétend.

    ⚠️ CE QUE CETTE TABLE N'EST PAS. La sélection se fait sur `p_c` : c'est donc
    un test de calibration du CLASSIFIEUR (`E[y | p_c] = p_c`, exactement sa
    définition), mais seulement une COMPARAISON pour le modèle de score — rien
    ne garantit `E[y | p_c ∈ S] = E[p_s | p_c ∈ S]` si `p_s` n'est calibré que
    conditionnellement à lui-même. Le test inattaquable pour chaque modèle,
    c'est ses PROPRES bins, plus haut : chacun y est conditionné sur sa propre
    probabilité. La table ci-dessous sert à répondre à « lequel colle à
    l'observé sur les affiches où l'un annonce un gros favori », pas à décerner
    un brevet de calibration au modèle de score.
    """
    n = int(mask.sum())
    if n == 0:
        return None
    home_fav = p_c[mask] >= 0.5
    q_c = np.where(home_fav, p_c[mask], 1 - p_c[mask])
    q_s = np.where(home_fav, p_s[mask], 1 - p_s[mask])
    y_fav = np.where(home_fav, y[mask], 1 - y[mask])
    k = int(y_fav.sum())
    c_lo, c_hi = _wilson(k, n)
    mc, ms = float(q_c.mean()), float(q_s.mean())
    return {"n": n,
            "favori_predit_classifieur": round(mc, 4),
            "favori_predit_score": round(ms, 4),
            "favori_observe": round(k / n, 4),
            "ci95": [round(c_lo, 4), round(c_hi, 4)],
            "classifieur_dans_ic": bool(c_lo <= mc <= c_hi),
            "score_dans_ic": bool(c_lo <= ms <= c_hi),
            # Effectif qu'il faudrait pour que l'IC devienne plus étroit que
            # l'écart entre les deux modèles — sinon « non tranché » ne veut
            # rien dire de plus que « pas assez de matchs ».
            "n_pour_trancher": (int(np.ceil(k / n * (1 - k / n) * (1.96 / abs(mc - ms)) ** 2))
                                if abs(mc - ms) > 1e-9 else None)}


def _paired(y, p_s, p_c, mask=None):
    """Différence APPARIÉE de log-loss, score − classifieur (négatif = score meilleur).

    Appariée parce que les deux modèles voient les mêmes matchs : la variance
    inter-matchs, énorme, se soustrait. C'est ce qui rend un écart de quelques
    millièmes détectable sur 4 304 matchs — la même raison qui fait converger le
    CLV 83 fois plus vite que le ROI (§2 de RESTE_A_FAIRE.md).
    """
    if mask is None:
        mask = np.ones(len(y), dtype=bool)
    n = int(mask.sum())
    if n < 2:
        return None
    d = _ll_each(y[mask], p_s[mask]) - _ll_each(y[mask], p_c[mask])
    mean = float(d.mean())
    se = float(d.std(ddof=1) / np.sqrt(n))
    return {"n": n, "delta_logloss": round(mean, 5), "se": round(se, 5),
            "ic95": [round(mean - 1.96 * se, 5), round(mean + 1.96 * se, 5)],
            "t": round(mean / se, 2) if se > 0 else None,
            "significatif": bool(abs(mean) > 1.96 * se)}


def reliability(min_bin: int = MIN_BIN_DEFAULT, n_boot: int = 200, top: int = 10) -> None:
    train_df, val, test = _test_slice()
    if test is None:
        return
    y = test["home_win"].values.astype(float)
    y_pl = ((test["home_score"] - test["away_score"]).values >= 2).astype(float)

    p_c, blend_w = _p_classifier(test)
    pt = _p_score(test)
    if pt is None:
        return
    p_s, p_pl = pt["moneyline"], pt["puckline"]
    ok = np.isfinite(p_s) & np.isfinite(p_c) & np.isfinite(p_pl)
    if not ok.all():
        print(f"   ⚠️  {int((~ok).sum())} matchs sans probabilité des deux côtés — écartés.")
        test, y, y_pl = test[ok].reset_index(drop=True), y[ok], y_pl[ok]
        p_c = p_c[ok]
        pt = {k: (v[ok] if isinstance(v, np.ndarray) else v) for k, v in pt.items()}
        p_s, p_pl = pt["moneyline"], pt["puckline"]
    lam_h, lam_a = pt["lam_h"], pt["lam_a"]

    print(f"📊 Fiabilité sur {len(test)} matchs de test "
          f"({test['date'].min()} → {test['date'].max()})")
    print("   Aucun des deux modèles n'a vu ces matchs.")
    if blend_w:
        print("   ⚠️  Un blend marché existe dans training_report.json — cette mesure "
              "porte sur le classifieur NU + Platt, celui que sert `ml_service`.")
    else:
        print("   Classifieur = XGBoost + Platt, sans blend marché : la tranche de "
              "test ne contient aucune cote (SBRO s'arrête en 2022-23).")

    edges = [i / 10 for i in range(11)]
    rows_s = _bins(y, p_s, edges, min_bin)
    rows_c = _bins(y, p_c, edges, min_bin)

    ll_s, ll_c = _ll_each(y, p_s).mean(), _ll_each(y, p_c).mean()
    br_s, br_c = float(np.mean((p_s - y) ** 2)), float(np.mean((p_c - y) ** 2))
    ece_s, mce_s, worst_s = _ece(rows_s, len(y), min_bin)
    ece_c, mce_c, worst_c = _ece(rows_c, len(y), min_bin)

    print(f"\n   {'':<22} {'log-loss':>9} {'Brier':>9} {'ECE':>9} {'MCE':>9} "
          f"{'p moyen':>9} {'observé':>9}")
    for lab, ll, br, ece, mce, p in (("modèle de score", ll_s, br_s, ece_s, mce_s, p_s),
                                     ("classifieur+Platt", ll_c, br_c, ece_c, mce_c, p_c)):
        print(f"   {lab:<22} {ll:>9.5f} {br:>9.5f} {ece:>9.5f} {mce:>9.5f} "
              f"{p.mean():>9.4f} {y.mean():>9.4f}")
    print("   ECE = écart moyen pondéré prédit/observé · MCE = pire bin "
          f"(effectif ≥ {min_bin})")

    # Étendue des probabilités — l'origine mécanique de l'écart des 11 points.
    # Deux modèles peuvent avoir la même log-loss et ne pas parler la même
    # langue : celui qui écrase tout vers 50 % a l'air prudent, mais il rend
    # aussi une EV systématiquement fausse sur les affiches tranchées, qui sont
    # les seules où l'on mise.
    sharp = {}
    print(f"\n   {'':<22} {'min':>7} {'max':>7} {'écart-type':>11} "
          f"{'hors [0,35;0,65]':>17} {'≥ 0,70':>8}")
    for lab, key, p in (("modèle de score", "score_model", p_s),
                        ("classifieur+Platt", "classifier", p_c)):
        out_mid = int(((p < 0.35) | (p > 0.65)).sum())
        hi70 = int((p >= 0.70).sum())
        sharp[key] = {"min": round(float(p.min()), 4), "max": round(float(p.max()), 4),
                      "std": round(float(p.std(ddof=1)), 4),
                      "hors_milieu": out_mid, "au_dessus_0_70": hi70}
        print(f"   {lab:<22} {p.min():>7.4f} {p.max():>7.4f} {p.std(ddof=1):>11.4f} "
              f"{out_mid:>17} {hi70:>8}")

    _print_bins(rows_s, "modèle de score (λ → distribution jointe → τ)")
    _print_bins(rows_c, "classifieur + Platt")

    # ── Les extrêmes, côté favori ────────────────────────────────────────────
    print(f"\n   ── Les extrêmes, orientés côté favori ──")
    print("   (c'est là que se pose une mise, et là que les deux modèles divergent)")
    print("   Sélection faite sur le classifieur : test de calibration pour LUI, "
          "simple comparaison pour le modèle de score — cf. les bins propres "
          "ci-dessus, seuls inattaquables.")
    print(f"   {'favori ≥':>9} {'n':>6} {'classif.':>9} {'score':>9} {'observé':>9} "
          f"{'IC 95 %':>19}  qui est dans l'IC")
    tails = {}
    for hi in (0.55, 0.60, 0.65, 0.70, 0.75):
        r = _oriented(y, p_s, p_c, (p_c >= hi) | (p_c <= 1 - hi))
        if not r:
            continue
        tails[f"{hi:.2f}"] = r
        who = []
        if r["classifieur_dans_ic"]:
            who.append("classifieur")
        if r["score_dans_ic"]:
            who.append("score")
        verdict = " et ".join(who) if who else "AUCUN des deux"
        thin = " ~" if r["n"] < min_bin else ""
        print(f"   {hi:>9.2f} {r['n']:>6} {r['favori_predit_classifieur']:>9.4f} "
              f"{r['favori_predit_score']:>9.4f} {r['favori_observe']:>9.4f} "
              f"[{r['ci95'][0]:.3f} ; {r['ci95'][1]:.3f}]  {verdict}{thin}")

    # ── Où ils divergent, et qui a raison ────────────────────────────────────
    delta = p_s - p_c
    print(f"\n   ── Par ampleur du désaccord |P_score − P_classif| ──")
    print(f"   {'bucket':>12} {'n':>6} {'|Δ| moy':>8} {'classif.':>9} {'score':>9} "
          f"{'observé':>9} {'Δ log-loss (score − classif.)':>31}")
    buckets, b_edges = [], [0.0, 0.02, 0.05, 0.10, 1.01]
    for lo, hi in zip(b_edges[:-1], b_edges[1:]):
        m = (np.abs(delta) >= lo) & (np.abs(delta) < hi)
        r = _oriented(y, p_s, p_c, m)
        if not r:
            continue
        pr = _paired(y, p_s, p_c, m)
        r["bucket"] = [round(lo, 2), round(hi, 2)]
        r["abs_delta_mean"] = round(float(np.abs(delta[m]).mean()), 4)
        r["paired"] = pr
        buckets.append(r)
        sig = "significatif" if (pr and pr["significatif"]) else "dans le bruit"
        cell = f"{pr['delta_logloss']:+.5f} ± {pr['se']:.5f}  {sig}" if pr else "—"
        print(f"   {lo:>5.2f}–{hi:<6.2f} {r['n']:>6} {r['abs_delta_mean']:>8.4f} "
              f"{r['favori_predit_classifieur']:>9.4f} {r['favori_predit_score']:>9.4f} "
              f"{r['favori_observe']:>9.4f} {cell:>31}")

    paired_all = _paired(y, p_s, p_c)
    paired_tail = _paired(y, p_s, p_c, (p_c >= 0.65) | (p_c <= 0.35))

    # ── Les affiches où l'écart est le plus grand ────────────────────────────
    print(f"\n   ── Les {top} plus gros désaccords ──")
    print(f"   {'date':>10} {'affiche':<24} {'classif.':>9} {'score':>9} {'Δ':>7} "
          f"{'résultat':>9}")
    idx = np.argsort(-np.abs(delta))[:top]
    worst_games = []
    for i in idx:
        r = test.iloc[int(i)]
        aff = f"{r['home_team']} vs {r['away_team']}"
        res = "dom gagne" if y[i] == 1 else "ext gagne"
        worst_games.append({"date": str(r["date"]), "match": aff,
                            "p_classifieur": round(float(p_c[i]), 4),
                            "p_score": round(float(p_s[i]), 4),
                            "delta": round(float(delta[i]), 4),
                            "home_win": int(y[i])})
        print(f"   {str(r['date']):>10} {aff:<24} {p_c[i]:>9.4f} {p_s[i]:>9.4f} "
              f"{delta[i]:>+7.4f} {res:>9}")

    # ── La puck line : le même objet, sans la prolongation ───────────────────
    #
    # LA QUESTION À LAQUELLE CETTE SECTION RÉPOND. Le moneyline est compressé.
    # Deux causes possibles, et elles n'appellent pas le même correctif :
    #   (A) l'écart entre λ_dom et λ_ext est rétréci par la régularisation des
    #       arbres → TOUTE la distribution jointe est compressée ;
    #   (B) `p_ot_home` est une CONSTANTE (~0,4996) : un gros favori qui va en
    #       prolongation est traité comme un pile ou face → seul le moneyline
    #       est touché.
    # La puck line −1.5 sépare les deux : elle sort de la même matrice, mais un
    # match qui va en prolongation finit forcément à un but d'écart, donc
    # `p_ot_home` n'entre pas dans son calcul. Compressée aussi → (A).
    #
    # ⚠️ `score_report.json` annonce la puck line calibrée : 0,3329 prédit contre
    # 0,332 observé. C'est une MOYENNE — exactement le chiffre qui laissait déjà
    # passer les queues fausses du moneyline. D'où les bins ci-dessous.
    rows_pl = _bins(y_pl, p_pl, edges, min_bin)
    ece_pl, mce_pl, worst_pl = _ece(rows_pl, len(y_pl), min_bin)
    print(f"\n   ── Puck line domicile −1.5 (marge ≥ 2 buts) ──")
    print(f"   moyenne : prédit {p_pl.mean():.4f} · observé {y_pl.mean():.4f} "
          f"· log-loss {_ll_each(y_pl, p_pl).mean():.5f} · ECE {ece_pl:.5f} "
          f"· MCE {mce_pl:.5f}")
    _print_bins(rows_pl, "puck line −1.5, modèle de score (aucune prolongation dedans)")

    # ── La compression en un nombre, comparable d'un marché à l'autre ────────
    print("\n   ── Pente de recalibration  a  de  y ~ σ(a·logit(p) + b) ──")
    print("   a > 1 : probabilités écrasées vers 50 %, à étirer · a ≈ 1 : calibré")
    print("   Ajustée sur la VALIDATION (hors test), puis re-mesurée sur le test :")
    print("   si les deux tombent au même endroit, la correction est stable.")
    pv_c, _ = _p_classifier(val)
    pv = _p_score(val)
    pv_s, pv_pl = pv["moneyline"], pv["puckline"]
    yv = val["home_win"].values.astype(float)
    yv_pl = ((val["home_score"] - val["away_score"]).values >= 2).astype(float)

    slopes = {}
    print(f"\n   {'':<34} {'a (validation)':>22} {'a (test)':>22}")
    for lab, key, (yv_, pv_), (yt_, pt_) in (
            ("moneyline — modèle de score", "score_moneyline", (yv, pv_s), (y, p_s)),
            ("puck line −1.5 — modèle de score", "score_puckline", (yv_pl, pv_pl), (y_pl, p_pl)),
            ("moneyline — classifieur+Platt", "classifier_moneyline", (yv, pv_c), (y, p_c))):
        a_v, a_t = _platt_slope(yv_, pv_), _platt_slope(yt_, pt_)
        slopes[key] = {"val": a_v, "test": a_t}
        f_v = "✗" if a_v["comprime"] else "✓"
        f_t = "✗" if a_t["comprime"] else "✓"
        print(f"   {lab:<34} {a_v['a']:>10.4f} ± {a_v['se_a']:.4f} {f_v}  "
              f"{a_t['a']:>10.4f} ± {a_t['se_a']:.4f} {f_t}")
    print("   ✗ = a significativement > 1 (IC 95 % au-dessus de 1) → comprimé")

    gap = _slope_gap(y, p_s, y_pl, p_pl, n_boot)
    if gap:
        verdict_gap = ("l'écart EST significatif" if gap["significatif"]
                       else "l'écart n'est PAS distinguable de zéro")
        print(f"\n   Écart de pente moneyline − puck line, bootstrap apparié "
              f"({gap['n_boot']} tirages) :")
        print(f"   {gap['gap_mean']:+.4f} ± {gap['gap_se']:.4f}, "
              f"IC 95 % [{gap['ic95'][0]:+.4f} ; {gap['ic95'][1]:+.4f}] → {verdict_gap}.")
        print("   C'est CE test qui sépare les deux causes, pas la comparaison "
              "des deux ✗/✓ ci-dessus.")

    # ── La cause (B) mesurée en face, pas déduite ────────────────────────────
    ot = _overtime(train_df, test, pt, min_bin)

    # Ce que la correction (B) donnerait, jugée HORS de la tranche qui l'a
    # produite : le remplaçant est ajusté sur la validation, appliqué au test,
    # et on refait passer le moneyline corrigé dans le même diagramme.
    rows_fix, slope_fix, ece_fix = None, None, None
    if pt.get("ot_model") is not None:
        print(f"\n   ── Correction de la prolongation : DÉJÀ EN SERVICE ──")
        print("   Les chiffres ci-dessus la comprennent déjà. La simulation "
              "« ce qu'elle donnerait » est donc sautée : la refaire par-dessus "
              "reviendrait à mesurer une seconde correction empilée sur la "
              "première.")
    elif ot.get("_w") is not None:
        p_ot_all = apply_logistic((pt["lam_h"] - pt["lam_a"]).reshape(-1, 1), ot["_w"])
        p_fix = pt["reg"] + pt["tie"] * p_ot_all
        rows_fix = _bins(y, p_fix, edges, min_bin)
        ece_fix, mce_fix, _ = _ece(rows_fix, len(y), min_bin)
        slope_fix = _platt_slope(y, p_fix)
        print(f"\n   ── Ce que la correction (B) donnerait sur le test ──")
        print(f"   (p_ot ajusté sur l'ENTRAÎNEMENT, appliqué ici : hors échantillon)")
        print(f"   log-loss {_ll_each(y, p_fix).mean():.5f} (avant {ll_s:.5f}) · "
              f"ECE {ece_fix:.5f} (avant {ece_s:.5f}) · MCE {mce_fix:.5f} "
              f"(avant {mce_s:.5f})")
        print(f"   pente a = {slope_fix['a']:.4f} ± {slope_fix['se_a']:.4f} "
              f"(avant {slopes['score_moneyline']['test']['a']:.4f})")
        _print_bins(rows_fix, "moneyline corrigé — p_ot dépendant de l'affiche")

    # ── Verdict, mécanique ───────────────────────────────────────────────────
    print("\n   ── Verdict ──")
    lines = []
    for lab, rows in (("modèle de score", rows_s), ("classifieur", rows_c)):
        bad = [r for r in rows if r["n"] >= min_bin and not r["calibrated"]]
        if bad:
            det = " ; ".join(f"[{r['lo']:.1f}–{r['hi']:.1f}] annonce "
                             f"{r['p_predicted']:.3f}, observé {r['p_observed']:.3f} "
                             f"sur {r['n']} matchs" for r in bad)
            lines.append(f"Sur ses PROPRES bins (test inattaquable), le {lab} sort de "
                         f"l'IC dans {len(bad)} bin(s) d'effectif suffisant : {det}.")
        else:
            lines.append(f"Sur ses propres bins, le {lab} est dans l'IC partout où "
                         f"l'effectif dépasse {min_bin}.")
    if paired_all and paired_all["significatif"]:
        gagnant = "modèle de score" if paired_all["delta_logloss"] < 0 else "classifieur"
        lines.append(f"Sur l'ensemble du test, le {gagnant} est meilleur : Δ log-loss "
                     f"{paired_all['delta_logloss']:+.5f} ± {paired_all['se']:.5f} "
                     f"(t = {paired_all['t']}).")
    elif paired_all:
        lines.append(f"Sur l'ensemble du test, les deux sont à parité : Δ log-loss "
                     f"{paired_all['delta_logloss']:+.5f} ± {paired_all['se']:.5f}, "
                     f"IC 95 % {paired_all['ic95']} — il contient 0.")
    if paired_tail and paired_tail["significatif"]:
        gagnant = "modèle de score" if paired_tail["delta_logloss"] < 0 else "classifieur"
        lines.append(f"Dans les extrêmes (P_classif hors [0,35 ; 0,65], "
                     f"n = {paired_tail['n']}), le {gagnant} est meilleur : "
                     f"{paired_tail['delta_logloss']:+.5f} ± {paired_tail['se']:.5f}.")
    elif paired_tail:
        lines.append(f"Dans les extrêmes (n = {paired_tail['n']}), l'écart reste dans "
                     f"le bruit : {paired_tail['delta_logloss']:+.5f} ± "
                     f"{paired_tail['se']:.5f}.")
    t65 = tails.get("0.65")
    if t65:
        if t65["score_dans_ic"] and not t65["classifieur_dans_ic"]:
            lines.append("À partir de 65 %, l'observé confirme le modèle de score et "
                         "REFUSE le classifieur : le classifieur surestime ses favoris.")
        elif t65["classifieur_dans_ic"] and not t65["score_dans_ic"]:
            lines.append("À partir de 65 %, l'observé confirme le classifieur et "
                         "REFUSE le modèle de score : sa prudence dans les extrêmes "
                         "coûte de la précision, et ④ a basculé six marchés dessus.")
        elif not t65["classifieur_dans_ic"] and not t65["score_dans_ic"]:
            lines.append("À partir de 65 %, AUCUN des deux n'est dans l'IC de "
                         "l'observé — les deux queues sont fausses, dans le même sens.")
        else:
            n_need = t65.get("n_pour_trancher")
            lines.append("À partir de 65 %, les deux prédictions tiennent dans l'IC de "
                         f"l'observé sur {t65['n']} matchs : l'écart des 11 points "
                         "n'est PAS tranchable ici"
                         + (f" — il faudrait ~{n_need} matchs de cette population "
                            f"(soit ~{n_need / max(t65['n'], 1):.1f}× ce qu'on a)."
                            if n_need else "."))
    s_ml, s_pl = slopes["score_moneyline"]["test"], slopes["score_puckline"]["test"]
    ot_bad = [b for b in ot["buckets"] if not b["constante_dans_ic"] and not b["thin"]]
    if gap and not gap["significatif"] and s_ml["comprime"]:
        lines.append(f"CAUSE NON TRANCHÉE par les pentes seules : moneyline "
                     f"a = {s_ml['a']:.3f} ± {s_ml['se_a']:.3f}, puck line "
                     f"a = {s_pl['a']:.3f} ± {s_pl['se_a']:.3f}, mais leur écart "
                     f"apparié vaut {gap['gap_mean']:+.3f} ± {gap['gap_se']:.3f} — "
                     f"IC 95 % {gap['ic95']}, il contient 0. « Puck line non "
                     f"significative » ne veut donc PAS dire « puck line saine ».")
    if ot_bad:
        det = " ; ".join(f"P(dom) {b['band'][0]:.2f}–{b['band'][1]:.2f} : observé "
                         f"{b['observed']:.3f} sur {b['n']} prolongations, IC "
                         f"[{b['ci95'][0]:.3f} ; {b['ci95'][1]:.3f}]" for b in ot_bad)
        lines.append(f"CAUSE (B) CONFIRMÉE EN FACE : la prolongation n'est pas un "
                     f"pile ou face uniforme — la constante {pt['p_ot_const']:.4f} "
                     f"tombe hors de l'IC observé dans {len(ot_bad)} tranche(s) "
                     f"({det}).")
    elif ot.get("fit"):
        lines.append(f"Prolongation : la constante {pt['p_ot_const']:.4f} reste dans "
                     f"l'IC de toutes les tranches d'effectif suffisant — la cause "
                     f"(B) n'est pas démontrée par la mesure directe.")
    if slope_fix is not None:
        # Les trois critères ont été posés AVANT de voir le résultat (cf.
        # RESTE_A_FAIRE.md). On les évalue un par un plutôt que de retenir
        # celui qui arrange.
        b78 = [r for r in rows_fix if r["n"] and abs(r["lo"] - 0.7) < 1e-9]
        c_tail = bool(b78 and b78[0]["calibrated"])
        c_ece = bool(ece_fix <= ece_s)
        avant = {(r["lo"], r["hi"]) for r in rows_s
                 if r["n"] >= min_bin and not r["calibrated"]}
        casses = [r for r in rows_fix if r["n"] >= min_bin and not r["calibrated"]
                  and (r["lo"], r["hi"]) not in avant]
        c_new = not casses
        det = " · ".join([
            f"queue {'✓' if c_tail else '✗'}",
            f"ECE {'✓' if c_ece else '✗'} ({ece_s:.5f} → {ece_fix:.5f})",
            f"aucun bin cassé {'✓' if c_new else '✗'}"
            + ("" if c_new else " — " + ", ".join(f"[{r['lo']:.1f}–{r['hi']:.1f}] "
                                                  f"annonce {r['p_predicted']:.3f}, "
                                                  f"observé {r['p_observed']:.3f}"
                                                  for r in casses)),
        ])
        verdict = ("elle passe les trois" if (c_tail and c_ece and c_new)
                   else "elle N'EST PAS suffisante en l'état")
        lines.append(f"Correction (B), jugée hors échantillon sur les 3 critères "
                     f"posés d'avance : {det}. Pente {s_ml['a']:.3f} → "
                     f"{slope_fix['a']:.3f} → {verdict}.")
    if ot_bad:
        pass          # la mesure directe a déjà tranché, plus haut : pas de doublon
    elif s_ml["comprime"] and s_pl["comprime"]:
        lines.append(f"CAUSE (A) — la compression est dans la DISTRIBUTION, pas dans "
                     f"la prolongation : la puck line est comprimée aussi "
                     f"(a = {s_pl['a']:.3f} ± {s_pl['se_a']:.3f}, contre "
                     f"{s_ml['a']:.3f} ± {s_ml['se_a']:.3f} pour le moneyline). "
                     f"Corriger à la source (étirer l'écart de λ), pas en sortie — "
                     f"et l'edge d'A2, qui est une règle de puck line, est biaisé "
                     f"par le même défaut.")
    elif s_ml["comprime"] and not s_pl["comprime"]:
        lines.append(f"CAUSE (B) — la puck line est calibrée (a = {s_pl['a']:.3f} ± "
                     f"{s_pl['se_a']:.3f}) alors que le moneyline ne l'est pas "
                     f"(a = {s_ml['a']:.3f}) : le défaut est dans la PROLONGATION, "
                     f"c'est-à-dire dans `p_ot_home` servi comme une constante. "
                     f"Correctif contenu au moneyline ; A2 et les totaux ne sont "
                     f"pas concernés.")
    elif not s_ml["comprime"]:
        lines.append(f"Aucune compression significative du moneyline sur cette "
                     f"tranche (a = {s_ml['a']:.3f} ± {s_ml['se_a']:.3f}) — relire "
                     f"les bins avant de corriger quoi que ce soit.")
    else:
        lines.append(f"Puck line comprimée (a = {s_pl['a']:.3f}) sans que le "
                     f"moneyline le soit : configuration inattendue, à comprendre "
                     f"avant de toucher au modèle.")
    for l in lines:
        print(f"   • {l}")
    print("   ⚠️  Calibration ≠ rentabilité : un modèle parfaitement calibré ne bat "
          "pas le marché pour autant. Cette mesure dit seulement à quoi se fier "
          "quand ④ price un marché non dérivable.")

    out = {
        "n_test_games": int(len(test)),
        "period": [str(test["date"].min()), str(test["date"].max())],
        "min_bin": min_bin,
        "market_blend_active": bool(blend_w),
        "global": {
            "score_model": {"log_loss": round(float(ll_s), 5), "brier": round(br_s, 5),
                            "ece": round(ece_s, 5), "mce": round(mce_s, 5),
                            "p_mean": round(float(p_s.mean()), 4)},
            "classifier": {"log_loss": round(float(ll_c), 5), "brier": round(br_c, 5),
                           "ece": round(ece_c, 5), "mce": round(mce_c, 5),
                           "p_mean": round(float(p_c.mean()), 4)},
            "observed": round(float(y.mean()), 4),
        },
        "sharpness": sharp,
        "bins": {"score_model": rows_s, "classifier": rows_c,
                 "score_model_puckline": rows_pl},
        "puck_line": {"p_mean": round(float(p_pl.mean()), 4),
                      "observed": round(float(y_pl.mean()), 4),
                      "log_loss": round(float(_ll_each(y_pl, p_pl).mean()), 5),
                      "ece": round(ece_pl, 5), "mce": round(mce_pl, 5),
                      "worst_bin": worst_pl},
        "calibration_slopes": slopes,
        "slope_gap_moneyline_minus_puckline": gap,
        "overtime": {k: v for k, v in ot.items() if not k.startswith("_")},
        "correction_b_out_of_sample": ({"bins": rows_fix, "ece": round(ece_fix, 5),
                                        "slope": slope_fix}
                                       if slope_fix is not None else None),
        "worst_bin": {"score_model": worst_s, "classifier": worst_c},
        "tails_favourite_view": tails,
        "disagreement_buckets": buckets,
        "paired_logloss": {"all": paired_all, "extremes": paired_tail},
        "largest_disagreements": worst_games,
        "verdict": lines,
    }
    # `encoding="utf-8"` explicite ET `ensure_ascii` laissé à True : sans le
    # premier, Windows ouvre en cp1252 et le « Δ » des verdicts fait planter
    # l'écriture après que TOUT a été calculé et affiché (vu le 2026-08-26) ;
    # sans le second, le fichier contiendrait des accents que le prochain
    # `json.load(open(...))` sur Windows relirait de travers. Les rapports du
    # dépôt sont tous en ASCII échappé pour cette raison — `score_report.json`
    # porte « empil\u00e9 ».
    with open(RELIABILITY_OUT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    print(f"\n✅ reliability_report.json → {MODELS}/")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--use", choices=["blend", "raw"], default="blend")
    ap.add_argument("--reliability", action="store_true",
                    help="Diagramme de fiabilité des DEUX modèles sur la tranche "
                         "de test, par bin de probabilité. N'a besoin d'aucune cote.")
    ap.add_argument("--slope-boot", type=int, default=200,
                    help="Tirages du bootstrap apparié qui teste l'écart de pente "
                         "entre marchés (défaut 200, ~35 s). 0 pour le sauter.")
    ap.add_argument("--min-bin", type=int, default=MIN_BIN_DEFAULT,
                    help=f"Effectif sous lequel un bin est marqué trop mince pour "
                         f"conclure (défaut {MIN_BIN_DEFAULT}).")
    args = ap.parse_args()

    if args.reliability:
        reliability(args.min_bin, args.slope_boot)
        return

    report = json.load(open(f"{MODELS}/training_report.json"))
    feats = report["features"]["game"]
    gr = report["game_model"]

    df = pd.read_csv(DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    test = df.iloc[int(len(df) * 0.8):].copy()

    need = ["market_home_p_close", "home_ml_close", "away_ml_close"]
    if not all(c in test.columns for c in need):
        print("❌ Pas de cotes dans le dataset — backtest ROI impossible.")
        return
    test = test[test["market_home_p_close"].notna()].copy()
    if len(test) < 100:
        print(f"❌ Seulement {len(test)} matchs de test avec cotes — backtest peu fiable.")
        return
    print(f"📊 Backtest sur {len(test)} matchs de test avec cotes "
          f"({test['date'].min()} → {test['date'].max()})")

    model = xgb.Booster()
    model.load_model(f"{MODELS}/game_model.json")
    dm = xgb.DMatrix(test[feats].values.astype(np.float32),
                     feature_names=feats, missing=np.nan)
    p_raw = model.predict(dm)

    cal = gr["calibration"]
    p_model = _sigmoid(cal["a"] * _logit(p_raw) + cal["b"])

    blend_w = (gr.get("baselines", {}).get("market", {}) or {}).get("blend_weights")
    if args.use == "blend" and blend_w:
        w = blend_w
        p_model = _sigmoid(w[0] * _logit(p_raw)
                           + w[1] * _logit(test["market_home_p_close"].values) + w[2])
        print("   → probas = blend modèle ⊕ marché")
    else:
        print("   → probas = modèle calibré (sans blend)")

    y = test["home_win"].values.astype(float)
    p_mkt = test["market_home_p_close"].values
    dec_h = test["home_ml_close"].values
    dec_a = test["away_ml_close"].values

    ll_model = -np.mean(y * np.log(np.clip(p_model, 1e-7, 1))
                        + (1 - y) * np.log(np.clip(1 - p_model, 1e-7, 1)))
    ll_mkt = -np.mean(y * np.log(p_mkt) + (1 - y) * np.log(1 - p_mkt))
    print(f"\n   Log-loss : modèle {ll_model:.4f}  vs marché {ll_mkt:.4f}")

    results = []
    print(f"\n   {'edge>':>6} {'paris':>6} {'hit%':>6} {'ROI flat':>9} {'ROI ¼Kelly':>11}")
    for edge in [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08]:
        profit_flat, profit_kelly, stake_kelly, bets, wins = 0.0, 0.0, 0.0, 0, 0
        for i in range(len(test)):
            if not (np.isfinite(dec_h[i]) and np.isfinite(dec_a[i])):
                continue
            for p, dec, won in [(p_model[i], dec_h[i], y[i] == 1),
                                (1 - p_model[i], dec_a[i], y[i] == 0)]:
                if dec <= 1:
                    continue
                p_imp = (1 / dec) / (1 / dec_h[i] + 1 / dec_a[i])   # dévigé
                if p - p_imp < edge:
                    continue
                bets += 1
                wins += int(won)
                profit_flat += (dec - 1) if won else -1
                b = dec - 1
                k = max(0.0, (p * b - (1 - p)) / b) * 0.25
                stake_kelly += k
                profit_kelly += k * b if won else -k
        roi_f = profit_flat / bets * 100 if bets else 0
        roi_k = profit_kelly / stake_kelly * 100 if stake_kelly > 0 else 0
        hit = wins / bets * 100 if bets else 0
        results.append({"edge_threshold": edge, "n_bets": bets,
                        "hit_rate": round(hit, 2), "roi_flat_pct": round(roi_f, 2),
                        "roi_kelly_pct": round(roi_k, 2)})
        print(f"   {edge:>5.0%} {bets:>6} {hit:>5.1f}% {roi_f:>8.2f}% {roi_k:>10.2f}%")

    out = {"n_test_games": len(test),
           "period": [str(test["date"].min()), str(test["date"].max())],
           "probas": args.use,
           "log_loss": {"model": round(float(ll_model), 4), "market": round(float(ll_mkt), 4)},
           "strategies": results}
    json.dump(out, open(f"{MODELS}/backtest_report.json", "w"), indent=2)
    print(f"\n✅ backtest_report.json → {MODELS}/")
    print("   ⚠️ ROI basé sur cotes de clôture historiques — le marché réel bouge. "
          "Un ROI flat > 0 avec ≥ 200 paris est déjà un excellent signe.")


if __name__ == "__main__":
    main()
