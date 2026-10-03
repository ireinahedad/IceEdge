"""
backtest_walkforward.py
=======================
Backtest ROI HONNÊTE, saison par saison, sur la période couverte par les cotes.

Le backtest.py standard échoue quand les cotes (gratuites → fin 2022-23) tombent
dans la période d'entraînement. Ici on fait du walk-forward :

  Pour chaque saison S ayant des cotes (et au moins 1 saison d'historique) :
    • entraîne un modèle sur TOUS les matchs des saisons < S
    • calibre (Platt) sur les 15 % finaux du train
    • prédit la saison S (jamais vue), blend avec le marché
    • parie en value betting → accumule le ROI

Aucun match n'est jamais prédit après avoir été vu à l'entraînement → ROI réaliste.

Mode incertitude (P4)
---------------------
`--uncertainty` remplace le classifieur moneyline par le **modèle de score**
walk-forward, doublé d'un ensemble bootstrap par fold. On compare alors deux
dimensionnements sur la même séquence de paris — Kelly ¼ nu contre Kelly ¼
réduit par σ — sur le drawdown maximal, qui est la métrique que P4 vise.

Avertissement à ne pas perdre de vue : P1 a établi qu'il n'y a **pas d'edge
moneyline**. Ce mode est donc un *stress test* du dimensionnement, pas une
stratégie à jouer. Il répond à « la réduction par σ protège-t-elle le bankroll ? »
et non à « ces paris sont-ils rentables ? ». On l'exécute sur le moneyline parce
que c'est le seul marché dont on possède les prix réels ; odds.csv ne contient
que la LIGNE de total, jamais le prix over/under.

Hyperparamètres par fold (P6)
----------------------------
Les modes `--uncertainty` et `--derived` lisaient les hyperparamètres du modèle
de score dans `score_report.json`. Ceux-ci sont choisis par recherche aléatoire
sur la tranche de validation de `train_score.split()`, soit 68-80 % de
l'historique trié par date — c'est-à-dire des saisons qui sont **de test** dans
le walk-forward. Fuite modeste mais réelle. Par défaut la recherche se fait
désormais **dans chaque fold**, sur une tranche interne à son propre train
(`--search-trials`, 8 par défaut ; 0 restaure l'ancien comportement en le
signalant). Les paramètres retenus sont mis en cache par fold, la clé étant
invalidée par toute reconstruction du dataset ou tout changement de features.

Usage :
    cd ml/python
    python backtest_walkforward.py                 # toutes les saisons avec cotes
    python backtest_walkforward.py --min-season 2015
    python backtest_walkforward.py --edge 0.04     # seuil d'edge unique détaillé
    python backtest_walkforward.py --uncertainty   # P4 : Kelly réduit par σ
    python backtest_walkforward.py --derived       # P6 : totaux + puck line
    python backtest_walkforward.py --derived --search-trials 16
    python backtest_walkforward.py --select-score-features   # A5 : élagage

Élagage du modèle de score (A5)
-------------------------------
`--select-score-features` applique au **modèle de score** la méthode qui avait
élagué le classifieur (117 → 13) : gain par saison, on garde ce qui est positif
sur ≥ 70 % des saisons. Trois points fixés avant toute lecture du résultat.

*La métrique de sélection est la log-loss de la puck line*, sur ses deux jambes,
τ ajusté par variante. C'est la seule piste vivante du projet (A2) : élaguer le
moteur de prix sur une métrique qui ne la price pas optimiserait pour un usage
qu'on n'a pas. Déviance de Poisson et log-loss moneyline restent affichées, mais
ne sélectionnent rien.

*L'ablation permute la colonne au lieu de la supprimer.* La variante garde ainsi
le même nombre de colonnes que celui sur lequel les hyperparamètres ont été
choisis, et ne perd que l'information. Sans cela, les variantes amputées
partaient handicapées par la dimension et les verdicts « garder » étaient trop
faciles.

*Des sentinelles de bruit pur traversent le même tuyau.* Elles ne contiennent
rien : tout ce qu'elles décrochent est ce que la procédure donne gratuitement.
Une vraie feature doit les battre — c'est un étalonnage mesuré, pas argumenté.

Le mode écrit un rapport et **n'élague rien tout seul** : `ATK_COLS` /
`DEF_COLS` se modifient à la main. Classement par permutation, confirmation par
suppression réelle — cette dernière est `--confirm-score-features`, qui rejoue
le jeu élagué contre les références par saison du rapport de sélection.
"""

import argparse
import hashlib
import json
import os

import numpy as np
import pandas as pd
import xgboost as xgb

import train as T   # réutilise select_features, fit_logistic, _logit, métriques
import train_score as TS
from score_model import (ScoreDistribution, ScoreEnsemble, fit_margin_correction,
                         lambdas_for_home_win, p_ot_for, read_ot_model,
                         stretch_lambdas, uncertainty_haircut)

DATA   = "../data/nhl_games_v4.csv"
MODELS = "../models"
# Les hyperparamètres retenus par fold sont coûteux à retrouver et strictement
# déterministes à données constantes : on les met en cache. La clé embarque la
# dernière date du train et un hash des features, donc reconstruire le dataset
# ou changer le jeu de features invalide l'entrée d'elle-même.
PARAM_CACHE = f"{MODELS}/fold_params_cache.json"


def season_of(date_str: str) -> int:
    y, m = int(str(date_str)[:4]), int(str(date_str)[5:7])
    return y if m >= 8 else y - 1


def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def fit_fold(train_df, feats, params):
    """Entraîne + calibre un modèle sur un fold.

    Retourne (booster, w_platt, w_blend). `w_blend` sont les poids du blend
    modèle ⊕ marché ajustés sur la tranche de calibration — c'est-à-dire
    uniquement sur du passé. Ils remplacent l'ancien blend codé en dur
    (0.55/0.55), qui n'était calibré sur rien et faisait du modèle évalué un
    objet à moitié composé du marché.
    """
    n = len(train_df)
    cut = int(n * 0.85)
    tr, cal = train_df.iloc[:cut], train_df.iloc[cut:]

    def dm(d):
        return xgb.DMatrix(d[feats].values.astype(np.float32),
                           label=d["home_win"].values.astype(np.float32),
                           feature_names=feats, missing=np.nan)

    rounds = params.get("_rounds", 400)
    clean_params = {k: v for k, v in params.items() if not k.startswith("_")}
    booster = xgb.train(clean_params, dm(tr), num_boost_round=rounds,
                        evals=[(dm(cal), "cal")], early_stopping_rounds=40,
                        verbose_eval=False)
    y_cal = cal["home_win"].values.astype(np.float32)
    p_cal = booster.predict(dm(cal))
    w = T.fit_logistic(T._logit(p_cal).reshape(-1, 1), y_cal)

    # Blend ajusté sur le passé : logit(modèle calibré) ⊕ logit(marché)
    w_blend = None
    mkt_cal = cal["market_home_p_close"].values.astype(np.float32)
    mask = np.isfinite(mkt_cal)
    if mask.sum() >= 200:
        p_cal_calib = _sigmoid(w[0] * T._logit(p_cal[mask]) + w[1])
        X = np.column_stack([T._logit(p_cal_calib), T._logit(mkt_cal[mask])])
        w_blend = T.fit_logistic(X, y_cal[mask])
    return booster, w, w_blend


# ── P4 — dimensionnement sous incertitude ────────────────────────────────────

def max_drawdown(curve: np.ndarray) -> float:
    """Perte maximale depuis un sommet, en fraction du sommet."""
    peak, mdd = -np.inf, 0.0
    for v in curve:
        peak = max(peak, v)
        if peak > 0:
            mdd = max(mdd, (peak - v) / peak)
    return float(mdd)


def simulate(bets, stake_fn, fraction: float = 0.25) -> dict:
    """Rejoue les paris dans l'ORDRE CHRONOLOGIQUE avec un bankroll composé.

    Kelly n'a de sens qu'en composé : miser une fraction d'un bankroll fixe
    n'est pas du Kelly et ne produit pas le drawdown qu'on cherche à mesurer.
    Les paris d'une même journée sont traités séquentiellement — approximation
    optimiste, puisqu'en réalité ils sont exposés simultanément.
    """
    bankroll, curve, staked = 1.0, [1.0], 0.0
    for b in bets:
        k = stake_fn(b) * fraction
        k = float(np.clip(k, 0.0, 0.25))       # jamais plus d'1/4 du bankroll
        if k <= 0:
            curve.append(bankroll)
            continue
        stake = k * bankroll
        staked += stake
        bankroll += stake * (b["dec"] - 1) if b["won"] else -stake
        curve.append(bankroll)
        if bankroll <= 1e-6:
            break
    curve = np.array(curve)
    return {"final_bankroll": round(float(curve[-1]), 4),
            "max_drawdown": round(max_drawdown(curve), 4),
            "n_staked": int(sum(1 for b in bets if stake_fn(b) > 0)),
            "total_staked": round(staked, 3)}


def kelly(p: float, dec: float) -> float:
    b = dec - 1.0
    return float(max(0.0, (p * b - (1 - p)) / b)) if b > 0 else 0.0


def _params_cache_key(season, tr_df, feats, trials) -> str:
    """Identifie un fold par ce qui influe réellement sur les paramètres retenus.

    La dernière date du train et le nombre de lignes changent dès que le dataset
    est reconstruit ; le hash des features change dès que le jeu de features
    bouge. Un cache qui rendrait des paramètres périmés serait pire qu'absent.
    """
    h = hashlib.md5(",".join(feats).encode()).hexdigest()[:8]
    return f"{season}|{len(tr_df)}|{tr_df['date'].iloc[-1]}|{trials}|{h}"


def search_params_fold(tr_df, feats, base_params, trials: int, seed: int,
                       season=None, use_cache: bool = True,
                       atk: list[str] | None = None,
                       dfn: list[str] | None = None) -> dict:
    """Recherche d'hyperparamètres STRICTEMENT à l'intérieur d'un fold.

    **Pourquoi ce détour plutôt que lire `score_report.json`.** Ces
    paramètres-là sont choisis par `train_score.random_search` sur la tranche de
    validation de `split()`, soit 68-80 % de l'historique trié par date —
    c'est-à-dire les saisons 2020-2022, qui sont des saisons de **test** du
    walk-forward. La fuite est modeste (six hyperparamètres, pas un modèle
    entier) mais elle est réelle, et elle biaise dans le sens qui arrange.

    **Trois tranches distinctes, toutes antérieures à la saison testée.**
    `fit_score_fold` scinde déjà le fold en `tr` / `cal`. On ne touche pas à
    `cal`, réservé à l'arrêt précoce et au calibrage de σ_max ; la recherche se
    fait sur un second découpage interne à `tr`. Choisir les paramètres, le
    nombre de tours et σ_max sur la même tranche les corrélerait tous les trois.

    Le tirage est seedé par saison : reproductible, et différent d'un fold à
    l'autre — un RNG global rendrait le résultat dépendant de l'ordre d'appel.
    """
    if trials <= 0:
        return dict(base_params)

    cache = {}
    key = _params_cache_key(season, tr_df, feats, trials)
    if use_cache:
        try:
            with open(PARAM_CACHE) as f:
                cache = json.load(f)
        except Exception:
            cache = {}
        if key in cache:
            return {**base_params, **cache[key]}

    cut = int(len(tr_df) * 0.85)
    # Un fold trop court ne supporte pas un troisième découpage : on préfère des
    # paramètres par défaut à une sélection sur 100 matchs.
    if cut < 400 or len(tr_df) - cut < 150:
        return dict(base_params)

    s_in = TS.stack(tr_df.iloc[:cut].reset_index(drop=True), atk, dfn)
    s_va = TS.stack(tr_df.iloc[cut:].reset_index(drop=True), atk, dfn)
    d_in, d_va = TS.dm(s_in, feats), TS.dm(s_va, feats)
    y_va = s_va["y"].values.astype(float)

    rng = np.random.default_rng(42 if season is None else 42 + int(season))
    best, best_score = dict(base_params), np.inf
    for _ in range(trials):
        p = dict(base_params)
        for k, choices in TS.SEARCH_SPACE.items():
            p[k] = choices[int(rng.integers(len(choices)))]
        m = xgb.train(p, d_in, num_boost_round=700, evals=[(d_va, "val")],
                      early_stopping_rounds=40, verbose_eval=False)
        s = TS.poisson_deviance(y_va, m.predict(d_va))
        if s < best_score:
            best, best_score = p, s

    if use_cache:
        cache[key] = {k: best[k] for k in TS.SEARCH_SPACE if k in best}
        try:
            with open(PARAM_CACHE, "w") as f:
                json.dump(cache, f, indent=2)
        except Exception:
            pass
    return best


def fit_score_fold(train_df, feats, params, n_members: int,
                   search_trials: int = 0, season=None, use_cache: bool = True):
    """Modèle de score principal + ensemble bootstrap sur un fold.

    Le modèle principal s'arrête tôt sur les 15 % finaux du train (donc sur du
    passé) ; les membres reprennent ses paramètres et son nombre de tours, sans
    arrêt précoce, pour que σ mesure la variance d'échantillonnage et non celle
    de la procédure d'arrêt.

    `search_trials > 0` sélectionne les hyperparamètres dans le fold plutôt que
    de les lire dans `score_report.json` — voir `search_params_fold` pour la
    fuite que cela corrige.
    """
    cut = int(len(train_df) * 0.85)
    tr, cal = train_df.iloc[:cut], train_df.iloc[cut:]
    params = search_params_fold(tr.reset_index(drop=True), feats, params,
                                search_trials, seed=42, season=season,
                                use_cache=use_cache)
    s_tr, s_cal = TS.stack(tr.reset_index(drop=True)), TS.stack(cal.reset_index(drop=True))
    main = xgb.train(params, TS.dm(s_tr, feats), num_boost_round=700,
                     evals=[(TS.dm(s_cal, feats), "cal")],
                     early_stopping_rounds=40, verbose_eval=False)

    # Les membres n'apprennent QUE sur `tr`, jamais sur `cal` : c'est ce qui
    # rend le σ mesuré sur `cal` hors échantillon, donc représentatif de celui
    # qu'on rencontrera sur la saison testée. Les entraîner sur tout le fold
    # rendrait σ_max biaisé bas et la règle inopérante.
    n_rounds = int(main.best_iteration) + 1
    members = TS.train_ensemble(tr.reset_index(drop=True), feats, params,
                                n_rounds, n_members) if n_members > 0 else []

    # τ et P(dom en OT) ajustés sur le train du fold — jamais sur la saison testée
    s_full = TS.stack(train_df.reset_index(drop=True))
    lam_h, lam_a = TS.lambdas_for(main, feats, s_full, len(train_df))
    exp_pmf = TS.expected_margin_pmf(lam_h, lam_a)
    margins = (train_df["home_reg_score"] - train_df["away_reg_score"]).values
    tau = fit_margin_correction(margins, exp_pmf)
    ot = train_df[train_df["went_to_ot"] == 1]
    p_ot = float((ot["home_score"] > ot["away_score"]).mean()) if len(ot) else 0.5
    return main, members, tau, p_ot


def base_score_params(search_trials: int) -> dict:
    """Paramètres de départ du modèle de score.

    Avec `search_trials > 0` ils ne servent que de repli (fold trop court pour
    un troisième découpage). Avec 0 ils sont utilisés tels quels, et on relit
    alors `score_report.json` — en signalant la fuite que cela réintroduit.
    """
    params = {"max_depth": 4, "learning_rate": 0.03, "subsample": 0.8,
              "colsample_bytree": 0.8, "min_child_weight": 5, "reg_lambda": 3.0}
    if search_trials <= 0:
        try:
            params.update(dict(json.load(
                open(f"{MODELS}/score_report.json")).get("params") or {}))
            print("   ⚠️  --search-trials 0 : hyperparamètres lus dans "
                  "score_report.json,\n       sélectionnés sur un split "
                  "recouvrant des saisons de test. Fuite assumée.")
        except Exception:
            pass
    params.update({"objective": "count:poisson", "eval_metric": "poisson-nloglik",
                   "seed": 42})
    return params


def run_uncertainty(df, test_seasons, n_members: int, edge_threshold: float,
                    n_perm: int = 200, search_trials: int = 0,
                    use_cache: bool = True):
    """Walk-forward du modèle de score + comparaison des dimensionnements."""
    feats = TS.stacked_features()
    params = base_score_params(search_trials)

    need = ["home_reg_score", "away_reg_score", "went_to_ot"]
    if any(c not in df.columns for c in need):
        print(f"❌ Colonnes de score absentes ({need}) — relance build_dataset.py.")
        return None

    rows = []
    print(f"   {'saison':>8} {'matchs':>7} {'ll_score':>10} {'ll_marché':>10} "
          f"{'σ moyen':>9} {'σ_max':>8}")
    for s in test_seasons:
        train_df = df[(df["season"] < s)].dropna(subset=need).reset_index(drop=True)
        test_df = df[(df["season"] == s) & df["market_home_p_close"].notna()].copy()
        test_df = test_df.dropna(subset=need).reset_index(drop=True)
        if len(test_df) < 50 or len(train_df) < 800:
            continue

        main, members, tau, p_ot = fit_score_fold(
            train_df, feats, params, n_members,
            search_trials=search_trials, season=s, use_cache=use_cache)

        # σ_max : p90 de σ sur la tranche de CALIBRATION, que les membres n'ont
        # pas vue. Calibré sur le train, il serait biaisé bas — les membres sont
        # dans l'échantillon et s'y accordent artificiellement — et réduirait à
        # zéro la moitié des paris au lieu de moduler. Aucune information de la
        # saison testée n'entre ici : la calibration reste du passé.
        sigma_max = None
        if members:
            cal = train_df.iloc[int(len(train_df) * 0.85):].reset_index(drop=True)
            s_cal = TS.stack(cal)
            lh_c, la_c = TS.ensemble_lambdas(members, feats, s_cal, len(cal))
            sd_c = np.array([
                ScoreEnsemble(list(zip(lh_c[:, j], la_c[:, j])), p_ot, tau)
                .spread("p_home_win")[1] for j in range(len(cal))])
            sigma_max = float(np.quantile(sd_c, 0.90))

        s_te = TS.stack(test_df)
        lam_h, lam_a = TS.lambdas_for(main, feats, s_te, len(test_df))
        lh_e, la_e = (TS.ensemble_lambdas(members, feats, s_te, len(test_df))
                      if members else (None, None))

        y = test_df["home_win"].values.astype(float)
        dec_h = test_df["home_ml_close"].values
        dec_a = test_df["away_ml_close"].values
        p_home = np.empty(len(test_df))
        sd_home = np.zeros(len(test_df))
        for j in range(len(test_df)):
            p_home[j] = ScoreDistribution(lam_h[j], lam_a[j], p_ot, tau).p_home_win()
            if members:
                sd_home[j] = ScoreEnsemble(list(zip(lh_e[:, j], la_e[:, j])),
                                           p_ot, tau).spread("p_home_win")[1]

        p_mkt = test_df["market_home_p_close"].values
        ll_m = T.log_loss_np(y, np.clip(p_home, 1e-6, 1 - 1e-6))
        ll_k = T.log_loss_np(y, p_mkt)
        print(f"   {s}-{str(s+1)[2:]:<2} {len(test_df):>7} {ll_m:>10.4f} {ll_k:>10.4f} "
              f"{sd_home.mean():>9.5f} {(sigma_max or 0):>8.5f}")

        for j in range(len(test_df)):
            if not (np.isfinite(dec_h[j]) and np.isfinite(dec_a[j])
                    and dec_h[j] > 1 and dec_a[j] > 1):
                continue
            overround = 1 / dec_h[j] + 1 / dec_a[j]
            for p, dec, won in [(p_home[j], dec_h[j], y[j] == 1),
                                (1 - p_home[j], dec_a[j], y[j] == 0)]:
                p_imp = (1 / dec) / overround
                rows.append({"date": test_df["date"].iloc[j], "p": p, "dec": dec,
                             "won": bool(won), "edge": p - p_imp,
                             "sigma": sd_home[j], "sigma_max": sigma_max})

    if not rows:
        print("❌ Aucun pari généré.")
        return None
    rows.sort(key=lambda r: str(r["date"]))
    bets = [r for r in rows if r["edge"] >= edge_threshold]
    print(f"\n   {len(bets)} paris retenus à edge ≥ {edge_threshold:.0%} "
          f"sur {len(rows)} possibles")
    if not bets:
        return None

    plain = simulate(bets, lambda b: kelly(b["p"], b["dec"]))
    shrunk = simulate(bets, lambda b: uncertainty_haircut(
        kelly(b["p"], b["dec"]), b["sigma"], b["sigma_max"]))

    # ── Bras de contrôle : réduction PLATE à exposition égale ────────────────
    #
    # Sans lui la comparaison est truquée. `k × (1 − σ/σ_max)` réduit toujours
    # la mise, donc réduit toujours le drawdown — et les gains avec. Un test que
    # la règle ne peut pas échouer ne mesure rien.
    #
    # On cherche donc c tel qu'un `k × c` uniforme mise le MÊME total que la
    # réduction par σ, et on compare à exposition égale. Si σ ne bat pas ce
    # bras, alors elle n'a rien apporté : on a seulement parié moins.
    lo, hi = 0.0, 1.0
    target = shrunk["total_staked"]
    for _ in range(40):
        mid = (lo + hi) / 2
        s = simulate(bets, lambda b, c=mid: kelly(b["p"], b["dec"]) * c)
        if s["total_staked"] < target:
            lo = mid
        else:
            hi = mid
    c_flat = (lo + hi) / 2
    flat = simulate(bets, lambda b: kelly(b["p"], b["dec"]) * c_flat)

    print(f"\n   ── Dimensionnement (¼ Kelly, bankroll composé) ──")
    print(f"   {'':<34} {'bankroll':>10} {'drawdown max':>13} {'misé total':>11}")
    for label, r in [("Kelly ¼ nu", plain),
                     (f"Kelly ¼ plat ×{c_flat:.3f} (contrôle)", flat),
                     ("Kelly ¼ réduit par σ", shrunk)]:
        print(f"   {label:<34} {r['final_bankroll']:>10.4f} "
              f"{r['max_drawdown']:>12.2%} {r['total_staked']:>11.3f}")

    d_bank = shrunk["final_bankroll"] - flat["final_bankroll"]
    d_dd = flat["max_drawdown"] - shrunk["max_drawdown"]
    print(f"\n   → À exposition égale, σ vs plat : bankroll {d_bank:+.4f}, "
          f"drawdown {d_dd:+.2%}")

    # ── Test de permutation ──────────────────────────────────────────────────
    #
    # Un avantage à exposition égale peut naître du seul hasard : moduler les
    # mises de façon quelconque redistribue les gains, et sur un millier de
    # paris certaines redistributions gagnent. La question n'est donc pas « σ
    # a-t-elle gagné ? » mais « a-t-elle gagné plus souvent qu'un σ arbitraire ? ».
    #
    # On mélange les étiquettes σ entre paris — en conservant EXACTEMENT la même
    # distribution de réductions, donc la même exposition — et on regarde où
    # tombe l'avantage observé dans cette distribution nulle.
    p_value = None
    if n_perm > 0:
        rng = np.random.default_rng(42)
        sigmas = np.array([b["sigma"] for b in bets])
        null = []
        for _ in range(n_perm):
            perm = rng.permutation(sigmas)
            shuffled = [dict(b, sigma=float(s)) for b, s in zip(bets, perm)]
            r = simulate(shuffled, lambda b: uncertainty_haircut(
                kelly(b["p"], b["dec"]), b["sigma"], b["sigma_max"]))
            null.append(r["final_bankroll"] - flat["final_bankroll"])
        null = np.array(null)
        p_value = float((null >= d_bank).mean())
        print(f"   Permutation ({n_perm} tirages, σ mélangée) : "
              f"avantage nul médian {np.median(null):+.4f}, "
              f"p90 {np.quantile(null, 0.90):+.4f}")
        print(f"   → p = {p_value:.3f} "
              f"({'significatif' if p_value < 0.05 else 'NON significatif'} à 5 %)")
        if p_value >= 0.05:
            print("     Un σ arbitraire fait aussi bien. L'avantage observé n'est "
                  "pas attribuable\n     à l'information portée par σ.")

    if d_bank <= 0 and d_dd <= 0:
        print("     σ ne bat pas une réduction plate de même ampleur — la règle "
              "n'apporte\n     rien d'autre que de miser moins. À consigner tel quel.")

    # ── Biais de sélection : l'edge prédit tient-il moins quand σ monte ? ─────
    sig = np.array([b["sigma"] for b in bets])
    buckets = []
    if sig.std() > 0:
        qs = np.quantile(sig, [0, 0.25, 0.5, 0.75, 1.0])
        print(f"\n   ── Edge prédit vs réalisé, par bucket de σ ──")
        print(f"   {'bucket':>7} {'n':>6} {'σ moyen':>9} {'edge prédit':>12} "
              f"{'edge réalisé':>13} {'écart':>9}")
        for b_i in range(4):
            lo, hi = qs[b_i], qs[b_i + 1]
            sel = [b for b in bets if lo <= b["sigma"] <= hi] if b_i == 3 else \
                  [b for b in bets if lo <= b["sigma"] < hi]
            if len(sel) < 20:
                continue
            pred = float(np.mean([b["edge"] for b in sel]))
            # Edge réalisé = rendement moyen par unité misée à plat
            real = float(np.mean([(b["dec"] - 1) if b["won"] else -1.0 for b in sel]))
            buckets.append({"bucket": b_i + 1, "n": len(sel),
                            "sigma_mean": round(float(np.mean([b["sigma"] for b in sel])), 5),
                            "edge_predicted": round(pred, 4),
                            "edge_realized": round(real, 4),
                            "gap": round(real - pred, 4)})
            print(f"   {b_i + 1:>7} {len(sel):>6} {buckets[-1]['sigma_mean']:>9.5f} "
                  f"{pred:>11.2%} {real:>12.2%} {real - pred:>8.2%}")
        if len(buckets) >= 2:
            gaps = [b["gap"] for b in buckets]
            monotone = all(gaps[i] >= gaps[i + 1] for i in range(len(gaps) - 1))
            worsens = gaps[-1] < gaps[0]
            print(f"\n   → Écart promis/réalisé : {gaps[0]:+.2%} → {gaps[-1]:+.2%}, "
                  f"{'monotone' if monotone else 'NON monotone'}")
            if worsens and monotone:
                print("     Le creusement est régulier : c'est la signature d'un biais "
                      "de sélection\n     lié à σ.")
            elif worsens:
                # Cas observé le 2026-08-03 : -7.04, -6.44, -4.62, -12.32. Le
                # « creusement » tenait au seul dernier bucket ; les trois
                # premiers s'amélioraient. Un effet porté par un seul groupe sur
                # quatre est un candidat au bruit, pas une tendance.
                print("     Attention : le creusement n'est pas régulier. S'il tient à "
                      "un seul\n     bucket, c'est un candidat au bruit — se fier au "
                      "test de permutation.")
            else:
                print("     Sans creusement, réduire la mise en fonction de σ n'a pas "
                      "de fondement mesuré sur ces données — à consigner tel quel.")

    return {"n_bets": len(bets), "edge_threshold": edge_threshold,
            "n_members": n_members,
            "sizing": {"kelly_plain": plain,
                       "kelly_flat_matched": dict(flat, c=round(c_flat, 4)),
                       "kelly_sigma_shrunk": shrunk},
            "sigma_vs_flat": {"d_final_bankroll": round(d_bank, 4),
                              "d_max_drawdown": round(d_dd, 4),
                              "permutation_p_value": p_value,
                              "n_permutations": n_perm},
            "sigma_buckets": buckets}


# ── Marchés dérivés — ROI avec de VRAIS prix ─────────────────────────────────

def bet_returns(sel) -> np.ndarray:
    """Rendement unitaire par pari. Le push rend la mise : rendement nul."""
    return np.array([0.0 if b["push"] else ((b["dec"] - 1) if b["won"] else -1.0)
                     for b in sel])


def bet_stats(sel):
    """(ROI %, erreur type %, z) sur une sélection de paris."""
    ret = bet_returns(sel)
    roi = ret.mean() * 100
    se = ret.std(ddof=1) / np.sqrt(len(ret)) * 100 if len(ret) > 1 else float("nan")
    return roi, se, (roi / se if se else float("nan"))


def _by_bucket(sel, key, n_buckets=3):
    """Découpe une sélection en terciles d'une variable continue."""
    vals = np.array([key(b) for b in sel], dtype=float)
    qs = np.quantile(vals, np.linspace(0, 1, n_buckets + 1))
    out = []
    for i in range(n_buckets):
        lo, hi = qs[i], qs[i + 1]
        m = (vals >= lo) & ((vals <= hi) if i == n_buckets - 1 else (vals < hi))
        grp = [b for b, keep in zip(sel, m) if keep]
        if len(grp) < 10:
            continue
        roi, se, z = bet_stats(grp)
        out.append({"lo": round(float(lo), 4), "hi": round(float(hi), 4),
                    "n": len(grp), "roi_pct": round(roi, 2), "z": round(z, 2)})
    return out


def dissect(sel, stats, label: str, profit_share: float, n_parent: int) -> dict:
    """Anatomie d'une poche de ROI positif : effet réel ou bruit concentré ?

    Un ROI porté par une minorité de paris n'est pas disqualifié d'office —
    c'est la forme normale d'un edge de niche. Mais il n'est crédible que s'il
    est **réparti** sur quatre axes indépendants : le temps, le prix, l'équipe
    et l'identité des gains. Un paquet de bruit se loge dans une saison, une
    plage de cotes, deux franchises, ou trois gros gains.

    Le test le plus tranchant est le dernier — `wins_to_flip`. Un vrai edge de
    2-3 % sur quelques centaines de paris ne repose sur aucun pari en
    particulier : il faut en retirer beaucoup pour le tuer. Un ROI de 21 %
    obtenu contre des cotes de clôture ne survit typiquement pas au retrait de
    deux ou trois gains — et un tel ROI n'existe pas dans un marché réel, où
    les edges valent 1 à 3 %.
    """
    ret = bet_returns(sel)
    roi, se, z = stats(sel)
    d = {"leg": label, "n": len(sel), "roi_pct": round(roi, 2),
         "roi_se_pct": round(se, 2), "z": round(z, 2),
         "profit_share": round(float(profit_share), 3),
         "bet_share": round(len(sel) / n_parent, 3) if n_parent else None}

    # ── 1. Le temps ──────────────────────────────────────────────────────────
    print(f"   {'saison':>8} {'paris':>7} {'ROI':>9}")
    by_season, npos = [], 0
    for s in sorted({b["season"] for b in sel}):
        ss = [b for b in sel if b["season"] == s]
        if len(ss) < 10:
            continue
        r_s, _, _ = stats(ss)
        by_season.append({"season": int(s), "n": len(ss), "roi_pct": round(r_s, 2)})
        npos += r_s > 0
        print(f"   {s}-{str(s+1)[2:]:<2} {len(ss):>7} {r_s:>8.2f}%")
    d["by_season"] = by_season
    d["seasons_positive"] = f"{npos}/{len(by_season)}"
    print(f"   → positif sur {npos}/{len(by_season)} saisons")

    # Jackknife : le ROI survit-il au retrait de n'importe quelle saison ?
    # Une saison qui, retirée, fait basculer l'agrégat, EST l'agrégat.
    jk = []
    for s in {b["season"] for b in sel}:
        rest = [b for b in sel if b["season"] != s]
        if len(rest) >= 30:
            jk.append((int(s), bet_stats(rest)[0]))
    if jk:
        worst = min(jk, key=lambda t: t[1])
        d["jackknife_season"] = {"worst_season": worst[0],
                                 "roi_without_pct": round(worst[1], 2),
                                 "stays_positive": bool(worst[1] > 0)}
        print(f"   Jackknife : sans {worst[0]}-{str(worst[0]+1)[2:]}, "
              f"ROI {worst[1]:.2f}% "
              f"({'tient' if worst[1] > 0 else 'bascule'})")

    # ── 2. Le prix ───────────────────────────────────────────────────────────
    d["by_odds"] = _by_bucket(sel, lambda b: b["dec"])
    print(f"\n   {'cote':>12} {'paris':>7} {'ROI':>9}")
    for q in d["by_odds"]:
        print(f"   {q['lo']:>5.2f}-{q['hi']:<5.2f} {q['n']:>7} {q['roi_pct']:>8.2f}%")

    # ── 3. L'edge lui-même ───────────────────────────────────────────────────
    # Si l'edge prédit ne trie pas le rendement à l'intérieur de la poche, ce
    # n'est pas le modèle qui a trouvé quelque chose : c'est la sélection.
    d["by_edge"] = _by_bucket(sel, lambda b: b["edge"])
    print(f"\n   {'edge':>12} {'paris':>7} {'ROI':>9}")
    for q in d["by_edge"]:
        print(f"   {q['lo']:>5.1%}-{q['hi']:<5.1%} {q['n']:>7} {q['roi_pct']:>8.2f}%")

    # ── 4. Les équipes ───────────────────────────────────────────────────────
    # Piège évité : « les 3 meilleures équipes portent 66 % du gain » ne veut
    # rien dire dans l'absolu. Avec dix équipes et des rendements purement
    # aléatoires, les trois meilleures portent *toujours* l'essentiel du gain
    # positif — c'est une propriété du maximum, pas une concentration. Le seuil
    # arbitraire testé d'abord (50 %) déclarait « bruit » un jeu de données
    # synthétique délibérément propre. On compare donc à un vrai témoin :
    # les mêmes rendements, les étiquettes d'équipe mélangées.
    teams = [b for b in sel if b.get("team")]
    if len(teams) >= 60:
        labels = np.array([b["team"] for b in teams])
        r_t = bet_returns(teams)

        def top3_share(lab):
            g = {}
            for t, r in zip(lab, r_t):
                g[t] = g.get(t, 0.0) + r
            pos = sorted((v for v in g.values() if v > 0), reverse=True)
            return sum(pos[:3]) / sum(pos) if pos else 0.0

        obs = top3_share(labels)
        rng_t = np.random.default_rng(11)
        null = np.array([top3_share(rng_t.permutation(labels)) for _ in range(300)])
        p_conc = float((null >= obs).mean())

        counts, nets = {}, {}
        for t, r in zip(labels, r_t):
            counts[t] = counts.get(t, 0) + 1
            nets[t] = nets.get(t, 0.0) + r
        ranked = sorted(nets.items(), key=lambda kv: -kv[1])
        d["by_team_top"] = [{"team": t, "n": counts[t], "gross_units": round(v, 2)}
                            for t, v in ranked[:5]]
        d["top3_teams_share"] = round(float(obs), 3)
        d["top3_teams_share_null_median"] = round(float(np.median(null)), 3)
        d["top3_teams_p"] = round(p_conc, 3)
        print(f"\n   {'équipe':>8} {'paris':>7} {'gain net':>10}")
        for t, v in ranked[:5]:
            print(f"   {t:>8} {counts[t]:>7} {v:>9.2f}u")
        print(f"   → top-3 = {obs:.0%} du gain positif ; témoin (étiquettes "
              f"mélangées) {np.median(null):.0%}, p = {p_conc:.3f} "
              f"[{len(nets)} équipes]")

    # ── 5. Fragilité : combien de gains font vivre ce ROI ? ───────────────────
    # Retirer les k plus gros rendements se calcule par somme cumulée : la
    # moyenne restante vaut (total − somme des k premiers) / (n − k).
    n = len(ret)
    desc = np.sort(ret)[::-1]
    cum = np.cumsum(desc)
    total = float(ret.sum())
    roi_without = lambda k: (total - float(cum[k - 1])) / (n - k)
    flipped = next((k for k in range(1, n) if roi_without(k) <= 0), None)
    d["wins_to_flip"] = flipped
    d["wins_to_flip_share"] = round(flipped / n, 4) if flipped else None
    for k in (1, 3, 5):
        if k < n:
            d[f"roi_drop_top{k}_pct"] = round(roi_without(k) * 100, 2)
    if flipped:
        print(f"\n   Fragilité : retirer les {flipped} plus gros gains "
              f"({flipped/n:.1%} des paris) annule le ROI.")
        print(f"   ROI sans le top-1 / top-3 / top-5 : "
              f"{d.get('roi_drop_top1_pct')}% / {d.get('roi_drop_top3_pct')}% / "
              f"{d.get('roi_drop_top5_pct')}%")

    # Bootstrap plutôt que le z : à des cotes de 3-4, la distribution des
    # rendements est fortement asymétrique (−1 la plupart du temps, +2 à +3
    # parfois) et l'approximation normale du z surestime la significativité.
    # Le bootstrap ne suppose rien sur cette forme.
    rng_b = np.random.default_rng(23)
    boot = rng_b.choice(ret, size=(2000, n), replace=True).mean(axis=1)
    d["bootstrap_p_positive"] = round(float((boot > 0).mean()), 3)
    d["bootstrap_ci95_pct"] = [round(float(np.quantile(boot, 0.025)) * 100, 2),
                               round(float(np.quantile(boot, 0.975)) * 100, 2)]
    print(f"   Bootstrap : P(ROI > 0) = {d['bootstrap_p_positive']:.3f}, "
          f"IC 95 % [{d['bootstrap_ci95_pct'][0]}%, "
          f"{d['bootstrap_ci95_pct'][1]}%]")

    # ── Verdict ──────────────────────────────────────────────────────────────
    # Deux niveaux, et la distinction compte.
    #
    # **Bloquant** : le ROI n'est pas distinguable de zéro (bootstrap), ou il
    # disparaît si l'on retire une seule saison. Dans ces deux cas il n'y a
    # rien à expliquer, donc rien à jouer.
    #
    # **Signal de concentration** : le ROI est significatif mais logé dans un
    # coin (une plage de cotes, quelques équipes, une minorité de saisons).
    # Cela n'annule pas l'edge — un edge de niche EST concentré — mais cela
    # veut dire qu'on ne mesure plus 2 893 paris, on en mesure quelques
    # centaines, et les seuils qui ont mené jusqu'ici ont été choisis après
    # avoir vu les données.
    #
    # **Multiplicité, assumée.** Trois contrôles de concentration à ~5 % chacun
    # font qu'un edge parfaitement propre en déclenche au moins un environ une
    # fois sur sept. Vérifié : sur 200 jeux synthétiques où les équipes sont
    # échangeables par construction, le test de permutation rend p < 0.05 dans
    # 5.5 % des cas (nominal 5 %, médiane de p à 0.47) — il est calibré, et un
    # déclenchement isolé n'est donc PAS une réfutation. Un seul signal de
    # concentration se lit comme une piste à creuser ; deux ou trois, comme un
    # ROI qui n'existe que dans un recoin.
    blocking, warnings = [], []
    if d["bootstrap_p_positive"] < 0.95:
        blocking.append(f"ROI non distinguable de zéro "
                        f"(bootstrap P(ROI>0) = {d['bootstrap_p_positive']})")
    if d.get("jackknife_season") and not d["jackknife_season"]["stays_positive"]:
        blocking.append(f"bascule sans la saison "
                        f"{d['jackknife_season']['worst_season']}")
    if by_season and npos < len(by_season) * 0.6:
        warnings.append(f"positif sur {npos}/{len(by_season)} saisons seulement")
    if d["by_odds"] and sum(q["roi_pct"] > 0 for q in d["by_odds"]) <= 1:
        warnings.append("concentré sur une plage de cotes")
    if (d.get("top3_teams_p") is not None) and d["top3_teams_p"] < 0.05:
        warnings.append(f"concentré sur quelques équipes (p = {d['top3_teams_p']})")

    d["blocking"] = blocking
    d["warnings"] = warnings
    if blocking:
        d["verdict"] = "à ne pas jouer — " + " ; ".join(blocking)
    elif len(warnings) >= 2:
        d["verdict"] = ("edge de recoin — significatif en agrégat mais logé "
                        "dans un coin : " + " ; ".join(warnings))
    elif warnings:
        d["verdict"] = ("non réfuté, une réserve (un contrôle sur trois se "
                        "déclenche par hasard une fois sur sept) : "
                        + warnings[0])
    else:
        d["verdict"] = ("réparti sur tous les axes — non réfuté. À confirmer "
                        "hors échantillon avant toute mise.")
    print(f"\n   Verdict : {d['verdict']}")
    return d


def run_derived(df, test_seasons, edge_threshold: float, n_members: int = 0,
                search_trials: int = 0, use_cache: bool = True):
    """ROI walk-forward sur les totaux et la puck line.

    Ces marchés sont ceux que P2 et P3 price le mieux, et ils étaient
    jusqu'ici **impossibles à évaluer** : `odds.csv` ne portait que la LIGNE de
    total, pas les prix. Les prix étaient pourtant dans les pages SBRO déjà
    sauvegardées — le parser les lisait et les jetait.

    Deux détails sans lesquels le ROI serait faux :

    • **Push.** 43 % des lignes de total sont entières (5.0, 6.0, 7.0) et 7.6 %
      des matchs tombent exactement dessus. Les compter comme des pertes
      écraserait le taux de réussite d'environ 5 points. Ici la mise est rendue.
    • **Prix réels, pas −110 supposé.** La marge mesurée est de 4.43 % et les
      prix sont souvent asymétriques (5.5 à −110 d'un côté, +100 de l'autre).
      Supposer −110/−110 gonflerait le ROI du côté qu'on aime.
    """
    feats = TS.stacked_features()
    params = base_score_params(search_trials)

    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    if "total_close_over" not in df.columns:
        print("❌ Pas de prix over/under dans le dataset.")
        print("   → relance : python fetch_data_v4.py --only odds --from-local")
        print("     puis     : python build_dataset.py")
        return None

    bets = []
    print(f"   {'saison':>8} {'matchs':>7} {'totaux':>8} {'puckline':>9}")
    for s in test_seasons:
        train_df = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        test_df = df[(df["season"] == s)].dropna(subset=need).reset_index(drop=True)
        if len(test_df) < 50 or len(train_df) < 800:
            continue
        main_m, _, tau, p_ot = fit_score_fold(
            train_df, feats, params, n_members,
            search_trials=search_trials, season=s, use_cache=use_cache)
        s_te = TS.stack(test_df)
        lam_h, lam_a = TS.lambdas_for(main_m, feats, s_te, len(test_df))

        n_tot = n_pl = 0
        for j in range(len(test_df)):
            r = test_df.iloc[j]
            d = ScoreDistribution(lam_h[j], lam_a[j], p_ot, tau)
            total = float(r["total_goals"])
            margin = float(r["home_score"]) - float(r["away_score"])
            # Source du prix : le ROI se lit PAR SOURCE, jamais sur des saisons
            # mélangées (marge DraftKings 3,95 % contre 2,53 % pour SBRO sur le
            # recouvrement de janvier 2022).
            src = r.get("source")
            src = src if isinstance(src, str) else "sbro"

            # ── Totaux ───────────────────────────────────────────────────────
            line = r.get("total_close")
            o_px, u_px = r.get("total_close_over"), r.get("total_close_under")
            if all(np.isfinite(x) if x is not None else False for x in (line, o_px, u_px)) \
                    and o_px > 1 and u_px > 1:
                p_mkt_over = (1 / o_px) / (1 / o_px + 1 / u_px)
                p_over = d.p_over(line)
                push = abs(total - line) < 1e-9
                for side, p, dec, p_mkt, won in [
                        ("over",  p_over,     o_px, p_mkt_over,     total > line),
                        ("under", 1 - p_over, u_px, 1 - p_mkt_over, total < line)]:
                    bets.append({"market": "total", "source": src,
                                 "season": s, "date": r["date"],
                                 "p": p, "dec": dec, "edge": p - p_mkt,
                                 "won": bool(won), "push": push,
                                 "side": side, "leg": side,
                                 "team": None, "line": float(line)})
                n_tot += 1

            # ── Puck line ────────────────────────────────────────────────────
            pl = r.get("puck_line_home")
            hp, ap_ = r.get("pl_home_price"), r.get("pl_away_price")
            if all(np.isfinite(x) if x is not None else False for x in (pl, hp, ap_)) \
                    and hp > 1 and ap_ > 1 and abs(abs(pl) - 1.5) < 1e-9:
                # pl = handicap du DOMICILE : −1.5 s'il est favori, +1.5 sinon.
                p_home = (d.p_home_cover_minus_15() if pl < 0
                          else d.p_home_cover_plus_15())
                won_home = (margin >= 2) if pl < 0 else (margin >= -1)
                p_mkt_home = (1 / hp) / (1 / hp + 1 / ap_)
                for side, p, dec, p_mkt, won in [
                        ("home", p_home,     hp, p_mkt_home,     won_home),
                        ("away", 1 - p_home, ap_, 1 - p_mkt_home, not won_home)]:
                    # `fav` distingue le côté qui DONNE les 1.5 buts de celui
                    # qui les reçoit. Un edge concentré d'un seul côté trahit
                    # un biais statique du modèle plutôt qu'une vraie lecture
                    # du match — c'est le premier réflexe de vérification.
                    gives = (pl < 0) if side == "home" else (pl > 0)
                    # L'équipe sur laquelle on mise, pour repérer un ROI porté
                    # par deux ou trois franchises — signature d'un biais
                    # d'estimation d'équipe plutôt que d'une lecture de match.
                    team = r["home_team"] if side == "home" else r["away_team"]
                    bets.append({"market": "puckline", "source": src,
                                 "season": s, "date": r["date"],
                                 "p": p, "dec": dec, "edge": p - p_mkt,
                                 "won": bool(won), "push": False,
                                 "side": side, "leg": "-1.5" if gives else "+1.5",
                                 "team": str(team), "line": float(pl)})
                n_pl += 1
        print(f"   {s}-{str(s+1)[2:]:<2} {len(test_df):>7} {n_tot:>8} {n_pl:>9}")

    if not bets:
        print("❌ Aucun pari généré — vérifie la couverture des prix.")
        return None

    stats = bet_stats

    # Une clé par (marché, source) : « puckline [sbro] », « puckline
    # [oddsapi:draftkings] ». Le tableau de bord (onglet Backtest) affiche
    # toute entrée de `markets` qui est un tableau, sans liste de clés : les
    # sources y apparaissent donc côte à côte, jamais agrégées.
    out = {"edge_threshold": edge_threshold, "markets": {},
           "split": "par source de prix (cle '<marche> [<source>]')"}
    combos = sorted({(b["market"], b["source"]) for b in bets},
                    key=lambda t: (t[0] != "total", t[1] != "sbro", t))
    for market_name, src in combos:
        market = f"{market_name} [{src}]"
        sel_all = [b for b in bets if b["market"] == market_name
                   and b["source"] == src]
        if not sel_all:
            continue
        print(f"\n   -- {market.upper()} -- {len(sel_all)} paris possibles --")
        print(f"   {'edge>':>6} {'paris':>7} {'push':>6} {'hit%':>7} {'ROI flat':>10} "
              f"{'±ET':>7} {'z':>6}")
        rows = []
        for edge in [0.01, 0.02, 0.03, 0.04, 0.05]:
            sel = [b for b in sel_all if b["edge"] >= edge]
            if len(sel) < 30:
                continue
            live = [b for b in sel if not b["push"]]
            n_push = len(sel) - len(live)
            roi, se, z = stats(sel)
            hit = np.mean([b["won"] for b in live]) * 100 if live else float("nan")
            rows.append({"edge": edge, "n_bets": len(sel), "n_push": n_push,
                         "hit_rate": round(hit, 2), "roi_flat_pct": round(roi, 2),
                         "roi_se_pct": round(se, 2), "z": round(z, 2)})
            print(f"   {edge:>5.0%} {len(sel):>7} {n_push:>6} {hit:>6.1f}% "
                  f"{roi:>9.2f}% {se:>6.2f}% {z:>6.2f}")
        # Cohérence entre les deux mesures : elles doivent raconter la même
        # histoire. Quand elles divergent, c'est la plus PRÉCISE qui décide —
        # et le bloc de convergence, plus bas, chiffre laquelle l'est.
        worst = max((r for r in rows
                     if r.get("gap_vs_close_sigma") is not None),
                    key=lambda r: abs(r["gap_vs_close_sigma"]), default=None)
        if worst and abs(worst["gap_vs_close_sigma"]) >= 2:
            print(f"\n   ⚠️  À edge ≥ {worst['edge']:.0%}, le ROI réalisé "
                  f"({worst['roi_open_pct']:+.2f} %) s'écarte de "
                  f"{worst['gap_vs_close_sigma']:+.2f}σ\n       de ce que la "
                  f"clôture prédisait ({worst['roi_implied_by_close_pct']:+.2f} %). "
                  f"Deux lectures :\n       ces paris ont battu la clôture — ce "
                  f"que P1 dit impossible — ou l'écart est du bruit.\n       Le "
                  f"CLV, mesuré bien plus efficacement que le ROI, dit la seconde.")

        # Le verdict qui compte : le CLV réel bat-il celui d'un modèle rendu
        # ignorant ? Sinon, tout le chiffre est de la régression vers la moyenne.
        beat = [r for r in rows if r.get("clv_net") is not None]
        if beat:
            best = max(beat, key=lambda r: r["clv_net"])
            pl = best["clv_placebo"]
            print(f"\n   Placebo (modèle permuté entre matchs, {pl['n_shuffles']} "
                  f"tirages) — le mécanisme de\n   sélection produit à lui seul "
                  f"{pl['mean']:+.4f} de CLV (max {pl['max']:+.4f}).")
            if best["clv_net"] <= 0:
                print("   → Le CLV mesuré NE BAT PAS le placebo : c'est de la "
                      "régression vers la\n     moyenne, pas une lecture du "
                      "marché. Le modèle n'y est pour rien.")
            elif best["clv_net"] < pl["sd"] * 2:
                print("   → Le CLV dépasse le placebo de moins de deux "
                      "écarts-types de celui-ci :\n     indistinguable du "
                      "mécanisme de sélection.")
            else:
                print(f"   → Le CLV NET du placebo vaut {best['clv_net']:+.4f} "
                      f"à edge ≥ {best['edge']:.0%}.\n     C'est ce qui reste "
                      f"attribuable au modèle, et rien de plus.")
        out["markets"][market] = rows

        # ── Les deux contrôles qui décident si un ROI positif est crédible ────
        best = max(rows, key=lambda r: r["roi_flat_pct"]) if rows else None
        if not best or best["roi_flat_pct"] <= 0:
            continue
        thr = best["edge"]
        sub = [b for b in sel_all if b["edge"] >= thr]

        # 1. Stabilité inter-saisons. Un ROI porté par une ou deux saisons est
        #    du bruit, quel que soit le nombre de paris — les matchs d'une même
        #    saison partagent équipes, arbitrage et régime de scoring.
        print(f"\n   Stabilité par saison à edge ≥ {thr:.0%} :")
        print(f"   {'saison':>8} {'paris':>7} {'ROI':>9}")
        seasons, pos = [], 0
        for s in sorted({b["season"] for b in sub}):
            ss = [b for b in sub if b["season"] == s]
            if len(ss) < 30:
                continue
            r_s, _, _ = stats(ss)
            seasons.append({"season": int(s), "n": len(ss), "roi_pct": round(r_s, 2)})
            pos += r_s > 0
            print(f"   {s}-{str(s+1)[2:]:<2} {len(ss):>7} {r_s:>8.2f}%")
        if seasons:
            print(f"   → positif sur {pos}/{len(seasons)} saisons")
            if pos < len(seasons) * 0.6:
                print("     Moins de 60 % des saisons dans le vert : l'agrégat "
                      "repose sur\n     quelques saisons, pas sur un effet stable.")

        # 2. Répartition par jambe. Un edge entièrement d'un côté trahit un
        #    biais statique du modèle (il aime les négligés, il aime l'over),
        #    exploitable seulement tant que ce biais reste dans le bon sens.
        legs = {}
        print(f"\n   Répartition par jambe à edge ≥ {thr:.0%} :")
        for leg in sorted({b["leg"] for b in sub}):
            ls = [b for b in sub if b["leg"] == leg]
            if len(ls) < 30:
                continue
            r_l, se_l, z_l = stats(ls)
            legs[leg] = {"n": len(ls), "roi_pct": round(r_l, 2), "z": round(z_l, 2)}
            print(f"   {leg:>8} {len(ls):>7} paris  ROI {r_l:>7.2f}%  z {z_l:>5.2f}")
        if len(legs) == 1:
            print("     Une seule jambe jouée : biais directionnel, pas une "
                  "lecture du match.")

        # 3. Dissection de la jambe qui porte le profit.
        #    Quand une minorité de paris fait la majorité du résultat, la seule
        #    question qui compte est : cette minorité est-elle un effet réel ou
        #    un paquet de bruit concentré ? Un ROI vrai est réparti dans le
        #    temps, à travers les cotes et à travers les équipes ; un ROI de
        #    hasard tient à quelques gains ou à une poignée de franchises.
        dissection = None
        if len(legs) > 1:
            gross = {k: v["n"] * v["roi_pct"] for k, v in legs.items()}
            top = max(gross, key=lambda k: gross[k])
            share = gross[top] / sum(gross.values()) if sum(gross.values()) else 0
            if share > 0.4 and legs[top]["n"] < 0.4 * len(sub):
                ls = [b for b in sub if b["leg"] == top]
                print(f"\n   ⚠️  La jambe {top} porte {share:.0%} du profit avec "
                      f"{legs[top]['n']/len(sub):.0%} des paris — dissection :")
                dissection = dissect(ls, stats, label=top,
                                     profit_share=share, n_parent=len(sub))
        out["markets"][market + "_diagnostics"] = {
            "threshold": thr, "by_season": seasons, "by_leg": legs,
            "dissection": dissection}
    print("\n   Rappel : marge SBRO mesurée 4.43 % (DraftKings : 3.95 % au "
          "moneyline).\n   Un ROI flat positif sur "
          "des prix\n   de clôture réels, avec plusieurs centaines de paris, serait "
          "le premier\n   edge exploitable trouvé dans ce plan.")
    return out


# ── A3 — battre l'OUVERTURE, et mesurer le CLV ───────────────────────────────
#
# POURQUOI CE MODE EXISTE. Tout ce qui a été mesuré jusqu'ici l'a été contre la
# cote de CLÔTURE, l'estimateur le plus dur qui soit — celui qui intègre toute
# l'information jusqu'à la mise au jeu. Trois chemins indépendants ont conclu
# qu'il n'y a rien. Mais **on ne parie jamais la clôture** : on parie ce qui est
# affiché au moment où on mise.
#
# Deux questions distinctes, que ce mode sépare exprès :
#
# 1. **ROI à l'ouverture.** Repère bien plus faible que la clôture. Si le modèle
#    ne bat pas non plus l'ouverture, le dossier moneyline est clos pour de bon.
# 2. **CLV — closing line value.** Le prix pris à l'ouverture est-il meilleur que
#    le prix de clôture ? C'est l'indicateur avancé standard d'un edge réel, et
#    il CONVERGE BEAUCOUP PLUS VITE que le ROI : on mesure un écart de prix sur
#    chaque pari au lieu d'attendre un résultat binaire très bruité. A2 a rendu
#    ça obligatoire — ~51 paris par saison ne concluront jamais sur un ROI.
#
# CE QUE CE MODE NE PEUT PAS FAIRE, ET IL FAUT LE DIRE EN GRAND. L'archive SBRO
# ne donne qu'UN SEUL prix de puck line par match (`pl_price`), pas une paire
# ouverture/clôture — contrairement au moneyline et aux totaux, qui en ont une.
# **Le CLV de la règle A2 n'est donc pas mesurable sur SBRO.** Il l'est sur les
# lignes The Odds API (2026-09-27) : leur série horodatée
# (`odds_snapshots_hist.csv`) donne une paire ouverture/clôture de puck line
# par match. Voir `load_snapshot_pairs` et le bloc « Règle A2 » de `run_clv`.
#
# LE PIÈGE DES TOTAUX, qu'une implémentation naïve rate. La LIGNE de total bouge
# (5.5 → 6.0). Quand elle a bougé, `market_over_p_open` et `market_over_p_close`
# ne décrivent pas le même pari, et leur différence n'est pas un CLV : c'est un
# changement de marché. Le CLV des totaux n'est donc calculé QUE sur les lignes
# restées identiques, et le nombre de paris écartés est imprimé — pas de
# troncature silencieuse.


def _clv_stats(deltas: np.ndarray) -> dict:
    """Moyenne, erreur-type, t et part positive d'une série de CLV."""
    n = len(deltas)
    mean = float(np.mean(deltas))
    sd = float(np.std(deltas, ddof=1)) if n > 1 else float("nan")
    se = sd / np.sqrt(n) if n > 1 else float("nan")
    return {"n": n, "mean": mean, "sd": sd, "se": se,
            "t": mean / se if se and np.isfinite(se) and se > 0 else float("nan"),
            "share_positive": float(np.mean(deltas > 0))}


# ── Le placebo du CLV — sans lui, le chiffre ne veut rien dire ───────────────
#
# LE BIAIS, ET IL EST STRUCTUREL. On sélectionne les paris sur
# `p_modèle − p_ouverture ≥ seuil`, puis on mesure
# `CLV = p_clôture − p_ouverture`. Les deux expressions partagent
# `p_ouverture`, et `p_ouverture` porte du bruit.
#
# Écrivons `p_ouv = vrai + ε_o` et `p_clô = vrai + ε_c`, avec ε_c plus petit
# (la clôture est le meilleur estimateur). Sélectionner sur un grand
# `p_modèle − p_ouv` retient préférentiellement les matchs où **ε_o est
# négatif** — où l'ouverture est trop basse, y compris par pur hasard. Sur ces
# matchs, `CLV = ε_c − ε_o` est positif EN MOYENNE, quelle que soit la qualité
# du modèle. Un modèle sans aucune information produit ce CLV positif.
#
# C'est de la régression vers la moyenne, et sa signature est visible dans le
# tableau : plus le seuil d'edge monte, plus le CLV monte. Une vraie compétence
# produirait exactement la même courbe. **Les deux sont indiscernables dans la
# sortie brute** — d'où ce placebo.
#
# LE PROTOCOLE, calqué sur les sentinelles d'A5, qui ont déjà servi une fois :
# plutôt que d'argumenter sur l'ampleur du biais, on le fait courir dans le
# même tuyau et on regarde ce qu'il produit. On permute les probabilités du
# modèle ENTRE LES MATCHS d'une même saison — le modèle ne sait donc plus rien
# du match qu'il price — et on refait exactement la même sélection.
#
# DEUX DÉTAILS SANS LESQUELS LE PLACEBO SERAIT FAUX :
#
# 1. **La permutation est par MATCH, pas par pari.** Les deux côtés d'un match
#    sont complémentaires (p et 1−p) ; les permuter séparément casserait cette
#    contrainte et le placebo choisirait parfois les deux côtés du même match.
# 2. **On égalise le NOMBRE de paris, pas le seuil d'edge.** Un modèle permuté
#    est décorrélé du marché, donc ses edges sont plus dispersés : à seuil égal
#    il sélectionnerait un ensemble plus grand et plus extrême. On prend donc
#    ses N meilleurs edges, N étant l'effectif réel du seuil comparé.
#
# Lecture : le CLV réel doit battre le placebo. S'il ne le bat pas, tout le
# chiffre est de la régression vers la moyenne et le modèle n'y est pour rien.


def _clv_placebo(bets: list, n_target: int, n_shuffles: int = 20,
                 leg: str | None = None) -> dict | None:
    """CLV obtenu par le MÊME mécanisme de sélection, modèle rendu ignorant.

    `leg` restreint la sélection à une jambe (« -1.5 » pour la règle A2) : le
    placebo ne choisit alors que ce côté-là, comme la règle, au lieu du côté
    d'edge positif. Sans ça il comparerait une règle à sens unique à un
    sélectionneur libre de prendre les deux jambes.
    """
    games: dict = {}
    for b in bets:
        games.setdefault(b["game_id"], []).append(b)
    # Un match n'est utilisable que s'il a ses deux côtés et un CLV défini.
    usable = [(gid, sides) for gid, sides in games.items()
              if len(sides) == 2 and all(x["clv"] is not None for x in sides)]
    if len(usable) < max(30, n_target):
        return None

    # `p_ref` = probabilité du côté de référence selon le modèle, et
    # `p_mkt_ref` = la même chose selon le marché à l'ouverture. Tout le reste
    # du match se déduit par complémentarité. Le côté de référence est marqué
    # `ref` par le constructeur des paris ; à défaut, home / over.
    #
    # POURQUOI LE MARQUAGE EXPLICITE : pour la puck line, « domicile » n'est
    # pas un repère stable — le domicile est à −1.5 un soir, à +1.5 le
    # lendemain. Permuter P(domicile couvre) entre ces deux matchs injecterait
    # 0,35 là où le marché dit 0,65 : des edges énormes et absurdes que le
    # placebo sélectionnerait en priorité. La référence y est donc la jambe
    # qui DONNE les 1.5 buts, dont la probabilité vit toujours dans la même
    # plage (~0,2-0,45).
    def is_ref(x):
        return x["ref"] if "ref" in x else x["side"] in ("home", "over")

    refs, others = [], []
    for _, sides in usable:
        ref = sides[0] if is_ref(sides[0]) else sides[1]
        oth = sides[1] if ref is sides[0] else sides[0]
        refs.append(ref)
        others.append(oth)
    p_ref = np.array([b["p"] for b in refs], dtype=float)
    p_mkt_ref = np.array([b["p"] - b["edge"] for b in refs], dtype=float)
    clv_ref = np.array([b["clv"] for b in refs], dtype=float)
    season = np.array([b["season"] for b in refs])
    ref_is_leg = (np.array([b["leg"] == leg for b in refs])
                  if leg is not None else None)

    means = []
    for k in range(n_shuffles):
        # Graine stable : reproductible d'une exécution à l'autre, et
        # différente à chaque tirage.
        rng = np.random.default_rng(_stable_seed("clv-placebo", k, len(refs)))
        shuffled = p_ref.copy()
        # Permutation À L'INTÉRIEUR de chaque saison : un modèle qui pricerait
        # 2014 avec les probabilités de 2021 verrait aussi changer le régime de
        # scoring de la ligue, ce qui n'est pas le bruit qu'on veut mesurer.
        for sea in np.unique(season):
            m = season == sea
            shuffled[m] = rng.permutation(p_ref[m])
        edge = shuffled - p_mkt_ref          # >0 : le placebo prend la réf.
        if ref_is_leg is None:
            # Le CLV du côté choisi. `clv` est antisymétrique entre les deux
            # côtés (p_clô − p_ouv d'un côté vaut l'opposé de l'autre), d'où
            # le signe.
            clv_taken = np.where(edge > 0, clv_ref, -clv_ref)
            order = np.argsort(-np.abs(edge))[:n_target]
        else:
            # Jambe imposée : son edge et son CLV, qu'elle soit la référence
            # ou l'autre côté du match ; puis ses N meilleurs edges.
            edge_leg = np.where(ref_is_leg, edge, -edge)
            clv_taken = np.where(ref_is_leg, clv_ref, -clv_ref)
            order = np.argsort(-edge_leg)[:n_target]
        means.append(float(np.mean(clv_taken[order])))

    arr = np.array(means)
    return {"n_shuffles": n_shuffles, "n_target": n_target,
            "mean": float(arr.mean()), "sd": float(arr.std(ddof=1)),
            "max": float(arr.max())}

# ── Les lignes The Odds API : ouverture et clôture lues dans la série horodatée ─
#
# POURQUOI PAS LES COLONNES `*_open` D'odds.csv. Elles sont VIDES pour les
# lignes API, volontairement (cf. `_oddsapi_row` dans fetch_data_v4.py) : « le
# prix à 15:25Z du jour du match » n'est pas « la cote d'ouverture » de SBRO,
# publiée la veille ou avant. Les deux repères sont lus ici, chacun à sa place :
#
#   • OUVERTURE API = le PREMIER snapshot du match dans odds_snapshots_hist.csv,
#     soit la reconnaissance de 15:25Z (10 h 25 à l'Est), avant toute mise au
#     jeu. C'est le prix auquel on miserait le matin.
#   • CLÔTURE API  = le DERNIER snapshot strictement avant `commence_time`.
#
# Deux conséquences qu'il faut garder en tête en lisant les chiffres :
#
# 1. Le CLV API mesure ~8 h de mouvement (médiane), pas les jours qui séparent
#    une ouverture SBRO de sa clôture. Il est mécaniquement plus PETIT ; les
#    deux sources ne se comparent pas entre elles, seulement chacune à son
#    propre placebo. D'où les résultats séparés par source, sans exception.
# 2. Le regroupement des clôtures (`--odds-api-close-window 60`) prend la
#    « clôture » d'un match jusqu'à ~68 min avant sa mise au jeu. Un match
#    dont le dernier snapshot est plus ancien que CLOSE_MAX_LEAD_MIN n'a pas
#    de clôture digne de ce nom : il est écarté du CLV et COMPTÉ, pas avalé.

SNAPSHOTS = "../data/odds_snapshots_hist.csv"
CLOSE_MAX_LEAD_MIN = 75.0
# Règle A2, figée le 2026-08-08 : jambe qui donne les 1.5 buts, edge >= 0.04.
A2_EDGE = 0.04

SOURCE_DEFINITIONS = {
    "sbro": "ouverture = cote d'ouverture SBRO (veille ou avant) ; "
            "cloture = cote de cloture SBRO",
    "oddsapi": "ouverture = premier snapshot du jour du match (15:25Z) ; "
               "cloture = dernier snapshot avant commence_time, au plus "
               f"{CLOSE_MAX_LEAD_MIN:.0f} min avant",
}


def _devig2(a, b):
    return (1 / a) / (1 / a + 1 / b)


def load_snapshot_pairs(path: str = SNAPSHOTS) -> tuple[dict, dict]:
    """(index {(date, dom, ext): [paires]}, compteurs) depuis la série horodatée.

    Une paire = ouverture et clôture d'UN livre pour UN match, séparément pour
    le moneyline et la puck line (un snapshot peut n'avoir que le h2h).
    """
    stats = {"file": path.split("/")[-1], "games": 0, "ml_pairs": 0,
             "pl_pairs": 0, "single_snapshot": 0, "close_too_early": 0}
    if not os.path.exists(path):
        return {}, stats
    s = pd.read_csv(path)
    if s.empty:
        return {}, stats
    s["_obs"] = pd.to_datetime(s["observed_at"], utc=True)
    s["_ct"] = pd.to_datetime(s["commence_time"], utc=True)
    # Défense : rien après la mise au jeu (le collecteur le garantit déjà).
    s = s[s["_obs"] < s["_ct"]].sort_values("_obs")

    def lead(row):
        return (row["_ct"] - row["_obs"]).total_seconds() / 60

    idx: dict = {}
    for (date, home, away, src), g in s.groupby(
            ["game_date", "home_team", "away_team", "source"], sort=False):
        stats["games"] += 1
        pair = {"source": str(src), "date": str(date)}

        ml = g.dropna(subset=["home_ml", "away_ml"])
        ml = ml[(ml["home_ml"] > 1) & (ml["away_ml"] > 1)]
        if len(ml) < 2:
            stats["single_snapshot"] += 1
        elif lead(ml.iloc[-1]) > CLOSE_MAX_LEAD_MIN:
            stats["close_too_early"] += 1
        else:
            o, c = ml.iloc[0], ml.iloc[-1]
            pair.update({"open_at": o["observed_at"], "close_at": c["observed_at"],
                         "open_lead_min": lead(o), "close_lead_min": lead(c),
                         "home_ml_open": float(o["home_ml"]),
                         "away_ml_open": float(o["away_ml"]),
                         "home_ml_close": float(c["home_ml"]),
                         "away_ml_close": float(c["away_ml"])})
            stats["ml_pairs"] += 1

        pl = g.dropna(subset=["puck_line_home", "pl_home_price", "pl_away_price"])
        pl = pl[(pl["pl_home_price"] > 1) & (pl["pl_away_price"] > 1)]
        if len(pl) >= 2 and lead(pl.iloc[-1]) <= CLOSE_MAX_LEAD_MIN:
            o, c = pl.iloc[0], pl.iloc[-1]
            pair.update({"pl_line_open": float(o["puck_line_home"]),
                         "pl_line_close": float(c["puck_line_home"]),
                         "pl_home_open": float(o["pl_home_price"]),
                         "pl_away_open": float(o["pl_away_price"]),
                         "pl_home_close": float(c["pl_home_price"]),
                         "pl_away_close": float(c["pl_away_price"])})
            stats["pl_pairs"] += 1

        if "home_ml_open" in pair or "pl_line_open" in pair:
            idx.setdefault((str(date), str(home), str(away)), []).append(pair)
    return idx, stats


def _net_z(c, pl) -> float | None:
    """z du CLV net : (CLV réel − placebo) / √(se_réel² + sd_placebo²).

    Les deux incertitudes comptent : l'erreur-type de la moyenne réelle, et la
    dispersion du placebo entre tirages. Ne comparer qu'à la seconde (très
    petite sur des milliers de paris) déclarerait « significatif » à peu près
    n'importe quel écart — c'est ce qui aurait fait passer les totaux, clos
    par A3, pour une compétence.
    """
    if not c or not pl or not np.isfinite(c["se"]):
        return None
    den = float(np.hypot(c["se"], pl["sd"]))
    return (c["mean"] - pl["mean"]) / den if den > 0 else None


def _placebo_verdict(z) -> str:
    """Lecture du CLV net d'une règle. Neutre : pas de seuil ajusté après coup."""
    if z is None:
        return "placebo non calculable (effectif insuffisant)"
    if z < 2:
        return (f"CLV net z = {z:+.2f} : indistinguable du mecanisme de "
                f"selection (regression vers la moyenne)")
    return (f"CLV net z = {z:+.2f} : au-dessus du placebo — a lire avec le "
            f"ROI que la cloture attribue a ces paris")


def _clv_block(sel, sel_all, leg: str | None = None) -> dict:
    """ROI à l'ouverture, CLV, placebo et ROI implicite de la clôture d'une
    sélection — tous calculés sur le MÊME sous-ensemble."""
    live = [b for b in sel if not b["push"]]
    roi, se, z = bet_stats(sel)
    hit = np.mean([b["won"] for b in live]) * 100 if live else float("nan")
    clv = np.array([b["clv"] for b in sel if b["clv"] is not None], dtype=float)
    c = _clv_stats(clv) if len(clv) > 1 else None
    # Le placebo tourne sur le MÊME effectif : c'est ce qui rend la
    # comparaison licite (cf. le commentaire de `_clv_placebo`).
    pl = _clv_placebo(sel_all, len(clv), leg=leg) if c else None
    net = (c["mean"] - pl["mean"]) if (c and pl) else None
    net_z = _net_z(c, pl)
    # ── Ce que la CLÔTURE dit de ces paris exacts ────────────────────────
    #
    # P1 a établi que la cote de clôture dévigée est le meilleur estimateur
    # disponible. On lui demande donc ce que valaient ces paris :
    # `p_clôture × cote_ouverture − 1`. Si le réalisé s'en écarte de plusieurs
    # σ, ces paris ont « battu la clôture elle-même » — plus probablement de
    # la chance. Comparaison sur ceux dont le CLV est défini.
    with_clv = [b for b in sel if b["clv"] is not None]
    exp_roi = gap = gap_se = None
    if len(with_clv) > 1:
        p_close = np.array([(b["p"] - b["edge"]) + b["clv"] for b in with_clv],
                           dtype=float)
        dec_a = np.array([b["dec"] for b in with_clv], dtype=float)
        exp_roi = float(np.mean(p_close * dec_a - 1)) * 100
        real = bet_returns(with_clv) * 100
        gap = float(real.mean()) - exp_roi
        gap_se = float(real.std(ddof=1) / np.sqrt(len(real)))

    def r6(d):
        return {k: (round(v, 6) if isinstance(v, float) else v)
                for k, v in d.items()} if d else None

    return {"n_bets": len(sel), "n_push": len(sel) - len(live),
            "hit_rate": round(float(hit), 2),
            "roi_open_pct": round(float(roi), 2),
            "roi_se_pct": round(float(se), 2), "z": round(float(z), 2),
            "clv": r6(c), "clv_placebo": r6(pl),
            "clv_net": round(net, 6) if net is not None else None,
            "clv_net_z": round(net_z, 2) if net_z is not None else None,
            "roi_implied_by_close_pct": (round(exp_roi, 2)
                                         if exp_roi is not None else None),
            "gap_vs_close_sigma": (round(gap / gap_se, 2) if gap_se else None)}


def _print_clv_row(label: str, r: dict) -> None:
    net, exp_roi, g = r["clv_net"], r["roi_implied_by_close_pct"], r["gap_vs_close_sigma"]
    print(f"   {label:>6} {r['n_bets']:>7} {r['hit_rate']:>6.1f}% "
          f"{r['roi_open_pct']:>9.2f}% {r['z']:>6.2f} "
          + (f"{net:>+9.4f} " if net is not None else f"{'—':>9} ")
          + (f"{exp_roi:>+9.2f}% " if exp_roi is not None else f"{'—':>10} ")
          + (f"{g:>+7.2f} sig" if g is not None else f"{'—':>8}"))


def run_clv(df, test_seasons, edge_threshold: float, search_trials: int = 0,
            use_cache: bool = True, snaps: dict | None = None,
            snap_stats: dict | None = None):
    feats = TS.stacked_features()
    params = base_score_params(search_trials)
    snaps = snaps or {}

    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    has_sbro_open = "market_home_p_open" in df.columns
    if not has_sbro_open and not snaps:
        print("ERREUR : ni ouverture SBRO dans le dataset, ni série horodatée API.")
        print("   -> python fetch_data_v4.py --only odds --from-local")
        print("     puis python build_dataset.py")
        return None

    bets = []
    n_line_moved = 0          # totaux écartés du CLV : la ligne a bougé
    pl_line_moved: dict = {}  # idem puck line, par source
    n_snap_used = 0           # paires API effectivement appariées au dataset

    def ok(*xs):
        return all(x is not None and np.isfinite(x) for x in xs)

    print(f"   {'saison':>8} {'matchs':>7}  paris par source et marche")
    for s in test_seasons:
        train_df = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        test_df = df[(df["season"] == s)].dropna(subset=need).reset_index(drop=True)
        if len(test_df) < 50 or len(train_df) < 800:
            continue
        main_m, _, tau, p_ot = fit_score_fold(
            train_df, feats, params, 0,
            search_trials=search_trials, season=s, use_cache=use_cache)
        s_te = TS.stack(test_df)
        lam_h, lam_a = TS.lambdas_for(main_m, feats, s_te, len(test_df))

        counts: dict = {}
        for j in range(len(test_df)):
            r = test_df.iloc[j]
            d = ScoreDistribution(lam_h[j], lam_a[j], p_ot, tau)
            total = float(r["total_goals"])
            margin = float(r["home_score"]) - float(r["away_score"])
            home_won = margin > 0
            src_row = r.get("source")
            src_row = src_row if isinstance(src_row, str) else "sbro"

            def add_side_pair(market, src, gid, legs):
                for leg in legs:
                    bets.append({"market": market, "source": src,
                                 "season": s, "date": r["date"],
                                 "game_id": gid, **leg})
                counts[(src, market)] = counts.get((src, market), 0) + 1

            # ── Moneyline SBRO ──────────────────────────────────────────────
            # Pas de ligne, donc pas de piège de mouvement : ouverture et
            # clôture décrivent toujours le même pari.
            if has_sbro_open:
                p_open = r.get("market_home_p_open")
                p_close = r.get("market_home_p_close")
                ho, ao = r.get("home_ml_open"), r.get("away_ml_open")
                if ok(p_open, p_close, ho, ao) and ho > 1 and ao > 1:
                    p_home = d.p_home_win()
                    add_side_pair("moneyline", src_row, f"{s}|{src_row}|ml|{j}", [
                        {"side": side, "p": p, "dec": dec, "edge": p - p_o,
                         "won": bool(won), "push": False,
                         # CLV en points de probabilité : le marché a-t-il
                         # bougé VERS le côté pris ? Positif = acheté moins
                         # cher que la clôture.
                         "clv": p_c - p_o, "leg": side,
                         "team": str(r["home_team"] if side == "home"
                                     else r["away_team"]), "line": None}
                        for side, p, dec, p_o, p_c, won in [
                            ("home", p_home, ho, p_open, p_close, home_won),
                            ("away", 1 - p_home, ao, 1 - p_open, 1 - p_close,
                             not home_won)]])

                # ── Totaux SBRO ─────────────────────────────────────────────
                l_open, l_close = r.get("total_open"), r.get("total_close")
                po, pc = r.get("market_over_p_open"), r.get("market_over_p_close")
                oo, uo = r.get("total_open_over"), r.get("total_open_under")
                if ok(l_open, l_close, po, pc, oo, uo) and oo > 1 and uo > 1:
                    # Le CLV n'a de sens que si la ligne n'a pas bougé : sinon
                    # ouverture et clôture ne sont pas le même pari.
                    same_line = abs(float(l_open) - float(l_close)) < 1e-9
                    if not same_line:
                        n_line_moved += 1
                    p_over = d.p_over(float(l_open))
                    push = abs(total - float(l_open)) < 1e-9
                    add_side_pair("total", src_row, f"{s}|{src_row}|tot|{j}", [
                        {"side": side, "p": p, "dec": dec, "edge": p - p_o,
                         "won": bool(won), "push": push,
                         "clv": (p_c - p_o) if same_line else None,
                         "leg": side, "team": None, "line": float(l_open)}
                        for side, p, dec, p_o, p_c, won in [
                            ("over", p_over, oo, po, pc, total > l_open),
                            ("under", 1 - p_over, uo, 1 - po, 1 - pc,
                             total < l_open)]])

            # ── Lignes API : paires lues dans la série horodatée ────────────
            # Les totaux n'y figurent pas : marché clos (CLV sous son propre
            # placebo, A3), le backfill ne les achète plus.
            for sp in snaps.get((str(r["date"]), str(r["home_team"]),
                                 str(r["away_team"])), []):
                src = sp["source"]
                n_snap_used += 1
                if "home_ml_open" in sp:
                    ho, ao = sp["home_ml_open"], sp["away_ml_open"]
                    p_open = _devig2(ho, ao)
                    p_close = _devig2(sp["home_ml_close"], sp["away_ml_close"])
                    p_home = d.p_home_win()
                    add_side_pair("moneyline", src, f"{s}|{src}|ml|{j}", [
                        {"side": side, "p": p, "dec": dec, "edge": p - p_o,
                         "won": bool(won), "push": False, "clv": p_c - p_o,
                         "leg": side,
                         "team": str(r["home_team"] if side == "home"
                                     else r["away_team"]), "line": None}
                        for side, p, dec, p_o, p_c, won in [
                            ("home", p_home, ho, p_open, p_close, home_won),
                            ("away", 1 - p_home, ao, 1 - p_open, 1 - p_close,
                             not home_won)]])

                # ── Puck line API : enfin une PAIRE ouverture/clôture ───────
                # Même règlement que `run_derived` : `pl` = handicap du
                # DOMICILE, −1.5 s'il est favori, +1.5 sinon. Le CLV exige la
                # même ligne aux deux instants (le favori peut s'inverser).
                if "pl_line_open" in sp:
                    pl_o, pl_c = sp["pl_line_open"], sp["pl_line_close"]
                    hp, ap_ = sp["pl_home_open"], sp["pl_away_open"]
                    same_line = abs(pl_o - pl_c) < 1e-9
                    if not same_line:
                        pl_line_moved[src] = pl_line_moved.get(src, 0) + 1
                    p_home = (d.p_home_cover_minus_15() if pl_o < 0
                              else d.p_home_cover_plus_15())
                    won_home = (margin >= 2) if pl_o < 0 else (margin >= -1)
                    p_mo = _devig2(hp, ap_)
                    p_mc = (_devig2(sp["pl_home_close"], sp["pl_away_close"])
                            if same_line else None)
                    legs = []
                    for side, p, dec, p_o, won in [
                            ("home", p_home, hp, p_mo, won_home),
                            ("away", 1 - p_home, ap_, 1 - p_mo, not won_home)]:
                        gives = (pl_o < 0) if side == "home" else (pl_o > 0)
                        p_c = (p_mc if side == "home" else 1 - p_mc) \
                            if p_mc is not None else None
                        legs.append({
                            "side": side, "p": p, "dec": dec, "edge": p - p_o,
                            "won": bool(won), "push": False,
                            "clv": (p_c - p_o) if p_c is not None else None,
                            "leg": "-1.5" if gives else "+1.5",
                            # Référence du placebo : la jambe qui DONNE les
                            # 1.5 buts (cf. `_clv_placebo`).
                            "ref": bool(gives),
                            "team": str(r["home_team"] if side == "home"
                                        else r["away_team"]),
                            "line": float(pl_o)})
                    add_side_pair("puckline", src, f"{s}|{src}|pl|{j}", legs)

        txt = "  ".join(f"{m}[{src}] {n}" for (src, m), n in sorted(counts.items()))
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(test_df):>7}  {txt}")

    if not bets:
        print("ERREUR : aucun pari généré — vérifie la couverture des ouvertures.")
        return None

    if snap_stats:
        n_idx = sum(len(v) for v in snaps.values())
        print(f"\n   Série horodatée : {snap_stats['games']} matchs, "
              f"{snap_stats['ml_pairs']} paires moneyline, "
              f"{snap_stats['pl_pairs']} paires puck line")
        print(f"   écartés : {snap_stats['single_snapshot']} à snapshot unique, "
              f"{snap_stats['close_too_early']} dont la clôture précède la mise "
              f"au jeu de plus de {CLOSE_MAX_LEAD_MIN:.0f} min")
        print(f"   {n_snap_used} des {n_idx} paires retrouvées dans les saisons "
              f"testées (le reste : séries, matchs filtrés < MIN_GP, ou saison "
              f"hors test)")
    if n_line_moved:
        print(f"\n   {n_line_moved} matchs SBRO dont la LIGNE de total a bougé "
              f"entre ouverture et clôture :\n   leur ROI est comptabilisé, leur "
              f"CLV ne l'est pas (ce ne serait pas le même pari).")
    for src, n in sorted(pl_line_moved.items()):
        print(f"   {n} matchs [{src}] dont la ligne de PUCK LINE s'est inversée "
              f"entre ouverture et clôture : ROI compté, CLV non.")

    out = {"edge_threshold": edge_threshold,
           "definitions": SOURCE_DEFINITIONS,
           "close_max_lead_min": CLOSE_MAX_LEAD_MIN,
           "snapshots": snap_stats,
           "totals_line_moved": n_line_moved,
           "puckline_line_moved": pl_line_moved,
           "puckline_sbro": "CLV non mesurable sur SBRO — un seul prix de puck "
                            "line par match. Mesure sur les sources API.",
           "by_source": {}}

    sources = sorted({b["source"] for b in bets})
    for src in sources:
        res = {"n_bets_possible": {}, "markets": {}}
        kind = "oddsapi" if src.startswith("oddsapi") else "sbro"
        print(f"\n   == SOURCE {src} — {SOURCE_DEFINITIONS[kind]} ==")
        for market in ("moneyline", "total", "puckline"):
            sel_all = [b for b in bets if b["source"] == src
                       and b["market"] == market]
            if not sel_all:
                continue
            res["n_bets_possible"][market] = len(sel_all)
            print(f"\n   -- {market.upper()} [{src}] — {len(sel_all)} paris "
                  f"possibles à l'ouverture --")
            print(f"   {'edge>':>6} {'paris':>7} {'hit%':>7} {'ROI ouv.':>10} "
                  f"{'z':>6} {'CLV net':>9} {'ROI clôt.':>10} {'écart':>8}")
            rows = []
            for edge in [0.01, 0.02, 0.03, 0.04, 0.05]:
                sel = [b for b in sel_all if b["edge"] >= edge]
                if len(sel) < 30:
                    continue
                row = {"edge": edge, **_clv_block(sel, sel_all)}
                rows.append(row)
                _print_clv_row(f"{edge:.0%}", row)
            res["markets"][market] = rows

            # Pas de verdict automatique ici : le placebo et le z du CLV net
            # sont imprimés, la lecture reste humaine. Les totaux en sont la
            # raison — leur CLV net positif a été jugé artefactuel par A3
            # (marché clos) ; une règle mécanique rouvrirait le dossier.
            if rows:
                print(f"   {'':>6} placebo : "
                      + "  ".join(f"{r['edge']:.0%} {r['clv_placebo']['mean']:+.4f}"
                                  f" (z net {r['clv_net_z']:+.1f})"
                                  for r in rows if r.get("clv_placebo")
                                  and r.get("clv_net_z") is not None))
            if market == "total":
                print("   Totaux : marché CLOS (A3, 2026-08-23) — affichés pour "
                      "mémoire, pas à rejuger.")

            # ── Le ROI à l'ouverture positif : réel ou bruit concentré ? ────
            # Même traitement qu'A2 : un ROI positif obtenu sur le MEILLEUR de
            # cinq seuils n'est pas un résultat tant qu'il n'est pas réparti
            # dans le temps, à travers les cotes, les équipes, et qu'il ne
            # tient pas à quelques gains.
            best_roi = max(rows, key=lambda r: r["roi_open_pct"]) if rows else None
            if best_roi and best_roi["roi_open_pct"] > 0:
                thr = best_roi["edge"]
                sub = [b for b in sel_all if b["edge"] >= thr]
                print(f"\n   -- Dissection du ROI à l'ouverture [{src}], "
                      f"{market}, edge >= {thr:.0%} ({len(sub)} paris) --")
                print("   Rappel : ce seuil est le MEILLEUR de cinq testés.")
                res["markets"][market + "_dissection"] = dissect(
                    sub, bet_stats, label=f"{market}@open[{src}]",
                    profit_share=1.0, n_parent=len(sel_all))

        # ── La règle A2, telle qu'elle a été figée — jugée en CLV ───────────
        #
        # Jambe qui DONNE les 1.5 buts, edge ≥ 0.04, mise à plat. Pré-
        # enregistrée le 2026-08-08 : on ne la retouche pas ici, on la mesure.
        # ~51 paris par saison ne concluront jamais sur un ROI ; le CLV, si.
        pl_all = [b for b in bets if b["source"] == src and b["market"] == "puckline"]
        a2 = [b for b in pl_all if b["leg"] == "-1.5" and b["edge"] >= A2_EDGE]
        if len(a2) >= 10:
            blk = _clv_block(a2, pl_all, leg="-1.5")
            by_season = []
            for sea in sorted({b["season"] for b in a2}):
                ss = [b for b in a2 if b["season"] == sea]
                cs = [b["clv"] for b in ss if b["clv"] is not None]
                r_s, _, _ = bet_stats(ss)
                by_season.append({"season": int(sea), "n": len(ss),
                                  "roi_open_pct": round(float(r_s), 2),
                                  "clv_mean": (round(float(np.mean(cs)), 6)
                                               if cs else None)})
            res["a2_rule"] = {"leg": "-1.5", "edge_min": A2_EDGE, **blk,
                              "by_season": by_season,
                              "verdict": _placebo_verdict(blk["clv_net_z"])}
            c = blk["clv"]
            print(f"\n   -- Règle A2 [{src}] — jambe -1.5, edge >= {A2_EDGE:.0%}, "
                  f"{len(a2)} paris --")
            print(f"   ROI à l'ouverture {blk['roi_open_pct']:+.2f} % "
                  f"(± {blk['roi_se_pct']:.2f}, z {blk['z']:+.2f})")
            if c:
                print(f"   CLV brut {c['mean']:+.4f} ± {c['se']:.4f} (t {c['t']:+.2f}, "
                      f"{c['share_positive']:.0%} positifs, n {c['n']})")
            if blk["clv_placebo"]:
                print(f"   placebo (même jambe, même effectif) "
                      f"{blk['clv_placebo']['mean']:+.4f} ± "
                      f"{blk['clv_placebo']['sd']:.4f}")
            print(f"   CLV net {blk['clv_net'] if blk['clv_net'] is not None else '—'}"
                  f" -> {res['a2_rule']['verdict']}")
            if blk["roi_implied_by_close_pct"] is not None:
                print(f"   ROI que la clôture attribue à ces paris : "
                      f"{blk['roi_implied_by_close_pct']:+.2f} % "
                      f"(réalisé à {blk['gap_vs_close_sigma']:+.2f} sig)")
        elif pl_all:
            print(f"\n   Règle A2 [{src}] : {len(a2)} paris seulement — "
                  f"trop peu pour une mesure.")

        # ── Pourquoi le CLV et pas le ROI, mêmes paris, cette source ────────
        ml = [b for b in bets if b["source"] == src and b["market"] == "moneyline"
              and b["edge"] >= edge_threshold and b["clv"] is not None]
        if len(ml) > 30:
            ret = np.array([(b["dec"] - 1) if b["won"] else -1.0 for b in ml])
            clv = np.array([b["clv"] for b in ml], dtype=float)
            r_eff, c_eff = 0.02, 0.005      # effets de référence, déclarés ici
            n_roi = (2 * ret.std(ddof=1) / r_eff) ** 2
            n_clv = (2 * clv.std(ddof=1) / c_eff) ** 2
            print(f"\n   Convergence [{src}] ({len(ml)} paris moneyline, edge >= "
                  f"{edge_threshold:.0%}) : ET rendement {ret.std(ddof=1):.4f}, "
                  f"ET CLV {clv.std(ddof=1):.4f}\n   -> ~{n_roi:,.0f} paris pour "
                  f"{r_eff:.0%} de ROI contre ~{n_clv:,.0f} pour {c_eff:.1%} de "
                  f"CLV (rapport {n_roi / n_clv:,.0f}×)")
            res["convergence"] = {
                "n_bets": len(ml), "sd_return": float(ret.std(ddof=1)),
                "sd_clv": float(clv.std(ddof=1)),
                "roi_effect_ref": r_eff, "clv_effect_ref": c_eff,
                "n_needed_roi": float(n_roi), "n_needed_clv": float(n_clv)}
        out["by_source"][src] = res

    print("\n   Lecture. Chaque source se lit contre SON placebo et jamais contre "
          "l'autre :\n   l'ouverture SBRO précède la clôture de plusieurs jours, "
          "celle de l'API de ~8 h.\n   Un CLV API plus petit que le CLV SBRO est "
          "attendu et ne dit rien du modèle.")
    return out


# ── A5 — élagage des features du modèle de score ─────────────────────────────
#
# Incohérence que ce mode corrige : P5 a élagué le CLASSIFIEUR (117 → 13) et
# mesuré que l'excès de features coûtait 0.00245 de log-loss en variance pure.
# Le MODÈLE DE SCORE n'a jamais subi le même traitement — il garde 13 colonnes
# d'attaque et 7 de défense qu'aucune mesure n'a confrontées à leur propre bruit.
#
# Méthode, identique à P5 : ablation « laisser-une-de-côté », gain par saison,
# on garde ce qui est positif sur au moins 70 % des saisons.

ABLATION_CACHE = f"{MODELS}/score_ablation_cache.json"
SELECTION_REPORT = f"{MODELS}/score_feature_selection.json"
CONFIRMATION_REPORT = f"{MODELS}/score_feature_confirmation.json"

# ── Métrique de sélection, déclarée AVANT de regarder quoi que ce soit ───────
#
# **Log-loss de la puck line**, sur les deux jambes du marché :
#
#     jambe dom : y = 1{écart final ≥ +2},  p = P(dom couvre −1.5)
#     jambe ext : y = 1{écart final ≤ −2},  p = P(ext couvre −1.5)
#
# Un match qui va en prolongation se règle toujours à un but d'écart : l'écart
# final vaut donc ±2 ou plus exactement quand l'écart RÉGLEMENTAIRE le vaut, ce
# qui rend la cible et la matrice du modèle cohérentes sans traitement spécial.
#
# Pourquoi celle-là plutôt que la déviance de Poisson. La puck line est la seule
# piste vivante du projet (A2) ; élaguer le moteur de prix sur une métrique qui
# ne la price pas serait optimiser pour un usage qu'on n'a pas. Le mécanisme
# invoqué en A2 — la distribution des écarts est *dentelée* au seuil de 2 buts —
# est précisément ce que cette log-loss mesure.
#
# Ce qu'on paie, et il faut le savoir avant : la cible est BEAUCOUP plus bruitée
# que la déviance. Deux événements binaires par match au lieu de deux comptes de
# buts. Moins de puissance, donc plus de features qui atterriront près de 50 %
# sans qu'on puisse les départager. Le tableau dira « je ne sais pas » plus
# souvent — c'est le prix de la pertinence, pas un défaut de la mesure.
#
# **τ est ajusté PAR VARIANTE**, sur le train du fold. La correction de marge
# est exactement une correction de la distribution des écarts (P2 : le Poisson
# brut sous-estime les nuls de 6 points, avec excès sur 0 et ±3 et déficit sur
# ±1 et ±2). Mesurer une log-loss de puck line sans τ mesurerait ce biais-là
# plutôt que la feature.
#
# La déviance de Poisson et la log-loss moneyline restent AFFICHÉES en regard.
# Elles ne sélectionnent rien : avoir plusieurs critères et retenir après coup
# celui qui donne le plus joli tableau, c'est le biais de sélection que P4 a
# mesuré. Elles servent à repérer un désaccord, pas à trancher.

# `is_home` porte le décalage domicile/extérieur sur lequel tout l'empilement
# repose : les deux lignes d'un match ne diffèrent que par lui, par l'orientation
# atk/def et par le signe de `elo_atk_minus_def`. On le mesure pour vérifier
# qu'il ressort — s'il ressortait RETIRER, ce serait une preuve que l'instrument
# est cassé, pas une information sur la feature.
#
# `elo_atk_minus_def` reste délibérément TESTABLE : c'est le seul signal de
# force d'équipe croisée, mais les colonnes xG glissantes en portent aussi. S'il
# ressort RETIRER, l'information est réelle et exploitable (l'xG glissant
# subsumerait l'ELO), pas symptomatique d'un bug. Un vrai candidat, pas un pilier.
STRUCTURAL_FEATS = {"is_home"}

# ── Sentinelles — l'étalonnage empirique du bruit ────────────────────────────
#
# Colonnes de bruit pur injectées dans le jeu de features et soumises exactement
# à la même ablation que les vraies. Elles ne mesurent pas une feature : elles
# mesurent **la procédure**. Tout ce qu'une feature sans information peut
# décrocher — biais des hyperparamètres, non-déterminisme de XGBoost, hasard du
# découpage — se retrouve dans leur score.
#
# C'est ce qui répond à « comment renforcer un verdict GARDER » : plutôt que
# d'argumenter sur l'ampleur du biais, on le fait courir dans le tuyau et on
# regarde ce qu'il produit. Une vraie feature doit battre la meilleure
# sentinelle, sinon son GARDER ne vaut rien.
SENTINEL_PREFIX = "sentinel_"


def _sentinel_names(n: int) -> list[str]:
    return [f"{SENTINEL_PREFIX}{i}" for i in range(n)]


def _stable_seed(*parts) -> int:
    """Graine reproductible entre exécutions — `hash()` ne l'est pas (PYTHONHASHSEED)."""
    h = hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()[:8]
    return int(h, 16)


def _prepare(stacked: pd.DataFrame, season, n_sentinels: int,
             permute: str | None) -> pd.DataFrame:
    """Ajoute les sentinelles, puis détruit l'information d'une colonne.

    **L'ablation permute la colonne au lieu de la supprimer**, et c'est le
    correctif de fond au biais des hyperparamètres. En supprimant, la variante
    tournait avec une colonne de moins que celle sur laquelle les paramètres ont
    été choisis : elle partait handicapée par la dimension, pas seulement privée
    de l'information. Le gain s'en trouvait gonflé, donc les verdicts GARDER
    trop faciles — exactement ce qu'on voulait durcir.

    En permutant, la variante garde le MÊME nombre de colonnes, la même
    structure, la même adéquation aux hyperparamètres. Seule l'information de la
    colonne disparaît. Le contraste redevient propre.

    Le vrai test de suppression n'est pas perdu pour autant : il reste l'étape de
    contrôle finale, `--confirm-score-features`, qui réentraîne sans les
    « RETIRER » et vérifie que la métrique ne se dégrade pas. Classement par
    permutation, confirmation par suppression.
    """
    out = stacked.copy()
    rng = np.random.default_rng(_stable_seed("sentinel", season, len(out)))
    for c in _sentinel_names(n_sentinels):
        out[c] = rng.normal(size=len(out))
    if permute is not None and permute in out.columns:
        prng = np.random.default_rng(_stable_seed("permute", season, permute, len(out)))
        out[permute] = prng.permutation(out[permute].to_numpy())
    return out


def _puckline_log_loss(dists, margin: np.ndarray) -> float:
    """Log-loss moyenne sur les DEUX jambes de la puck line.

    Ne mesurer que la jambe domicile laisserait une feature qui n'aide que sur
    les favoris à domicile passer pour utile sur tout le marché.
    """
    p_home_cov = np.array([d.p_home_cover_minus_15() for d in dists])
    # P(ext couvre −1.5) = P(écart ≤ −2) = 1 − P(écart ≥ −1)
    p_away_cov = 1.0 - np.array([d.p_home_cover_plus_15() for d in dists])
    y_home = (margin >= 2).astype(float)
    y_away = (margin <= -2).astype(float)
    p = np.clip(np.concatenate([p_home_cov, p_away_cov]), 1e-6, 1 - 1e-6)
    return T.log_loss_np(np.concatenate([y_home, y_away]), p)


def _season_scores(train_df, test_df, feats, params, season,
                   n_sentinels: int, permute: str | None) -> dict:
    """Métriques hors échantillon d'une variante sur une saison.

    `ll_puckline` sélectionne ; `deviance` et `ll_moneyline` sont indicatives.
    Même découpage que `fit_score_fold` (85 % / 15 % pour l'arrêt précoce), pour
    que les chiffres restent comparables aux autres modes.
    """
    def prep(d):
        return _prepare(TS.stack(d.reset_index(drop=True)), season,
                        n_sentinels, permute)

    cut = int(len(train_df) * 0.85)
    s_tr = prep(train_df.iloc[:cut])
    s_cal = prep(train_df.iloc[cut:])
    m = xgb.train(params, TS.dm(s_tr, feats), num_boost_round=700,
                  evals=[(TS.dm(s_cal, feats), "cal")],
                  early_stopping_rounds=40, verbose_eval=False)

    # τ ajusté sur le train du fold, JAMAIS sur la saison testée, et refait pour
    # chaque variante : il découle des λ du modèle, donc il en fait partie.
    s_full = prep(train_df)
    lam_h_tr, lam_a_tr = TS.lambdas_for(m, feats, s_full, len(train_df))
    tau = fit_margin_correction(
        (train_df["home_reg_score"] - train_df["away_reg_score"]).to_numpy(),
        TS.expected_margin_pmf(lam_h_tr, lam_a_tr))

    s_te = prep(test_df)
    mu = m.predict(TS.dm(s_te, feats, with_label=False))
    dev = TS.poisson_deviance(s_te["y"].to_numpy(dtype=float), mu)

    # On repasse par `_row`/`_side` plutôt que de trancher le vecteur en deux :
    # l'ordre d'empilement est une convention de `stack()`, pas un contrat.
    n = len(test_df)
    lam_h, lam_a = np.full(n, np.nan), np.full(n, np.nan)
    rows, sides = s_te["_row"].to_numpy(), s_te["_side"].to_numpy()
    lam_h[rows[sides == "home"]] = mu[sides == "home"]
    lam_a[rows[sides == "away"]] = mu[sides == "away"]
    dists = [ScoreDistribution(h, a, tau=tau) for h, a in zip(lam_h, lam_a)]

    margin = (test_df["home_score"] - test_df["away_score"]).to_numpy(dtype=float)
    return {
        "ll_puckline": _puckline_log_loss(dists, margin),
        "deviance": dev,
        "ll_moneyline": T.log_loss_np(
            test_df["home_win"].to_numpy(dtype=float),
            np.clip(np.array([d.p_home_win() for d in dists]), 1e-6, 1 - 1e-6)),
    }


def _ablation_cache_key(season, train_df, feats, permuted, n_sentinels) -> str:
    h = hashlib.md5(",".join(feats).encode()).hexdigest()[:8]
    return (f"{season}|{len(train_df)}|{train_df['date'].iloc[-1]}"
            f"|perm:{permuted}|sent:{n_sentinels}|{h}|v2")


def run_score_feature_ablation(df, test_seasons, search_trials: int,
                               use_cache: bool = True, keep_share: float = 0.70,
                               n_sentinels: int = 3):
    """Ablation par permutation des features empilées, saison par saison.

    Pour chaque saison testée et chaque feature `f` :

        gain(f, saison) = ll_puckline(f permutée) − ll_puckline(tout intact)

    Un gain **positif** signifie que détruire l'information de `f` dégrade le
    prix de la puck line, donc que `f` sert. On garde `f` si son gain est positif
    sur au moins `keep_share` des saisons **et** si elle bat la meilleure
    sentinelle.

    Les hyperparamètres sont cherchés une seule fois par saison, sur le jeu
    complet, puis réutilisés pour toutes les variantes. Relancer la recherche à
    chaque ablation mélangerait le bruit du tirage à l'effet de la feature, et
    les deux seraient indiscernables. Le biais que cela introduisait — variantes
    amputées jugées avec des réglages taillés pour un jeu plus large — est traité
    en amont : les variantes gardent toutes leurs colonnes (cf. `_prepare`), et
    ce qu'il en reste se lit dans les sentinelles.
    """
    from math import comb

    real_feats = TS.stacked_features()
    sentinels = _sentinel_names(n_sentinels)
    feats = real_feats + sentinels
    candidates = [f for f in real_feats if f not in STRUCTURAL_FEATS]

    base_params = base_score_params(search_trials)
    n_fits = len(test_seasons) * (len(feats) + 1)
    print(f"🔬 A5 — ablation de {len(real_feats)} features "
          f"(+{n_sentinels} sentinelles) sur {len(test_seasons)} saisons")
    print("   Métrique de sélection : log-loss de la puck line, deux jambes, "
          "τ ajusté par variante.")
    print(f"   {n_fits} entraînements. Long. Le cache "
          f"({ABLATION_CACHE.split('/')[-1]}) rend la reprise\n   gratuite après "
          f"interruption.\n")

    cache = {}
    if use_cache:
        try:
            cache = json.load(open(ABLATION_CACHE))
        except Exception:
            cache = {}

    per_season: dict[int, dict] = {}
    for s in test_seasons:
        train_df = df[df["season"] < s]
        test_df = df[df["season"] == s].dropna(
            subset=["home_reg_score", "away_reg_score",
                    "home_score", "away_score"]).copy()
        if len(test_df) < 50:
            continue
        # La recherche d'hyperparamètres tourne sur les features RÉELLES, sans
        # les sentinelles. Deux raisons. D'abord `search_params_fold` empile
        # lui-même avec `TS.stack()`, qui ne connaît évidemment pas des colonnes
        # inventées ici — lui passer `feats` levait un KeyError. Ensuite, régler
        # des hyperparamètres contre des colonnes de bruit n'aurait aucun sens :
        # les sentinelles servent à mesurer ce que la procédure donne pour rien,
        # pas à l'orienter.
        #
        # Les paramètres sont ensuite appliqués à un jeu de 3 colonnes de plus.
        # Le seul réglage sensible à la largeur est `colsample_bytree`, qui est
        # une *fraction* : elle s'adapte d'elle-même. Et surtout, la même valeur
        # sert à toutes les variantes de la saison, y compris la référence —
        # le contraste reste propre, ce qui est la seule chose qui compte ici.
        params = search_params_fold(train_df.iloc[:int(len(train_df) * 0.85)]
                                    .reset_index(drop=True),
                                    real_feats, base_params, search_trials,
                                    seed=42, season=s, use_cache=use_cache)

        def scored(permute: str | None):
            key = _ablation_cache_key(s, train_df, feats, permute or "-", n_sentinels)
            if key in cache:
                return cache[key]
            out = _season_scores(train_df, test_df, feats, params, s,
                                 n_sentinels, permute)
            cache[key] = out
            if use_cache:
                try:
                    json.dump(cache, open(ABLATION_CACHE, "w"), indent=2)
                except Exception:
                    pass
            return out

        ref = scored(None)
        row = {"n_games": len(test_df), "ref": ref, "gains": {}}
        for f in feats:
            without = scored(f)
            row["gains"][f] = {k: without[k] - ref[k] for k in ref}
        per_season[s] = row
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(test_df):>5} matchs · "
              f"ll puck line de référence {ref['ll_puckline']:.5f}")

    if not per_season:
        print("❌ Aucune saison exploitable.")
        return None

    seasons = sorted(per_season)
    n_s = len(seasons)

    def profile(f):
        g = [per_season[s]["gains"][f]["ll_puckline"] for s in seasons]
        n_pos = sum(1 for x in g if x > 0)
        return {
            "feature": f,
            "n_seasons_positive": n_pos,
            "share_positive": round(n_pos / n_s, 4),
            "mean_gain_puckline": round(float(np.mean(g)), 6),
            "median_gain_puckline": round(float(np.median(g)), 6),
            "mean_gain_deviance": round(float(np.mean(
                [per_season[s]["gains"][f]["deviance"] for s in seasons])), 6),
            "mean_gain_ll_moneyline": round(float(np.mean(
                [per_season[s]["gains"][f]["ll_moneyline"] for s in seasons])), 6),
        }

    sent_rows = [profile(f) for f in sentinels]
    sent_bar = max((r["share_positive"] for r in sent_rows), default=0.0)

    summary = []
    for f in real_feats:
        r = profile(f)
        if f in STRUCTURAL_FEATS:
            r["verdict"] = "STRUCTUREL"
        elif r["share_positive"] >= keep_share and r["share_positive"] > sent_bar:
            r["verdict"] = "GARDER"
        elif r["share_positive"] >= keep_share:
            # Franchit le seuil mais pas les sentinelles : le seuil ne prouve rien
            # ici, puisque du bruit pur fait aussi bien.
            r["verdict"] = "SOUS SENTINELLE"
        else:
            r["verdict"] = "RETIRER"
        r["structural"] = f in STRUCTURAL_FEATS
        summary.append(r)
    summary.sort(key=lambda r: (-r["share_positive"], -r["mean_gain_puckline"]))

    print("\n   Gain = ll puck line(feature permutée) − ll puck line(intacte).")
    print("   Positif = détruire l'information dégrade le prix, donc la feature sert.")
    print(f"   Règle : garder si positif sur ≥ {keep_share:.0%} des {n_s} saisons "
          f"ET au-dessus des sentinelles.\n")
    head = (f"   {'feature':<26} {'+/saisons':>10} {'part':>6} "
            f"{'gain moyen':>11} {'gain méd.':>10}  verdict")
    print(head)
    for r in summary:
        print(f"   {r['feature']:<26} {r['n_seasons_positive']:>4}/{n_s:<5} "
              f"{r['share_positive']:>6.0%} {r['mean_gain_puckline']:>11.5f} "
              f"{r['median_gain_puckline']:>10.5f}  {r['verdict']}")

    # ── Étalonnage : ce que le bruit pur obtient dans le MÊME tuyau ─────────
    print(f"\n   Sentinelles (bruit pur, même traitement) — barre à battre : "
          f"{sent_bar:.0%}")
    for r in sorted(sent_rows, key=lambda r: -r["share_positive"]):
        print(f"   {r['feature']:<26} {r['n_seasons_positive']:>4}/{n_s:<5} "
              f"{r['share_positive']:>6.0%} {r['mean_gain_puckline']:>11.5f} "
              f"{r['median_gain_puckline']:>10.5f}")

    # Le centre du nuage de sentinelles est le diagnostic qui compte : c'est lui
    # qui dit si la procédure elle-même est biaisée. Une colonne de bruit ne
    # contient rien, donc son gain doit être positif une fois sur deux. Si la
    # médiane s'écarte franchement de 50 %, l'ablation par permutation n'a pas
    # neutralisé le biais qu'elle visait, et TOUT le tableau au-dessus est à
    # relire avec ce décalage en tête.
    sent_med = float(np.median([r["share_positive"] for r in sent_rows])) \
        if sent_rows else float("nan")
    print(f"   Médiane des sentinelles : {sent_med:.0%} — attendu ≈ 50 % si la "
          f"procédure est neutre.")
    if sent_rows and abs(sent_med - 0.5) > 0.2:
        print("   ⚠️  Écart net à 50 % : la procédure elle-même penche. Les "
              "verdicts ci-dessus\n       héritent de ce biais — ne pas élaguer "
              "avant de comprendre d'où il vient.")
    n_binding = sum(1 for r in sent_rows if r["share_positive"] >= keep_share)
    if n_binding:
        print(f"   {n_binding} sentinelle(s) atteignent le seuil de "
              f"{keep_share:.0%} : la barre est fixée par du bruit,\n   ce qui la "
              f"rend sévère. Des features à {keep_share:.0%} pile sont recalées "
              f"sans que ça les condamne.")
    print(f"   Plus de sentinelles rend la barre MOINS bruitée mais aussi PLUS "
          f"HAUTE (c'est\n   un maximum). `--sentinels 10` coûte "
          f"{n_s * (10 - n_sentinels)} entraînements de plus et durcit le test.")

    # Repère théorique, en complément : il dit ce qu'un tirage à pile ou face
    # produirait, là où les sentinelles disent ce que CETTE procédure produit.
    need = int(np.ceil(keep_share * n_s))
    p_one = sum(comb(n_s, k) for k in range(need, n_s + 1)) / (2 ** n_s)
    expected_false = p_one * len(candidates)
    n_keep = sum(1 for r in summary if r["verdict"] == "GARDER")
    print(f"\n   Repère théorique : une feature sans effet a {p_one:.1%} de "
          f"chances d'atteindre\n   {need}/{n_s} à pile ou face. Sur "
          f"{len(candidates)} candidates (hors structurelles), on attend\n   "
          f"≈ {expected_false:.1f} faux « GARDER ». {n_keep} en décrochent un.")
    if n_keep <= expected_false * 1.5:
        print("   ⚠️  Ce n'est pas distinguable du hasard : le jeu de features "
              "n'est pas\n       départageable avec cet historique. Ne pas "
              "élaguer sur cette base.")

    print("\n   Ce mode NE MODIFIE PAS train_score.py. Les listes ATK_COLS / "
          "DEF_COLS\n   se modifient à la main, après lecture — un élagage "
          "appliqué automatiquement\n   sur un tableau qu'on n'a pas lu est une "
          "sélection sur le bruit.")
    print("   Contrôle après avoir élagué : `--confirm-score-features` "
          "réentraîne en\n   SUPPRIMANT réellement et vérifie que la log-loss "
          "puck line NE MONTE PAS —\n   1 entraînement par saison au lieu de "
          f"{len(feats) + 1}. Le classement se fait par\n   permutation, la "
          "confirmation par suppression.")

    return {
        "method": "ablation par permutation (dimension constante), walk-forward",
        "metric": "log-loss de la puck line, deux jambes, τ ajusté par variante",
        "secondary_metrics_displayed_only": ["deviance", "ll_moneyline"],
        "keep_share": keep_share,
        "sentinel_bar": sent_bar,
        "sentinel_median_share": round(sent_med, 4) if sent_rows else None,
        "seasons": seasons,
        "search_trials_per_fold": search_trials,
        "structural_features": sorted(STRUCTURAL_FEATS),
        "chance_reference": {"p_single_feature": round(p_one, 5),
                             "n_candidates": len(candidates),
                             "expected_false_keeps": round(expected_false, 2),
                             "n_kept": n_keep},
        "sentinels": sent_rows,
        "features": summary,
        "by_season": {str(s): per_season[s] for s in seasons},
    }


# ── A5, étape de confirmation ────────────────────────────────────────────────
#
# « Classement par permutation, confirmation par suppression. » L'ablation
# ci-dessus ne supprime jamais rien : elle permute, pour garder la dimension
# constante et laisser les hyperparamètres adéquats. C'est ce qui rend son
# classement propre, et c'est aussi sa limite — chaque verdict mesure ce
# qu'apporte une feature *les autres présentes*. Deux colonnes corrélées se
# partagent le crédit et sortent faibles toutes les deux, sans que ça prouve
# qu'on puisse les retirer ENSEMBLE.
#
# Ce mode teste exactement ça : le jeu réellement élagué, tel qu'il est écrit
# dans `train_score.ATK_COLS` / `DEF_COLS` à l'instant du run, contre la
# référence par saison enregistrée dans `score_feature_selection.json`.
#
# Trois choix qui font que la comparaison veut dire quelque chose :
#
# 1. **Les sentinelles restent en place**, en même nombre que dans le run de
#    référence. Elles ne portent aucune information ; les garder fait que la
#    SEULE chose qui change entre la référence et la variante est l'information
#    retirée — pas le protocole.
# 2. **Les hyperparamètres sont re-cherchés** pour le jeu élagué (la clé de
#    `fold_params_cache.json` contient le hash des features, donc le cache ne
#    rend pas ceux de l'ancien jeu). Comparer un modèle amputé à des réglages
#    taillés pour 22 colonnes mesurerait l'inadéquation des réglages, pas
#    l'élagage. Chaque variante à son meilleur : c'est la seule comparaison
#    honnête quand la dimension change pour de bon.
# 3. **Le critère est fixé ici, avant le run** (cf. `_confirmation_verdict`).
#
# Coût : une saison = une recherche d'hyperparamètres + un entraînement, contre
# 26 entraînements par saison pour l'ablation complète. Le cache d'ablation est
# réutilisé tel quel — sa clé contient le hash des features, donc la variante ne
# peut pas se confondre avec le run de référence, et un second appel est gratuit.


def _confirmation_verdict(mean_delta: float, n_worse: int, n_seasons: int,
                          noise: float) -> str:
    """Critère de confirmation, déclaré AVANT de regarder le résultat.

    `noise` est la plus grande moyenne de gain décrochée par une sentinelle dans
    le run de référence : l'ordre de grandeur de ce que cette procédure produit
    à partir de rien. Un écart plus petit que ça n'est pas un écart, c'est le
    bruit du tuyau — et un élagage neutre est un élagage réussi, puisqu'il rend
    des colonnes en moins pour la même log-loss.

    Le garde-fou sur `n_worse` empêche qu'une moyenne tirée par une saison
    aberrante fasse passer une dégradation systématique.
    """
    if mean_delta > noise:
        return "DÉGRADE"
    if n_worse > n_seasons / 2 and mean_delta > 0:
        return "DÉGRADE"
    if mean_delta < -noise:
        return "AMÉLIORE"
    return "NEUTRE"


def run_score_feature_confirmation(df, test_seasons, search_trials: int,
                                   use_cache: bool = True,
                                   n_sentinels: int = 3):
    from math import comb

    real_feats = TS.stacked_features()
    feats = real_feats + _sentinel_names(n_sentinels)

    try:
        prev = json.load(open(SELECTION_REPORT))
    except Exception:
        print(f"❌ {SELECTION_REPORT.split('/')[-1]} introuvable ou illisible.")
        print("   → python backtest_walkforward.py --select-score-features")
        return None

    ref_by_season = prev.get("by_season") or {}
    before = [r["feature"] for r in prev.get("features") or []]
    if not ref_by_season or not before:
        print("❌ Rapport de sélection incomplet — pas de référence par saison.")
        return None

    dropped = [f for f in before if f not in real_feats]
    added = [f for f in real_feats if f not in before]
    if not dropped and not added:
        print("ℹ️  Le jeu de features est identique à celui du run de référence.")
        print("   Rien à confirmer : élague d'abord ATK_COLS / DEF_COLS dans "
              "train_score.py.")
        return None

    # Un bruit PAR MÉTRIQUE : la déviance de Poisson vaut ~1.09 et la log-loss
    # ~0.57, donc juger un écart de déviance contre un seuil calibré sur la puck
    # line compare deux échelles différentes et crie au désaccord pour rien.
    ref_sent = prev.get("sentinels") or []

    def _noise(metric_key: str) -> float:
        return max((abs(r.get(metric_key, 0.0)) for r in ref_sent), default=0.0)

    noise = _noise("mean_gain_puckline")
    noise_by_metric = {"deviance": _noise("mean_gain_deviance"),
                       "ll_moneyline": _noise("mean_gain_ll_moneyline")}

    # `n_sentinels` doit valoir celui du run de référence, sinon le protocole
    # change en même temps que les features et la comparaison ne dit plus rien.
    ref_n_sent = sum(1 for r in ref_sent)
    if ref_n_sent != n_sentinels:
        print(f"⚠️  Le run de référence avait {ref_n_sent} sentinelle(s), "
              f"celui-ci en a {n_sentinels}.")
        print("   → relance avec --sentinels "
              f"{ref_n_sent} pour que le protocole soit identique.")

    seasons = [s for s in test_seasons if str(s) in ref_by_season]
    print(f"🔬 A5 — confirmation par SUPPRESSION : {len(before)} features → "
          f"{len(real_feats)}")
    print(f"   Retirées ({len(dropped)}) : {', '.join(dropped)}")
    if added:
        print(f"   ⚠️  Ajoutées ({len(added)}) : {', '.join(added)} — le run de "
              f"référence ne les a jamais vues.")
    print(f"   {len(seasons)} saisons, 1 entraînement chacune (+ recherche "
          f"d'hyperparamètres).")
    print(f"   Bruit de procédure mesuré par les sentinelles : {noise:.5f}.\n")

    cache = {}
    if use_cache:
        try:
            cache = json.load(open(ABLATION_CACHE))
        except Exception:
            cache = {}

    base_params = base_score_params(search_trials)
    rows = []
    for s in seasons:
        train_df = df[df["season"] < s]
        test_df = df[df["season"] == s].dropna(
            subset=["home_reg_score", "away_reg_score",
                    "home_score", "away_score"]).copy()
        if len(test_df) < 50:
            continue

        params = search_params_fold(train_df.iloc[:int(len(train_df) * 0.85)]
                                    .reset_index(drop=True),
                                    real_feats, base_params, search_trials,
                                    seed=42, season=s, use_cache=use_cache)

        key = _ablation_cache_key(s, train_df, feats, "-", n_sentinels)
        if key in cache:
            after = cache[key]
        else:
            after = _season_scores(train_df, test_df, feats, params, s,
                                   n_sentinels, None)
            cache[key] = after
            if use_cache:
                try:
                    json.dump(cache, open(ABLATION_CACHE, "w"), indent=2)
                except Exception:
                    pass

        ref = ref_by_season[str(s)]["ref"]
        rows.append({
            # `int()` explicite : `s` vient de `df["season"].unique()`, donc
            # c'est un numpy.int64, que le module json refuse de sérialiser.
            "season": int(s),
            "n_games": int(len(test_df)),
            "before": {k: ref[k] for k in ref},
            "after": after,
            "delta": {k: after[k] - ref[k] for k in ref if k in after},
        })
        d = rows[-1]["delta"]["ll_puckline"]
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(test_df):>5} matchs · "
              f"{ref['ll_puckline']:.5f} → {after['ll_puckline']:.5f}  "
              f"Δ {d:+.5f}  {'↑ pire' if d > 0 else '↓ mieux'}")

    if not rows:
        print("❌ Aucune saison comparable.")
        return None

    deltas = np.array([r["delta"]["ll_puckline"] for r in rows])
    mean_delta = float(np.mean(deltas))
    n_worse = int((deltas > 0).sum())
    verdict = _confirmation_verdict(mean_delta, n_worse, len(rows), noise)

    # Ce que le critère ne dit pas et qu'il faut lire à côté : la précision de la
    # mesure. Le critère est pré-enregistré et tranche seul — mais un verdict
    # rendu sur un écart plus petit que sa propre barre d'erreur est un verdict
    # « je ne sais pas » déguisé, et le savoir change la suite (élaguer autrement
    # ne servira à rien si la mesure ne peut pas départager).
    se = float(np.std(deltas, ddof=1) / np.sqrt(len(deltas))) if len(deltas) > 1 \
        else float("nan")
    p_signs = (sum(comb(len(rows), k) for k in range(n_worse, len(rows) + 1))
               / (2 ** len(rows)))

    print(f"\n   Δ moyen puck line : {mean_delta:+.5f} "
          f"(médiane {float(np.median(deltas)):+.5f})")
    print(f"   Incertitude : ± {se:.5f} (erreur-type sur {len(rows)} saisons) "
          f"→ t = {mean_delta / se:+.2f}")
    print(f"   Saisons dégradées : {n_worse}/{len(rows)} — du pile ou face en "
          f"produirait autant {p_signs:.0%} du temps")
    print(f"   Bruit de la procédure (max des sentinelles) : ±{noise:.5f}")
    if abs(mean_delta) < se:
        print("   ⚠️  L'écart est plus petit que son erreur-type : cette mesure "
              "ne PEUT PAS\n       départager les deux jeux de features. Le "
              "verdict ci-dessous applique la\n       règle pré-enregistrée, il "
              "ne constate pas un effet établi.")
    print(f"\n   → {verdict}")
    if verdict == "DÉGRADE":
        print("   L'élagage coûte plus que le bruit. Les features retirées "
              "portaient de\n   l'information que l'ablation marginale n'a pas "
              "vue — typiquement un groupe\n   corrélé dont chaque membre "
              "paraissait dispensable. Remets-en une partie et\n   recommence, "
              "par sous-groupes.")
    elif verdict == "NEUTRE":
        print("   Même log-loss avec moins de colonnes : l'élagage est confirmé.")
    else:
        print("   La log-loss BAISSE : les features retirées coûtaient de la "
              "variance.")
    print("\n   Ensuite : `python train_score.py` pour régénérer "
          "score_model.json et\n   score_report.json — ml_service lit la liste "
          "des features dans le rapport,\n   l'élagage s'y propage seul.")

    # Les métriques secondaires n'ont pas décidé de l'élagage et ne décident pas
    # plus de sa confirmation : un désaccord se regarde, il ne renverse rien.
    secondary = {}
    for k in ("deviance", "ll_moneyline"):
        md = float(np.mean([r["delta"][k] for r in rows if k in r["delta"]]))
        nk = noise_by_metric.get(k, 0.0)
        sign = 0 if abs(md) <= nk else (1 if md > 0 else -1)
        ref_sign = 0 if abs(mean_delta) <= noise else (1 if mean_delta > 0 else -1)
        flag = "  ⚠️ désaccord" if sign and ref_sign and sign != ref_sign else ""
        if sign and not ref_sign:
            flag = "  ↳ tranche là où la puck line ne tranche pas"
        secondary[k] = {"mean_delta": round(md, 6), "noise": round(nk, 6),
                        "direction": sign}
        print(f"   ({k} : Δ moyen {md:+.5f} contre un bruit de ±{nk:.5f}, "
              f"indicatif{flag})")

    return {
        "method": "confirmation par suppression réelle, walk-forward",
        "metric": "log-loss de la puck line, deux jambes, τ ajusté par variante",
        "criterion": ("DÉGRADE si Δ moyen > bruit des sentinelles, ou si Δ > 0 "
                      "sur plus de la moitié des saisons avec Δ moyen > 0 ; "
                      "AMÉLIORE si Δ moyen < −bruit ; NEUTRE sinon"),
        "noise_reference": round(noise, 6),
        "features_before": before,
        "features_after": real_feats,
        "dropped": dropped,
        "added": added,
        "n_sentinels": n_sentinels,
        "search_trials_per_fold": search_trials,
        "mean_delta_puckline": round(mean_delta, 6),
        "median_delta_puckline": round(float(np.median(deltas)), 6),
        "stderr_delta_puckline": round(se, 6),
        "resolvable": bool(abs(mean_delta) >= se),
        "sign_test_p": round(p_signs, 4),
        "secondary_metrics_displayed_only": secondary,
        "n_seasons_worse": n_worse,
        "n_seasons": len(rows),
        "verdict": verdict,
        "by_season": rows,
    }


# ── Poids du récent : deux leviers, mesurés séparément (2026-09-27) ──────────
#
# LA DEMANDE : « que le ML prenne plus en considération la saison récente ».
# Deux lectures, toutes deux testées, chacune contre le modèle actuel seul :
#
#   A. LES FEATURES. Les moyennes d'équipe sont des EWMA continus qui ignorent
#      le changement de saison. Variante : elles repartent à chaque saison, la
#      précédente ne valant plus que k matchs d'amorce
#      (`build_dataset._season_prior_ewm`). k ∈ {5, 15}.
#      Hors champ, et pourquoi : le GARDIEN (P3 a mesuré qu'un cumul régressé
#      bat les moyennes récentes — son GSAx à court terme est du bruit) et
#      l'ALIGNEMENT (il suit déjà les joueurs réellement habillés).
#   B. L'APPRENTISSAGE. Chaque saison d'entraînement pèse 0,5^(âge / H), l'âge
#      comptant en saisons depuis la plus récente du fold. H ∈ {4, 8}.
#
# PROTOCOLE, FIXÉ AVANT TOUT RUN — celui d'A5, à ne pas renégocier après coup :
#   • walk-forward, saisons >= --min-season avec >= 800 matchs d'historique ;
#   • mêmes hyperparamètres par fold pour toutes les variantes (cache de
#     `search_params_fold`, choisis sur le modèle actuel : léger avantage au
#     modèle actuel, assumé) ; τ ajusté par variante sur son propre train ;
#   • métrique qui DÉCIDE : log-loss de la puck line, deux jambes, par match ;
#     moneyline et déviance de Poisson affichées, elles ne décident rien ;
#   • ADOPTION si, et seulement si : z apparié <= −RECENCY_Z (2,24 : 5 %
#     bilatéral corrigé de Bonferroni pour 2 variantes par levier) ET gain sur
#     >= 70 % des saisons ET moneyline pas significativement dégradé (z < +2).
#   • Le sous-ensemble « début de saison » (les deux équipes à < 20 matchs de
#     la saison) est affiché : c'est là que A doit agir. Il ne décide rien.

RECENCY_Z = 2.24
RECENCY_SEASON_SHARE = 0.70
RECENCY_EARLY_GAMES = 20
RECENCY_REPORT = f"{MODELS}/recency_report.json"


def _with_team_variant(df: pd.DataFrame, k: float | None) -> pd.DataFrame:
    """Le dataset avec les features d'équipe roulantes recalculées.

    `k=None` reconstruit l'original : c'est le contrôle qui prouve que la
    substitution elle-même ne change rien.
    """
    import build_dataset as BD
    fv, _ = BD.build_team_features(season_prior_k=k)
    f = fv.drop(columns=["gameId"]).drop_duplicates(subset=["team", "date"],
                                                    keep="last")
    cols = [c for c in f.columns if c not in ("team", "date", "team_gp")]
    out = df.copy()
    for side in ("home", "away"):
        m = out[[f"{side}_team", "date"]].merge(
            f, left_on=[f"{side}_team", "date"], right_on=["team", "date"],
            how="left")
        for c in cols:
            if f"{side}_{c}" in out.columns:
                out[f"{side}_{c}"] = m[c].to_numpy()
    return out


def _recency_eval(train_df, test_df, feats, params, weight_hl=None) -> dict:
    """Pertes PAR MATCH d'une variante sur une saison testée.

    Même découpage que `fit_score_fold` (85 % / 15 % pour l'arrêt précoce).
    `weight_hl` : demi-vie en saisons des poids d'entraînement (levier B) ;
    l'arrêt précoce et τ restent non pondérés.
    """
    cut = int(len(train_df) * 0.85)
    s_tr = TS.stack(train_df.iloc[:cut].reset_index(drop=True))
    s_cal = TS.stack(train_df.iloc[cut:].reset_index(drop=True))
    d_tr = TS.dm(s_tr, feats)
    if weight_hl:
        last = season_of(train_df["date"].iloc[-1])
        age = last - s_tr["date"].map(season_of).to_numpy()
        d_tr.set_weight((0.5 ** (age / weight_hl)).astype(np.float32))
    m = xgb.train(params, d_tr, num_boost_round=700,
                  evals=[(TS.dm(s_cal, feats), "cal")],
                  early_stopping_rounds=40, verbose_eval=False)

    s_full = TS.stack(train_df.reset_index(drop=True))
    lam_h_tr, lam_a_tr = TS.lambdas_for(m, feats, s_full, len(train_df))
    tau = fit_margin_correction(
        (train_df["home_reg_score"] - train_df["away_reg_score"]).to_numpy(),
        TS.expected_margin_pmf(lam_h_tr, lam_a_tr))

    s_te = TS.stack(test_df.reset_index(drop=True))
    mu = m.predict(TS.dm(s_te, feats, with_label=False))
    y = s_te["y"].to_numpy(dtype=float)
    mu_c = np.clip(mu, 1e-6, None)
    with np.errstate(divide="ignore", invalid="ignore"):
        dev_row = 2.0 * (np.where(y > 0, y * np.log(y / mu_c), 0.0) - (y - mu_c))
    n = len(test_df)
    rows, sides = s_te["_row"].to_numpy(), s_te["_side"].to_numpy()
    lam_h, lam_a, dev = np.full(n, np.nan), np.full(n, np.nan), np.zeros(n)
    lam_h[rows[sides == "home"]] = mu[sides == "home"]
    lam_a[rows[sides == "away"]] = mu[sides == "away"]
    np.add.at(dev, rows, dev_row)
    dists = [ScoreDistribution(h, a, tau=tau) for h, a in zip(lam_h, lam_a)]

    def ll(yv, p):
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return -(yv * np.log(p) + (1 - yv) * np.log(1 - p))

    margin = (test_df["home_score"] - test_df["away_score"]).to_numpy(dtype=float)
    p_hc = np.array([d.p_home_cover_minus_15() for d in dists])
    p_ac = 1.0 - np.array([d.p_home_cover_plus_15() for d in dists])
    pl = 0.5 * (ll((margin >= 2).astype(float), p_hc)
                + ll((margin <= -2).astype(float), p_ac))
    ml = ll(test_df["home_win"].to_numpy(dtype=float),
            np.array([d.p_home_win() for d in dists]))
    # `p_ml` : P(victoire domicile) par match, pour `--market-gap`.
    return {"pl": pl, "ml": ml, "dev": dev / 2.0,
            "p_ml": np.array([d.p_home_win() for d in dists])}


def _early_mask(df: pd.DataFrame) -> pd.Series:
    """Vrai si les deux équipes ont joué < RECENCY_EARLY_GAMES matchs de la saison."""
    long = pd.concat([
        pd.DataFrame({"i": df.index, "season": df["season"], "date": df["date"],
                      "team": df[f"{s}_team"], "side": s}) for s in ("home", "away")])
    long = long.sort_values(["season", "team", "date"])
    long["gp"] = long.groupby(["season", "team"]).cumcount()
    gp = long.pivot_table(index="i", columns="side", values="gp", aggfunc="first")
    early = (gp["home"] < RECENCY_EARLY_GAMES) & (gp["away"] < RECENCY_EARLY_GAMES)
    return early.reindex(df.index).fillna(False)


def _paired(delta: np.ndarray) -> dict:
    n = len(delta)
    se = float(delta.std(ddof=1) / np.sqrt(n)) if n > 1 else float("nan")
    mean = float(delta.mean())
    return {"n": n, "delta": round(mean, 6), "se": round(se, 6),
            "z": round(mean / se, 2) if se and np.isfinite(se) else None}


def run_recency(df, seasons, search_trials: int, use_cache: bool = True,
                ks=(5, 15), hls=(4, 8)) -> dict | None:
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    feats = TS.stacked_features()
    base = base_score_params(search_trials)
    df = df.copy()
    df["_early"] = _early_mask(df)

    # ── Contrôle : la substitution des features ne change rien à k=None ──────
    ctrl = _with_team_variant(df, None)
    tcols = [c for c in df.columns if c.startswith(("home_", "away_"))
             and c in ctrl.columns and df[c].dtype.kind == "f"]
    worst = max((float(np.nanmax(np.abs(ctrl[c].to_numpy() - df[c].to_numpy())))
                 if np.isfinite(ctrl[c].to_numpy() - df[c].to_numpy()).any() else 0.0)
                for c in tcols)
    nan_mis = sum(int((ctrl[c].isna() != df[c].isna()).sum()) for c in tcols)
    print(f"   Contrôle de substitution (k=None) : écart max {worst:.2e}, "
          f"NaN discordants {nan_mis}")
    if worst > 1e-9 or nan_mis:
        print("ERREUR : reconstruire les features à l'identique échoue ; la mesure "
              "de la variante A ne serait pas interprétable. Arrêt.")
        return None
    del ctrl

    variants = [("actuel", df, None)]
    for k in ks:
        variants.append((f"A_k{k}", _with_team_variant(df, k), None))
    for h in hls:
        variants.append((f"B_H{h}", df, h))

    per = {name: {"pl": [], "ml": [], "dev": [], "season": [], "early": []}
           for name, _, _ in variants}
    print(f"\n   {'saison':>8} {'matchs':>7} " + " ".join(f"{v[0]:>9}" for v in variants)
          + "   (log-loss puck line)")
    for s in seasons:
        idx_tr = df.index[(df["season"] < s)]
        idx_te = df.index[(df["season"] == s)]
        line = []
        for name, d, hl in variants:
            train_df = d.loc[idx_tr].dropna(subset=need).reset_index(drop=True)
            test_df = d.loc[idx_te].dropna(subset=need).reset_index(drop=True)
            if len(test_df) < 50 or len(train_df) < 800:
                break
            cut = int(len(train_df) * 0.85)
            params = search_params_fold(train_df.iloc[:cut].reset_index(drop=True),
                                        feats, base, search_trials, seed=42,
                                        season=s, use_cache=use_cache)
            r = _recency_eval(train_df, test_df, feats, params, weight_hl=hl)
            for key in ("pl", "ml", "dev"):
                per[name][key].append(r[key])
            per[name]["season"].append(np.full(len(test_df), s))
            per[name]["early"].append(test_df["_early"].to_numpy(dtype=bool))
            line.append(float(r["pl"].mean()))
        if line:
            n_te = len(per["actuel"]["pl"][-1])
            print(f"   {s}-{str(s + 1)[2:]:<2} {n_te:>7} "
                  + " ".join(f"{v:>9.5f}" for v in line))

    cat = {name: {k: np.concatenate(v) for k, v in d.items()} for name, d in per.items()}
    ref = cat["actuel"]
    out = {"protocol": {"metric": "log-loss puck line (2 jambes), par match",
                        "adopt_if": f"z <= -{RECENCY_Z} ET gain sur >= "
                                    f"{RECENCY_SEASON_SHARE:.0%} des saisons ET "
                                    "moneyline z < +2",
                        "early_subset": f"les deux equipes a < {RECENCY_EARLY_GAMES} "
                                        "matchs de la saison",
                        "seasons": [int(s) for s in seasons],
                        "params": "hyperparametres par fold du modele actuel "
                                  "(cache), communs a toutes les variantes"},
           "baseline": {"ll_puckline": round(float(ref["pl"].mean()), 6),
                        "ll_moneyline": round(float(ref["ml"].mean()), 6),
                        "deviance": round(float(ref["dev"].mean()), 6),
                        "n_games": int(len(ref["pl"]))},
           "variants": {}}
    print(f"\n   {'variante':>9} {'dPL':>9} {'z':>6} {'saisons+':>9} {'dML':>9} "
          f"{'z ML':>6} {'dDEV':>9} {'dPL debut':>10} {'z':>6}   verdict")
    for name, _, _ in variants[1:]:
        v = cat[name]
        assert len(v["pl"]) == len(ref["pl"])
        dpl, dml, ddev = v["pl"] - ref["pl"], v["ml"] - ref["ml"], v["dev"] - ref["dev"]
        seasons_better = [int(s) for s in np.unique(ref["season"])
                          if dpl[ref["season"] == s].mean() < 0]
        n_seas = len(np.unique(ref["season"]))
        p_pl, p_ml, p_dev = _paired(dpl), _paired(dml), _paired(ddev)
        p_early = _paired(dpl[ref["early"]])
        share = len(seasons_better) / n_seas
        adopt = (p_pl["z"] is not None and p_pl["z"] <= -RECENCY_Z
                 and share >= RECENCY_SEASON_SHARE
                 and (p_ml["z"] is None or p_ml["z"] < 2))
        verdict = ("ADOPTER" if adopt else
                   "PIRE" if (p_pl["z"] or 0) >= RECENCY_Z else
                   "NON TRANCHABLE")
        by_season = [{"season": int(s),
                      "d_puckline": round(float(dpl[ref["season"] == s].mean()), 6),
                      "d_moneyline": round(float(dml[ref["season"] == s].mean()), 6)}
                     for s in np.unique(ref["season"])]
        out["variants"][name] = {"puckline": p_pl, "moneyline": p_ml,
                                 "deviance": p_dev, "early_puckline": p_early,
                                 "seasons_better": seasons_better,
                                 "share_seasons_better": round(share, 3),
                                 "by_season": by_season, "verdict": verdict}
        print(f"   {name:>9} {p_pl['delta']:>+9.5f} {p_pl['z']:>+6.2f} "
              f"{len(seasons_better):>4}/{n_seas:<4} {p_ml['delta']:>+9.5f} "
              f"{p_ml['z']:>+6.2f} {p_dev['delta']:>+9.5f} "
              f"{p_early['delta']:>+10.5f} {p_early['z']:>+6.2f}   {verdict}")
    print("\n   d = variante - actuel : NEGATIF = mieux. z apparie par match. "
          f"'debut' = {int(ref['early'].sum())} matchs ou les deux equipes ont "
          f"< {RECENCY_EARLY_GAMES} matchs de la saison.")
    return out


# ── Apprentissage en cours de saison (2026-09-27) ────────────────────────────
#
# LA QUESTION : le modèle gagne-t-il à réapprendre PENDANT la saison, avec les
# matchs déjà joués, au lieu de rester figé sur la fin de la saison précédente ?
#
# LE DÉCOUPAGE EST CHRONOLOGIQUE, jamais aléatoire. Tirer 25 % des matchs au
# hasard mettrait des matchs de mars dans l'entraînement d'un test de novembre :
# le modèle connaîtrait la force réelle de chaque équipe cette saison-là, et le
# chiffre serait flatteur et faux. Les coupures tombent entre deux JOURNÉES,
# jamais au milieu d'une soirée.
#
# Pour chaque saison S testée, sur les MÊMES matchs :
#   • figé     — entraîné sur les saisons < S (la pratique actuelle) ;
#   • 75/25    — entraîné sur les saisons < S + les premiers 75 % de S, testé
#                sur les 25 % finaux (la demande telle que formulée) ;
#   • trimestriel — réentraîné à 25, 50 et 75 % de S ; chaque quart suivant est
#                prédit par le dernier modèle disponible. C'est ce que donnerait
#                un réentraînement mensuel en service.
# Mêmes hyperparamètres par fold (cache, choisis sur les saisons < S), τ ajusté
# sur chaque train. Critère d'adoption : celui de `--recency` (log-loss puck
# line, z <= −RECENCY_Z, >= 70 % des saisons, moneyline non dégradé).
#
# Le MARCHÉ est affiché sur les matchs testés qui ont une cote de clôture, par
# source : c'est l'étalon qui dit si le modèle est « bon ». Il ne décide rien.

IN_SEASON_REPORT = f"{MODELS}/in_season_report.json"
IN_SEASON_RANDOM_REPORT = f"{MODELS}/in_season_random_report.json"

# ── Variante ALÉATOIRE, demandée par le user le 2026-09-27 ─────────────────
#
# 75 % des matchs de la saison tirés AU HASARD rejoignent l'entraînement, les
# 25 % restants font le test, où qu'ils tombent dans la saison. Chaque feature
# reste pré-match (aucune fuite du résultat lui-même), mais le modèle apprend
# sur des matchs POSTÉRIEURS à ceux qu'il prédit : il absorbe le climat de la
# saison entière (niveau de buts, arbitrage). Ce chiffre est donc un plafond
# optimiste de ce que l'app obtiendra en service, où le futur n'existe pas.
# L'écart avec le découpage chronologique chiffre cet optimisme. Plusieurs
# tirages par saison, pour ne pas dépendre d'un tirage chanceux.
IN_SEASON_DRAWS = 3
IN_SEASON_CUTS = (0.25, 0.50, 0.75)


def _date_cut(dates: pd.Series, share: float) -> int:
    """Index de coupure à `share` des matchs, avancé jusqu'au changement de date."""
    i = int(len(dates) * share)
    d = dates.to_numpy()
    while 0 < i < len(d) and d[i] == d[i - 1]:
        i += 1
    return i


def run_in_season_random(df, seasons, search_trials: int, use_cache: bool = True,
                         draws: int = IN_SEASON_DRAWS, test_share: float = 0.25):
    """75 % / 25 % tirés au hasard dans chaque saison (cf. le commentaire de
    IN_SEASON_DRAWS). Figé et « en saison » jugés sur les MÊMES matchs de test."""
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    feats = TS.stacked_features()
    base = base_score_params(search_trials)
    rows = {d: {k: [] for k in ("season", "src", "p_mkt", "y", "pl_fig", "ml_fig",
                                "dev_fig", "pl_ins", "ml_ins", "dev_ins")}
            for d in range(draws)}
    print(f"   {'saison':>8} {'n test':>7} " + " ".join(
        f"{'dPL tirage ' + str(d + 1):>15}" for d in range(draws)))
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).sort_values(
            "date", kind="mergesort").reset_index(drop=True)
        if len(cur) < 200 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        params = search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                    feats, base, search_trials, seed=42,
                                    season=s, use_cache=use_cache)
        fig = _recency_eval(prior, cur, feats, params)     # figé : toute la saison
        line = []
        for d in range(draws):
            rng = np.random.default_rng(_stable_seed("in-season-random", s, d))
            test = np.zeros(len(cur), dtype=bool)
            test[rng.choice(len(cur), int(round(len(cur) * test_share)),
                            replace=False)] = True
            # Entraînement trié par date : l'arrêt précoce prend les 15 % les
            # plus récents, comme partout ailleurs.
            train_q = pd.concat([prior, cur[~test]], ignore_index=True) \
                .sort_values("date", kind="mergesort").reset_index(drop=True)
            test_q = cur[test].reset_index(drop=True)
            ins = _recency_eval(train_q, test_q, feats, params)
            R = rows[d]
            n = int(test.sum())
            R["season"].append(np.full(n, s))
            R["src"].append(test_q["source"].fillna("-").astype(str).to_numpy()
                            if "source" in test_q.columns else np.full(n, "-"))
            R["p_mkt"].append(test_q["market_home_p_close"].to_numpy(dtype=float)
                              if "market_home_p_close" in test_q.columns
                              else np.full(n, np.nan))
            R["y"].append(test_q["home_win"].to_numpy(dtype=float))
            for k in ("pl", "ml", "dev"):
                R[f"{k}_fig"].append(fig[k][test])
                R[f"{k}_ins"].append(ins[k])
            line.append(float(ins["pl"].mean() - fig["pl"][test].mean()))
        print(f"   {s}-{str(s + 1)[2:]:<2} {int(round(len(cur) * test_share)):>7} "
              + " ".join(f"{v:>+15.5f}" for v in line))

    out = {"protocol": {"split": f"aleatoire dans la saison, {1 - test_share:.0%} "
                                 f"entrainement / {test_share:.0%} test",
                        "draws": draws,
                        "caveat": "le modele apprend sur des matchs posterieurs "
                                  "a ceux qu'il predit : plafond optimiste",
                        "adopt_if": f"z <= -{RECENCY_Z} ET gain sur >= "
                                    f"{RECENCY_SEASON_SHARE:.0%} des saisons ET "
                                    "moneyline z < +2 (sur la moyenne des tirages)",
                        "seasons": [int(s) for s in seasons]},
           "draws": {}}
    print(f"\n   {'tirage':<8} {'dPL':>9} {'z':>6} {'saisons+':>9} {'dML':>9} "
          f"{'z ML':>6} {'dDEV':>9} {'z DEV':>6}")
    per_draw = []
    for d in range(draws):
        R = {k: np.concatenate(v) for k, v in rows[d].items()}
        dpl, dml = R["pl_ins"] - R["pl_fig"], R["ml_ins"] - R["ml_fig"]
        ddev = R["dev_ins"] - R["dev_fig"]
        seas = np.unique(R["season"])
        better = [int(x) for x in seas if dpl[R["season"] == x].mean() < 0]
        res = {"puckline": _paired(dpl), "moneyline": _paired(dml),
               "deviance": _paired(ddev), "seasons_better": better}
        out["draws"][str(d + 1)] = res
        per_draw.append((R, res))
        print(f"   {d + 1:<8} {res['puckline']['delta']:>+9.5f} "
              f"{res['puckline']['z']:>+6.2f} {len(better):>4}/{len(seas):<4} "
              f"{res['moneyline']['delta']:>+9.5f} {res['moneyline']['z']:>+6.2f} "
              f"{res['deviance']['delta']:>+9.5f} {res['deviance']['z']:>+6.2f}")

    # Verdict sur la MOYENNE des tirages : z et part des saisons moyennés.
    z_pl = float(np.mean([r["puckline"]["z"] for _, r in per_draw]))
    z_ml = float(np.mean([r["moneyline"]["z"] for _, r in per_draw]))
    share = float(np.mean([len(r["seasons_better"]) for _, r in per_draw])) / len(seasons)
    adopt = z_pl <= -RECENCY_Z and share >= RECENCY_SEASON_SHARE and z_ml < 2
    out["summary"] = {
        "d_puckline_mean": round(float(np.mean([r["puckline"]["delta"] for _, r in per_draw])), 6),
        "z_puckline_mean": round(z_pl, 2),
        "d_moneyline_mean": round(float(np.mean([r["moneyline"]["delta"] for _, r in per_draw])), 6),
        "z_moneyline_mean": round(z_ml, 2),
        "d_deviance_mean": round(float(np.mean([r["deviance"]["delta"] for _, r in per_draw])), 6),
        "share_seasons_better": round(share, 3),
        "verdict": ("ADOPTER" if adopt else
                    "PIRE" if z_pl >= RECENCY_Z else "NON TRANCHABLE")}
    sm = out["summary"]
    print(f"   {'moyenne':<8} {sm['d_puckline_mean']:>+9.5f} {z_pl:>+6.2f} "
          f"{share:>9.0%} {sm['d_moneyline_mean']:>+9.5f} {z_ml:>+6.2f} "
          f"{sm['d_deviance_mean']:>+9.5f}          -> {sm['verdict']}")

    # Le marché, sur les matchs de test du premier tirage.
    R = per_draw[0][0]
    mk = {}
    print(f"\n   Moneyline contre le marché (tirage 1, clôture dévigée) :")
    print(f"   {'source':>20} {'matchs':>7} {'fige':>8} {'en saison':>10} {'marche':>8}")
    ok = np.isfinite(R["p_mkt"])
    for src in sorted(set(R["src"][ok])):
        m = ok & (R["src"] == src)
        if m.sum() < 100:
            continue
        p = np.clip(R["p_mkt"][m], 1e-6, 1 - 1e-6)
        yv = R["y"][m]
        ll_mkt = float(-np.mean(yv * np.log(p) + (1 - yv) * np.log(1 - p)))
        mk[src] = {"n": int(m.sum()), "ll_frozen": round(float(R["ml_fig"][m].mean()), 5),
                   "ll_in_season": round(float(R["ml_ins"][m].mean()), 5),
                   "ll_market": round(ll_mkt, 5)}
        print(f"   {src:>20} {int(m.sum()):>7} {R['ml_fig'][m].mean():>8.4f} "
              f"{R['ml_ins'][m].mean():>10.4f} {ll_mkt:>8.4f}")
    out["market"] = mk
    print("\n   d = en saison - fige : NEGATIF = mieux. Rappel : ce decoupage "
          "laisse le modele\n   apprendre sur des matchs posterieurs a ceux qu'il "
          "predit (plafond optimiste).")
    return out


def run_in_season(df, seasons, search_trials: int, use_cache: bool = True):
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    feats = TS.stacked_features()
    base = base_score_params(search_trials)

    rec = {k: [] for k in ("season", "quarter", "src", "p_mkt", "y",
                           "pl_fig", "ml_fig", "dev_fig",
                           "pl_ins", "ml_ins", "dev_ins")}
    print(f"   {'saison':>8} {'n test':>7} {'PL fige':>9} {'PL 75/25':>9} "
          f"{'delta':>9} {'ML fige':>9} {'ML 75/25':>9}")
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).sort_values(
            "date", kind="mergesort").reset_index(drop=True)
        if len(cur) < 200 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        params = search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                    feats, base, search_trials, seed=42,
                                    season=s, use_cache=use_cache)
        cuts = [_date_cut(cur["date"], q) for q in IN_SEASON_CUTS] + [len(cur)]

        # Figé : un seul modèle, prédit tout ce qui suit le premier quart.
        fig = _recency_eval(prior, cur.iloc[cuts[0]:].reset_index(drop=True),
                            feats, params)
        off = cuts[0]
        for qi in range(3):
            lo, hi = cuts[qi], cuts[qi + 1]
            train_q = pd.concat([prior, cur.iloc[:lo]], ignore_index=True)
            test_q = cur.iloc[lo:hi].reset_index(drop=True)
            ins = _recency_eval(train_q, test_q, feats, params)
            sl = slice(lo - off, hi - off)
            n = hi - lo
            rec["season"].append(np.full(n, s))
            rec["quarter"].append(np.full(n, qi + 2))
            src = (test_q["source"].fillna("-").astype(str).to_numpy()
                   if "source" in test_q.columns else np.full(n, "-"))
            rec["src"].append(src)
            rec["p_mkt"].append(test_q["market_home_p_close"].to_numpy(dtype=float)
                                if "market_home_p_close" in test_q.columns
                                else np.full(n, np.nan))
            rec["y"].append(test_q["home_win"].to_numpy(dtype=float))
            for k in ("pl", "ml", "dev"):
                rec[f"{k}_fig"].append(fig[k][sl])
                rec[f"{k}_ins"].append(ins[k])
        q4 = slice(cuts[2] - off, None)
        pl_f, pl_i = fig["pl"][q4].mean(), rec["pl_ins"][-1].mean()
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(rec['pl_ins'][-1]):>7} "
              f"{pl_f:>9.5f} {pl_i:>9.5f} {pl_i - pl_f:>+9.5f} "
              f"{fig['ml'][q4].mean():>9.5f} {rec['ml_ins'][-1].mean():>9.5f}")

    R = {k: np.concatenate(v) for k, v in rec.items()}
    n_seas = len(np.unique(R["season"]))

    def compare(mask, label):
        dpl = R["pl_ins"][mask] - R["pl_fig"][mask]
        dml = R["ml_ins"][mask] - R["ml_fig"][mask]
        ddev = R["dev_ins"][mask] - R["dev_fig"][mask]
        better = [int(s) for s in np.unique(R["season"][mask])
                  if dpl[R["season"][mask] == s].mean() < 0]
        p_pl, p_ml, p_dev = _paired(dpl), _paired(dml), _paired(ddev)
        share = len(better) / n_seas
        adopt = (p_pl["z"] is not None and p_pl["z"] <= -RECENCY_Z
                 and share >= RECENCY_SEASON_SHARE
                 and (p_ml["z"] is None or p_ml["z"] < 2))
        verdict = ("ADOPTER" if adopt else
                   "PIRE" if (p_pl["z"] or 0) >= RECENCY_Z else "NON TRANCHABLE")
        print(f"   {label:<26} {p_pl['delta']:>+9.5f} {p_pl['z']:>+6.2f} "
              f"{len(better):>4}/{n_seas:<4} {p_ml['delta']:>+9.5f} "
              f"{p_ml['z']:>+6.2f} {p_dev['delta']:>+9.5f}   {verdict}")
        return {"puckline": p_pl, "moneyline": p_ml, "deviance": p_dev,
                "seasons_better": better, "share_seasons_better": round(share, 3),
                "verdict": verdict}

    print(f"\n   {'comparaison (en saison - fige)':<26} {'dPL':>9} {'z':>6} "
          f"{'saisons+':>9} {'dML':>9} {'z ML':>6} {'dDEV':>9}   verdict")
    out = {"protocol": {"split": "chronologique, coupures entre deux journees",
                        "cuts": list(IN_SEASON_CUTS),
                        "adopt_if": f"z <= -{RECENCY_Z} ET gain sur >= "
                                    f"{RECENCY_SEASON_SHARE:.0%} des saisons ET "
                                    "moneyline z < +2",
                        "seasons": [int(s) for s in seasons]},
           "split_75_25": compare(R["quarter"] == 4, "75/25 (quart final)"),
           "quarterly": compare(R["quarter"] >= 2, "trimestriel (Q2 a Q4)"),
           "by_quarter": {}}
    for q in (2, 3, 4):
        out["by_quarter"][f"Q{q}"] = compare(R["quarter"] == q, f"  dont Q{q}")

    # ── L'étalon : le marché, sur les mêmes matchs ──────────────────────────
    print(f"\n   Moneyline contre le marché (clôture dévigée), mêmes matchs :")
    print(f"   {'source':>20} {'matchs':>7} {'fige':>8} {'en saison':>10} "
          f"{'marche':>8} {'ecart fige-marche':>18}")
    mk = {}
    ok = np.isfinite(R["p_mkt"])
    for src in sorted(set(R["src"][ok])):
        m = ok & (R["src"] == src) & (R["quarter"] >= 2)
        if m.sum() < 100:
            continue
        p = np.clip(R["p_mkt"][m], 1e-6, 1 - 1e-6)
        yv = R["y"][m]
        ll_mkt = float(-np.mean(yv * np.log(p) + (1 - yv) * np.log(1 - p)))
        ll_f, ll_i = float(R["ml_fig"][m].mean()), float(R["ml_ins"][m].mean())
        d = R["ml_fig"][m] + (yv * np.log(p) + (1 - yv) * np.log(1 - p))
        mk[src] = {"n": int(m.sum()), "ll_frozen": round(ll_f, 5),
                   "ll_in_season": round(ll_i, 5), "ll_market": round(ll_mkt, 5),
                   "gap_frozen_minus_market": _paired(d)}
        print(f"   {src:>20} {int(m.sum()):>7} {ll_f:>8.4f} {ll_i:>10.4f} "
              f"{ll_mkt:>8.4f} {ll_f - ll_mkt:>+11.4f} (z {mk[src]['gap_frozen_minus_market']['z']:+.1f})")
    out["market"] = mk
    print("\n   delta = en saison - fige : NEGATIF = mieux. Ecart au marche : "
          "POSITIF = le marche fait mieux.")
    return out


# ── Régimes d'entraînement : fenêtre de 6 saisons, réentraînement hebdomadaire
#    (demande du user, 2026-09-27) ──────────────────────────────────────────
#
# Trois régimes jugés contre le modèle FIGÉ (tout l'historique, un
# entraînement par saison — ce qui est servi), sur les MÊMES matchs :
#   • figé_6s   : figé, mais n'apprend que sur les 6 saisons précédentes ;
#   • hebdo     : réentraîné chaque lundi sur tout ce qui a été joué avant ;
#   • hebdo_6s  : les deux.
# Saisons testées >= 2015 : avant, « 6 saisons » couvre déjà tout l'historique
# depuis 2008 et la comparaison serait vide. Mêmes hyperparamètres pour tous
# (ceux de la saison, choisis sur le passé complet, en cache). τ par train.
# Critère fixé AVANT le run : log-loss puck line, z <= −REGIME_Z (2,39 : 5 %
# bilatéral, Bonferroni pour 3 régimes), gain sur >= 70 % des saisons,
# moneyline non dégradé (z < +2).

REGIME_Z = 2.39
REGIME_WINDOW = 6
REGIME_MIN_SEASON = 2015
REGIMES_REPORT = f"{MODELS}/regimes_report.json"


def run_regimes(df, seasons, search_trials: int, use_cache: bool = True):
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    feats = TS.stacked_features()
    base = base_score_params(search_trials)
    names = ["fige_6s", "hebdo", "hebdo_6s"]
    acc = {k: [] for k in ["season", "pl_fige", "ml_fige", "dev_fige"]
           + [f"{m}_{n}" for n in names for m in ("pl", "ml", "dev")]}
    print(f"   {'saison':>8} {'matchs':>7} {'semaines':>9} {'fige':>9} "
          + " ".join(f"{n:>9}" for n in names) + "   (log-loss puck line)")
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        prior6 = prior[prior["season"] >= s - REGIME_WINDOW].reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).sort_values(
            "date", kind="mergesort").reset_index(drop=True)
        if len(cur) < 200 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        params = search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                    feats, base, search_trials, seed=42,
                                    season=s, use_cache=use_cache)
        res = {"fige": _recency_eval(prior, cur, feats, params),
               "fige_6s": _recency_eval(prior6, cur, feats, params)}

        # Semaines calendaires (lundi) : le modèle de la semaine w a vu tous les
        # matchs joués AVANT le lundi de w, rien de plus.
        wk = pd.to_datetime(cur["date"]).dt.to_period("W-SUN").dt.start_time
        weeks = sorted(wk.unique())
        for n, base_df in (("hebdo", prior), ("hebdo_6s", prior6)):
            parts = {m: np.full(len(cur), np.nan) for m in ("pl", "ml", "dev")}
            for w in weeks:
                idx = np.where(wk.to_numpy() == w)[0]
                seen = cur.iloc[:idx[0]]
                train_w = pd.concat([base_df, seen], ignore_index=True)
                r = _recency_eval(train_w, cur.iloc[idx].reset_index(drop=True),
                                  feats, params)
                for m in parts:
                    parts[m][idx] = r[m]
            res[n] = parts

        acc["season"].append(np.full(len(cur), s))
        for m in ("pl", "ml", "dev"):
            acc[f"{m}_fige"].append(res["fige"][m])
            for n in names:
                acc[f"{m}_{n}"].append(res[n][m])
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(cur):>7} {len(weeks):>9} "
              f"{res['fige']['pl'].mean():>9.5f} "
              + " ".join(f"{res[n]['pl'].mean():>9.5f}" for n in names))

    A = {k: np.concatenate(v) for k, v in acc.items()}
    seas = np.unique(A["season"])
    out = {"protocol": {"baseline": "fige, tout l'historique, un entrainement par saison",
                        "window_seasons": REGIME_WINDOW,
                        "weekly": "reentraine chaque lundi sur tout ce qui precede",
                        "adopt_if": f"z <= -{REGIME_Z} ET gain sur >= "
                                    f"{RECENCY_SEASON_SHARE:.0%} des saisons ET "
                                    "moneyline z < +2",
                        "seasons": [int(x) for x in seas]},
           "baseline": {"ll_puckline": round(float(A["pl_fige"].mean()), 6),
                        "ll_moneyline": round(float(A["ml_fige"].mean()), 6),
                        "n_games": int(len(A["pl_fige"]))},
           "regimes": {}}
    print(f"\n   {'regime':>9} {'dPL':>9} {'z':>6} {'saisons+':>9} {'dML':>9} "
          f"{'z ML':>6} {'dDEV':>9} {'z DEV':>6}   verdict")
    for n in names:
        dpl = A[f"pl_{n}"] - A["pl_fige"]
        dml = A[f"ml_{n}"] - A["ml_fige"]
        ddev = A[f"dev_{n}"] - A["dev_fige"]
        better = [int(x) for x in seas if dpl[A["season"] == x].mean() < 0]
        p_pl, p_ml, p_dev = _paired(dpl), _paired(dml), _paired(ddev)
        share = len(better) / len(seas)
        adopt = (p_pl["z"] is not None and p_pl["z"] <= -REGIME_Z
                 and share >= RECENCY_SEASON_SHARE
                 and (p_ml["z"] is None or p_ml["z"] < 2))
        verdict = ("ADOPTER" if adopt else
                   "PIRE" if (p_pl["z"] or 0) >= REGIME_Z else "NON TRANCHABLE")
        out["regimes"][n] = {
            "puckline": p_pl, "moneyline": p_ml, "deviance": p_dev,
            "seasons_better": better, "share_seasons_better": round(share, 3),
            "by_season": [{"season": int(x),
                           "d_puckline": round(float(dpl[A["season"] == x].mean()), 6),
                           "d_moneyline": round(float(dml[A["season"] == x].mean()), 6)}
                          for x in seas],
            "verdict": verdict}
        print(f"   {n:>9} {p_pl['delta']:>+9.5f} {p_pl['z']:>+6.2f} "
              f"{len(better):>4}/{len(seas):<4} {p_ml['delta']:>+9.5f} "
              f"{p_ml['z']:>+6.2f} {p_dev['delta']:>+9.5f} {p_dev['z']:>+6.2f}   {verdict}")
    print("\n   d = regime - fige : NEGATIF = mieux. z apparie par match.")
    return out


# ── Décomposer l'écart au marché (2026-09-27) ────────────────────────────────
#
# LA QUESTION : le modèle figé perd ~0,004 de log-loss moneyline contre la
# clôture. OÙ, et quelle information lui manque-t-il ?
#
# Prédictions : modèle figé en walk-forward (celui qui est servi), sur les
# saisons qui ont une cote de clôture, chaque source à part. Écart par match =
# log-loss modèle − log-loss marché (positif = le marché fait mieux).
#
# 1. PAR TYPE DE MATCH : écart moyen, part du retard total, z. ~40 cases : seul
#    |z| >= GAP_Z_NOTABLE est signalé, pour ne pas lire du hasard.
# 2. PAR FEATURE, deux tests :
#      • « le marché la pèse plus » : corrélation entre la feature et
#        D = logit(p_marché) − logit(p_modèle) ;
#      • « information absente du modèle » : régression logistique du résultat
#        sur logit(p_modèle) À PENTE LIBRE + la feature standardisée — z du
#        coefficient de la feature. La pente libre est indispensable : le
#        modèle de score est trop prudent dans les extrêmes (déciles), et avec
#        un offset fixe toute feature de force « apporterait de l'information »
#        rien qu'en corrigeant cette compression (premier jet du 2026-09-27).
#    |z| >= 3 => information à ajouter ou à renforcer.
# 4. CE QUI EST RÉCUPÉRABLE, validé en laissant une saison de côté : (a) la
#    seule recalibration de la pente du modèle, (b) recalibration + toutes les
#    features ci-dessus. Mesuré contre le marché sur les mêmes matchs.
# 3. INFORMATION RÉSIDUELLE : y ~ logit(p_modèle) + logit(p_marché). Si le poids
#    du modèle est nul, il n'apporte rien que le marché n'ait déjà.

GAP_REPORT = f"{MODELS}/market_gap_report.json"
GAP_Z_NOTABLE = 3.0
GAP_BACKUP_WINDOW = 10        # matchs précédents de l'équipe
GAP_BACKUP_SHARE = 0.40       # partant de moins de 40 % d'entre eux = relève


def _goalie_backup_flags() -> pd.DataFrame:
    """(team, date, backup) : le partant a-t-il commencé < 40 % des 10 matchs
    précédents de son équipe ? Même définition du partant que build_dataset
    (plus de temps de glace), et même normalisation des équipes."""
    import build_dataset as BD
    gl = pd.read_csv("../data/mp_goalie_games.csv", low_memory=False,
                     usecols=["playerId", "playerTeam", "gameId", "gameDate",
                              "icetime", "situation"])
    gl = gl[gl["situation"] == "all"].copy()
    gl["team"] = gl["playerTeam"].map(BD.norm_team)
    gl["date"] = gl["gameDate"].map(BD.mp_date)
    gl = gl.sort_values(["team", "gameId", "icetime"], ascending=[True, True, False])
    st = gl.drop_duplicates(subset=["team", "gameId"], keep="first") \
           .sort_values(["team", "date", "gameId"]).reset_index(drop=True)
    shares = np.full(len(st), np.nan)
    for _, g in st.groupby("team", sort=False):
        pid = g["playerId"].to_numpy()
        for j, i in enumerate(g.index):
            prev = pid[max(0, j - GAP_BACKUP_WINDOW):j]
            if len(prev) >= 5:
                shares[i] = float(np.mean(prev == pid[j]))
    # 1 = relève, 0 = titulaire, NaN = moins de 5 matchs d'historique d'équipe.
    st["backup"] = np.where(np.isnan(shares), np.nan,
                            (shares < GAP_BACKUP_SHARE).astype(float))
    return st[["team", "date", "backup"]].drop_duplicates(["team", "date"], keep="last")


def _special_teams_features() -> pd.DataFrame:
    """(team, date, pp_min, pk_min) : minutes par match en avantage (5 c. 4) et
    en désavantage (4 c. 5), EWMA hl=20 décalé d'un match (pré-match).

    Le modèle connaît l'EFFICACITÉ des unités spéciales (xG par 60), pas leur
    VOLUME : combien de temps une équipe passe en avantage ou à se défendre à
    court d'un homme. Le temps de glace par situation est la mesure la moins
    ambiguë de ce volume — les colonnes `penaltiesFor/Against` de MoneyPuck
    ne disent pas sans équivoque qui a pris la punition.
    """
    import build_dataset as BD
    mp = pd.read_csv("../data/mp_team_games.csv", low_memory=False,
                     usecols=["playerTeam", "gameId", "gameDate", "situation", "iceTime"])
    mp = mp[mp["situation"].isin(["5on4", "4on5"])].copy()
    mp["team"] = mp["playerTeam"].map(BD.norm_team)
    mp["date"] = mp["gameDate"].map(BD.mp_date)
    w = mp.pivot_table(index=["team", "date", "gameId"], columns="situation",
                       values="iceTime", aggfunc="sum").reset_index()
    w = w.rename(columns={"5on4": "pp", "4on5": "pk"}).sort_values(["team", "date", "gameId"])
    for c in ("pp", "pk"):
        w[f"{c}_min"] = w.groupby("team")[c].transform(
            lambda x: (x / 60.0).shift(1).ewm(halflife=20, min_periods=5).mean())
    return w[["team", "date", "pp_min", "pk_min"]].drop_duplicates(["team", "date"], keep="last")


def _logit(p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return np.log(p / (1 - p))


def _logistic_offset(y, X, offset, iters: int = 50):
    """Régression logistique y ~ X (avec constante) + offset. (coef, se)."""
    X1 = np.column_stack([np.ones(len(y)), X])
    b = np.zeros(X1.shape[1])
    for _ in range(iters):
        eta = X1 @ b + offset
        p = 1 / (1 + np.exp(-eta))
        W = p * (1 - p)
        H = X1.T @ (X1 * W[:, None]) + 1e-9 * np.eye(len(b))
        step = np.linalg.solve(H, X1.T @ (y - p))
        b += step
        if np.max(np.abs(step)) < 1e-10:
            break
    se = np.sqrt(np.diag(np.linalg.inv(H)))
    return b, se


def run_market_gap(df, seasons, search_trials: int, use_cache: bool = True):
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    feats = TS.stacked_features()
    base = base_score_params(search_trials)
    parts = []
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        cut_p = int(len(prior) * 0.85)
        params = search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                    feats, base, search_trials, seed=42,
                                    season=s, use_cache=use_cache)
        r = _recency_eval(prior, cur, feats, params)
        c = cur.copy()
        c["p_model"] = r["p_ml"]
        parts.append(c)
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(cur):>6} matchs predits")
    G = pd.concat(parts, ignore_index=True)
    G = G[G["market_home_p_close"].notna()].reset_index(drop=True)
    G["source"] = G["source"].fillna("sbro").astype(str) if "source" in G else "sbro"

    y = G["home_win"].to_numpy(dtype=float)
    pm, pk = G["p_model"].to_numpy(), G["market_home_p_close"].to_numpy(dtype=float)
    ll = lambda p: -(y * np.log(np.clip(p, 1e-6, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-6, 1)))
    G["gap"] = ll(pm) - ll(pk)
    G["D"] = _logit(pk) - _logit(pm)

    # ── Descripteurs de match ────────────────────────────────────────────────
    long = pd.concat([pd.DataFrame({"i": G.index, "season": G["season"],
                                    "date": G["date"], "team": G[f"{s}_team"], "side": s})
                      for s in ("home", "away")]).sort_values(["season", "team", "date"])
    # Numéro du match dans la saison, compté sur le calendrier COMPLET de df.
    full = pd.concat([pd.DataFrame({"season": df["season"], "date": df["date"],
                                    "team": df[f"{s}_team"]}) for s in ("home", "away")])
    full = full.sort_values(["season", "team", "date"])
    full["gp"] = full.groupby(["season", "team"]).cumcount()
    long = long.merge(full.drop_duplicates(["season", "team", "date"]),
                      on=["season", "team", "date"], how="left")
    gp = long.pivot_table(index="i", columns="side", values="gp", aggfunc="first")
    G["gp_min"] = np.minimum(gp["home"].reindex(G.index), gp["away"].reindex(G.index))
    bk = _goalie_backup_flags()
    for s in ("home", "away"):
        G = G.merge(bk.rename(columns={"team": f"{s}_team", "backup": f"{s}_backup"}),
                    on=[f"{s}_team", "date"], how="left")
    p_fav = np.maximum(pk, 1 - pk)

    def lab(cond_list):
        out = np.full(len(G), None, dtype=object)
        for name, cond in cond_list:
            out[np.asarray(cond, dtype=bool) & (out == None)] = name   # noqa: E711
        return out

    hb, ab = G["home_backup"] == 1, G["away_backup"] == 1
    hs = G["home_stars_out_weight"].fillna(0) > 0
    as_ = G["away_stars_out_weight"].fillna(0) > 0
    month = pd.to_datetime(G["date"]).dt.month
    dis = pm - pk
    segs = {
        "source": G["source"].to_numpy(),
        "force du favori (marche)": lab([("50-55 %", p_fav < .55), ("55-60 %", p_fav < .60),
                                         ("60-65 %", p_fav < .65), ("65-70 %", p_fav < .70),
                                         ("70 %+", p_fav >= .70)]),
        "favori": lab([("domicile", pk >= .5), ("exterieur", pk < .5)]),
        "phase de saison": lab([("< 10 matchs", G["gp_min"] < 10), ("10-29", G["gp_min"] < 30),
                                ("30-59", G["gp_min"] < 60), ("60+", G["gp_min"] >= 60)]),
        "mois": lab([("oct", month == 10), ("nov-dec", month.isin([11, 12])),
                     ("jan-fev", month.isin([1, 2])), ("mar-avr+", month >= 3)]),
        "dos-a-dos": lab([("les deux", (G["home_b2b"] == 1) & (G["away_b2b"] == 1)),
                          ("domicile", G["home_b2b"] == 1), ("exterieur", G["away_b2b"] == 1),
                          ("aucun", True)]),
        "gardien de releve": lab([("les deux", hb & ab), ("domicile", hb),
                                  ("exterieur", ab), ("aucun", True)]),
        "vedettes absentes": lab([("les deux", hs & as_), ("domicile", hs),
                                  ("exterieur", as_), ("aucune", True)]),
        "voyage visiteur": lab([(">= 2 fuseaux", G["away_tz_shift"].abs() >= 2),
                                ("< 2 fuseaux", True)]),
        "desaccord modele - marche": lab([("modele < marche de 5+ pts", dis <= -.05),
                                          ("-5 a -2 pts", dis <= -.02), ("-2 a +2 pts", dis < .02),
                                          ("+2 a +5 pts", dis < .05), ("modele > marche de 5+ pts", True)]),
    }
    total_excess = float(G["gap"].sum())
    out = {"n_games": int(len(G)),
           "by_source": {}, "segments": {}, "features": {}, "residual_information": {}}
    print(f"\n   {len(G)} matchs avec cote de cloture. Ecart = LL modele - LL marche "
          f"(POSITIF = le marche fait mieux).")
    for src in sorted(G["source"].unique()):
        m = G["source"] == src
        out["by_source"][src] = {"n": int(m.sum()), "ll_model": round(float(ll(pm)[m].mean()), 5),
                                 "ll_market": round(float(ll(pk)[m].mean()), 5),
                                 "gap": _paired(G.loc[m, "gap"].to_numpy())}
    print(f"   {'':<28} {'n':>6} {'ecart':>9} {'z':>6} {'part du retard':>15}   "
          f"(obs. / modele / marche, victoire dom.)")
    for fam, labels in segs.items():
        print(f"\n   -- {fam} --")
        rows = []
        for lv in [v for v in dict.fromkeys(labels) if v is not None]:
            m = labels == lv
            if m.sum() < 100:
                continue
            p = _paired(G.loc[m, "gap"].to_numpy())
            share = float(G.loc[m, "gap"].sum()) / total_excess if total_excess else None
            flag = "  <==" if p["z"] is not None and abs(p["z"]) >= GAP_Z_NOTABLE else ""
            rows.append({"level": str(lv), **p, "share_of_gap": round(share, 3),
                         "home_win_observed": round(float(y[m].mean()), 4),
                         "p_model_mean": round(float(pm[m].mean()), 4),
                         "p_market_mean": round(float(pk[m].mean()), 4),
                         "notable": bool(flag)})
            print(f"   {str(lv):<28} {p['n']:>6} {p['delta']:>+9.5f} {p['z']:>+6.2f} "
                  f"{share:>14.0%}   ({y[m].mean():.3f} / {pm[m].mean():.3f} / "
                  f"{pk[m].mean():.3f}){flag}")
        out["segments"][fam] = rows

    # ── Par feature ──────────────────────────────────────────────────────────
    G["lineup_xg_diff"] = G["home_lineup_xg"] - G["away_lineup_xg"]
    G["goalie_starts_logdiff"] = np.log1p(G["home_goalie_starts"]) - np.log1p(G["away_goalie_starts"])
    G["backup_diff"] = hb.astype(float) - ab.astype(float)
    G["gp_min_f"] = G["gp_min"].astype(float)
    # Unités spéciales : volume attendu × efficacité, des deux côtés.
    stf = _special_teams_features()
    for s_ in ("home", "away"):
        G = G.merge(stf.rename(columns={"team": f"{s_}_team", "pp_min": f"{s_}_pp_min",
                                        "pk_min": f"{s_}_pk_min"}),
                    on=[f"{s_}_team", "date"], how="left")
    # Minutes d'avantage attendues : ce que l'équipe obtient d'habitude, et ce
    # que l'adversaire concède d'habitude.
    exp_pp_h = (G["home_pp_min"] + G["away_pk_min"]) / 2
    exp_pp_a = (G["away_pp_min"] + G["home_pk_min"]) / 2
    G["pp_time_diff"] = exp_pp_h - exp_pp_a
    G["discipline_diff"] = G["home_pk_min"] - G["away_pk_min"]     # + = domicile plus puni
    G["st_xg_edge"] = (exp_pp_h / 60 * (G["home_pp_xgf60_s"] + G["away_pk_xga60_s"]) / 2
                       - exp_pp_a / 60 * (G["away_pp_xgf60_s"] + G["home_pk_xga60_s"]) / 2)
    G["pp_eff_diff"] = G["home_pp_xgf60_s"] - G["away_pp_xgf60_s"]
    G["pk_eff_diff"] = G["home_pk_xga60_s"] - G["away_pk_xga60_s"]
    fcols = ["elo_diff", "goalie_gsax60_diff", "goalie_svpct_diff", "goalie_starts_logdiff",
             "backup_diff", "stars_out_weight_diff", "star_power_diff", "lineup_xg_diff",
             "b2b_diff", "rest_days_diff", "tz_shift_diff", "distance_km_diff",
             "ev_xgf_pct_s_diff", "ev_xgf_pct_l_diff", "xg_matchup_diff", "win_s_diff",
             "finishing_s_diff", "gp_min_f",
             "pp_time_diff", "discipline_diff", "st_xg_edge", "pp_eff_diff", "pk_eff_diff"]
    lm = _logit(pm)
    b0, se0 = _logistic_offset(y, lm.reshape(-1, 1), np.zeros(len(y)))
    out["model_slope"] = {"a": round(float(b0[0]), 4), "b": round(float(b0[1]), 4),
                          "se_b": round(float(se0[1]), 4)}
    print(f"\n   Pente du modele : y ~ {b0[0]:+.3f} + {b0[1]:.3f} x logit(p_modele) "
          f"(+/- {se0[1]:.3f}) ; > 1 = modele trop prudent.")
    print(f"\n   -- Par feature : information absente du modele (pente libre) --")
    print(f"   {'feature':<24} {'corr(f, D)':>11} {'z info':>8}   lecture")
    for c in fcols:
        if c not in G.columns:
            continue
        x = G[c].astype(float).to_numpy()
        ok = np.isfinite(x)
        if ok.sum() < 500 or np.nanstd(x[ok]) == 0:
            continue
        xs = (x[ok] - x[ok].mean()) / x[ok].std()
        corr = float(np.corrcoef(xs, G["D"].to_numpy()[ok])[0, 1])
        b, se = _logistic_offset(y[ok], np.column_stack([lm[ok], xs]), np.zeros(ok.sum()))
        z = float(b[2] / se[2])
        read = ("A AJOUTER / RENFORCER" if abs(z) >= GAP_Z_NOTABLE else
                "piste faible" if abs(z) >= 2 else "-")
        out["features"][c] = {"n": int(ok.sum()), "corr_with_market_minus_model": round(corr, 4),
                              "info_beyond_model_coef": round(float(b[2]), 5),
                              "info_beyond_model_z": round(z, 2), "reading": read}
        print(f"   {c:<24} {corr:>+11.3f} {z:>+8.2f}   {read}")

    # ── Ce qui est récupérable, une saison laissée de côté ───────────────────
    X_all = []
    for c in fcols:
        x = G[c].astype(float).to_numpy()
        mu, sd = np.nanmean(x), np.nanstd(x)
        X_all.append(np.nan_to_num((x - mu) / sd if sd else x * 0, nan=0.0))
    X_all = np.column_stack(X_all)
    p_cal, p_feat = np.full(len(y), np.nan), np.full(len(y), np.nan)
    seas = G["season"].to_numpy()
    for s_out in np.unique(seas):
        tr, te = seas != s_out, seas == s_out
        b1, _ = _logistic_offset(y[tr], lm[tr].reshape(-1, 1), np.zeros(tr.sum()))
        p_cal[te] = 1 / (1 + np.exp(-(b1[0] + b1[1] * lm[te])))
        b2, _ = _logistic_offset(y[tr], np.column_stack([lm[tr], X_all[tr]]),
                                 np.zeros(tr.sum()))
        p_feat[te] = 1 / (1 + np.exp(-(b2[0] + np.column_stack([lm[te], X_all[te]]) @ b2[1:])))
    print(f"\n   -- Ce qui est recuperable (une saison laissee de cote a chaque fois) --")
    print(f"   {'':<34} {'LL':>8} {'ecart au marche':>16} {'z':>6}")
    rec = {}
    for name, p in (("modele tel quel", pm), ("modele recalibre (pente)", p_cal),
                    ("recalibre + features", p_feat), ("marche", pk)):
        gap_v = ll(p) - ll(pk)
        pr = _paired(gap_v)
        rec[name] = {"ll": round(float(ll(p).mean()), 5), "gap_vs_market": pr}
        print(f"   {name:<34} {ll(p).mean():>8.5f} {pr['delta']:>+16.5f} "
              f"{(pr['z'] if pr['z'] is not None else 0):>+6.2f}")
    out["recoverable_loso"] = rec

    # ── Information résiduelle ───────────────────────────────────────────────
    print(f"\n   -- Information residuelle : y ~ logit(modele) + logit(marche) --")
    for src in ["tout"] + sorted(G["source"].unique()):
        m = np.ones(len(G), bool) if src == "tout" else (G["source"] == src).to_numpy()
        b, se = _logistic_offset(y[m], np.column_stack([_logit(pm[m]), _logit(pk[m])]),
                                 np.zeros(m.sum()))
        out["residual_information"][src] = {
            "n": int(m.sum()), "w_model": round(float(b[1]), 4), "se_model": round(float(se[1]), 4),
            "w_market": round(float(b[2]), 4), "se_market": round(float(se[2]), 4)}
        print(f"   {src:<20} n {int(m.sum()):>6}   poids modele {b[1]:+.3f} +/- {se[1]:.3f}"
              f"   poids marche {b[2]:+.3f} +/- {se[2]:.3f}")
    print("\n   Lecture : poids modele ~ 0 = il n'ajoute rien au marche ; > 0 et "
          "significatif = il porte\n   une information que la cloture n'a pas "
          "entierement.")
    return out


# ── Modèle de score v2 : les quatre causes de l'écart au marché (2026-09-27) ─
#
# `--market-gap` a isolé quatre informations que le modèle de score n'utilise
# pas ou mal. Trois sont des FEATURES ajoutées :
#   • def_b2b, def_rest_days : la fatigue de l'équipe qui DÉFEND (le modèle ne
#     connaissait que celle de l'équipe qui attaque) ;
#   • def_goalie_backup : le partant adverse est un gardien de relève
#     (build_dataset, < 40 % des 10 derniers départs de son équipe) ;
#   • atk_ev_xgf_pct_l : la possession en xG à 5 c. 5 sur le long terme.
# La quatrième est la PRUDENCE du modèle, corrigée par γ (`score_model.
# stretch_lambdas`), ajusté sur la tranche d'arrêt précoce du fold (hors
# échantillon : sur l'entraînement, les λ sur-ajustés tireraient γ sous 1).
#
# Variantes, contre le modèle ACTUEL tel qu'il est servi (τ + prolongation
# dépendante de l'affiche, tous deux ajustés sur le train du fold) :
#   F = + features ;  G = + γ ;  FG = les deux.
# Hyperparamètres : recherche par fold pour CHAQUE jeu de features (cache
# indexé sur les features) — une variante n'hérite pas des réglages d'une autre.
# Critère fixé AVANT le run : puck line OU moneyline améliorés à z <= −2,39
# (Bonferroni, 3 variantes) sur >= 70 % des saisons, et l'autre marché pas
# dégradé (z < +2). L'écart au marché est affiché, il ne décide rien.

V2_ATK_ADD = ["ev_xgf_pct_l"]
V2_DEF_ADD = ["b2b", "rest_days", "goalie_backup"]
V2_Z = 2.39
V2_REPORT = f"{MODELS}/score_v2_report.json"


def _eval_v2(train_df, test_df, atk, dfn, params, use_gamma: bool) -> dict:
    """Pertes par match d'une variante, telle qu'elle serait servie."""
    feats = TS.stacked_features(atk, dfn)
    cut = int(len(train_df) * 0.85)
    tr, cal = train_df.iloc[:cut].reset_index(drop=True), train_df.iloc[cut:].reset_index(drop=True)
    s_tr, s_cal = TS.stack(tr, atk, dfn), TS.stack(cal, atk, dfn)
    m = xgb.train(params, TS.dm(s_tr, feats), num_boost_round=700,
                  evals=[(TS.dm(s_cal, feats), "cal")],
                  early_stopping_rounds=40, verbose_eval=False)
    ot = train_df[train_df["went_to_ot"] == 1]
    p_ot_home = float((ot["home_score"] > ot["away_score"]).mean()) if len(ot) else 0.5

    gamma = 1.0
    if use_gamma:
        lh_c, la_c = TS.lambdas_for(m, feats, s_cal, len(cal))
        gamma = TS.fit_gamma(lh_c, la_c, cal["home_win"].to_numpy(float), p_ot_home)

    lh_tr, la_tr = TS.lambdas_for(m, feats, TS.stack(train_df.reset_index(drop=True), atk, dfn),
                                  len(train_df))
    lh_tr, la_tr = stretch_lambdas(lh_tr, la_tr, gamma)
    tau = fit_margin_correction(
        (train_df["home_reg_score"] - train_df["away_reg_score"]).to_numpy(),
        TS.expected_margin_pmf(lh_tr, la_tr))
    ot_model = TS.fit_ot_model(train_df.reset_index(drop=True), lh_tr, la_tr, p_ot_home)

    s_te = TS.stack(test_df.reset_index(drop=True), atk, dfn)
    lh, la = TS.lambdas_for(m, feats, s_te, len(test_df))
    lh, la = stretch_lambdas(lh, la, gamma)
    p_ot = TS.p_ot_series(ot_model, lh, la, p_ot_home)
    p_ot = np.broadcast_to(np.asarray(p_ot, float), (len(lh),))
    dists = [ScoreDistribution(h, a, po, tau) for h, a, po in zip(lh, la, p_ot)]

    def ll(yv, p):
        p = np.clip(p, 1e-6, 1 - 1e-6)
        return -(yv * np.log(p) + (1 - yv) * np.log(1 - p))

    margin = (test_df["home_score"] - test_df["away_score"]).to_numpy(float)
    p_hc = np.array([d.p_home_cover_minus_15() for d in dists])
    p_ac = 1.0 - np.array([d.p_home_cover_plus_15() for d in dists])
    p_ml = np.array([d.p_home_win() for d in dists])
    yh, ya = test_df["home_reg_score"].to_numpy(float), test_df["away_reg_score"].to_numpy(float)

    def dev(y, mu):
        mu = np.clip(mu, 1e-6, None)
        with np.errstate(divide="ignore", invalid="ignore"):
            return 2.0 * (np.where(y > 0, y * np.log(y / mu), 0.0) - (y - mu))
    return {"pl": 0.5 * (ll((margin >= 2).astype(float), p_hc)
                         + ll((margin <= -2).astype(float), p_ac)),
            "ml": ll(test_df["home_win"].to_numpy(float), p_ml),
            "dev": (dev(yh, lh) + dev(ya, la)) / 2.0,
            "p_ml": p_ml, "gamma": gamma}


def run_score_v2(df, seasons, search_trials: int, use_cache: bool = True):
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    # Référence = le modèle d'AVANT la v2, reconstruite explicitement : depuis
    # que les ajouts sont dans ATK_COLS / DEF_COLS, les listes du module ne
    # sont plus la référence mais la variante F.
    atk0 = [c for c in TS.ATK_COLS if c not in V2_ATK_ADD]
    def0 = [c for c in TS.DEF_COLS if c not in V2_DEF_ADD]
    atk1, def1 = atk0 + V2_ATK_ADD, def0 + V2_DEF_ADD
    variants = {"actuel": (atk0, def0, False), "F": (atk1, def1, False),
                "G": (atk0, def0, True), "FG": (atk1, def1, True)}
    base = base_score_params(search_trials)
    acc = {n: {k: [] for k in ("pl", "ml", "dev", "p_ml")} for n in variants}
    meta = {"season": [], "y": [], "p_mkt": [], "src": []}
    gammas = {n: [] for n in variants if variants[n][2]}
    print(f"   {'saison':>8} {'matchs':>7} " + " ".join(f"{n:>9}" for n in variants)
          + "   (log-loss moneyline)   gamma G / FG")
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        if len(cur) < 50 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        line = []
        for n, (atk, dfn, g) in variants.items():
            params = search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                        TS.stacked_features(atk, dfn), base,
                                        search_trials, seed=42, season=s,
                                        use_cache=use_cache, atk=atk, dfn=dfn)
            r = _eval_v2(prior, cur, atk, dfn, params, g)
            for k in ("pl", "ml", "dev", "p_ml"):
                acc[n][k].append(r[k])
            if g:
                gammas[n].append(round(r["gamma"], 4))
            line.append(float(r["ml"].mean()))
        meta["season"].append(np.full(len(cur), s))
        meta["y"].append(cur["home_win"].to_numpy(float))
        meta["p_mkt"].append(cur["market_home_p_close"].to_numpy(float)
                             if "market_home_p_close" in cur else np.full(len(cur), np.nan))
        meta["src"].append(cur["source"].fillna("-").astype(str).to_numpy()
                           if "source" in cur else np.full(len(cur), "-"))
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(cur):>7} " + " ".join(f"{v:>9.5f}" for v in line)
              + f"   {gammas['G'][-1]:.3f} / {gammas['FG'][-1]:.3f}")

    A = {n: {k: np.concatenate(v) for k, v in d.items()} for n, d in acc.items()}
    M = {k: np.concatenate(v) for k, v in meta.items()}
    seas = np.unique(M["season"])
    ref = A["actuel"]
    out = {"protocol": {"added_features": {"atk": V2_ATK_ADD, "def": V2_DEF_ADD},
                        "gamma": "ajuste sur la tranche d'arret precoce du fold",
                        "adopt_if": f"puck line OU moneyline a z <= -{V2_Z} sur >= "
                                    f"{RECENCY_SEASON_SHARE:.0%} des saisons, l'autre "
                                    "marche z < +2",
                        "seasons": [int(x) for x in seas]},
           "baseline": {k: round(float(ref[k].mean()), 6) for k in ("pl", "ml", "dev")},
           "gammas": gammas, "variants": {}, "market": {}}
    print(f"\n   {'variante':>9} {'dML':>9} {'z':>6} {'s+':>6} {'dPL':>9} {'z':>6} {'s+':>6} "
          f"{'dDEV':>9} {'z':>6}   verdict")
    for n in ("F", "G", "FG"):
        v = A[n]
        d = {k: v[k] - ref[k] for k in ("pl", "ml", "dev")}
        p = {k: _paired(d[k]) for k in d}
        sb = {k: [int(x) for x in seas if d[k][M["season"] == x].mean() < 0] for k in ("pl", "ml")}
        share = {k: len(sb[k]) / len(seas) for k in sb}
        ok_ml = p["ml"]["z"] <= -V2_Z and share["ml"] >= RECENCY_SEASON_SHARE and p["pl"]["z"] < 2
        ok_pl = p["pl"]["z"] <= -V2_Z and share["pl"] >= RECENCY_SEASON_SHARE and p["ml"]["z"] < 2
        worse = p["ml"]["z"] >= V2_Z or p["pl"]["z"] >= V2_Z
        verdict = "ADOPTER" if (ok_ml or ok_pl) else ("PIRE" if worse else "NON TRANCHABLE")
        out["variants"][n] = {"moneyline": p["ml"], "puckline": p["pl"], "deviance": p["dev"],
                              "seasons_better": sb, "verdict": verdict}
        print(f"   {n:>9} {p['ml']['delta']:>+9.5f} {p['ml']['z']:>+6.2f} "
              f"{len(sb['ml']):>3}/{len(seas):<2} {p['pl']['delta']:>+9.5f} "
              f"{p['pl']['z']:>+6.2f} {len(sb['pl']):>3}/{len(seas):<2} "
              f"{p['dev']['delta']:>+9.5f} {p['dev']['z']:>+6.2f}   {verdict}")

    print(f"\n   Ecart au marche (moneyline), matchs avec cote de cloture :")
    ok = np.isfinite(M["p_mkt"])
    y = M["y"]
    for src in ["tout"] + sorted(set(M["src"][ok])):
        msk = ok if src == "tout" else ok & (M["src"] == src)
        if msk.sum() < 100:
            continue
        pk = np.clip(M["p_mkt"][msk], 1e-6, 1 - 1e-6)
        ll_mkt = -(y[msk] * np.log(pk) + (1 - y[msk]) * np.log(1 - pk))
        row = {"n": int(msk.sum()), "ll_market": round(float(ll_mkt.mean()), 5)}
        txt = []
        for n in variants:
            g = _paired(A[n]["ml"][msk] - ll_mkt)
            row[n] = g
            txt.append(f"{n} {g['delta']:+.5f} (z {g['z']:+.1f})")
        out["market"][src] = row
        print(f"   {src:>20} n {int(msk.sum()):>6} : " + "  ".join(txt))
    print("\n   d = variante - actuel : NEGATIF = mieux. Ecart au marche : POSITIF = "
          "le marche fait mieux.")
    return out


# ── Recalibration de la pente, ajustée sur le PASSÉ seulement (2026-10-01) ──
#
# `--market-gap` mesure encore une pente > 1 après la v2 (1,28 ± 0,06) : le
# modèle reste trop prudent. γ (forme cohérente, étirer l'écart des λ) a échoué
# hors échantillon le 2026-09-27. Ce mode teste la forme la plus simple, en
# walk-forward STRICT : pour chaque saison S, logit p' = a + b·logit p, avec
# (a, b) ajustés sur les prédictions hors échantillon des saisons < S
# uniquement (au moins RECAL_MIN_SEASONS saisons), puis appliqués à S.
# Prédictions telles que le service les produit (`_eval_v2` : τ, prolongation
# dépendante de l'affiche, features par défaut du module).
# Critère fixé AVANT le run : log-loss moneyline z <= −2 et gain sur >= 70 %
# des saisons. Même adoptée, elle ne toucherait que le moneyline : les prix
# de puck line et de totaux sortiraient d'une distribution non recalibrée.

RECAL_MIN_SEASONS = 3
RECAL_REPORT = f"{MODELS}/recal_report.json"


def run_recal(df, seasons, search_trials: int, use_cache: bool = True):
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    atk, dfn = list(TS.ATK_COLS), list(TS.DEF_COLS)
    base = base_score_params(search_trials)
    P = {}
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        if len(cur) < 50 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        params = search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                    TS.stacked_features(atk, dfn), base, search_trials,
                                    seed=42, season=s, use_cache=use_cache,
                                    atk=atk, dfn=dfn)
        r = _eval_v2(prior, cur, atk, dfn, params, use_gamma=False)
        P[s] = (r["p_ml"], cur["home_win"].to_numpy(float))
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(cur):>6} matchs predits")

    ll = lambda y, p: -(y * np.log(np.clip(p, 1e-6, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-6, 1)))
    ks = sorted(P)
    out = {"protocol": {"fit": f"(a, b) sur les saisons < S, au moins {RECAL_MIN_SEASONS}",
                        "adopt_if": "log-loss moneyline z <= -2 ET gain sur >= 70 % des saisons"},
           "by_season": []}
    d_all, s_all = [], []
    print(f"\n   {'saison':>8} {'n':>6} {'a':>7} {'b':>6} {'LL brut':>9} {'LL recal':>9} {'delta':>9}")
    for i, s in enumerate(ks):
        past = ks[:i]
        if len(past) < RECAL_MIN_SEASONS:
            continue
        p_tr = np.concatenate([P[x][0] for x in past])
        y_tr = np.concatenate([P[x][1] for x in past])
        b, _ = _logistic_offset(y_tr, _logit(p_tr).reshape(-1, 1), np.zeros(len(y_tr)))
        p, y = P[s]
        p2 = 1 / (1 + np.exp(-(b[0] + b[1] * _logit(p))))
        d = ll(y, p2) - ll(y, p)
        d_all.append(d)
        s_all.append(np.full(len(d), s))
        out["by_season"].append({"season": int(s), "a": round(float(b[0]), 4),
                                 "b": round(float(b[1]), 4),
                                 "ll_raw": round(float(ll(y, p).mean()), 5),
                                 "ll_recal": round(float(ll(y, p2).mean()), 5)})
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(y):>6} {b[0]:>+7.3f} {b[1]:>6.3f} "
              f"{ll(y, p).mean():>9.5f} {ll(y, p2).mean():>9.5f} {d.mean():>+9.5f}")
    D, S = np.concatenate(d_all), np.concatenate(s_all)
    pr = _paired(D)
    better = [int(x) for x in np.unique(S) if D[S == x].mean() < 0]
    share = len(better) / len(np.unique(S))
    verdict = ("ADOPTER" if pr["z"] <= -2 and share >= RECENCY_SEASON_SHARE
               else "PIRE" if pr["z"] >= 2 else "NON TRANCHABLE")
    out.update({"moneyline": pr, "seasons_better": better,
                "share_seasons_better": round(share, 3), "verdict": verdict})
    print(f"\n   recalibration - brut : {pr['delta']:+.5f} (z {pr['z']:+.2f}), "
          f"{len(better)}/{len(np.unique(S))} saisons -> {verdict}")
    return out



# ── Couche de correction au-dessus du modèle, walk-forward STRICT (2026-10-02) ─
#
# `--market-gap` a mesuré, en « une saison laissée de côté » (donc en
# s'entraînant aussi sur des saisons FUTURES), qu'une régression logistique
# posée sur logit(p_modèle) + quelques features rattrapait le marché :
# log-loss 0,66869 → 0,66620 (marché 0,66675). Ce mode refait la mesure sans
# regarder l'avenir : pour chaque saison S, la couche est ajustée sur les
# prédictions hors échantillon des saisons < S (au moins RECAL_MIN_SEASONS),
# puis appliquée à S. Trois variantes :
#   R = recalibration seule (logit p) — doit REPRODUIRE `recal_report.json`,
#       c'est le contrôle de la manip ;
#   C = recalibration + CORRECTION_FEATURES ;
#   B = C sans `elo_diff` (le modèle de score lit déjà l'ELO).
# Les features sont celles que `--market-gap` (2026-10-01) classait « piste »
# ou mieux (|z| >= 2) ; standardisées avec les moyennes / écarts-types du
# PASSÉ du fold, NaN → 0 (la moyenne).
# Critère fixé AVANT le run : log-loss moneyline z <= −2 (apparié, par match)
# ET gain sur >= 70 % des saisons — le même que `--recal`. Avec le biais de
# sélection des features (choisies sur ces mêmes saisons par `--market-gap`),
# un résultat juste au seuil ne suffira pas : regarder aussi l'erreur-type
# calculée sur les moyennes de saison.
# Même adoptée, la couche ne toucherait que la victoire (moneyline) : puck line
# et totaux sortent de la distribution des buts, qu'elle ne modifie pas.

CORRECTION_FEATURES = ["b2b_diff", "ev_xgf_pct_s_diff", "ev_xgf_pct_l_diff",
                       "lineup_xg_diff", "star_power_diff", "xg_matchup_diff", "elo_diff"]
CORRECTION_REPORT = f"{MODELS}/correction_report.json"
CORRECTION_LAYER = f"{MODELS}/correction_layer.json"


def _correction_X(frame: pd.DataFrame, cols: list) -> np.ndarray:
    f = frame.copy()
    if "lineup_xg_diff" in cols and "lineup_xg_diff" not in f:
        f["lineup_xg_diff"] = f["home_lineup_xg"] - f["away_lineup_xg"]
    return np.column_stack([f[c].astype(float).to_numpy() for c in cols])


def run_correction(df, seasons, search_trials: int, use_cache: bool = True):
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    atk, dfn = list(TS.ATK_COLS), list(TS.DEF_COLS)
    base = base_score_params(search_trials)
    P = {}
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        if len(cur) < 50 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        params = search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                    TS.stacked_features(atk, dfn), base, search_trials,
                                    seed=42, season=s, use_cache=use_cache,
                                    atk=atk, dfn=dfn)
        r = _eval_v2(prior, cur, atk, dfn, params, use_gamma=False)
        P[s] = {"p": np.asarray(r["p_ml"], float), "y": cur["home_win"].to_numpy(float),
                "X": _correction_X(cur, CORRECTION_FEATURES),
                "pk": cur["market_home_p_close"].to_numpy(float)
                      if "market_home_p_close" in cur else np.full(len(cur), np.nan),
                "src": (cur["source"].fillna("sbro").astype(str).to_numpy()
                        if "source" in cur else np.full(len(cur), "sbro"))}
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(cur):>6} matchs predits")

    ll = lambda y, p: -(y * np.log(np.clip(p, 1e-6, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-6, 1)))
    variants = {"R": [], "C": list(range(len(CORRECTION_FEATURES))),
                "B": [i for i, c in enumerate(CORRECTION_FEATURES) if c != "elo_diff"]}
    ks = sorted(P)
    D = {v: [] for v in variants}
    S_lab, by_season, coefs = [], [], {}
    mkt = {"raw": [], **{v: [] for v in variants}}
    mkt_src = []
    for i, s in enumerate(ks):
        past = ks[:i]
        if len(past) < RECAL_MIN_SEASONS:
            continue
        y_tr = np.concatenate([P[x]["y"] for x in past])
        lp_tr = _logit(np.concatenate([P[x]["p"] for x in past]))
        X_tr_all = np.concatenate([P[x]["X"] for x in past])
        mu, sd = np.nanmean(X_tr_all, axis=0), np.nanstd(X_tr_all, axis=0)
        sd[sd == 0] = 1.0
        std = lambda X: np.nan_to_num((X - mu) / sd, nan=0.0)
        y, p = P[s]["y"], P[s]["p"]
        lp = _logit(p)
        row = {"season": int(s), "n": int(len(y)), "ll_raw": round(float(ll(y, p).mean()), 5)}
        has_mkt = np.isfinite(P[s]["pk"])
        if has_mkt.any():
            mkt["raw"].append(ll(y, p)[has_mkt] - ll(y, P[s]["pk"])[has_mkt])
            mkt_src.append(P[s]["src"][has_mkt])
        for v, idx in variants.items():
            Xtr = np.column_stack([lp_tr] + ([std(X_tr_all)[:, idx]] if idx else []))
            Xte = np.column_stack([lp] + ([std(P[s]["X"])[:, idx]] if idx else []))
            b, _ = _logistic_offset(y_tr, Xtr, np.zeros(len(y_tr)))
            p2 = 1 / (1 + np.exp(-(b[0] + Xte @ b[1:])))
            D[v].append(ll(y, p2) - ll(y, p))
            row[f"ll_{v}"] = round(float(ll(y, p2).mean()), 5)
            if has_mkt.any():
                mkt[v].append(ll(y, p2)[has_mkt] - ll(y, P[s]["pk"])[has_mkt])
            coefs[v] = [round(float(x), 4) for x in b]      # dernier fold = le plus d'historique
        S_lab.append(np.full(len(y), s))
        by_season.append(row)
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(y):>6}  brut {row['ll_raw']:.5f}  "
              + "  ".join(f"{v} {row[f'll_{v}']:.5f}" for v in variants))

    S_all = np.concatenate(S_lab)
    out = {"protocol": {
        "fit": f"logistique sur les saisons < S (au moins {RECAL_MIN_SEASONS}), appliquee a S",
        "features": CORRECTION_FEATURES,
        "variants": {"R": "recalibration seule (controle : doit reproduire recal_report.json)",
                     "C": "recalibration + features", "B": "C sans elo_diff"},
        "adopt_if": "log-loss moneyline z <= -2 (apparie, par match) ET gain sur >= 70 % des saisons"},
        "by_season": by_season, "variants": {}, "vs_market": {},
        "coefficients_last_fold": {"order": ["const", "logit_p"] + CORRECTION_FEATURES, **coefs}}
    for v in variants:
        d = np.concatenate(D[v])
        pr = _paired(d)
        means = np.array([d[S_all == x].mean() for x in np.unique(S_all)])
        better = [int(x) for x in np.unique(S_all) if d[S_all == x].mean() < 0]
        share = len(better) / len(np.unique(S_all))
        se_seasons = float(means.std(ddof=1) / np.sqrt(len(means)))
        verdict = ("ADOPTER" if pr["z"] <= -2 and share >= RECENCY_SEASON_SHARE
                   else "PIRE" if pr["z"] >= 2 else "NON TRANCHABLE")
        out["variants"][v] = {**pr, "z_seasons": round(float(d.mean()) / se_seasons, 2),
                              "seasons_better": better, "share_seasons_better": round(share, 3),
                              "verdict": verdict}
        print(f"\n   {v} - brut : {pr['delta']:+.5f} (z {pr['z']:+.2f} par match, "
              f"{float(d.mean()) / se_seasons:+.2f} par saison), "
              f"{len(better)}/{len(np.unique(S_all))} saisons -> {verdict}")
    if mkt["raw"]:
        src_all = np.concatenate(mkt_src)
        print("\n   Ecart au marche (LL - LL marche, POSITIF = le marche fait mieux), matchs cotes :")
        for k, parts in mkt.items():
            d = np.concatenate(parts)
            out["vs_market"][k] = {"tout": _paired(d),
                                   **{src: _paired(d[src_all == src]) for src in np.unique(src_all)}}
            print(f"   {k:<4} " + "   ".join(f"{name} {r['n']:>6} {r['delta']:>+9.5f} (z {r['z']:+.2f})"
                                            for name, r in out["vs_market"][k].items()))

    # ── La couche à servir : ajustée sur TOUTES les saisons prédites ─────────
    # Mêmes prédictions hors échantillon que ci-dessus, aucune saison exclue :
    # c'est l'équivalent, pour la couche, de l'entraînement final d'un modèle.
    y_all = np.concatenate([P[x]["y"] for x in ks])
    lp_all = _logit(np.concatenate([P[x]["p"] for x in ks]))
    X_all = np.concatenate([P[x]["X"] for x in ks])
    mu, sd = np.nanmean(X_all, axis=0), np.nanstd(X_all, axis=0)
    sd[sd == 0] = 1.0
    b, se = _logistic_offset(y_all, np.column_stack([lp_all, np.nan_to_num((X_all - mu) / sd, nan=0.0)]),
                             np.zeros(len(y_all)))
    out["layer"] = {"features": CORRECTION_FEATURES, "mean": [round(float(x), 6) for x in mu],
                    "std": [round(float(x), 6) for x in sd], "intercept": round(float(b[0]), 6),
                    "coef_logit_p": round(float(b[1]), 6),
                    "coef": [round(float(x), 6) for x in b[2:]],
                    "z": [round(float(x / e), 2) for x, e in zip(b[1:], se[1:])],
                    "n_games": int(len(y_all)), "seasons": [int(x) for x in ks]}
    print("\n   Couche finale (toutes saisons) : const %+.4f, logit p x%.4f" % (b[0], b[1]))
    for c, x, e in zip(CORRECTION_FEATURES, b[2:], se[2:]):
        print(f"     {c:<20} {x:+.4f}  (z {x / e:+.2f})")
    return out


# ── Value bets : la chaîne SERVIE, mesurée telle quelle (2026-10-03) ─────────
#
# POURQUOI CE MODE (ml/INCOHERENCES_ML.md §5). La bande « edge ∈ [2 %, 6 %] »
# des value bets moneyline vient du mode par défaut de ce fichier, qui évalue
# le CLASSIFIEUR mélangé à la cote de CLÔTURE. Le service, lui, mise sur :
#
#   modèle de score (fold) → couche de correction (walk-forward) → λ recalés
#   pour que la matrice donne la victoire corrigée (`lambdas_for_home_win`,
#   comme `ml_service._align_distribution`) → edge contre le prix du MATIN,
#   dé-viggé chez le même livre → règle : moneyline edge ∈ [2 %, 6 %],
#   puck line jambe −1.5 edge ≥ 4 %, et EV = p × cote − 1 ≥ 0.
#
# Ce mode rejoue exactement cette chaîne, saison par saison, sans jamais
# regarder l'avenir :
#   • modèle de score, τ et prolongation : ajustés sur les saisons < S ;
#   • couche de correction (variante C de `--correction`) : ajustée sur les
#     prédictions hors échantillon des saisons < S (au moins RECAL_MIN_SEASONS) ;
#   • prix « du matin » : ouverture SBRO, ou premier snapshot de la série
#     The Odds API (15:25Z) ; CLV = clôture − ouverture, jugé contre le
#     placebo de `_clv_placebo` (sans lui, le CLV d'une sélection sur l'edge est
#     de la régression vers la moyenne) ;
#   • puck line SBRO : un seul prix par match → ROI seulement, pas de CLV.
# Le modèle BRUT (sans correction, sans recalage) passe dans le même tuyau,
# pour voir ce que la correction change.
#
# CRITÈRE, FIXÉ AVANT TOUT RUN — par marché et par source de prix, sur le
# modèle SERVI, règle en service appliquée :
#   • effectif < SERVED_MIN_N            → NON TRANCHABLE (trop peu de paris) ;
#   • ROI z ≤ −2  OU  CLV net z < 0      → REJETÉE ;
#   • CLV net z ≥ 2 (et ROI z > −2)      → CONFIRMÉE ;
#   • sinon                              → NON TRANCHABLE.
# La source qui décide est celle des prix de production (The Odds API) ; SBRO,
# plus long mais d'un autre livre et d'un autre horaire, sert de contexte.
# Une grille de bandes candidates est AUSSI calculée, et la meilleure (CLV net
# z maximal, effectif suffisant, ROI z > −1) est signalée — mais elle est
# choisie SUR LES MÊMES DONNÉES : c'est une piste à confirmer sur la saison
# suivante, pas une règle à adopter sur ce seul run.

SERVED_REPORT = f"{MODELS}/served_value_bets_report.json"
SERVED_ML_BAND = (0.02, 0.06)          # valueBets.service.ts (VALUE_BET_MIN/MAX_EDGE)
SERVED_PL_MIN = A2_EDGE                # règle A2 : jambe −1.5, edge ≥ 4 %
SERVED_MIN_N = {"moneyline": 200, "puckline": 100}
SERVED_GRID = {
    "moneyline": [(lo, hi) for lo in (0.01, 0.02, 0.03, 0.04, 0.05)
                  for hi in (0.04, 0.05, 0.06, 0.08, None) if hi is None or hi > lo],
    "puckline": [(lo, hi) for lo in (0.02, 0.03, 0.04, 0.05, 0.06) for hi in (0.08, None)
                 if hi is None or hi > lo],
}


def _served_fold(train_df, test_df, atk, dfn, params) -> dict:
    """Modèle de score d'un fold, tel que servi : λ de la saison testée, τ et
    prolongation (constante + logistique) ajustés sur le train du fold.
    Même procédure que `_eval_v2`, sans γ (non adopté)."""
    feats = TS.stacked_features(atk, dfn)
    cut = int(len(train_df) * 0.85)
    tr, cal = train_df.iloc[:cut].reset_index(drop=True), train_df.iloc[cut:].reset_index(drop=True)
    m = xgb.train(params, TS.dm(TS.stack(tr, atk, dfn), feats), num_boost_round=700,
                  evals=[(TS.dm(TS.stack(cal, atk, dfn), feats), "cal")],
                  early_stopping_rounds=40, verbose_eval=False)
    ot = train_df[train_df["went_to_ot"] == 1]
    p_ot_home = float((ot["home_score"] > ot["away_score"]).mean()) if len(ot) else 0.5
    lh_tr, la_tr = TS.lambdas_for(m, feats, TS.stack(train_df.reset_index(drop=True), atk, dfn),
                                  len(train_df))
    tau = fit_margin_correction(
        (train_df["home_reg_score"] - train_df["away_reg_score"]).to_numpy(),
        TS.expected_margin_pmf(lh_tr, la_tr))
    ot_model = TS.fit_ot_model(train_df.reset_index(drop=True), lh_tr, la_tr, p_ot_home)
    lh, la = TS.lambdas_for(m, feats, TS.stack(test_df.reset_index(drop=True), atk, dfn),
                            len(test_df))
    # Les mêmes garde-fous que le service (`read_ot_model`).
    w = read_ot_model({"p_ot_model": ot_model}) if ot_model else None
    return {"lh": np.asarray(lh, float), "la": np.asarray(la, float), "tau": tau,
            "p_ot_fn": lambda h, a, _w=w, _d=p_ot_home: p_ot_for(_w, h, a, _d)}


def _served_bets(dists, cur: pd.DataFrame, s: int, snaps: dict, tag: str) -> list:
    """Paris possibles d'une saison, au format de `run_clv` (lisible par
    `_clv_block` et `_clv_placebo`). `dec` = prix du MATIN (ouverture)."""
    bets = []

    def ok(*xs):
        return all(x is not None and np.isfinite(x) for x in xs)

    def add(market, src, gid, legs):
        for leg in legs:
            leg["ev"] = leg["p"] * leg["dec"] - 1.0
            bets.append({"market": market, "source": src, "season": s,
                         "game_id": f"{tag}|{gid}", "push": False, **leg})

    for j in range(len(cur)):
        r, d = cur.iloc[j], dists[j]
        margin = float(r["home_score"]) - float(r["away_score"])
        home_won = margin > 0
        src_row = r.get("source") if isinstance(r.get("source"), str) else "sbro"
        p_home = d.p_home_win()

        # ── SBRO : moneyline à l'ouverture, CLV vers la clôture ─────────────
        p_o, p_c = r.get("market_home_p_open"), r.get("market_home_p_close")
        ho, ao = r.get("home_ml_open"), r.get("away_ml_open")
        if src_row == "sbro" and ok(p_o, p_c, ho, ao) and ho > 1 and ao > 1:
            add("moneyline", "sbro", f"{s}|sbro|ml|{j}", [
                {"side": side, "leg": side, "ref": side == "home", "p": p, "dec": dec,
                 "edge": p - po, "won": bool(won), "clv": pc - po}
                for side, p, dec, po, pc, won in [
                    ("home", p_home, ho, p_o, p_c, home_won),
                    ("away", 1 - p_home, ao, 1 - p_o, 1 - p_c, not home_won)]])

        # ── SBRO : puck line, UN seul prix (pas de CLV) ─────────────────────
        pl, hp, ap_ = r.get("puck_line_home"), r.get("pl_home_price"), r.get("pl_away_price")
        if src_row == "sbro" and ok(pl, hp, ap_) and hp > 1 and ap_ > 1 and abs(abs(pl) - 1.5) < 1e-9:
            add("puckline", "sbro", f"{s}|sbro|pl|{j}",
                _pl_legs(d, pl, hp, ap_, None, margin))

        # ── The Odds API : premier snapshot du jour → dernier avant le match ─
        for sp in snaps.get((str(r["date"]), str(r["home_team"]), str(r["away_team"])), []):
            src = sp["source"]
            if "home_ml_open" in sp:
                ho, ao = sp["home_ml_open"], sp["away_ml_open"]
                po = _devig2(ho, ao)
                pc = _devig2(sp["home_ml_close"], sp["away_ml_close"])
                add("moneyline", src, f"{s}|{src}|ml|{j}", [
                    {"side": side, "leg": side, "ref": side == "home", "p": p, "dec": dec,
                     "edge": p - p_open, "won": bool(won), "clv": p_close - p_open}
                    for side, p, dec, p_open, p_close, won in [
                        ("home", p_home, ho, po, pc, home_won),
                        ("away", 1 - p_home, ao, 1 - po, 1 - pc, not home_won)]])
            if "pl_line_open" in sp and abs(abs(sp["pl_line_open"]) - 1.5) < 1e-9:
                same = abs(sp["pl_line_open"] - sp["pl_line_close"]) < 1e-9
                p_close = _devig2(sp["pl_home_close"], sp["pl_away_close"]) if same else None
                add("puckline", src, f"{s}|{src}|pl|{j}",
                    _pl_legs(d, sp["pl_line_open"], sp["pl_home_open"], sp["pl_away_open"],
                             p_close, margin))
    return bets


def _pl_legs(d, pl: float, hp: float, ap_: float, p_close_home, margin: float) -> list:
    """Les deux jambes d'une puck line ±1.5 ; `pl` = handicap du DOMICILE."""
    p_home = d.p_home_cover_minus_15() if pl < 0 else d.p_home_cover_plus_15()
    won_home = (margin >= 2) if pl < 0 else (margin >= -1)
    p_mo = _devig2(hp, ap_)
    legs = []
    for side, p, dec, po, won in [("home", p_home, hp, p_mo, won_home),
                                  ("away", 1 - p_home, ap_, 1 - p_mo, not won_home)]:
        gives = (pl < 0) if side == "home" else (pl > 0)
        pc = None if p_close_home is None else (p_close_home if side == "home" else 1 - p_close_home)
        legs.append({"side": side, "leg": "-1.5" if gives else "+1.5", "ref": bool(gives),
                     "p": p, "dec": dec, "edge": p - po, "won": bool(won),
                     "clv": (pc - po) if pc is not None else None})
    return legs


def _served_select(bets: list, market: str, lo: float, hi: float | None) -> list:
    """La règle en service : bande d'edge, EV ≥ 0, et jambe −1.5 en puck line."""
    eps = 1e-9
    return [b for b in bets if b["market"] == market
            and (market != "puckline" or b["leg"] == "-1.5")
            and b["edge"] + eps >= lo and (hi is None or b["edge"] - eps <= hi)
            and b["ev"] + eps >= 0]


def _served_verdict(block: dict | None, market: str) -> str:
    """Critère fixé avant le run (cf. l'en-tête de la section)."""
    if not block or block["n_bets"] < SERVED_MIN_N[market]:
        return f"NON TRANCHABLE (moins de {SERVED_MIN_N[market]} paris)"
    z_clv, z_roi = block["clv_net_z"], block["z"]
    if (np.isfinite(z_roi) and z_roi <= -2) or (z_clv is not None and z_clv < 0):
        return "REJETÉE"
    if z_clv is not None and z_clv >= 2:
        return "CONFIRMÉE"
    return "NON TRANCHABLE"


def run_served(df, seasons, search_trials: int, use_cache: bool = True,
               snaps: dict | None = None, snap_stats: dict | None = None):
    snaps = snaps or {}
    need = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]
    atk, dfn = list(TS.ATK_COLS), list(TS.DEF_COLS)
    base = base_score_params(search_trials)

    # ── 1. Modèle de score walk-forward, saison par saison ──────────────────
    F = {}
    for s in seasons:
        prior = df[df["season"] < s].dropna(subset=need).reset_index(drop=True)
        cur = df[df["season"] == s].dropna(subset=need).reset_index(drop=True)
        if len(cur) < 50 or len(prior) < 800:
            continue
        cut_p = int(len(prior) * 0.85)
        params = search_params_fold(prior.iloc[:cut_p].reset_index(drop=True),
                                    TS.stacked_features(atk, dfn), base, search_trials,
                                    seed=42, season=s, use_cache=use_cache, atk=atk, dfn=dfn)
        fold = _served_fold(prior, cur, atk, dfn, params)
        raw = [ScoreDistribution(h, a, fold["p_ot_fn"](h, a), fold["tau"])
               for h, a in zip(fold["lh"], fold["la"])]
        F[s] = {**fold, "cur": cur, "raw": raw,
                "p": np.array([d.p_home_win() for d in raw]),
                "y": cur["home_win"].to_numpy(float),
                "X": _correction_X(cur, CORRECTION_FEATURES)}
        print(f"   {s}-{str(s + 1)[2:]:<2} {len(cur):>6} matchs predits")

    # ── 2. Correction walk-forward (variante C) + λ recalés ─────────────────
    ks = sorted(F)
    bets = {"brut": [], "servi": []}
    used = []
    for i, s in enumerate(ks):
        past = ks[:i]
        if len(past) < RECAL_MIN_SEASONS:
            continue
        y_tr = np.concatenate([F[x]["y"] for x in past])
        lp_tr = _logit(np.concatenate([F[x]["p"] for x in past]))
        X_tr = np.concatenate([F[x]["X"] for x in past])
        mu, sd = np.nanmean(X_tr, axis=0), np.nanstd(X_tr, axis=0)
        sd[sd == 0] = 1.0
        std = lambda X: np.nan_to_num((X - mu) / sd, nan=0.0)
        b, _ = _logistic_offset(y_tr, np.column_stack([lp_tr, std(X_tr)]), np.zeros(len(y_tr)))
        f = F[s]
        p_corr = 1 / (1 + np.exp(-(b[0] + np.column_stack([_logit(f["p"]), std(f["X"])]) @ b[1:])))
        served = []
        for h, a, pc in zip(f["lh"], f["la"], p_corr):
            lh2, la2 = lambdas_for_home_win(h + a, float(pc), f["p_ot_fn"], f["tau"])
            served.append(ScoreDistribution(lh2, la2, f["p_ot_fn"](lh2, la2), f["tau"]))
        bets["brut"] += _served_bets(f["raw"], f["cur"], s, snaps, "brut")
        bets["servi"] += _served_bets(served, f["cur"], s, snaps, "servi")
        used.append(int(s))
    if not used:
        print("ERREUR : aucune saison avec assez d'historique pour la correction.")
        return None

    # ── 3. Règle en service, par modèle × marché × source ───────────────────
    rules = {"moneyline": SERVED_ML_BAND, "puckline": (SERVED_PL_MIN, None)}
    out = {"protocol": {
               "chain": "modele de score (fold) -> correction C walk-forward -> lambdas "
                        "recales -> edge contre le prix du matin, meme livre",
               "rules": {"moneyline": {"edge_min": SERVED_ML_BAND[0], "edge_max": SERVED_ML_BAND[1],
                                       "ev_min": 0.0},
                         "puckline": {"leg": "-1.5", "edge_min": SERVED_PL_MIN, "ev_min": 0.0}},
               "verdict": "n < min -> NON TRANCHABLE ; ROI z <= -2 ou CLV net z < 0 -> REJETEE ; "
                          "CLV net z >= 2 -> CONFIRMEE ; sinon NON TRANCHABLE",
               "deciding_source": "prix de production (The Odds API) ; SBRO = contexte",
               "min_n": SERVED_MIN_N, "sources": SOURCE_DEFINITIONS},
           "seasons": used, "snapshots": snap_stats, "current_rule": {}, "verdict": {},
           "grid": {}, "best_candidate": {}}
    hdr = (f"   {'':>6} {'paris':>7} {'hit':>7} {'ROI':>10} {'z':>6} "
           f"{'CLV net':>9} {'ROI clot.':>10} {'ecart':>8}")
    for model in ("brut", "servi"):
        out["current_rule"][model] = {}
        for market, (lo, hi) in rules.items():
            out["current_rule"][model][market] = {}
            for src in sorted({b["source"] for b in bets[model] if b["market"] == market}):
                pool = [b for b in bets[model] if b["market"] == market and b["source"] == src]
                sel = _served_select(pool, market, lo, hi)
                if not sel:
                    continue
                blk = _clv_block(sel, pool, leg="-1.5" if market == "puckline" else None)
                out["current_rule"][model][market][src] = blk
                if model == "servi":
                    out["verdict"].setdefault(market, {})[src] = _served_verdict(blk, market)
                print(f"\n   [{model}] {market} [{src}] — regle en service")
                print(hdr)
                _print_clv_row("", blk)
                if model == "servi":
                    print(f"   → {out['verdict'][market][src]}")

    # ── 4. Grille de bandes (modèle servi) — piste, pas une règle ───────────
    for market, grid in SERVED_GRID.items():
        out["grid"][market], out["best_candidate"][market] = {}, {}
        for src in sorted({b["source"] for b in bets["servi"] if b["market"] == market}):
            pool = [b for b in bets["servi"] if b["market"] == market and b["source"] == src]
            rows = []
            for lo, hi in grid:
                sel = _served_select(pool, market, lo, hi)
                if not sel:
                    continue
                blk = _clv_block(sel, pool, leg="-1.5" if market == "puckline" else None)
                rows.append({"edge_min": lo, "edge_max": hi, **{k: blk[k] for k in (
                    "n_bets", "hit_rate", "roi_open_pct", "roi_se_pct", "z",
                    "clv_net", "clv_net_z")}})
            out["grid"][market][src] = rows
            ok_rows = [x for x in rows if x["n_bets"] >= SERVED_MIN_N[market]
                       and np.isfinite(x["z"]) and x["z"] > -1 and x["clv_net_z"] is not None]
            if ok_rows:
                best = max(ok_rows, key=lambda x: x["clv_net_z"])
                out["best_candidate"][market][src] = {
                    **best, "selected_on_same_data": True,
                    "note": "piste a confirmer sur une saison non vue, pas une regle"}
                hi_txt = f"{best['edge_max']:.0%}" if best["edge_max"] is not None else "∞"
                print(f"   grille {market} [{src}] : meilleure bande {best['edge_min']:.0%}–{hi_txt} "
                      f"(n {best['n_bets']}, ROI {best['roi_open_pct']:+.2f} %, "
                      f"CLV net z {best['clv_net_z']:+.2f}) — choisie sur ces memes donnees")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-season", type=int, default=2012)
    ap.add_argument("--edge", type=float, default=None,
                    help="Si fourni, détaille un seuil d'edge unique par saison")
    ap.add_argument("--uncertainty", action="store_true",
                    help="P4 : modèle de score + ensemble bootstrap, compare "
                         "Kelly nu et Kelly réduit par σ sur le drawdown")
    ap.add_argument("--derived", action="store_true",
                    help="ROI des totaux et de la puck line avec les VRAIS prix "
                         "SBRO (over/under et puck line), push gérés")
    ap.add_argument("--permutations", type=int, default=200,
                    help="Tirages du test de permutation sur l'avantage de σ "
                         "à exposition égale (0 = désactivé)")
    ap.add_argument("--members", type=int, default=10,
                    help="Membres bootstrap par fold en mode --uncertainty "
                         "(10 par défaut : 20 doublerait un temps déjà long)")
    ap.add_argument("--search-trials", type=int, default=8,
                    help="Essais de recherche d'hyperparamètres PAR FOLD, sur "
                         "une tranche interne au train du fold. 0 relit "
                         "score_report.json et réintroduit une fuite (params "
                         "choisis sur un split qui recouvre des saisons de test)")
    ap.add_argument("--clv", action="store_true",
                    help="A3 : ROI aux prix d'OUVERTURE et closing line value. "
                         "Répond à « le modèle bat-il l'ouverture ? » et mesure "
                         "si le prix pris est meilleur que la clôture. "
                         "Résultats PAR SOURCE ; la puck line (et la règle A2) "
                         "n'y figure que pour les lignes API, SBRO n'en donnant "
                         "qu'un seul prix par match")
    ap.add_argument("--select-score-features", action="store_true",
                    help="A5 : ablation laisser-une-de-côté des features du "
                         "modèle de score, saison par saison. N'écrit qu'un "
                         "rapport — n'élague rien tout seul")
    ap.add_argument("--confirm-score-features", action="store_true",
                    help="A5, étape de confirmation : compare le jeu de "
                         "features RÉELLEMENT élagué (celui de train_score.py "
                         "à l'instant du run) aux références par saison de "
                         "score_feature_selection.json. 1 entraînement par "
                         "saison au lieu de 26 — le classement se fait par "
                         "permutation, la confirmation par suppression")
    ap.add_argument("--keep-share", type=float, default=0.70,
                    help="Part des saisons où le gain doit être positif pour "
                         "garder une feature (A5, 0.70 comme P5)")
    ap.add_argument("--sentinels", type=int, default=3,
                    help="Colonnes de bruit pur soumises à la même ablation "
                         "(A5). Elles étalonnent empiriquement ce que la "
                         "procédure donne pour rien : une feature doit les "
                         "battre. Plus il y en a, plus la barre est nette")
    ap.add_argument("--recency", action="store_true",
                    help="Poids du récent : mesure A (features d'équipe par "
                         "saison, k=5 et 15) et B (poids d'entraînement par "
                         "saison, H=4 et 8) contre le modèle actuel. Critère "
                         "d'adoption fixé dans le code. N'écrit qu'un rapport")
    ap.add_argument("--in-season", action="store_true",
                    help="Apprentissage en cours de saison : figé contre "
                         "réentraîné sur 75 %% de la saison (test sur les 25 %% "
                         "finaux, chronologique) et contre un réentraînement "
                         "trimestriel ; comparé au marché. N'écrit qu'un rapport")
    ap.add_argument("--split", choices=["chrono", "random"], default="chrono",
                    help="Avec --in-season : 'chrono' (défaut) coupe la saison à "
                         "25/50/75 %%, 'random' tire 75 %% des matchs au hasard "
                         "pour l'entraînement et teste sur les 25 %% restants")
    ap.add_argument("--regimes", action="store_true",
                    help="Régimes d'entraînement contre le modèle figé : fenêtre "
                         "des 6 dernières saisons, réentraînement hebdomadaire, "
                         "et les deux. Saisons >= 2015. N'écrit qu'un rapport")
    ap.add_argument("--market-gap", action="store_true",
                    help="Décompose l'écart de log-loss modèle - marché par type "
                         "de match et par feature (modèle figé, walk-forward). "
                         "N'écrit qu'un rapport")
    ap.add_argument("--score-v2", action="store_true",
                    help="Modèle de score v2 contre l'actuel : features de fatigue "
                         "adverse, gardien de relève, xG%% long terme (F), étirement "
                         "gamma des intensites (G), et les deux (FG). N'écrit qu'un rapport")
    ap.add_argument("--recal", action="store_true",
                    help="Recalibration de la pente du moneyline, ajustee sur les "
                         "saisons passees seulement (walk-forward strict). "
                         "N'ecrit qu'un rapport")
    ap.add_argument("--correction", action="store_true",
                    help="Couche de correction (logit p + features de --market-gap) "
                         "au-dessus du modele de score, walk-forward strict. "
                         "N'ecrit qu'un rapport, sauf avec --write-layer")
    ap.add_argument("--write-layer", action="store_true",
                    help="Avec --correction : ecrit aussi correction_layer.json (la "
                         "couche servie par ml_service), SEULEMENT si le verdict est ADOPTER")
    ap.add_argument("--served", action="store_true",
                    help="Value bets : la chaine SERVIE (modele de score + correction + "
                         "lambdas recales) contre le prix du matin, regle en service, "
                         "CLV et placebo ; verdict sur la regle + grille de bandes")
    ap.add_argument("--no-param-cache", action="store_true",
                    help="Ignore le cache des hyperparamètres par fold "
                         "(fold_params_cache.json)")
    args = ap.parse_args()

    df = pd.read_csv(DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(season_of)

    # A5 ne regarde que la qualité des λ — aucun prix n'intervient. Il passe donc
    # AVANT le garde sur les cotes, sinon un dataset sans cotes interdirait une
    # mesure qui n'en a pas besoin.
    if args.correction:
        cseasons = [s for s in sorted(df["season"].unique())
                    if s >= args.min_season and (df["season"] < s).sum() >= 800
                    and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
        print(f"   Couche de correction — {len(cseasons)} saisons predites")
        res = run_correction(df, cseasons, args.search_trials,
                             use_cache=not args.no_param_cache)
        if res:
            with open(CORRECTION_REPORT, "w", encoding="utf-8") as fh:
                json.dump(res, fh, indent=2)
            print(f"\nOK {CORRECTION_REPORT.split('/')[-1]} -> {MODELS}/")
            if args.write_layer:
                if res["variants"]["C"]["verdict"] != "ADOPTER":
                    print("   couche NON ecrite : le verdict de C n'est pas ADOPTER")
                else:
                    with open(CORRECTION_LAYER, "w", encoding="utf-8") as fh:
                        json.dump({**res["layer"], "variant": "C",
                                   "measured": {k: res["variants"]["C"][k] for k in
                                                ("delta", "z", "z_seasons", "share_seasons_better")}},
                                  fh, indent=2)
                    print(f"OK {CORRECTION_LAYER.split('/')[-1]} -> {MODELS}/ (servie par ml_service)")
        return

    if args.served:
        sseasons = [s for s in sorted(df["season"].unique())
                    if s >= args.min_season and (df["season"] < s).sum() >= 800
                    and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
        snaps, snap_stats = load_snapshot_pairs()
        print(f"   Value bets, chaine servie — {len(sseasons)} saisons predites, "
              f"correction des la {RECAL_MIN_SEASONS + 1}e ; "
              f"{snap_stats['ml_pairs']} paires moneyline API")
        res = run_served(df, sseasons, args.search_trials,
                         use_cache=not args.no_param_cache, snaps=snaps, snap_stats=snap_stats)
        if res:
            with open(SERVED_REPORT, "w", encoding="utf-8") as fh:
                json.dump(res, fh, indent=2, default=float)
            print(f"\nOK {SERVED_REPORT.split('/')[-1]} -> {MODELS}/")
        return

    if args.recal:
        rseasons = [s for s in sorted(df["season"].unique())
                    if s >= args.min_season and (df["season"] < s).sum() >= 800
                    and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
        print(f"   Recalibration de la pente — {len(rseasons)} saisons predites")
        res = run_recal(df, rseasons, args.search_trials,
                        use_cache=not args.no_param_cache)
        if res:
            with open(RECAL_REPORT, "w", encoding="utf-8") as fh:
                json.dump(res, fh, indent=2)
            print(f"\nOK {RECAL_REPORT.split('/')[-1]} -> {MODELS}/")
        return

    if args.score_v2:
        vseasons = [s for s in sorted(df["season"].unique())
                    if s >= args.min_season and (df["season"] < s).sum() >= 800
                    and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
        print(f"   Modele de score v2 — {len(vseasons)} saisons testees")
        res = run_score_v2(df, vseasons, args.search_trials,
                           use_cache=not args.no_param_cache)
        if res:
            with open(V2_REPORT, "w", encoding="utf-8") as fh:
                json.dump(res, fh, indent=2)
            print(f"\nOK {V2_REPORT.split('/')[-1]} -> {MODELS}/")
        return

    if args.market_gap:
        mseasons = [s for s in sorted(df["season"].unique())
                    if s >= args.min_season and (df["season"] < s).sum() >= 800
                    and df.loc[df["season"] == s, "market_home_p_close"].notna().sum() >= 50]
        print(f"   Ecart au marche — {len(mseasons)} saisons avec cotes")
        res = run_market_gap(df, mseasons, args.search_trials,
                             use_cache=not args.no_param_cache)
        if res:
            with open(GAP_REPORT, "w", encoding="utf-8") as fh:
                json.dump(res, fh, indent=2)
            print(f"\nOK {GAP_REPORT.split('/')[-1]} -> {MODELS}/")
        return

    if args.regimes:
        gseasons = [s for s in sorted(df["season"].unique())
                    if s >= max(args.min_season, REGIME_MIN_SEASON)
                    and (df["season"] < s).sum() >= 800
                    and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 200]
        print(f"   Régimes d'entraînement — {len(gseasons)} saisons testées")
        res = run_regimes(df, gseasons, args.search_trials,
                          use_cache=not args.no_param_cache)
        if res:
            with open(REGIMES_REPORT, "w", encoding="utf-8") as fh:
                json.dump(res, fh, indent=2)
            print(f"\nOK {REGIMES_REPORT.split('/')[-1]} -> {MODELS}/")
        return

    if args.in_season:
        iseasons = [s for s in sorted(df["season"].unique())
                    if s >= args.min_season
                    and (df["season"] < s).sum() >= 800
                    and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 200]
        print(f"   Apprentissage en saison — {len(iseasons)} saisons testées, "
              f"découpage {args.split}")
        if args.split == "random":
            res = run_in_season_random(df, iseasons, args.search_trials,
                                       use_cache=not args.no_param_cache)
            out_path = IN_SEASON_RANDOM_REPORT
        else:
            res = run_in_season(df, iseasons, args.search_trials,
                                use_cache=not args.no_param_cache)
            out_path = IN_SEASON_REPORT
        if res:
            with open(out_path, "w", encoding="utf-8") as fh:
                json.dump(res, fh, indent=2)
            print(f"\nOK {out_path.split('/')[-1]} -> {MODELS}/")
        return

    if args.recency:
        # Mêmes saisons que A5 : l'historique disponible, pas les cotes.
        rseasons = [s for s in sorted(df["season"].unique())
                    if s >= args.min_season
                    and (df["season"] < s).sum() >= 800
                    and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
        print(f"   Poids du récent — {len(rseasons)} saisons testées, "
              f"{args.search_trials} essais d'hyperparamètres par fold (cache)")
        res = run_recency(df, rseasons, args.search_trials,
                          use_cache=not args.no_param_cache)
        if res:
            with open(RECENCY_REPORT, "w", encoding="utf-8") as fh:
                json.dump(res, fh, indent=2)
            print(f"\nOK {RECENCY_REPORT.split('/')[-1]} -> {MODELS}/")
        return

    if args.select_score_features or args.confirm_score_features:
        # Saisons choisies sur l'historique disponible, pas sur la couverture
        # des cotes : s'y restreindre jetterait de la donnée utile. La
        # confirmation utilise EXACTEMENT le même filtre que la sélection, sans
        # quoi elle comparerait des saisons que la référence n'a pas mesurées.
        sel_seasons = [s for s in sorted(df["season"].unique())
                       if s >= args.min_season
                       and (df["season"] < s).sum() >= 800
                       and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
        if not sel_seasons:
            print("❌ Pas assez d'historique, ou cibles réglementaires absentes.")
            print("   → python build_dataset.py")
            return
        if args.confirm_score_features:
            res = run_score_feature_confirmation(
                df, sel_seasons, args.search_trials,
                use_cache=not args.no_param_cache, n_sentinels=args.sentinels)
            if res:
                json.dump(res, open(CONFIRMATION_REPORT, "w"), indent=2)
                print(f"\n✅ {CONFIRMATION_REPORT.split('/')[-1]} → {MODELS}/")
            return
        res = run_score_feature_ablation(df, sel_seasons, args.search_trials,
                                         use_cache=not args.no_param_cache,
                                         keep_share=args.keep_share,
                                         n_sentinels=args.sentinels)
        if res:
            json.dump(res, open(SELECTION_REPORT, "w"), indent=2)
            print(f"\n✅ {SELECTION_REPORT.split('/')[-1]} → {MODELS}/")
        return

    if "market_home_p_close" not in df.columns:
        print("❌ Pas de colonne cotes — relance fetch odds + build_dataset."); return

    # Jeu cœur : le modèle n'apprend pas le marché en feature (il est blendé
    # explicitement plus bas), sinon le blend double-compte la même information.
    feats = T.select_features(df, use_odds=False)
    # Params : ceux du dernier train.py si dispo, sinon défauts raisonnables
    try:
        rep = json.load(open(f"{MODELS}/training_report.json"))
        params = {k: v for k, v in rep["game_model"]["params"].items()}
    except Exception:
        params = {"max_depth": 4, "learning_rate": 0.03, "subsample": 0.8,
                  "colsample_bytree": 0.7, "min_child_weight": 5,
                  "reg_alpha": 0.1, "reg_lambda": 3.0}
    params.update({"objective": "binary:logistic", "eval_metric": "logloss",
                   "seed": 42, "_rounds": 400})

    odds_seasons = sorted(s for s in df["season"].unique()
                          if df.loc[df["season"] == s, "market_home_p_close"].notna().sum() >= 50)
    test_seasons = [s for s in odds_seasons if s >= args.min_season
                    and (df["season"] < s).sum() >= 800]
    if not test_seasons:
        print("❌ Aucune saison testable (pas assez d'historique + cotes)."); return

    print(f"📊 Walk-forward sur {len(test_seasons)} saisons : "
          f"{test_seasons[0]}-{str(test_seasons[0]+1)[2:]} → "
          f"{test_seasons[-1]}-{str(test_seasons[-1]+1)[2:]}")

    if args.clv:
        # Saisons sélectionnées sur la couverture des OUVERTURES : elle est plus
        # étroite que celle des clôtures, et une saison sans ouverture ne peut
        # rien dire ici. Deux sources d'ouverture : les colonnes SBRO du
        # dataset, et les paires lues dans la série horodatée de l'API.
        col = "market_home_p_open"
        snaps, snap_stats = load_snapshot_pairs()
        snap_keys = set(snaps)
        in_snaps = pd.Series([(str(d), str(h), str(a)) in snap_keys for d, h, a in
                              zip(df["date"], df["home_team"], df["away_team"])],
                             index=df.index)

        def n_open(s):
            m = df["season"] == s
            n_sbro = int(df.loc[m, col].notna().sum()) if col in df.columns else 0
            return max(n_sbro, int((m & in_snaps).sum()))

        cseasons = [s for s in sorted(df["season"].unique())
                    if n_open(s) >= 50
                    and s >= args.min_season and (df["season"] < s).sum() >= 800]
        if not cseasons:
            print("ERREUR : aucune saison avec assez d'ouvertures (SBRO ou API).")
            print("   -> python fetch_data_v4.py --only odds --from-local")
            print("      puis python build_dataset.py")
            return
        print(f"   A3 — CLV et ROI à l'ouverture, {len(cseasons)} saisons")
        print("   Puck line : CLV mesurable sur les seules lignes API (SBRO n'en "
              "donne qu'un prix par match).\n")
        res = run_clv(df, cseasons,
                      args.edge if args.edge is not None else 0.02,
                      search_trials=args.search_trials,
                      use_cache=not args.no_param_cache,
                      snaps=snaps, snap_stats=snap_stats)
        if res:
            with open(f"{MODELS}/backtest_clv_report.json", "w",
                      encoding="utf-8") as fh:
                json.dump(res, fh, indent=2)
            print(f"\nOK backtest_clv_report.json -> {MODELS}/")
        return

    if args.derived:
        # Saisons sélectionnées sur la couverture des PRIX dérivés, pas sur
        # celle du moneyline : les deux ne coïncident pas forcément.
        # Totaux OU puck line : les lignes API (backfill h2h,spreads) n'ont pas
        # de prix de total, la saison compte quand même par sa puck line.
        cols = [c for c in ("total_close_over", "pl_home_price") if c in df.columns]
        if not cols:
            print("❌ Pas de prix over/under dans le dataset.")
            print("   → python fetch_data_v4.py --only odds --from-local")
            print("     puis python build_dataset.py")
            return
        dseasons = [s for s in sorted(df["season"].unique())
                    if max(int(df.loc[df["season"] == s, c].notna().sum())
                           for c in cols) >= 50
                    and s >= args.min_season and (df["season"] < s).sum() >= 800]
        if not dseasons:
            print("❌ Aucune saison avec assez de prix dérivés.")
            return
        print(f"   Marchés dérivés — {len(dseasons)} saisons, prix réels")
        if args.search_trials > 0:
            print(f"   Hyperparamètres : {args.search_trials} essais par fold, "
                  f"sur une tranche interne au train du fold")
        print()
        res = run_derived(df, dseasons,
                          args.edge if args.edge is not None else 0.02,
                          search_trials=args.search_trials,
                          use_cache=not args.no_param_cache)
        if res:
            with open(f"{MODELS}/backtest_derived_report.json", "w",
                      encoding="utf-8") as fh:
                json.dump(res, fh, indent=2)
            print(f"\nOK backtest_derived_report.json -> {MODELS}/")
        return

    if args.uncertainty:
        print(f"   Mode P4 — modèle de score, {args.members} membres bootstrap "
              f"par fold\n")
        print("   ⚠️  Stress test du DIMENSIONNEMENT. P1 a montré qu'il n'y a pas "
              "d'edge\n       moneyline : ces paris ne sont pas à jouer, ils "
              "servent de banc d'essai.\n")
        res = run_uncertainty(df, test_seasons, args.members,
                              args.edge if args.edge is not None else 0.02,
                              args.permutations,
                              search_trials=args.search_trials,
                              use_cache=not args.no_param_cache)
        if res:
            json.dump(res, open(f"{MODELS}/backtest_uncertainty_report.json", "w"),
                      indent=2)
            print(f"\n✅ backtest_uncertainty_report.json → {MODELS}/")
        return

    print(f"   {len(feats)} features (cotes incluses)\n")

    all_bets = []          # (p_model, dec, won, edge) pour l'agrégat
    bet_src = []           # source du prix de chaque pari (ROI lu PAR source)
    ll_model_all, ll_mkt_all, y_all = [], [], []

    print(f"   {'saison':>8} {'matchs':>7} {'ll_modèle':>10} {'ll_marché':>10}")
    for s in test_seasons:
        train_df = df[df["season"] < s]
        test_df  = df[(df["season"] == s) & df["market_home_p_close"].notna()].copy()
        if len(test_df) < 50:
            continue
        booster, w, w_blend = fit_fold(train_df, feats, params)
        dtest = xgb.DMatrix(test_df[feats].values.astype(np.float32),
                            feature_names=feats, missing=np.nan)
        p_raw = booster.predict(dtest)
        p_cal = _sigmoid(w[0] * T._logit(p_raw) + w[1])
        p_mkt = test_df["market_home_p_close"].values
        # Blend dont les poids ont été ajustés sur le passé (cf. fit_fold).
        # Sans marché exploitable sur le fold → modèle calibré seul.
        if w_blend is not None:
            X = np.column_stack([T._logit(p_cal), T._logit(p_mkt)])
            p_model = T.apply_logistic(X, w_blend)
        else:
            p_model = p_cal

        y = test_df["home_win"].values.astype(float)
        dec_h = test_df["home_ml_close"].values
        dec_a = test_df["away_ml_close"].values
        srcs = (test_df["source"].fillna("sbro").astype(str).values
                if "source" in test_df.columns else np.array(["sbro"] * len(test_df)))
        ll_m = T.log_loss_np(y, p_model)
        ll_k = T.log_loss_np(y, p_mkt)
        ll_model_all.append(ll_m * len(y)); ll_mkt_all.append(ll_k * len(y))
        y_all.append(len(y))
        print(f"   {s}-{str(s+1)[2:]:<2} {len(test_df):>7} {ll_m:>10.4f} {ll_k:>10.4f}")

        for i in range(len(test_df)):
            if not (np.isfinite(dec_h[i]) and np.isfinite(dec_a[i])):
                continue
            for p, dec, won in [(p_model[i], dec_h[i], y[i] == 1),
                                (1 - p_model[i], dec_a[i], y[i] == 0)]:
                if dec <= 1:
                    continue
                p_imp = (1 / dec) / (1 / dec_h[i] + 1 / dec_a[i])
                all_bets.append((p, dec, won, p - p_imp))
                bet_src.append(srcs[i])

    tot = sum(y_all)
    print(f"\n   Log-loss agrégé : modèle {sum(ll_model_all)/tot:.4f}  "
          f"vs marché {sum(ll_mkt_all)/tot:.4f}  ({tot} matchs)")

    all_arr = np.array([(p, dec, won, edge) for p, dec, won, edge in all_bets])
    src_arr = np.array(bet_src)
    thresholds = [args.edge] if args.edge is not None else [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]
    # ROI PAR SOURCE : les marges diffèrent (SBRO 2,53 %, DraftKings 3,95 %),
    # un ROI agrégé sur les deux mesurerait autant le mélange que le modèle.
    # `roi` garde SBRO — la série historique que lit le tableau de bord.
    roi_by_source = {}
    for src in sorted(set(bet_src), key=lambda x: (x != "sbro", x)):
        bets = all_arr[src_arr == src]
        print(f"\n   ROI value betting [{src}] (saisons de cette source agrégées) :")
        print(f"   {'edge>':>6} {'paris':>6} {'hit%':>6} {'ROI flat':>9} {'ROI ¼Kelly':>11}")
        results = []
        for edge in thresholds:
            sel = bets[bets[:, 3] >= edge]
            if len(sel) == 0:
                print(f"   {edge:>5.0%} {0:>6}"); continue
            p, dec, won = sel[:, 0], sel[:, 1], sel[:, 2]
            profit_flat = np.where(won == 1, dec - 1, -1).sum()
            b = dec - 1
            k = np.clip((p * b - (1 - p)) / b, 0, None) * 0.25
            profit_k = np.where(won == 1, k * b, -k).sum()
            stake_k = k.sum()
            roi_f = profit_flat / len(sel) * 100
            roi_k = profit_k / stake_k * 100 if stake_k > 0 else 0
            hit = won.mean() * 100
            results.append({"edge": edge, "n_bets": int(len(sel)), "hit_rate": round(hit, 2),
                            "roi_flat_pct": round(roi_f, 2), "roi_kelly_pct": round(roi_k, 2)})
            print(f"   {edge:>5.0%} {len(sel):>6} {hit:>5.1f}% {roi_f:>8.2f}% {roi_k:>10.2f}%")
        roi_by_source[src] = results

    with open(f"{MODELS}/backtest_walkforward_report.json", "w",
              encoding="utf-8") as fh:
        json.dump({"seasons": [int(s) for s in test_seasons],
                   "n_games_with_odds": int(tot),
                   "log_loss": {"model": round(sum(ll_model_all)/tot, 4),
                                "market": round(sum(ll_mkt_all)/tot, 4)},
                   "roi": roi_by_source.get("sbro", []),
                   "roi_by_source": roi_by_source}, fh, indent=2)
    print(f"\n✅ backtest_walkforward_report.json → {MODELS}/")
    print("   Un ROI flat > 0 avec plusieurs centaines de paris sur des cotes de "
          "clôture est un très bon signe (la clôture est le prix le plus dur à battre).")


if __name__ == "__main__":
    main()
