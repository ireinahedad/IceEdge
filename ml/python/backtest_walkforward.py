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
suppression réelle.
"""

import argparse
import hashlib
import json

import numpy as np
import pandas as pd
import xgboost as xgb

import train as T   # réutilise select_features, fit_logistic, _logit, métriques
import train_score as TS
from score_model import (ScoreDistribution, ScoreEnsemble, fit_margin_correction,
                         uncertainty_haircut)

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
                       season=None, use_cache: bool = True) -> dict:
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

    s_in = TS.stack(tr_df.iloc[:cut].reset_index(drop=True))
    s_va = TS.stack(tr_df.iloc[cut:].reset_index(drop=True))
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
                    bets.append({"market": "total", "season": s, "date": r["date"],
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
                    bets.append({"market": "puckline", "season": s, "date": r["date"],
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

    out = {"edge_threshold": edge_threshold, "markets": {}}
    for market in ("total", "puckline"):
        sel_all = [b for b in bets if b["market"] == market]
        if not sel_all:
            continue
        print(f"\n   ── {market.upper()} — {len(sel_all)} paris possibles ──")
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
    print("\n   Rappel : marge bookmaker mesurée 4.43 %. Un ROI flat positif sur "
          "des prix\n   de clôture réels, avec plusieurs centaines de paris, serait "
          "le premier\n   edge exploitable trouvé dans ce plan.")
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
    contrôle finale, réentraîner sans les « RETIRER » et vérifier que la métrique
    ne se dégrade pas. Classement par permutation, confirmation par suppression.
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
    print("   Contrôle avant d'appliquer : réentraîner en SUPPRIMANT réellement "
          "les\n   « RETIRER » et vérifier que la log-loss puck line NE MONTE "
          "PAS. Le classement\n   se fait par permutation, la confirmation par "
          "suppression.")

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
    ap.add_argument("--select-score-features", action="store_true",
                    help="A5 : ablation laisser-une-de-côté des features du "
                         "modèle de score, saison par saison. N'écrit qu'un "
                         "rapport — n'élague rien tout seul")
    ap.add_argument("--keep-share", type=float, default=0.70,
                    help="Part des saisons où le gain doit être positif pour "
                         "garder une feature (A5, 0.70 comme P5)")
    ap.add_argument("--sentinels", type=int, default=3,
                    help="Colonnes de bruit pur soumises à la même ablation "
                         "(A5). Elles étalonnent empiriquement ce que la "
                         "procédure donne pour rien : une feature doit les "
                         "battre. Plus il y en a, plus la barre est nette")
    ap.add_argument("--no-param-cache", action="store_true",
                    help="Ignore le cache des hyperparamètres par fold "
                         "(fold_params_cache.json)")
    args = ap.parse_args()

    df = pd.read_csv(DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(season_of)

    # A5 ne regarde que la qualité des λ — aucun prix n'intervient. Il passe donc
    # AVANT le garde sur les cotes, sinon un dataset sans cotes interdirait une
    # mesure qui n'en a pas besoin.
    if args.select_score_features:
        # Saisons choisies sur l'historique disponible, pas sur la couverture
        # des cotes : s'y restreindre jetterait de la donnée utile.
        sel_seasons = [s for s in sorted(df["season"].unique())
                       if s >= args.min_season
                       and (df["season"] < s).sum() >= 800
                       and df.loc[df["season"] == s, "home_reg_score"].notna().sum() >= 50]
        if not sel_seasons:
            print("❌ Pas assez d'historique, ou cibles réglementaires absentes.")
            print("   → python build_dataset.py")
            return
        res = run_score_feature_ablation(df, sel_seasons, args.search_trials,
                                         use_cache=not args.no_param_cache,
                                         keep_share=args.keep_share,
                                         n_sentinels=args.sentinels)
        if res:
            json.dump(res, open(f"{MODELS}/score_feature_selection.json", "w"),
                      indent=2)
            print(f"\n✅ score_feature_selection.json → {MODELS}/")
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

    if args.derived:
        # Saisons sélectionnées sur la couverture des PRIX dérivés, pas sur
        # celle du moneyline : les deux ne coïncident pas forcément.
        col = "total_close_over"
        if col not in df.columns:
            print("❌ Pas de prix over/under dans le dataset.")
            print("   → python fetch_data_v4.py --only odds --from-local")
            print("     puis python build_dataset.py")
            return
        dseasons = [s for s in sorted(df["season"].unique())
                    if df.loc[df["season"] == s, col].notna().sum() >= 50
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
            json.dump(res, open(f"{MODELS}/backtest_derived_report.json", "w"),
                      indent=2)
            print(f"\n✅ backtest_derived_report.json → {MODELS}/")
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

    all_bets = []          # (p_model, dec, won) pour l'agrégat
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

    tot = sum(y_all)
    print(f"\n   Log-loss agrégé : modèle {sum(ll_model_all)/tot:.4f}  "
          f"vs marché {sum(ll_mkt_all)/tot:.4f}  ({tot} matchs)")

    bets = np.array([(p, dec, won, edge) for p, dec, won, edge in all_bets])
    print(f"\n   ROI value betting (toutes saisons agrégées) :")
    print(f"   {'edge>':>6} {'paris':>6} {'hit%':>6} {'ROI flat':>9} {'ROI ¼Kelly':>11}")
    results = []
    thresholds = [args.edge] if args.edge is not None else [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]
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

    json.dump({"seasons": [int(s) for s in test_seasons],
               "n_games_with_odds": int(tot),
               "log_loss": {"model": round(sum(ll_model_all)/tot, 4),
                            "market": round(sum(ll_mkt_all)/tot, 4)},
               "roi": results},
              open(f"{MODELS}/backtest_walkforward_report.json", "w"), indent=2)
    print(f"\n✅ backtest_walkforward_report.json → {MODELS}/")
    print("   Un ROI flat > 0 avec plusieurs centaines de paris sur des cotes de "
          "clôture est un très bon signe (la clôture est le prix le plus dur à battre).")


if __name__ == "__main__":
    main()
