"""
train_score.py — modèle de score structuré (P2)
================================================

Remplace la régression MSE sur `total_goals`, qui n'apprenait presque rien
(MAE 1.866 contre 1.8996 pour une constante) et ne permettait de pricer aucune
ligne, par un modèle du **processus de buts**.

Principe
--------
Un seul modèle Poisson, entraîné sur des lignes « équipe-match » : chaque match
produit deux lignes, une par équipe, avec les features orientées attaque/défense.

    ligne 1 : cible = buts réglementaires dom, atk_* = dom, def_* = ext, is_home=1
    ligne 2 : cible = buts réglementaires ext, atk_* = ext, def_* = dom, is_home=0

Deux fois plus de données qu'un modèle par côté, et les paramètres sont partagés :
marquer 3 buts contre une défense donnée obéit à la même mécanique qu'on soit à
domicile ou à l'extérieur — seule l'intensité change, ce que capte `is_home`.

En sortie, λ_dom et λ_ext donnent la distribution jointe complète, d'où se
déduisent analytiquement : moneyline, puckline ±1.5, totaux à N'IMPORTE quelle
ligne, totaux d'équipe. Le modèle précédent ne pouvait rien pricer de tout ça.

Incertitude (P4) — OPT-IN, désactivé par défaut
-----------------------------------------------
`--ensemble K` entraîne en plus K boosters sur autant de rééchantillonnages
bootstrap des matchs. Chaque membre donne son propre couple (λ_dom, λ_ext),
donc son propre prix pour chaque marché : l'écart-type entre membres est
l'incertitude d'estimation du prix.

P4 a tranché : σ ne dit PAS où le modèle se trompe, seulement où l'edge
*sélectionné* est gonflé (malédiction du vainqueur), et ce n'est pas
actionnable — l'edge corrigé est négatif partout. La règle de réduction de mise
n'a donc jamais été branchée, et les 8.9 Mo de membres n'étaient plus qu'un
poids mort dans l'image. Le défaut est passé à 0 : c'est un outil de
diagnostic hors ligne, qu'on relance quand on veut re-mesurer σ.

Usage :
    cd ml/python
    python build_dataset.py     # d'abord — crée les cibles réglementaires
    python train_score.py [--trials 30]
    python train_score.py --ensemble 20    # diagnostic σ, hors ligne
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
import xgboost as xgb

from score_model import (MAX_GOALS, ScoreDistribution, ScoreEnsemble,
                         apply_margin_correction, fit_margin_correction,
                         joint_matrix)

DATA_V4 = "../data/nhl_games_v4.csv"
MODELS_DIR = "../models"
RNG = np.random.default_rng(42)

# ── Features orientées ───────────────────────────────────────────────────────
# ATK : capacité offensive de l'équipe qui marque
# DEF : capacité défensive de l'adversaire (gardien inclus)
#
# ── A5, clos le 2026-08-23 : ces 22 features ne sont PAS départageables ──────
#
# Ne pas relancer d'élagage ici sans lire d'abord ce paragraphe : la mesure a
# été faite, elle a coûté 364 entraînements, et sa conclusion est négative au
# sens propre — pas « garder les 22 est optimal », mais « l'historique
# disponible ne permet pas de dire lesquelles retirer ».
#
# L'ablation par permutation (14 saisons 2012-2025, métrique = log-loss de la
# puck line, rapport dans `../models/score_feature_selection.json`) classe six
# features au-dessus de la barre : `elo_atk_minus_def` (92,9 % de saisons
# positives), `def_ev_xga60_s` (85,7 %), `atk_lineup_pts` (78,6 %),
# `atk_ev_xgf_pct_s`, `atk_stars_out_weight`, `def_goalie_svpct` (71,4 %).
# Trois colonnes de bruit pur soumises au même traitement décrochent 50 %,
# 57,1 % et 64,3 % — le hasard, tel que cette procédure le produit.
#
# Le contrôle par suppression réelle (`backtest_walkforward.py
# --confirm-score-features`, rapport dans `score_feature_confirmation.json`) a
# retiré les 12 features à ≤ 57,1 %. Résultat :
#
#     Δ log-loss puck line  +0,00019  ±  0,00024 (erreur-type, 14 saisons)
#
# **L'écart est plus petit que sa propre barre d'erreur** (t = 0,82 ; 8 saisons
# sur 14 dégradées, ce que du pile ou face produit 39,5 % du temps). L'écart-type
# inter-saisons est de 0,00089 : il faudrait ≈ 154 saisons pour résoudre un effet
# de cette taille. Le critère pré-enregistré rend DÉGRADE et on s'y tient, mais
# ce qu'il faut retenir est plus fort — **aucun sous-groupe ne sera plus
# résoluble**, puisqu'un effet plus petit demande encore plus de saisons.
#
# Les deux métriques secondaires, chacune contre son propre bruit, expliquent
# pourquoi la puck line reste muette : déviance de Poisson +0,00089 (±0,00037,
# nettement pire) contre log-loss moneyline −0,00054 (±0,00015, nettement mieux).
# Les 12 colonnes retirées portent le **niveau** de λ, pas l'**écart** entre les
# deux équipes. La puck line dépend de l'écart : elle se retrouve entre les deux
# et ne tranche pas.
#
# Ce que ça coûte de garder les 22 : P5 avait mesuré 0,00245 de log-loss pour
# 104 features en trop sur le classifieur. Ici il s'agit de 12, dont l'effet
# mesuré vaut 0,0002. Négligeable — et c'est la raison de ne pas y revenir.
ATK_COLS = ["xgf60_s", "xgf60_l", "ev_xgf60_s", "ev_xgf_pct_s", "gf_s",
            "finishing_s", "star_power", "stars_out_weight",
            "pp_xgf60_s", "rest_days", "b2b",
            # Projection bottom-up depuis l'alignement habillé (P3).
            # Mesuré : déviance de validation 1.05500 → 1.05232 et log-loss
            # moneyline 0.6687 → 0.6675. Complémentaire de `star_power`, qui
            # reste utile (le retirer dégrade : 1.05339).
            "lineup_xg", "lineup_pts"]
DEF_COLS = ["xga60_s", "xga60_l", "ev_xga60_s", "ga_s",
            "pk_xga60_s", "goalie_gsax60", "goalie_svpct"]

SEARCH_SPACE = {
    "max_depth":        [3, 4, 5],
    "learning_rate":    [0.02, 0.03, 0.05],
    "subsample":        [0.7, 0.8, 0.9],
    "colsample_bytree": [0.6, 0.8, 1.0],
    "min_child_weight": [1, 5, 10, 20],
    "reg_lambda":       [1.0, 3.0, 10.0],
}


def stacked_features() -> list[str]:
    return ([f"atk_{c}" for c in ATK_COLS] + [f"def_{c}" for c in DEF_COLS]
            + ["is_home", "elo_atk_minus_def"])


def stack(df: pd.DataFrame) -> pd.DataFrame:
    """Un match → deux lignes équipe-match, features orientées attaque/défense."""
    out = []
    for atk, dfn, is_home, target in [("home", "away", 1, "home_reg_score"),
                                      ("away", "home", 0, "away_reg_score")]:
        d = pd.DataFrame(index=df.index)
        for c in ATK_COLS:
            d[f"atk_{c}"] = df[f"{atk}_{c}"] if f"{atk}_{c}" in df.columns else np.nan
        for c in DEF_COLS:
            d[f"def_{c}"] = df[f"{dfn}_{c}"] if f"{dfn}_{c}" in df.columns else np.nan
        d["is_home"] = float(is_home)
        d["elo_atk_minus_def"] = df[f"{atk}_elo"] - df[f"{dfn}_elo"]
        d["y"] = df[target].astype(float)
        d["date"] = df["date"].values
        d["_side"] = atk
        d["_row"] = np.arange(len(df))
        out.append(d)
    return pd.concat(out, ignore_index=True)


def dm(d: pd.DataFrame, feats: list[str], with_label: bool = True) -> xgb.DMatrix:
    return xgb.DMatrix(d[feats].values.astype(np.float32),
                       label=d["y"].values.astype(np.float32) if with_label else None,
                       feature_names=feats, missing=np.nan)


def poisson_deviance(y: np.ndarray, mu: np.ndarray) -> float:
    mu = np.clip(mu, 1e-6, None)
    with np.errstate(divide="ignore", invalid="ignore"):
        term = np.where(y > 0, y * np.log(y / mu), 0.0)
    return float(2.0 * np.mean(term - (y - mu)))


def split(df: pd.DataFrame, val=0.15, test=0.2):
    df = df.sort_values("date").reset_index(drop=True)
    n = len(df)
    cut_t = int(n * (1 - test))
    cut_v = int(cut_t * (1 - val))
    return df.iloc[:cut_v].copy(), df.iloc[cut_v:cut_t].copy(), df.iloc[cut_t:].copy()


def random_search(dtrain, dval, y_val, trials: int) -> dict:
    base = {"objective": "count:poisson", "eval_metric": "poisson-nloglik", "seed": 42}
    best, best_score = None, np.inf
    for i in range(trials):
        p = dict(base)
        for k, choices in SEARCH_SPACE.items():
            p[k] = choices[RNG.integers(len(choices))]
        m = xgb.train(p, dtrain, num_boost_round=700, evals=[(dval, "val")],
                      early_stopping_rounds=40, verbose_eval=False)
        s = poisson_deviance(y_val, m.predict(dval))
        if s < best_score:
            best, best_score = p, s
            print(f"   essai {i + 1}/{trials} : déviance {s:.5f} ★")
    return best


def lambdas_for(model, feats, stacked, n_games):
    """Retourne (λ_dom, λ_ext) alignés sur les lignes du dataset d'origine."""
    pred = model.predict(dm(stacked, feats, with_label=False))
    lam_h = np.full(n_games, np.nan)
    lam_a = np.full(n_games, np.nan)
    rows = stacked["_row"].values
    sides = stacked["_side"].values
    lam_h[rows[sides == "home"]] = pred[sides == "home"]
    lam_a[rows[sides == "away"]] = pred[sides == "away"]
    return lam_h, lam_a


def expected_margin_pmf(lam_h, lam_a, max_abs=6) -> np.ndarray:
    """Distribution moyenne des écarts prédite par le Poisson, match par match.

    Moyenner les distributions par match (et non utiliser un λ global) évite de
    confondre l'hétérogénéité des affiches avec le biais structurel du modèle.
    """
    acc = {d: 0.0 for d in range(-max_abs, max_abs + 1)}
    idx = np.arange(MAX_GOALS + 1)
    margin = idx[:, None] - idx[None, :]
    for lh, la in zip(lam_h, lam_a):
        M = joint_matrix(lh, la)
        for d in acc:
            acc[d] += float(M[margin == d].sum())
    n = len(lam_h)
    return {d: v / n for d, v in acc.items()}


def evaluate(df, lam_h, lam_a, tau, label):
    """Métriques sur les marchés réellement pricés."""
    y_tot = df["total_goals"].values.astype(float)
    y_win = df["home_win"].values.astype(float)
    ot = df["went_to_ot"].values.astype(float)

    p_home, e_tot, p_tie, p_m15 = [], [], [], []
    for lh, la in zip(lam_h, lam_a):
        d = ScoreDistribution(lh, la, tau=tau)
        p_home.append(d.p_home_win())
        e_tot.append(d.expected_total())
        p_tie.append(d.p_regulation_tie())
        p_m15.append(d.p_home_cover_minus_15())
    p_home = np.array(p_home); e_tot = np.array(e_tot)
    p_tie = np.array(p_tie); p_m15 = np.array(p_m15)

    ll = float(-np.mean(y_win * np.log(np.clip(p_home, 1e-7, 1)) +
                        (1 - y_win) * np.log(np.clip(1 - p_home, 1e-7, 1))))
    mae = float(np.mean(np.abs(e_tot - y_tot)))
    margin_real = (df["home_score"] - df["away_score"]).values
    res = {
        "label": label,
        "mae_total": round(mae, 4),
        "logloss_moneyline": round(ll, 4),
        "tie_predicted": round(float(np.nanmean(p_tie)), 4),
        "tie_observed": round(float(np.nanmean(ot)), 4),
        "home_-1.5_predicted": round(float(p_m15.mean()), 4),
        "home_-1.5_observed": round(float((margin_real >= 2).mean()), 4),
        "home_win_predicted": round(float(p_home.mean()), 4),
        "home_win_observed": round(float(y_win.mean()), 4),
    }
    return res


# ── Ensemble bootstrap (P4) ──────────────────────────────────────────────────

def train_ensemble(train_df, feats, params, n_rounds: int, k: int):
    """K boosters entraînés sur K rééchantillonnages bootstrap des MATCHS.

    Trois choix qui comptent :

    1. **On rééchantillonne les matchs, pas les lignes empilées.** Les deux
       lignes d'un match partagent le même résultat et les mêmes features
       adverses ; les tirer séparément casserait cette dépendance et
       sous-estimerait σ.
    2. **Pas de recherche d'hyperparamètres par membre.** On réutilise les
       paramètres du modèle principal, sinon σ mélangerait la variance
       d'échantillonnage (ce qu'on veut mesurer) avec la variance de la
       recherche aléatoire (un artefact de notre procédure).
    3. **Nombre de tours fixé, pas d'arrêt précoce.** Chaque membre s'arrêterait
       sur le même jeu de validation, ce qui les corrélerait artificiellement et
       écraserait σ. On fige le nombre de tours à celui du modèle principal.

    La graine change à chaque membre : le sous-échantillonnage lignes/colonnes
    de XGBoost devient une source de diversité supplémentaire, ce qui est
    souhaitable — σ doit refléter toute l'instabilité de la procédure, pas
    seulement celle du jeu de données.
    """
    members = []
    n = len(train_df)
    for m in range(k):
        idx = RNG.integers(0, n, size=n)
        boot = train_df.iloc[idx].reset_index(drop=True)
        p = dict(params)
        p["seed"] = 1000 + m
        d = dm(stack(boot), feats)
        members.append(xgb.train(p, d, num_boost_round=n_rounds, verbose_eval=False))
        if (m + 1) % 5 == 0 or m == k - 1:
            print(f"   membre {m + 1}/{k}")
    return members


def ensemble_lambdas(members, feats, stacked, n_games):
    """(K, n_games) pour λ_dom et λ_ext — un vecteur par membre."""
    lam_h = np.empty((len(members), n_games))
    lam_a = np.empty((len(members), n_games))
    for i, mdl in enumerate(members):
        lam_h[i], lam_a[i] = lambdas_for(mdl, feats, stacked, n_games)
    return lam_h, lam_a


def sigma_report(df, lam_h_ens, lam_a_ens, p_ot, tau, n_buckets: int = 4) -> dict:
    """σ porte-t-elle de l'information ? Test décisif, sans aucun prix.

    Si le modèle sait quand il ne sait pas, alors les matchs à σ élevé doivent
    être ceux où il se trompe le plus. On bucketise par σ et on regarde la
    log-loss. Si elle est plate d'un bucket à l'autre, σ est du bruit et réduire
    la mise en fonction de σ ne peut rien apporter — il faut le dire, comme pour
    le résultat négatif de P1, plutôt que livrer un garde-fou décoratif.
    """
    n = lam_h_ens.shape[1]
    p_mean = np.empty(n)
    p_sd = np.empty(n)
    for j in range(n):
        ens = ScoreEnsemble(list(zip(lam_h_ens[:, j], lam_a_ens[:, j])), p_ot, tau)
        p_mean[j], p_sd[j] = ens.spread("p_home_win")

    y = df["home_win"].values.astype(float)
    ll = -(y * np.log(np.clip(p_mean, 1e-7, 1)) +
           (1 - y) * np.log(np.clip(1 - p_mean, 1e-7, 1)))

    edges = np.quantile(p_sd, np.linspace(0, 1, n_buckets + 1))
    buckets = []
    for b in range(n_buckets):
        lo, hi = edges[b], edges[b + 1]
        sel = (p_sd >= lo) & (p_sd <= hi if b == n_buckets - 1 else p_sd < hi)
        if sel.sum() < 20:
            continue
        buckets.append({
            "bucket": b + 1,
            "n": int(sel.sum()),
            "sigma_mean": round(float(p_sd[sel].mean()), 5),
            "log_loss": round(float(ll[sel].mean()), 5),
            "p_predicted": round(float(p_mean[sel].mean()), 4),
            "p_observed": round(float(y[sel].mean()), 4),
        })
    verdict = "indéterminé"
    if len(buckets) >= 2:
        lls = [b["log_loss"] for b in buckets]
        gain = lls[-1] - lls[0]
        monotone = all(lls[i] <= lls[i + 1] + 1e-9 for i in range(len(lls) - 1))
        verdict = ("σ informative (log-loss croissante et monotone)" if monotone and gain > 0.005
                   else "σ faiblement informative" if gain > 0.005
                   else "σ NON informative — la réduction de mise n'a pas de fondement mesuré")
    return {"sigma_mean": round(float(p_sd.mean()), 5),
            "sigma_p90": round(float(np.quantile(p_sd, 0.90)), 5),
            "buckets": buckets, "verdict": verdict}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=30)
    ap.add_argument("--ensemble", type=int, default=0,
                    help="Membres bootstrap pour le diagnostic σ (P4). 0 = désactivé "
                         "(défaut) — σ n'est consommé par aucun code de mise et les "
                         "membres pèsent 8.9 Mo, exclus de l'image Docker. "
                         "Mettre 20 pour re-mesurer σ hors ligne.")
    ap.add_argument("--data", default=DATA_V4,
                    help="Chemin du dataset (défaut : ../data/nhl_games_v4.csv)")
    ap.add_argument("--out", default=MODELS_DIR, help="Répertoire de sortie des modèles")
    args = ap.parse_args()

    out_dir = args.out
    if not os.path.exists(args.data):
        print(f"❌ {args.data} manquant — lance d'abord : python build_dataset.py")
        return
    df = pd.read_csv(args.data, low_memory=False)
    need = ["home_reg_score", "away_reg_score", "went_to_ot"]
    if any(c not in df.columns for c in need):
        print(f"❌ Colonnes de score absentes ({need}).")
        print("   → relance `python build_dataset.py` : elles y sont désormais construites.")
        return
    df = df.dropna(subset=["home_reg_score", "away_reg_score", "went_to_ot",
                           "total_goals", "home_win", "date"]).reset_index(drop=True)
    print(f"📂 {len(df)} matchs avec cibles de score")

    train_df, val_df, test_df = split(df)
    print(f"   Split : {len(train_df)} / {len(val_df)} / {len(test_df)} "
          f"(test dès {test_df['date'].min()})")

    feats = stacked_features()
    s_tr, s_va, s_te = stack(train_df), stack(val_df), stack(test_df)
    print(f"   {len(feats)} features orientées, {len(s_tr)} lignes équipe-match d'entraînement")

    print(f"\n🥅 Recherche d'hyperparamètres ({args.trials} essais) …")
    dtr, dva = dm(s_tr, feats), dm(s_va, feats)
    params = random_search(dtr, dva, s_va["y"].values.astype(float), args.trials)
    model = xgb.train(params, dtr, num_boost_round=700, evals=[(dva, "val")],
                      early_stopping_rounds=40, verbose_eval=False)

    # ── Correction de marge τ, ajustée sur TRAIN uniquement ──────────────────
    lam_h_tr, lam_a_tr = lambdas_for(model, feats, s_tr, len(train_df))
    exp_pmf = expected_margin_pmf(lam_h_tr, lam_a_tr)
    margins_tr = (train_df["home_reg_score"] - train_df["away_reg_score"]).values
    tau = fit_margin_correction(margins_tr, exp_pmf)
    print(f"\n📐 Correction de marge τ (ajustée sur l'entraînement) :")
    for d in sorted(tau):
        if abs(tau[d] - 1.0) > 0.02:
            print(f"     écart {d:+d} : ×{tau[d]:.3f}")

    # ── Prolongation : taux de victoire à domicile, mesuré sur TRAIN ─────────
    ot_tr = train_df[train_df["went_to_ot"] == 1]
    p_ot_home = float((ot_tr["home_score"] > ot_tr["away_score"]).mean())
    print(f"   Victoire domicile en prolongation (train) : {p_ot_home:.4f} "
          f"sur {len(ot_tr)} matchs")

    # ── Évaluation sur TEST ─────────────────────────────────────────────────
    lam_h_te, lam_a_te = lambdas_for(model, feats, s_te, len(test_df))
    print(f"\n   ── Test ({len(test_df)} matchs) ──")
    r_raw = evaluate(test_df, lam_h_te, lam_a_te, None, "Poisson sans correction")
    r_cor = evaluate(test_df, lam_h_te, lam_a_te, tau, "Poisson + correction τ")

    y_tot = test_df["total_goals"].values.astype(float)
    base_mae = float(np.mean(np.abs(y_tot - train_df["total_goals"].mean())))
    print(f"\n   {'':<26} {'MAE tot':>8} {'LL ML':>8} {'nul préd':>9} {'nul obs':>8}")
    for r in (r_raw, r_cor):
        print(f"   {r['label']:<26} {r['mae_total']:>8.4f} {r['logloss_moneyline']:>8.4f} "
              f"{r['tie_predicted']:>9.4f} {r['tie_observed']:>8.4f}")
    print(f"   {'baseline constante':<26} {base_mae:>8.4f}")
    print(f"\n   Calibration puckline dom -1.5 : prédit {r_cor['home_-1.5_predicted']:.4f} "
          f"vs observé {r_cor['home_-1.5_observed']:.4f}")
    print(f"   Calibration moneyline         : prédit {r_cor['home_win_predicted']:.4f} "
          f"vs observé {r_cor['home_win_observed']:.4f}")

    # Exemple de pricing complet
    d = ScoreDistribution(float(lam_h_te[0]), float(lam_a_te[0]), p_ot_home, tau)
    print(f"\n   Exemple — {test_df.iloc[0]['home_team']} vs "
          f"{test_df.iloc[0]['away_team']} le {test_df.iloc[0]['date']} :")
    print("   " + json.dumps(d.summary(), indent=3).replace("\n", "\n   "))

    # ── Ensemble bootstrap → σ (P4) ─────────────────────────────────────────
    ens_meta = None
    if args.ensemble > 0:
        n_rounds = int(model.best_iteration) + 1
        print(f"\n🎲 Ensemble bootstrap — {args.ensemble} membres, "
              f"{n_rounds} tours fixes (best_iteration du modèle principal)")
        members = train_ensemble(train_df, feats, params, n_rounds, args.ensemble)

        # σ_max se calibre HORS ÉCHANTILLON, sur la validation.
        #
        # Mesuré le 2026-08-03 : calibré sur le train, σ_max valait 0.02307 alors
        # que le σ *moyen* du test était 0.02215 — la moitié des matchs
        # dépassaient le seuil et se voyaient réduits à zéro. La règle ne
        # modulait plus rien, elle filtrait. La cause est mécanique : les membres
        # bootstrap sont dans l'échantillon sur le train, donc ils s'y accordent
        # artificiellement et σ_train est biaisé bas. La validation n'a été vue
        # par aucun membre, son σ est celui qu'on rencontrera en service.
        lh_va, la_va = ensemble_lambdas(members, feats, s_va, len(val_df))
        sig_va = sigma_report(val_df, lh_va, la_va, p_ot_home, tau)
        sigma_max = sig_va["sigma_p90"]

        lh_tr, la_tr = ensemble_lambdas(members, feats, s_tr, len(train_df))
        sig_tr = sigma_report(train_df, lh_tr, la_tr, p_ot_home, tau)
        print(f"\n   σ p90 — train (dans l'échantillon) {sig_tr['sigma_p90']:.5f} · "
              f"validation (hors échantillon) {sigma_max:.5f}")
        if sig_tr["sigma_p90"] < 0.9 * sigma_max:
            print("   ⚠️  écart important : σ dans l'échantillon sous-estime bien "
                  "la dispersion réelle")

        lh_te, la_te = ensemble_lambdas(members, feats, s_te, len(test_df))
        sig_te = sigma_report(test_df, lh_te, la_te, p_ot_home, tau)

        print(f"\n   σ(P(dom)) moyenne {sig_te['sigma_mean']:.5f} · "
              f"σ_max (p90 train) {sigma_max:.5f}")
        print(f"   {'bucket σ':>9} {'n':>6} {'σ moyen':>9} {'log-loss':>9} "
              f"{'p prédit':>9} {'p observé':>10}")
        for b in sig_te["buckets"]:
            print(f"   {b['bucket']:>9} {b['n']:>6} {b['sigma_mean']:>9.5f} "
                  f"{b['log_loss']:>9.5f} {b['p_predicted']:>9.4f} {b['p_observed']:>10.4f}")
        print(f"   → {sig_te['verdict']}")

        ens_dir = os.path.join(out_dir, "score_ensemble")
        os.makedirs(ens_dir, exist_ok=True)
        for old in os.listdir(ens_dir):          # pas de mélange entre deux runs
            if old.startswith("member_") and old.endswith(".json"):
                os.remove(os.path.join(ens_dir, old))
        for i, mdl in enumerate(members):
            mdl.save_model(f"{ens_dir}/member_{i:02d}.json")
        ens_meta = {"n_members": len(members), "n_rounds": n_rounds,
                    "sigma_max": sigma_max,
                    "sigma_max_source": "p90 sur la validation (hors échantillon)",
                    "sigma_p90_train_insample": sig_tr["sigma_p90"],
                    "train": sig_tr, "val": sig_va, "test": sig_te}
        print(f"   {len(members)} membres → {ens_dir}/")

    os.makedirs(out_dir, exist_ok=True)
    model.save_model(f"{out_dir}/score_model.json")
    scores = model.get_score(importance_type="gain")
    total = sum(scores.values()) or 1
    fi = sorted([{"name": k, "importance": round(v / total, 4)} for k, v in scores.items()],
                key=lambda x: -x["importance"])
    json.dump({
        "model": "XGBoost count:poisson empilé (équipe-match)",
        "features": feats,
        "params": {k: v for k, v in params.items() if k in SEARCH_SPACE},
        "best_iteration": int(model.best_iteration),
        "tau_margin": {str(k): round(v, 5) for k, v in tau.items()},
        "p_ot_home": round(p_ot_home, 5),
        "n_train": len(train_df), "n_test": len(test_df),
        "test": {"raw": r_raw, "corrected": r_cor,
                 "baseline_mae_total": round(base_mae, 4)},
        "ensemble": ens_meta,
        "feature_importances": fi,
    }, open(f"{out_dir}/score_report.json", "w"), indent=2)

    print(f"\n   Top features :")
    for f in fi[:10]:
        print(f"   {f['name']:<26} {f['importance']:.4f}  {'█' * int(f['importance'] * 120)}")
    print(f"\n✅ score_model.json + score_report.json → {out_dir}/")
    if ens_meta:
        print(f"   Ensemble : {ens_meta['n_members']} membres, "
              f"σ_max {ens_meta['sigma_max']:.5f}")


if __name__ == "__main__":
    main()
