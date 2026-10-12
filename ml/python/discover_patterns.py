"""
discover_patterns.py
====================
Découverte AUTOMATIQUE de patterns statistiques récurrents, et tri entre ce qui
est réel, ce qui est déjà connu du modèle et ce qui n'est que du bruit
(STATUS.md §3.5 « P. Découverte de patterns », pilote du 2026-10-12).

Hors production : ce script ne lit que des CSV et n'écrit que des rapports.
Aucune prédiction servie ne dépend de lui. Un pattern ne passe en production
qu'en devenant une variable candidate d'un protocole d'adoption EXISTANT
(`backtest_walkforward.py --correction`, `measure_level.py`, `train_player.py`).

La question posée à chaque condition (« le samedi », « CAR contre NYR »,
« visiteur en back-to-back au 3e match d'un road trip »…) n'est PAS « le taux
de victoire est-il différent de la moyenne ? » — presque tout l'est, parce que
la force des équipes et le domicile expliquent déjà l'essentiel — mais :

    « Dans cette condition, les résultats s'écartent-ils de ce que la chaîne
      de prédiction annonçait AVANT le match ? »

Base de comparaison, sans fuite :
  * `../data/served_pregame.csv` (`live_pregame.py --served`) : la chaîne
    servie rejouée saison par saison — modèle de score du fold → couche de
    correction walk-forward → recalage de niveau gelé le lundi. C'est la base
    de référence. Les saisons sans correction (moins de 3 saisons de passé)
    sont exclues de la découverte.
  * à défaut, `../data/live_pregame.csv` (modèle de score brut, walk-forward)
    + un recalage simple ajusté sur la découverte seulement (logit p, écart
    ELO, écart b2b) — l'esprit de `correction_layer.json`.

Modes (par défaut : tous) :
  --games           conditions de match (facteur seul, paires, équipe x facteur,
                    équipe x adversaire) : victoire et total réglementaire
  --combos          test global des COMBINAISONS : XGBoost peu profond sur le
                    résidu (base_margin = logit p de la base), arrêt précoce
  --players         joueur x jour / adversaire / aréna / mois (buts)
  --shooter-goalie  tireur x gardien précis (données tir par tir MoneyPuck)
  --candidates      suivi des candidats du registre (pattern_registry.json)

Méthode, fixée AVANT les runs (pilote du 2026-10-12) :
  * découverte = saisons ≤ DISCOVERY_END, validation = saisons suivantes ;
  * z résiduel = Σ(y − p) / √Σp(1−p) (victoire), (obs − att) / √att (buts) ;
  * Benjamini-Hochberg q = 0.10 PAR FAMILLE de conditions ;
  * réplication = même signe et |z| ≥ 1.645 en validation ;
  * persistance = corrélation des z découverte / validation sur toute la
    famille : la mesure la plus parlante (≈ 0 → la famille est du bruit) ;
  * contrôle positif dans chaque expérience (un effet connu doit ressortir) ;
  * écart au marché (cote de clôture dévigée) quand elle existe.
  Un match ne compte qu'une fois par condition (sinon les deux lignes équipe
  d'un même match s'annulent ou se doublent).

Verdicts par condition : BRUIT · DÉJÀ DANS LE MODÈLE · DESCRIPTIF (vrai dans
les données, non prédictif) · CANDIDAT (à inscrire au registre et à juger sur
des matchs FUTURS) — jamais « ADOPTÉ » ici.

Dépendances : numpy, pandas, xgboost (déjà dans requirements.txt).
Pas de scipy ni de scikit-learn : tests et logistique écrits à la main.

Sorties :
  ../models/patterns_report.json     synthèse par famille + listes courtes
  ../data/patterns_conditions.csv    toutes les conditions testées (gitignoré)

Usage :
  cd ml/python
  python live_pregame.py --served     # une fois, ~30-60 min : la base servie
  python discover_patterns.py         # ~1 min
  python discover_patterns.py --games --combos
"""

from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import zipfile
from datetime import datetime, timezone

import numpy as np
import pandas as pd

DATA_DIR = "../data"
MODELS_DIR = "../models"
REPORT = f"{MODELS_DIR}/patterns_report.json"
CONDITIONS_CSV = f"{DATA_DIR}/patterns_conditions.csv"
REGISTRY = f"{MODELS_DIR}/pattern_registry.json"
SERVED = f"{DATA_DIR}/served_pregame.csv"
RAW = f"{DATA_DIR}/live_pregame.csv"

FDR_Q = 0.10
Z_REPLICATE = 1.645
MIN_N_PAIR = 300          # paires de facteurs : matchs en découverte
MIN_N_TEAM_FACTOR = 80    # équipe x facteur
MIN_N_TEAM_OPP = 15       # équipe x adversaire
EPS = 1e-6
TEAM_FIX = {"L.A": "LAK", "N.J": "NJD", "S.J": "SJS", "T.B": "TBL"}
DOW = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]


# ── Statistiques (sans scipy) ────────────────────────────────────────────────

def p_two_sided(z):
    z = np.abs(np.asarray(z, float))
    return np.vectorize(lambda x: math.erfc(x / math.sqrt(2)) if np.isfinite(x) else np.nan)(z)


def bh(pvals, q=FDR_Q) -> np.ndarray:
    """Benjamini-Hochberg : masque des hypothèses rejetées."""
    p = np.nan_to_num(np.asarray(pvals, float), nan=1.0)
    n = len(p)
    if n == 0:
        return np.zeros(0, bool)
    order = np.argsort(p)
    passed = p[order] <= q * np.arange(1, n + 1) / n
    k = int(np.max(np.where(passed)[0]) + 1) if passed.any() else 0
    out = np.zeros(n, bool)
    out[order[:k]] = True
    return out


def resid_z(y, p) -> float:
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    v = float((p * (1 - p)).sum())
    return float((np.asarray(y, float) - p).sum() / math.sqrt(v)) if v > 0 else np.nan


def poisson_z(obs, exp) -> float:
    o, e = float(np.sum(obs)), float(np.sum(exp))
    return (o - e) / math.sqrt(e) if e > 0 else np.nan


def two_prop_z(k1, n1, k2, n2) -> float:
    if n1 == 0 or n2 == 0:
        return np.nan
    p = (k1 + k2) / (n1 + n2)
    se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    return ((k1 / n1) - (k2 / n2)) / se if se > 0 else np.nan


def binom_two_sided(k: int, n: int, p: float) -> float:
    """Test binomial exact bilatéral (somme des issues pas plus probables)."""
    ks = np.arange(n + 1)
    lp = (np.array([math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) for i in ks])
          + ks * math.log(p) + (n - ks) * math.log1p(-p))
    return float(min(1.0, np.exp(lp[lp <= lp[k] + 1e-9]).sum()))


def logit(p):
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return np.log(p / (1 - p))


def sigmoid(z):
    return 1 / (1 + np.exp(-z))


def logistic_fit(X: np.ndarray, y: np.ndarray, iters: int = 50) -> np.ndarray:
    """Régression logistique (constante + X) par Newton. Renvoie [b0, b…]."""
    A = np.column_stack([np.ones(len(X)), X])
    b = np.zeros(A.shape[1])
    for _ in range(iters):
        p = sigmoid(A @ b)
        W = p * (1 - p)
        H = A.T @ (A * W[:, None]) + 1e-9 * np.eye(A.shape[1])
        step = np.linalg.solve(H, A.T @ (y - p))
        b += step
        if np.max(np.abs(step)) < 1e-10:
            break
    return b


def log_loss(y, p) -> np.ndarray:
    p = np.clip(np.asarray(p, float), EPS, 1 - EPS)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def paired(d: np.ndarray) -> dict:
    se = float(d.std(ddof=1) / math.sqrt(len(d)))
    return {"n": int(len(d)), "delta": round(float(d.mean()), 6), "se": round(se, 6),
            "z": round(float(d.mean()) / se, 2) if se > 0 else None}


def corr(a, b) -> float | None:
    a, b = np.asarray(a, float), np.asarray(b, float)
    m = np.isfinite(a) & np.isfinite(b)
    return round(float(np.corrcoef(a[m], b[m])[0, 1]), 3) if m.sum() > 2 else None


# ── Données de match + base de comparaison ───────────────────────────────────

def load_games(base: str) -> tuple[pd.DataFrame, dict]:
    g = pd.read_csv(f"{DATA_DIR}/nhl_games_v4.csv", low_memory=False)
    info = {}
    if base == "served":
        b = pd.read_csv(SERVED)
        info = {"base": "chaîne servie walk-forward (served_pregame.csv)"}
        b = b.dropna(subset=["p_home_corr"])           # saisons avec correction seulement
        b = b.rename(columns={"p_home_win": "p_base"})
        cols = ["game_id", "p_base", "lam_home", "lam_away"]
    else:
        b = pd.read_csv(RAW).rename(columns={"p_home_win": "p_base"})
        info = {"base": "modèle de score brut walk-forward (live_pregame.csv) + recalage simple"}
        cols = ["game_id", "p_base", "lam_home", "lam_away"]
    df = g.merge(b[cols], on="game_id", how="inner").copy()
    df["date"] = pd.to_datetime(df["date"])
    df["dow"] = df["date"].dt.dayofweek
    df["month"] = df["date"].dt.month
    df["reg_total"] = df["home_reg_score"] + df["away_reg_score"]
    df = df.sort_values("date").reset_index(drop=True)
    # Total attendu : λ de la base, ramenés au niveau de chaque saison. Le
    # recalage de niveau servi le fait déjà en cours de saison ; ici on veut
    # seulement que la dérive de niveau ne passe pas pour un « pattern ».
    lam = df["lam_home"] + df["lam_away"]
    k = (df.groupby("season")["reg_total"].transform("sum")
         / lam.groupby(df["season"]).transform("sum"))
    df["exp_total"] = lam * k
    return df, info


def simple_recal(df: pd.DataFrame, disc: np.ndarray) -> tuple[np.ndarray, list]:
    X = np.column_stack([logit(df["p_base"]), df["elo_diff"].values / 100,
                         df["b2b_diff"].fillna(0).values])
    b = logistic_fit(X[disc], df["home_win"].values[disc].astype(float))
    return sigmoid(b[0] + X @ b[1:]), [round(float(x), 4) for x in b]


# ── 1. Conditions de match ───────────────────────────────────────────────────

SIDE_COLS = ["rest_days", "b2b", "3in4", "distance_km", "tz_shift", "days_away",
             "road_trip_len", "road_game_num", "getaway", "alt_gain", "goalie_backup",
             "stars_missing", "win_s", "finishing_s", "elo"]


def team_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Deux lignes par match, du point de vue de chaque équipe."""
    parts = []
    for me, op, home in (("home", "away", 1), ("away", "home", 0)):
        d = {"game_idx": np.arange(len(df)), "is_home": home,
             "team": df[f"{me}_team"].values, "opp": df[f"{op}_team"].values}
        for c in SIDE_COLS:
            d[c] = df[f"{me}_{c}"].values
            d["opp_" + c] = df[f"{op}_{c}"].values
        d["y"] = df["home_win"].values if home else 1 - df["home_win"].values
        d["p"] = df["p_base"].values if home else 1 - df["p_base"].values
        pm = df["market_home_p_close"].values
        d["pm"] = pm if home else 1 - pm
        for c in ("season", "dow", "month", "reg_total", "exp_total"):
            d[c] = df[c].values
        parts.append(pd.DataFrame(d))
    return pd.concat(parts, ignore_index=True)


def factors(T: pd.DataFrame) -> dict[str, np.ndarray]:
    """Facteurs discrétisés. Seuils fixés avant de regarder les résultats."""
    def cut(x, bins, labels):
        return pd.cut(x, bins=bins, labels=labels).astype(object)

    def q5(x):
        return pd.qcut(x.rank(method="first"), 5, labels=["q1", "q2", "q3", "q4", "q5"]).astype(object)

    F = {
        "domicile": T["is_home"].map({1: "oui", 0: "non"}),
        "repos": cut(T["rest_days"], [0, 1, 2, 3, 99], ["1j", "2j", "3j", "4j+"]),
        "repos_adv": cut(T["opp_rest_days"], [0, 1, 2, 3, 99], ["1j", "2j", "3j", "4j+"]),
        "ecart_repos": np.sign(T["rest_days"] - T["opp_rest_days"]).map({-1: "moins", 0: "egal", 1: "plus"}),
        "b2b": T["b2b"].map({1: "oui", 0: "non"}),
        "b2b_adv": T["opp_b2b"].map({1: "oui", 0: "non"}),
        "3en4": (T["3in4"] >= 2).map({True: "oui", False: "non"}),
        "distance": cut(T["distance_km"], [-1, 0, 500, 1500, 1e9], ["0", "<500", "500-1500", ">1500"]),
        "fuseaux": cut(T["tz_shift"], [-99, -2, -1, 0, 1, 99], ["<=-2", "-1", "0", "+1", ">=+2"]),
        "match_du_trip": cut(T["road_game_num"], [0, 1, 2, 3, 99], ["1er", "2e", "3e", "4e+"]),
        "jours_loin": cut(T["days_away"], [-1, 0, 3, 7, 999], ["0", "1-3", "4-7", "8+"]),
        "altitude": (T["alt_gain"] > 300).map({True: "gain>300m", False: "non"}),
        "getaway": T["getaway"].map({1: "oui", 0: "non"}),
        "gardien_releve": T["goalie_backup"].map({1: "oui", 0: "non"}),
        "gardien_releve_adv": T["opp_goalie_backup"].map({1: "oui", 0: "non"}),
        "etoiles_abs": cut(T["stars_missing"], [-1, 0, 1, 99], ["0", "1", "2+"]),
        "etoiles_abs_adv": cut(T["opp_stars_missing"], [-1, 0, 1, 99], ["0", "1", "2+"]),
        "jour": T["dow"].map(dict(enumerate(DOW))),
        "mois": T["month"].astype(str),
        "ecart_elo": q5(T["elo"] - T["opp_elo"]),
        "forme": q5(T["win_s"]),
        "chance_finition": q5(T["finishing_s"]),
    }
    return {k: np.array(["nan" if (v is None or (isinstance(v, float) and np.isnan(v))) else str(v)
                         for v in pd.Series(s).tolist()]) for k, s in F.items()}


def run_games(df: pd.DataFrame, disc_seasons: list, val_seasons: list) -> tuple[dict, pd.DataFrame]:
    T = team_rows(df)
    F = factors(T)
    disc = T["season"].isin(disc_seasons).values
    val = T["season"].isin(val_seasons).values
    is_home = (T["is_home"] == 1).values
    gidx = T["game_idx"].values
    y, p = T["y"].values.astype(float), T["p"].values
    pm = T["pm"].values
    has_m = np.isfinite(pm)
    tot, etot = T["reg_total"].values.astype(float), T["exp_total"].values
    n_games = len(df)

    def dedupe(mask):
        both = np.bincount(gidx[mask], minlength=n_games) == 2
        return mask & ~(mask & both[gidx] & ~is_home)

    def evaluate(name, family, mask):
        m = dedupe(mask)
        out = {"condition": name, "family": family}
        for per, pmask in (("d", disc), ("v", val)):
            mm = m & pmask
            n = int(mm.sum())
            out[f"n_{per}"] = n
            if n == 0:
                continue
            comp = pmask & ~m
            out[f"taux_{per}"] = float(y[mm].mean())
            out[f"base_{per}"] = float(p[mm].mean())
            out[f"z_brut_{per}"] = two_prop_z(y[mm].sum(), n, y[comp].sum(), comp.sum())
            out[f"z_res_{per}"] = resid_z(y[mm], p[mm])
            out[f"buts_{per}"] = float(tot[mm].mean())
            out[f"buts_att_{per}"] = float(etot[mm].mean())
            out[f"z_buts_{per}"] = poisson_z(tot[mm], etot[mm])
            mk = mm & has_m
            out[f"n_cotes_{per}"] = int(mk.sum())
            if mk.any():
                out[f"marche_{per}"] = float(pm[mk].mean())
                out[f"z_marche_{per}"] = resid_z(y[mk], pm[mk])
        return out

    rows, single = [], {}
    for f, vals in F.items():
        for v in np.unique(vals):
            if v == "nan":
                continue
            single[(f, v)] = vals == v
            rows.append(evaluate(f"{f}={v}", "1_facteur", single[(f, v)]))
    for a, b in itertools.combinations(list(single), 2):
        if a[0] == b[0]:
            continue
        mask = single[a] & single[b]
        if (mask & disc).sum() >= MIN_N_PAIR:
            rows.append(evaluate(f"{a[0]}={a[1]} & {b[0]}={b[1]}", "2_paire", mask))
    team, opp = T["team"].values, T["opp"].values
    teams = sorted(set(team[val]))
    for t in teams:
        tm = team == t
        for (f, v), mask in single.items():
            if f == "domicile":
                continue
            mm = tm & mask
            if (mm & disc).sum() >= MIN_N_TEAM_FACTOR:
                rows.append(evaluate(f"{t} & {f}={v}", "3_equipe_x_facteur", mm))
        for o in teams:
            mm = tm & (opp == o)
            if o != t and (mm & disc).sum() >= MIN_N_TEAM_OPP:
                rows.append(evaluate(f"{t} vs {o}", "4_equipe_x_adversaire", mm))

    R = pd.DataFrame(rows)
    R = R[R["n_d"] > 0].reset_index(drop=True)
    for kind in ("brut", "res", "buts"):
        R[f"p_{kind}_d"] = p_two_sided(R[f"z_{kind}_d"])
        R[f"bh_{kind}"] = False
        R[f"rep_{kind}"] = ((np.sign(R[f"z_{kind}_d"]) == np.sign(R[f"z_{kind}_v"]))
                            & (R[f"z_{kind}_v"].abs() >= Z_REPLICATE))
    for fam, idx in R.groupby("family").groups.items():
        for kind in ("brut", "res", "buts"):
            R.loc[idx, f"bh_{kind}"] = bh(R.loc[idx, f"p_{kind}_d"].values)

    def verdict(r):
        if r["bh_res"] and r["rep_res"]:
            return "CANDIDAT"
        if r["bh_brut"] and r["rep_brut"]:
            return "DÉJÀ DANS LE MODÈLE"
        if r["bh_brut"]:
            return "DESCRIPTIF"
        return "BRUIT"
    R["verdict"] = R.apply(verdict, axis=1)

    summary = {}
    for fam, g in R.groupby("family"):
        s = {"conditions": int(len(g))}
        for kind, label in (("brut", "contre le reste de la ligue"),
                            ("res", "contre la prédiction d'avant-match"),
                            ("buts", "total réglementaire contre l'attendu")):
            nominal = g[g[f"p_{kind}_d"] < 0.05]
            sig = g[g[f"bh_{kind}"]]
            s[kind] = {"question": label,
                       "p<0.05_sans_correction": int(len(nominal)),
                       "attendu_par_hasard": round(0.05 * len(g), 1),
                       "significatives_BH": int(len(sig)),
                       "dont_repliquees": int(sig[f"rep_{kind}"].sum()),
                       "persistance_corr_z": corr(g[f"z_{kind}_d"], g[f"z_{kind}_v"])}
        s["verdicts"] = g["verdict"].value_counts().to_dict()
        summary[fam] = s
    keep = ["condition", "n_d", "taux_d", "base_d", "z_res_d", "n_v", "taux_v", "base_v",
            "z_res_v", "n_cotes_v", "marche_v", "z_marche_v"]
    cand = R[R["verdict"] == "CANDIDAT"].sort_values("z_res_d", key=np.abs, ascending=False)
    out = {"familles": summary,
           "candidats": cand[keep].round(4).head(40).to_dict(orient="records")}
    return out, R


# ── 2. Combinaisons : peut-on apprendre le résidu ? ──────────────────────────

def run_combos(df: pd.DataFrame, disc_seasons: list, val_seasons: list) -> dict:
    import xgboost as xgb
    y = df["home_win"].values.astype(float)
    d_sorted = sorted(disc_seasons)
    es_seasons = d_sorted[-2:]                      # arrêt précoce : 2 dernières saisons de découverte
    tr = df["season"].isin(d_sorted[:-2]).values
    es = df["season"].isin(es_seasons).values
    te = df["season"].isin(val_seasons).values
    base = df["p_base"].values
    cols = []
    for s in ("home", "away"):
        cols += [f"{s}_{c}" for c in ["rest_days", "b2b", "3in4", "distance_km", "tz_shift",
                                      "days_away", "road_trip_len", "road_game_num", "alt_gain",
                                      "goalie_backup", "stars_missing", "win_s", "finishing_s",
                                      "goalie_starts"]]
    X = df[cols].copy()
    for c in ("dow", "month", "elo_diff", "venue_altitude_m"):
        X[c] = df[c]
    teams = sorted(set(df["home_team"]) | set(df["away_team"]))
    Xt = X.copy()
    for t in teams:
        Xt[f"h_{t}"] = (df["home_team"] == t).astype(int)
        Xt[f"a_{t}"] = (df["away_team"] == t).astype(int)

    def boost(M):
        params = dict(objective="binary:logistic", eval_metric="logloss", eta=0.02, max_depth=3,
                      min_child_weight=50, subsample=0.8, colsample_bytree=0.7, reg_lambda=20,
                      seed=0, nthread=2)
        m = logit(base)
        bst = xgb.train(params, xgb.DMatrix(M[tr], label=y[tr], base_margin=m[tr]), 2000,
                        evals=[(xgb.DMatrix(M[es], label=y[es], base_margin=m[es]), "es")],
                        early_stopping_rounds=100, verbose_eval=False)
        p = bst.predict(xgb.DMatrix(M, base_margin=m), iteration_range=(0, bst.best_iteration + 1))
        return p, int(bst.best_iteration + 1)

    pm = df["market_home_p_close"].values
    mk = te & np.isfinite(pm)
    out = {"protocole": f"entraînement {d_sorted[0]}-{d_sorted[-3]}, arrêt précoce {es_seasons}, "
                        f"validation {val_seasons[0]}-{val_seasons[-1]}",
           "n_validation": int(te.sum()), "n_validation_cotes": int(mk.sum()),
           "base": {"log_loss": round(float(log_loss(y[te], base[te]).mean()), 5)},
           "marche_cloture_log_loss": round(float(log_loss(y[mk], pm[mk]).mean()), 5),
           "base_vs_marche": paired(log_loss(y[mk], base[mk]) - log_loss(y[mk], pm[mk]))}
    for name, M in (("combinaisons", X.values), ("combinaisons+identite_equipes", Xt.values)):
        p, it = boost(M)
        out[name] = {"arbres_retenus": it,
                     "log_loss": round(float(log_loss(y[te], p[te]).mean()), 5),
                     "vs_base": paired(log_loss(y[te], p[te]) - log_loss(y[te], base[te]))}
    out["lecture"] = ("Si l'arrêt précoce garde 1 arbre et que vs_base est nul, les combinaisons "
                      "de ces facteurs n'apportent rien que la base ne sache déjà.")
    return out


# ── 3. Joueurs : jour, adversaire, aréna, mois ───────────────────────────────

def load_skaters() -> pd.DataFrame:
    s = pd.read_csv(f"{DATA_DIR}/mp_skater_games.csv")
    spine = pd.read_csv(f"{DATA_DIR}/games_spine.csv")
    s = s.merge(spine[["game_id", "home_team", "away_team"]], left_on="gameId",
                right_on="game_id", how="inner")
    s["date"] = pd.to_datetime(s["gameDate"].astype(str))
    s["season"] = s["gameId"] // 1000000
    s = s[s["season"] >= 2010].sort_values(["playerId", "date"]).reset_index(drop=True)
    s["team"] = s["playerTeam"].replace(TEAM_FIX)
    s["is_home"] = s["team"] == s["home_team"]
    s["opp"] = np.where(s["is_home"], s["away_team"], s["home_team"])
    s["arena"] = s["home_team"]
    s["dow"] = s["date"].dt.dayofweek
    s["month"] = s["date"].dt.month
    # Attendu pré-match : EWMA décalée (demi-vie 30, >= 10 matchs) de 0.5·buts + 0.5·xG
    mix = 0.5 * s["I_F_goals"] + 0.5 * s["I_F_xGoals"]
    s["rate"] = mix.groupby(s["playerId"]).transform(
        lambda x: x.shift(1).ewm(halflife=30, min_periods=10).mean())
    s = s[s["rate"].notna()].copy()
    s["exp"] = s["rate"] * (s.groupby("season")["I_F_goals"].transform("sum")
                            / s.groupby("season")["rate"].transform("sum"))
    return s


def run_players(split_season: int, focus: list[int]) -> dict:
    s = load_skaters()
    s["period"] = np.where(s["season"] <= split_season, "A", "B")
    out = {"protocole": f"A = saisons ≤ {split_season}, B = après ; attendu = EWMA décalée "
                        "du joueur (buts + xG) ; cellules avec ≥ 3 buts attendus par période",
           "joueurs_matchs": int(len(s))}
    own_home = s["arena"] == s["team"]
    for key, label, sub in (("dow", "jour", None), ("opp", "adversaire", None),
                            ("arena", "arena_hors_domicile", ~own_home), ("month", "mois", None)):
        d = s if sub is None else s[sub]
        t = (d.groupby(["playerId", key, "period"])
             .agg(obs=("I_F_goals", "sum"), exp=("exp", "sum")).reset_index())
        t["z"] = (t["obs"] - t["exp"]) / np.sqrt(t["exp"])
        w = t.pivot_table(index=["playerId", key], columns="period", values=["obs", "exp", "z"]).dropna()
        w.columns = [f"{a}_{b}" for a, b in w.columns]
        w = w[(w["exp_A"] >= 3) & (w["exp_B"] >= 3)]
        tA = t[(t["period"] == "A") & (t["exp"] >= 3)]
        pA = p_two_sided(tA["z"])
        top = w.sort_values("z_A", ascending=False).head(50)
        out[label] = {"cellules_A": int(len(tA)), "p<0.05_A": int((pA < 0.05).sum()),
                      "attendu_par_hasard": round(0.05 * len(tA), 1),
                      "significatives_BH_A": int(bh(pA).sum()),
                      "cellules_2_periodes": int(len(w)),
                      "persistance_corr_z": corr(w["z_A"], w["z_B"]),
                      "top50_A_buts_sur_attendu": {"A": round(float(top["obs_A"].sum() / top["exp_A"].sum()), 3),
                                                   "B": round(float(top["obs_B"].sum() / top["exp_B"].sum()), 3)}}

    # Contrôle positif : la finition (buts − xG) d'un joueur DOIT persister
    f = s.groupby(["playerId", "period"]).agg(G=("I_F_goals", "sum"), X=("I_F_xGoals", "sum")).reset_index()
    f = f.pivot(index="playerId", columns="period", values=["G", "X"]).dropna()
    f.columns = [f"{a}_{b}" for a, b in f.columns]
    f = f[(f["X_A"] >= 15) & (f["X_B"] >= 15)]
    out["controle_positif_finition"] = {
        "joueurs": int(len(f)),
        "persistance_corr_z": corr((f["G_A"] - f["X_A"]) / np.sqrt(f["X_A"]),
                                   (f["G_B"] - f["X_B"]) / np.sqrt(f["X_B"]))}

    # Effet « jour » PROPRE au joueur : variance des vrais effets estimée par la
    # covariance entre périodes → rétrécissement empirique de Bayes.
    t = s.groupby(["playerId", "dow", "period"]).agg(G=("I_F_goals", "sum"), E=("exp", "sum")).reset_index()
    tt = s.groupby(["playerId", "period"]).agg(GT=("I_F_goals", "sum"), ET=("exp", "sum")).reset_index()
    t = t.merge(tt, on=["playerId", "period"])
    t["lift"] = (t["G"] / t["E"]) / ((t["GT"] - t["G"]) / (t["ET"] - t["E"])) - 1
    w = t.pivot_table(index=["playerId", "dow"], columns="period", values=["lift", "E"]).dropna()
    w.columns = [f"{a}_{b}" for a, b in w.columns]
    w = w[(w["E_A"] >= 5) & (w["E_B"] >= 5)]
    a, b = w["lift_A"].values, w["lift_B"].values
    rng = np.random.default_rng(1)
    boots = [np.cov(a[i], b[i])[0, 1] for i in (rng.integers(0, len(a), len(a)) for _ in range(1000))]
    tau2, tau2_hi = max(float(np.cov(a, b)[0, 1]), 0.0), max(float(np.percentile(boots, 97.5)), 0.0)
    out["effet_jour_propre_au_joueur"] = {"cellules": int(len(w)),
                                          "variance_vraie_estimee": round(tau2, 5),
                                          "borne_haute_IC95": round(tau2_hi, 5)}

    # Joueurs suivis (ex. Cole Caufield 8481540) : chaque jour contre ses autres jours
    out["joueurs_suivis"] = {}
    for pid in focus:
        c = s[s["playerId"] == pid]
        if c.empty:
            continue
        rows = []
        for dd in range(7):
            m = c["dow"] == dd
            g_d, n_d = int(c.loc[m, "I_F_goals"].sum()), int(m.sum())
            g_t = int(c["I_F_goals"].sum())
            if n_d < 10:
                continue
            e_d = float(c.loc[m, "exp"].sum())
            lift = (g_d / e_d) / ((g_t - g_d) / (c["exp"].sum() - e_d)) - 1
            noise = 1 / max(e_d, 1e-9) + 1 / max(float(c["exp"].sum()) - e_d, 1e-9)
            rows.append({"jour": DOW[dd], "matchs": n_d, "buts": g_d,
                         "buts_par_match": round(g_d / n_d, 3),
                         "autres_jours_buts_par_match": round((g_t - g_d) / (len(c) - n_d), 3),
                         "p_vs_autres_jours": round(binom_two_sided(g_d, g_t, n_d / len(c)), 4),
                         "lift_observe": round(lift, 3),
                         "lift_predictif_estime": round(lift * tau2 / (tau2 + noise), 3),
                         "lift_predictif_max": round(lift * tau2_hi / (tau2_hi + noise), 3)})
        per_season = (c.assign(jour=c["dow"].map(dict(enumerate(DOW))))
                      .groupby(["season", "jour"]).agg(matchs=("I_F_goals", "size"),
                                                       buts=("I_F_goals", "sum"),
                                                       attendus=("exp", "sum")).round(1).reset_index())
        out["joueurs_suivis"][str(pid)] = {"nom": str(c["name"].iloc[-1]), "par_jour": rows,
                                           "par_saison": per_season.to_dict(orient="records")}
    return out


# ── 4. Tireur x gardien ──────────────────────────────────────────────────────

def run_shooter_goalie(first: int, split_season: int, last: int) -> dict:
    cols = ["season", "shooterPlayerId", "goalieIdForShot", "goal", "xGoal",
            "shotOnEmptyNet", "isPlayoffGame"]
    frames = []
    for yr in range(first, last + 1):
        path = f"{DATA_DIR}/raw/shots/shots_{yr}.zip"
        if not os.path.exists(path):
            continue
        z = zipfile.ZipFile(path)
        frames.append(pd.read_csv(z.open(z.namelist()[0]), usecols=cols))
    sh = pd.concat(frames, ignore_index=True)
    sh = sh[(sh["isPlayoffGame"] == 0) & (sh["shotOnEmptyNet"] == 0) & (sh["goalieIdForShot"] > 0)]
    sh["period"] = np.where(sh["season"] <= split_season, "A", "B")
    parts = []
    for _, d in sh.groupby("period"):     # attendu = xG x finition du tireur x gardien (même période)
        f_s = d.groupby("shooterPlayerId").agg(G=("goal", "sum"), X=("xGoal", "sum"))
        f_g = d.groupby("goalieIdForShot").agg(G=("goal", "sum"), X=("xGoal", "sum"))
        e = (d["xGoal"] * d["shooterPlayerId"].map((f_s["G"] + 30) / (f_s["X"] + 30))
             * d["goalieIdForShot"].map((f_g["G"] + 60) / (f_g["X"] + 60)))
        parts.append(d.assign(e=e * d["goal"].sum() / e.sum()))
    sh = pd.concat(parts)
    pr = sh.groupby(["shooterPlayerId", "goalieIdForShot", "period"]).agg(
        G=("goal", "sum"), E=("e", "sum")).reset_index()
    pr["z"] = (pr["G"] - pr["E"]) / np.sqrt(pr["E"])
    w = pr.pivot_table(index=["shooterPlayerId", "goalieIdForShot"], columns="period",
                       values=["G", "E", "z"]).dropna()
    w.columns = [f"{a}_{b}" for a, b in w.columns]
    out = {"protocole": f"tirs non bloqués hors filet désert, saison régulière, {first}-{last} ; "
                        f"A ≤ {split_season} < B", "tirs": int(len(sh))}
    for thr in (1.0, 2.0):
        ww = w[(w["E_A"] >= thr) & (w["E_B"] >= thr)]
        top = ww.sort_values("z_A", ascending=False).head(50)
        out[f"paires_buts_attendus>={thr:g}"] = {
            "paires": int(len(ww)), "persistance_corr_z": corr(ww["z_A"], ww["z_B"]),
            "top50_A_buts_sur_attendu": {"A": round(float(top["G_A"].sum() / top["E_A"].sum()), 3),
                                         "B": round(float(top["G_B"].sum() / top["E_B"].sum()), 3)}}
    for who, key, k in (("tireur", "shooterPlayerId", 50), ("gardien", "goalieIdForShot", 100)):
        m = sh.groupby([key, "period"]).agg(G=("goal", "sum"), X=("xGoal", "sum")).reset_index()
        m = m.pivot(index=key, columns="period", values=["G", "X"]).dropna()
        m.columns = [f"{a}_{b}" for a, b in m.columns]
        m = m[(m["X_A"] >= k) & (m["X_B"] >= k)]
        out[f"controle_positif_{who}"] = {
            "n": int(len(m)), "persistance_corr_z": corr((m["G_A"] - m["X_A"]) / np.sqrt(m["X_A"]),
                                                         (m["G_B"] - m["X_B"]) / np.sqrt(m["X_B"]))}
    return out


# ── 5. Candidats du registre : suivi en avant ────────────────────────────────

def lone_b2b_vs_market() -> pd.DataFrame:
    """Équipe SEULE en back-to-back : une ligne par match, de son point de vue.
    Ne dépend d'aucun modèle : calendrier + cote de clôture seulement, donc
    suivable dès le premier match de la saison en cours."""
    g = pd.read_csv(f"{DATA_DIR}/nhl_games_v4.csv", low_memory=False,
                    usecols=["season", "date", "home_win", "home_b2b", "away_b2b",
                             "home_ml_close", "away_ml_close", "market_home_p_close"])
    g["date"] = pd.to_datetime(g["date"])
    g = g[g["home_ml_close"].notna() & g["market_home_p_close"].notna() & g["home_win"].notna()]
    a = g[(g["home_b2b"] == 1) & (g["away_b2b"] == 0)]
    b = g[(g["away_b2b"] == 1) & (g["home_b2b"] == 0)]
    return pd.concat([
        pd.DataFrame({"season": a["season"], "date": a["date"], "y": a["home_win"],
                      "p_mkt": a["market_home_p_close"], "dec_against": a["away_ml_close"]}),
        pd.DataFrame({"season": b["season"], "date": b["date"], "y": 1 - b["home_win"],
                      "p_mkt": 1 - b["market_home_p_close"], "dec_against": b["home_ml_close"]})],
                     ignore_index=True)


def run_candidates() -> dict:
    try:
        with open(REGISTRY, encoding="utf-8") as fh:
            reg = json.load(fh)
    except FileNotFoundError:
        return {"note": f"{REGISTRY} absent"}
    out = {}
    for c in reg.get("candidates", []):
        if c["id"] != "lone_b2b_vs_market":
            out[c["id"]] = {"note": "pas de suivi automatique pour ce candidat"}
            continue
        d = lone_b2b_vs_market()
        res = {}
        for label, m in (("avant_inscription", d["date"] < pd.Timestamp(c["registered"])),
                         ("depuis_inscription", d["date"] >= pd.Timestamp(c["registered"]))):
            x = d[m]
            if x.empty:
                res[label] = {"n": 0}
                continue
            pnl = np.where(x["y"] == 0, x["dec_against"] - 1, -1.0)
            se = float(pnl.std(ddof=1) / math.sqrt(len(pnl))) if len(pnl) > 1 else np.nan
            res[label] = {"n": int(len(x)), "victoires": round(float(x["y"].mean()), 4),
                          "marche": round(float(x["p_mkt"].mean()), 4),
                          "z_vs_marche": round(resid_z(x["y"], x["p_mkt"]), 2),
                          "roi_contre_pct": round(float(pnl.mean()) * 100, 2),
                          "roi_se_pct": round(se * 100, 2) if np.isfinite(se) else None}
        fwd = res["depuis_inscription"]
        rule = c["rule"]
        if fwd.get("n", 0) < rule["min_n"]:
            v = f"EN COURS ({fwd.get('n', 0)}/{rule['min_n']} matchs)"
        elif fwd["z_vs_marche"] <= rule["z_max"]:
            v = "CONFIRMÉ EN AVANT — à proposer au protocole --correction"
        else:
            v = "REJETÉ EN AVANT"
        out[c["id"]] = {**res, "verdict": v}
    return out


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", action="store_true")
    ap.add_argument("--combos", action="store_true")
    ap.add_argument("--players", action="store_true")
    ap.add_argument("--shooter-goalie", action="store_true")
    ap.add_argument("--candidates", action="store_true")
    ap.add_argument("--base", choices=["auto", "served", "raw"], default="auto")
    ap.add_argument("--discovery-end", type=int, default=2019,
                    help="dernière saison de découverte (validation = saisons suivantes)")
    ap.add_argument("--focus-player", type=int, action="append", default=None,
                    help="playerId à détailler (défaut : Cole Caufield 8481540)")
    a = ap.parse_args()
    modes = [m for m in ("games", "combos", "players", "shooter_goalie", "candidates") if getattr(a, m)]
    modes = modes or ["games", "combos", "players", "shooter_goalie", "candidates"]

    base = a.base if a.base != "auto" else ("served" if os.path.exists(SERVED) else "raw")
    report = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
              "rules": {"fdr_q": FDR_Q, "z_replicate": Z_REPLICATE,
                        "min_n": {"paire": MIN_N_PAIR, "equipe_x_facteur": MIN_N_TEAM_FACTOR,
                                  "equipe_x_adversaire": MIN_N_TEAM_OPP}}}
    try:
        with open(REPORT, encoding="utf-8") as fh:
            old = json.load(fh)
        report = {**{k: v for k, v in old.items() if k not in report}, **report}
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    if {"games", "combos"} & set(modes):
        df, info = load_games(base)
        seasons = sorted(df["season"].unique())
        last_full = max(s for s in seasons if (df["season"] == s).sum() >= 500)
        disc_s = [s for s in seasons if s <= a.discovery_end]
        val_s = [s for s in seasons if a.discovery_end < s <= last_full]
        if base == "raw":
            p_cal, coefs = simple_recal(df, df["season"].isin(disc_s).values)
            df["p_base"] = p_cal
            info["recalage_simple"] = {"ordre": ["const", "logit_p", "elo_diff/100", "b2b_diff"],
                                       "coef": coefs}
        info.update({"decouverte": [int(disc_s[0]), int(disc_s[-1])],
                     "validation": [int(val_s[0]), int(val_s[-1])],
                     "matchs_decouverte": int(df["season"].isin(disc_s).sum()),
                     "matchs_validation": int(df["season"].isin(val_s).sum())})
        report["base"] = info
        print(f"📂 base : {info['base']} — découverte {disc_s[0]}-{disc_s[-1]} "
              f"({info['matchs_decouverte']} matchs), validation {val_s[0]}-{val_s[-1]} "
              f"({info['matchs_validation']})")
        if "games" in modes:
            report["games"], R = run_games(df, disc_s, val_s)
            R.to_csv(CONDITIONS_CSV, index=False)
            for fam, s in report["games"]["familles"].items():
                print(f"   {fam:<24} {s['conditions']:>5} conditions — vs prédiction : "
                      f"{s['res']['p<0.05_sans_correction']} à p<0.05 (hasard ≈ {s['res']['attendu_par_hasard']}), "
                      f"{s['res']['significatives_BH']} BH, {s['res']['dont_repliquees']} répliquées, "
                      f"persistance {s['res']['persistance_corr_z']}")
        if "combos" in modes:
            report["combos"] = run_combos(df, disc_s, val_s)
            c = report["combos"]
            print(f"   combinaisons : {c['combinaisons']['arbres_retenus']} arbre(s), "
                  f"Δ log-loss {c['combinaisons']['vs_base']['delta']:+.5f} "
                  f"(z {c['combinaisons']['vs_base']['z']})")
    if "candidates" in modes:
        report["candidates"] = run_candidates()
        for k, v in report["candidates"].items():
            print(f"   candidat {k} : {v.get('verdict', v.get('note'))}")
    if "players" in modes:
        report["players"] = run_players(a.discovery_end, a.focus_player or [8481540])
        print("   joueurs : persistance jour "
              f"{report['players']['jour']['persistance_corr_z']}, adversaire "
              f"{report['players']['adversaire']['persistance_corr_z']}, contrôle positif "
              f"{report['players']['controle_positif_finition']['persistance_corr_z']}")
    if "shooter_goalie" in modes:
        report["shooter_goalie"] = run_shooter_goalie(2015, a.discovery_end, 2025)
        print("   tireur x gardien : " + ", ".join(
            f"{k} {v['persistance_corr_z']}" for k, v in report["shooter_goalie"].items()
            if isinstance(v, dict) and "persistance_corr_z" in v))

    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1, default=float)
    print(f"✅ {os.path.relpath(REPORT)}")


if __name__ == "__main__":
    main()
