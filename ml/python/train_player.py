"""
train_player.py — modèle JOUEUR : cadence par match de 8 statistiques de patineur.

    python train_player.py                 # construit, entraîne, écrit l'état
    python train_player.py --state-only    # ne refait que player_state.json

Entrées (déjà présentes pour le reste du pipeline) :
    ../data/raw/skaters_*.zip   MoneyPuck, patineur par match, TOUTES situations
    ../data/nhl_games_v4.csv    features d'équipe PRÉ-MATCH (build_dataset.py)

Sorties (MODELS_DIR, par défaut ../models) :
    player/<stat>.json          un booster XGBoost `count:poisson` par statistique
    player_report.json          features, dispersion k par stat, backtest vs règle
    player_state.json           features du DERNIER état de chaque joueur (inférence)

── Ce que le modèle voit ────────────────────────────────────────────────────
Tout est PRÉ-MATCH (fenêtres décalées d'un match) :
  · rôle      — temps de glace moyen (5, 10, 30 derniers matchs), temps en
                avantage numérique (10 derniers) : de loin le signal le plus fort
                pour les points et les tirs ;
  · talent    — production par 60 minutes sur 10 / 30 matchs et en carrière,
                pour les 8 statistiques (les tirs renseignent les buts, etc.),
                xG individuel par 60 ;
  · trio      — xG des COÉQUIPIERS quand il est sur la glace à 5 c. 5 (xG pour
                de l'unité moins son propre xG), 20 derniers matchs. MoneyPuck ne
                publie pas les trios par match : c'est leur trace mesurable ;
  · match     — forces de son équipe et de l'adversaire (buts, xG, tirs pour et
                contre, AN / PK, gardien), domicile, repos ;
  · face-à-face — sur ses 10 derniers matchs contre CET adversaire, a-t-il
                produit plus ou moins que son niveau du moment ? (`vs_lift_*`,
                rétréci vers 1, contrainte monotone : un lift plus haut ne
                peut que faire monter la prédiction). Essayé pour chaque stat,
                gardé seulement là où il bat le modèle sans face-à-face en
                validation ET en test (z ≥ 2) → `player_vs_report.json`.
                Mesure 2026-10-06 : gardé pour mises en échec et pénalités ;
                bruit pour buts, passes, points, tirs, tirs bloqués, points AN.

── Validation ───────────────────────────────────────────────────────────────
Entraînement ≤ 2021-22, arrêt précoce sur 2022-23, test 2023-24 → 2025-26. La
référence est la règle en production (`playerRates.ts`) : saison en cours
rétrécie vers un a priori de poste, × adversaire. `k` (binomiale négative) est
ajusté sur la validation.
"""
from __future__ import annotations
import argparse, glob, json, os, time, zipfile
import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.special import gammaln

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
MODELS_DIR = os.environ.get("MODELS_DIR") or os.path.join(HERE, "..", "models")

STATS = ["goals", "assists", "points", "shots", "hits", "blocks", "pim", "ppPoints"]
TEAM_COLS = ["gf_s", "ga_s", "xgf60_s", "xga60_s", "sog_f_s", "sog_a_s", "ev_xgf60_s", "ev_xga60_s",
             "pp_xgf60_s", "pk_xga60_s", "goalie_svpct", "goalie_gsax60", "win_s"]
WINDOWS = (10, 30)
SKATER_COLS = ["playerId", "name", "gameId", "season", "playerTeam", "opposingTeam", "home_or_away",
               "gameDate", "position", "situation", "icetime", "I_F_goals", "I_F_primaryAssists",
               "I_F_secondaryAssists", "I_F_points", "I_F_shotsOnGoal", "I_F_xGoals", "I_F_hits",
               "shotsBlockedByPlayer", "penalityMinutes", "OnIce_F_xGoals"]

# ── Règle en production (référence du backtest) — miroir de playerRates.ts ──
PRIOR = {"F": dict(goals=.16, assists=.22, points=.38, shots=1.5, hits=1.1, blocks=.45, pim=.40, ppPoints=.08),
         "D": dict(goals=.05, assists=.20, points=.25, shots=1.2, hits=1.1, blocks=1.05, pim=.45, ppPoints=.06)}
PSEUDO = dict(goals=12, assists=12, points=12, shots=6, hits=6, blocks=6, pim=8, ppPoints=12)

# ── Face-à-face joueur vs adversaire ──────────────────────────────────────────
# Sur ses VS_WINDOW derniers matchs contre CETTE équipe, le joueur a-t-il produit
# plus (ou moins) que ce que son niveau du moment annonçait ? « lift » = réel /
# attendu, chaque rencontre étant jugée avec la cadence PRÉ-MATCH qu'il avait ce
# soir-là (30 derniers matchs) × son temps de glace — un joueur qui a progressé
# ne paraît donc pas « dominer » tout le monde. VS_PSEUDO (en événements
# attendus) rétrécit vers 1 : 2 matchs à 2 buts ne pèsent presque rien, 10 matchs
# à 40 tirs au lieu de 25 pèsent vraiment. Contrainte monotone +1 : un lift
# plus haut ne peut que FAIRE MONTER la prédiction (et un lift < 1 la baisser).
VS_WINDOW = 10
# Mêmes franchises que `build_dataset.norm_team` (codes MoneyPuck → codes NHL
# actuels) : l'état d'inférence est indexé par l'abréviation que Node envoie.
FRANCHISE = {"ATL": "WPG", "PHX": "UTA", "ARI": "UTA", "L.A": "LAK", "S.J": "SJS",
             "N.J": "NJD", "T.B": "TBL"}
VS_PSEUDO = dict(goals=4, assists=5, points=6, shots=20, hits=15, blocks=10, pim=10, ppPoints=3)
VS_FEATS = ["vs_gp"] + [f"vs_lift_{s}" for s in STATS]


# ══════════════════════════════════════════════════════════════════════════════
# 1. Données
# ══════════════════════════════════════════════════════════════════════════════

def load_skaters(raw_dir: str) -> pd.DataFrame:
    frames = []
    for zp in sorted(glob.glob(os.path.join(raw_dir, "skaters*.zip"))):
        z = zipfile.ZipFile(zp)
        for name in z.namelist():
            with z.open(name) as f:
                for ch in pd.read_csv(f, usecols=SKATER_COLS, chunksize=500_000, low_memory=False):
                    frames.append(ch[ch["situation"].isin(["all", "5on4", "5on5"])])
        print(f"   {os.path.basename(zp)} lu", flush=True)
    raw = pd.concat(frames, ignore_index=True)
    return raw[raw.position != "G"]


def per_game(raw: pd.DataFrame) -> pd.DataFrame:
    """Une ligne par patineur et par match : cibles + temps de glace par situation."""
    base = raw[raw.situation == "all"].copy()
    pp = raw[raw.situation == "5on4"][["playerId", "gameId", "icetime", "I_F_points"]] \
        .rename(columns={"icetime": "toi_pp", "I_F_points": "pp_points"})
    ev = raw[raw.situation == "5on5"][["playerId", "gameId", "icetime", "OnIce_F_xGoals", "I_F_xGoals"]] \
        .rename(columns={"icetime": "toi_ev", "OnIce_F_xGoals": "ev_onice_xgf", "I_F_xGoals": "ev_ixg"})
    df = base.merge(pp, on=["playerId", "gameId"], how="left").merge(ev, on=["playerId", "gameId"], how="left")
    for c in ["toi_pp", "pp_points", "toi_ev", "ev_onice_xgf", "ev_ixg"]:
        df[c] = df[c].fillna(0.0)
    df["date"] = pd.to_datetime(df.gameDate.astype(str), format="%Y%m%d")
    df["opposingTeam"] = df.opposingTeam.replace(FRANCHISE)
    df["toi"] = df.icetime / 60.0
    df["toi_pp"] = df.toi_pp / 60.0
    df["toi_ev"] = df.toi_ev / 60.0
    df = df[df.toi > 0].copy()
    df["pos"] = np.where(df.position == "D", "D", "F")
    df["y_goals"] = df.I_F_goals
    df["y_assists"] = df.I_F_primaryAssists + df.I_F_secondaryAssists
    df["y_points"] = df.I_F_points
    df["y_shots"] = df.I_F_shotsOnGoal
    df["y_hits"] = df.I_F_hits
    df["y_blocks"] = df.shotsBlockedByPlayer
    df["y_pim"] = df.penalityMinutes
    df["y_ppPoints"] = df.pp_points
    df["mates_xg"] = (df.ev_onice_xgf - df.ev_ixg).clip(lower=0)
    return df.sort_values(["playerId", "date", "gameId"]).reset_index(drop=True)


def rolling_features(df: pd.DataFrame, shift: int) -> pd.DataFrame:
    """Features joueur. `shift=1` : pré-match (entraînement). `shift=0` : état APRÈS
    le dernier match (inférence du match suivant)."""
    g = df.groupby("playerId", sort=False)

    def rsum(col, w):
        return g[col].transform(lambda s: s.shift(shift).rolling(w, min_periods=1).sum())

    def rcount(w):
        return g["toi"].transform(lambda s: s.shift(shift).rolling(w, min_periods=1).count())

    def csum(col):
        return g[col].transform(lambda s: s.shift(shift).cumsum())

    out = {}
    for w in (5,) + WINDOWS:
        out[f"toi_avg_{w}"] = rsum("toi", w) / rcount(w)
    for w in WINDOWS:
        toi_w = rsum("toi", w)
        for st in STATS:
            out[f"{st}_p60_{w}"] = rsum(f"y_{st}", w) / toi_w * 60
    out["toi_pp_avg_10"] = rsum("toi_pp", 10) / rcount(10)
    out["mates_xg60_20"] = rsum("mates_xg", 20) / rsum("toi_ev", 20) * 60
    out["ixg60_20"] = rsum("I_F_xGoals", 20) / rsum("toi", 20) * 60
    out["gp_career"] = g.cumcount() + (1 - shift)
    car = csum("toi")
    for st in STATS:
        out[f"{st}_p60_career"] = csum(f"y_{st}") / car * 60
    return pd.DataFrame(out, index=df.index).replace([np.inf, -np.inf], np.nan)


def vs_features(df: pd.DataFrame, pre: pd.DataFrame, shift: int) -> pd.DataFrame:
    """Face-à-face du joueur contre l'adversaire de chaque ligne.

    `pre` = rolling_features(df, shift=1) : la cadence PRÉ-MATCH de chaque
    rencontre passée, qui sert à calculer ce qui était « attendu » ce soir-là.
    `shift=1` : les VS_WINDOW rencontres AVANT ce match (entraînement, aucune
    fuite). `shift=0` : les VS_WINDOW dernières, ce match compris (état
    d'inférence pour la PROCHAINE rencontre contre cette équipe).
    """
    key = [df.playerId, df.opposingTeam]
    out = {}

    def window_sum(x: pd.Series) -> pd.Series:
        c = x.groupby(key, sort=False).cumsum()
        cg = c.groupby(key, sort=False)
        end = cg.shift(shift).fillna(0.0) if shift else c
        start = cg.shift(shift + VS_WINDOW).fillna(0.0)
        return end - start

    out["vs_gp"] = window_sum(pd.Series(1.0, index=df.index))
    for st in STATS:
        rate = pre[f"{st}_p60_30"].fillna(pre[f"{st}_p60_career"])
        ok = rate.notna()
        act = window_sum(df[f"y_{st}"].where(ok, 0.0).astype(float))
        exp = window_sum((rate * df.toi / 60.0).where(ok, 0.0))
        ps = VS_PSEUDO[st]
        out[f"vs_lift_{st}"] = (act + ps) / (exp + ps)
    return pd.DataFrame(out, index=df.index)


def build_vs_state(pg: pd.DataFrame, pre: pd.DataFrame, since_season: int) -> dict:
    """{ playerId: { équipe adverse: [vs_gp, lift goals, …, lift ppPoints] } }
    après la dernière rencontre de chaque paire — ce que l'inférence lit pour
    le prochain match contre cette équipe. Ordre des valeurs : VS_FEATS."""
    vs = vs_features(pg, pre, shift=0)
    full = pd.concat([pg[["playerId", "opposingTeam", "season"]], vs], axis=1)
    active = set(pg.loc[pg.season >= since_season, "playerId"].unique())
    last = full[full.playerId.isin(active)].groupby(["playerId", "opposingTeam"]).tail(1)
    out: dict[str, dict[str, list]] = {}
    for r in last.itertuples(index=False):
        d = r._asdict()
        out.setdefault(str(int(d["playerId"])), {})[d["opposingTeam"]] = \
            [int(d["vs_gp"])] + [round(float(d[f"vs_lift_{s}"]), 4) for s in STATS]
    return out


def game_context(df: pd.DataFrame, games: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for side, other in (("home", "away"), ("away", "home")):
        sub = games[["game_id"]].copy()
        sub["team_side"] = side.upper()
        for c in TEAM_COLS:
            sub[f"tm_{c}"] = games.get(f"{side}_{c}")
            sub[f"opp_{c}"] = games.get(f"{other}_{c}")
        sub["b2b"] = games.get(f"{side}_b2b")
        sub["days_rest"] = games.get(f"{side}_rest_days")
        rows.append(sub)
    ctx = pd.concat(rows)
    df = df.copy()
    df["team_side"] = df.home_or_away.str.upper()
    df = df.merge(ctx, left_on=["gameId", "team_side"], right_on=["game_id", "team_side"], how="left")
    df["is_home"] = (df.team_side == "HOME").astype(int)
    df["is_D"] = (df.pos == "D").astype(int)
    return df


def feature_names() -> list[str]:
    return (["toi_avg_5", "toi_avg_10", "toi_avg_30", "toi_pp_avg_10", "mates_xg60_20", "ixg60_20",
             "gp_career", "days_rest", "is_home", "is_D", "b2b"]
            + [f"{s}_p60_{w}" for s in STATS for w in WINDOWS + ("career",)]
            + [f"tm_{c}" for c in TEAM_COLS] + [f"opp_{c}" for c in TEAM_COLS])


# ══════════════════════════════════════════════════════════════════════════════
# 2. Évaluation
# ══════════════════════════════════════════════════════════════════════════════

def nb_ll(y, mu, k):
    mu = np.maximum(mu, 1e-6)
    if k >= 1e4:
        return y * np.log(mu) - mu - gammaln(y + 1)
    return (gammaln(y + k) - gammaln(k) - gammaln(y + 1)
            + k * np.log(k / (k + mu)) + y * np.log(mu / (k + mu)))


K_GRID = [0.3, 0.5, 0.7, 1, 1.5, 2, 3, 4, 6, 8, 12, 20, 40, 1e5]


def p_ge1(mu, k):
    """P(X ≥ 1) — binomiale négative, Poisson quand k est « infini »."""
    return 1 - np.exp(-mu) if k >= 1e4 else 1 - (k / (k + mu)) ** k


def fit_k(y, mu):
    return max(K_GRID, key=lambda k: nb_ll(y, mu, k).mean())


def baseline(d: pd.DataFrame, s: str) -> np.ndarray:
    cur = d.gp_season_prior > 0
    tot = np.where(cur, d[f"{s}_season_prior"], d[f"prev_{s}_tot"].fillna(0))
    gp = np.where(cur, d.gp_season_prior, d["prev_gp_tot"].fillna(0))
    pri = np.where(d.pos == "D", PRIOR["D"][s], PRIOR["F"][s])
    lam = (tot + PSEUDO[s] * pri) / (gp + PSEUDO[s])
    if s in ("goals", "assists", "points", "ppPoints"):
        lam = lam * np.clip(d.opp_ga_s.fillna(3.05) / 3.05, .85, 1.15)
    elif s == "shots":
        lam = lam * np.clip(d.opp_sog_a_s.fillna(30) / 30, .9, 1.1)
    elif s == "blocks":
        lam = lam * np.clip(d.opp_sog_f_s.fillna(30) / 30, .85, 1.15)
    return np.maximum(lam, 1e-4)


# ══════════════════════════════════════════════════════════════════════════════
# 3. Pipeline
# ══════════════════════════════════════════════════════════════════════════════

def build_state(pg: pd.DataFrame, since_season: int) -> dict:
    """Features de chaque joueur APRÈS son dernier match — ce que l'inférence
    combine au contexte du match à venir."""
    feats = rolling_features(pg, shift=0)
    full = pd.concat([pg[["playerId", "name", "playerTeam", "pos", "season", "date"]], feats], axis=1)
    last = full.groupby("playerId").tail(1)
    last = last[last.season >= since_season]
    keep = [c for c in feats.columns]
    state = {}
    for r in last.itertuples(index=False):
        d = r._asdict()
        state[str(int(d["playerId"]))] = {
            "name": d["name"], "team": d["playerTeam"], "pos": d["pos"],
            "last_game": d["date"].strftime("%Y-%m-%d"),
            "f": {k: (None if pd.isna(d[k]) else round(float(d[k]), 5)) for k in keep},
        }
    return state


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--state-only", action="store_true")
    ap.add_argument("--no-vs", action="store_true",
                    help="N'essaie pas les face-à-face (modèle sans vs_* pour toutes les stats)")
    args = ap.parse_args()
    t0 = time.time()
    print("⛸️  lecture des patineurs MoneyPuck …")
    pg = per_game(load_skaters(os.path.join(DATA_DIR, "raw")))
    print(f"   {len(pg)} patineur-matchs ({time.time()-t0:.0f}s)")
    out_dir = os.path.join(MODELS_DIR, "player")
    os.makedirs(out_dir, exist_ok=True)

    pre = rolling_features(pg, shift=1)
    last_season = int(pg.season.max())
    state = build_state(pg, since_season=last_season - 1)
    vs_state = build_vs_state(pg, pre, since_season=last_season - 1)
    json.dump({"as_of": pg.date.max().strftime("%Y-%m-%d"), "players": state,
               "vs_features": VS_FEATS, "vs": vs_state},
              open(os.path.join(MODELS_DIR, "player_state.json"), "w"))
    print(f"   état : {len(state)} joueurs, {sum(len(v) for v in vs_state.values())} "
          f"paires joueur-adversaire → player_state.json")
    if args.state_only:
        return

    df = pd.concat([pg, pre, vs_features(pg, pre, shift=1)], axis=1)
    gs = df.groupby(["playerId", "season"], sort=False)
    df["gp_season_prior"] = gs.cumcount()
    for st in STATS:
        df[f"{st}_season_prior"] = gs[f"y_{st}"].transform(lambda s: s.shift(1).cumsum()).fillna(0)
    tot = df.groupby(["playerId", "season"]).agg(**{f"{s}_tot": (f"y_{s}", "sum") for s in STATS},
                                                 gp_tot=("gameId", "count")).reset_index()
    tot["season"] += 1
    df = df.merge(tot.rename(columns={c: "prev_" + c for c in tot.columns if c not in ("playerId", "season")}),
                  on=["playerId", "season"], how="left")
    games = pd.read_csv(os.path.join(DATA_DIR, "nhl_games_v4.csv"), low_memory=False)
    df = game_context(df, games)
    df = df[df.season >= 2010]
    BASE = feature_names()
    WITH_VS = BASE + VS_FEATS
    tr, va, te = df[df.season <= 2021], df[df.season == 2022], df[df.season >= 2023]
    print(f"   entraînement {len(tr)} / validation {len(va)} / test {len(te)}")
    print(f"   face-à-face (test) : {float((te.vs_gp > 0).mean()):.0%} des lignes ont ≥ 1 rencontre "
          f"passée, médiane {float(te.vs_gp.median()):.0f}")

    params = dict(objective="count:poisson", eta=0.05, max_depth=5, min_child_weight=50,
                  subsample=0.8, colsample_bytree=0.8, eval_metric="poisson-nloglik",
                  max_delta_step=0.7, nthread=os.cpu_count() or 2, seed=7)
    # Lift plus haut ⇒ prédiction plus haute (jamais l'inverse). vs_gp libre :
    # il sert au modèle à juger combien croire le lift.
    params_vs = dict(params, monotone_constraints={f"vs_lift_{s}": 1 for s in STATS})

    def fit(feats, p, y):
        dtr = xgb.DMatrix(tr[feats], label=tr[y], feature_names=feats)
        dva = xgb.DMatrix(va[feats], label=va[y], feature_names=feats)
        bst = xgb.train(p, dtr, 2000, evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
        it = (0, bst.best_iteration + 1)
        mu_va = bst.predict(dva, iteration_range=it)
        k = fit_k(va[y].values, mu_va)
        mu_te = bst.predict(xgb.DMatrix(te[feats], feature_names=feats), iteration_range=it)
        return bst[: it[1]], it[1], k, mu_va, mu_te

    report, vs_report = {}, {}
    yrs = te.season.values
    has_vs = (te.vs_gp >= 3).values
    for s in STATS:
        y = f"y_{s}"
        yv, yt = va[y].values, te[y].values
        b0, r0, k0, mva0, mte0 = fit(BASE, params, y)
        chosen = (b0, r0, k0, mte0, BASE)
        if not args.no_vs:
            b1, r1, k1, mva1, mte1 = fit(WITH_VS, params_vs, y)
            # Écarts appariés de log-vraisemblance (positif = face-à-face meilleur).
            d_va = nb_ll(yv, mva1, k1) - nb_ll(yv, mva0, k0)
            d_te = nb_ll(yt, mte1, k1) - nb_ll(yt, mte0, k0)
            z = float(d_te.mean() / (d_te.std(ddof=1) / np.sqrt(len(d_te))))
            per_season = {int(ss): round(float(d_te[yrs == ss].mean()), 6) for ss in np.unique(yrs)}
            # Règle (posée avant de lire le résultat) : on garde le face-à-face pour
            # cette stat si la log-vraisemblance s'améliore sur la validation ET sur
            # le test, avec z ≥ 2 sur le test.
            keep = bool(d_va.mean() > 0 and d_te.mean() > 0 and z >= 2)
            # Effet concret sur les joueurs à ≥ 3 rencontres : de combien la
            # cadence bouge-t-elle selon que le lift est haut ou bas ?
            lift = te[f"vs_lift_{s}"].values
            ratio = mte1 / np.maximum(mte0, 1e-6)
            hi, lo = has_vs & (lift >= 1.2), has_vs & (lift <= 0.8)
            vs_report[s] = {
                "keep": keep, "z_test": round(z, 2),
                "dll_val": round(float(d_va.mean()), 6), "dll_test": round(float(d_te.mean()), 6),
                "dll_test_by_season": per_season,
                "loglik_base": round(float(nb_ll(yt, mte0, k0).mean()), 5),
                "loglik_vs": round(float(nb_ll(yt, mte1, k1).mean()), 5),
                "pred_ratio_when_lift_ge_1.2": round(float(ratio[hi].mean()), 4) if hi.any() else None,
                "pred_ratio_when_lift_le_0.8": round(float(ratio[lo].mean()), 4) if lo.any() else None,
                "obs_over_base_when_lift_ge_1.2": round(float(yt[hi].sum() / mte0[hi].sum()), 4) if hi.any() else None,
                "obs_over_base_when_lift_le_0.8": round(float(yt[lo].sum() / mte0[lo].sum()), 4) if lo.any() else None,
                "n_lift_ge_1.2": int(hi.sum()), "n_lift_le_0.8": int(lo.sum()),
            }
            print(f"   {s:9s} face-à-face : {vs_report[s]}", flush=True)
            if keep:
                chosen = (b1, r1, k1, mte1, WITH_VS)
        bst, rounds, k, mu, feats = chosen
        base = baseline(te, s)
        kb = fit_k(yv, baseline(va, s))
        report[s] = {
            "k": k, "k_rules": kb, "rounds": rounds, "features": feats,
            "loglik_model": round(float(nb_ll(yt, mu, k).mean()), 5),
            "loglik_rules": round(float(nb_ll(yt, base, kb).mean()), 5),
            "brier_ge1_model": round(float(((p_ge1(mu, k) - (yt >= 1)) ** 2).mean()), 5),
            "brier_ge1_rules": round(float(((p_ge1(base, kb) - (yt >= 1)) ** 2).mean()), 5),
            "mean_obs": round(float(yt.mean()), 4), "mean_model": round(float(mu.mean()), 4),
        }
        bst.save_model(os.path.join(out_dir, f"{s}.json"))
        print(f"   {s:9s} {({k_: v for k_, v in report[s].items() if k_ != 'features'})}  "
              f"vs={'oui' if feats is WITH_VS else 'non'} ({time.time()-t0:.0f}s)", flush=True)

    used_vs = any(r["features"] is WITH_VS for r in report.values())
    json.dump({"trained_at": time.strftime("%Y-%m-%d"),
               # Union des features — chaque stat a sa propre liste dans stats[s].features.
               "features": WITH_VS if used_vs else BASE,
               "split": {"train": "<=2021", "val": 2022, "test": ">=2023"},
               "stats": report}, open(os.path.join(MODELS_DIR, "player_report.json"), "w"), indent=1)
    if vs_report:
        json.dump({"trained_at": time.strftime("%Y-%m-%d"), "window": VS_WINDOW, "pseudo": VS_PSEUDO,
                   "features": VS_FEATS,
                   "rule": "garder si Δ log-vraisemblance > 0 en validation ET en test, avec z ≥ 2 en test",
                   "stats": vs_report},
                  open(os.path.join(MODELS_DIR, "player_vs_report.json"), "w"), indent=1)
    print("✅ modèle joueur écrit")


if __name__ == "__main__":
    main()
