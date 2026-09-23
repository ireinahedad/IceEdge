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
                contre, AN / PK, gardien), domicile, repos.

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
    args = ap.parse_args()
    t0 = time.time()
    print("⛸️  lecture des patineurs MoneyPuck …")
    pg = per_game(load_skaters(os.path.join(DATA_DIR, "raw")))
    print(f"   {len(pg)} patineur-matchs ({time.time()-t0:.0f}s)")
    out_dir = os.path.join(MODELS_DIR, "player")
    os.makedirs(out_dir, exist_ok=True)

    last_season = int(pg.season.max())
    state = build_state(pg, since_season=last_season - 1)
    json.dump({"as_of": pg.date.max().strftime("%Y-%m-%d"), "players": state},
              open(os.path.join(MODELS_DIR, "player_state.json"), "w"))
    print(f"   état : {len(state)} joueurs → player_state.json")
    if args.state_only:
        return

    df = pd.concat([pg, rolling_features(pg, shift=1)], axis=1)
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
    FEATS = feature_names()
    tr, va, te = df[df.season <= 2021], df[df.season == 2022], df[df.season >= 2023]
    print(f"   entraînement {len(tr)} / validation {len(va)} / test {len(te)}")

    report = {}
    params = dict(objective="count:poisson", eta=0.05, max_depth=5, min_child_weight=50,
                  subsample=0.8, colsample_bytree=0.8, eval_metric="poisson-nloglik",
                  max_delta_step=0.7, nthread=os.cpu_count() or 2, seed=7)
    for s in STATS:
        y = f"y_{s}"
        dtr = xgb.DMatrix(tr[FEATS], label=tr[y], feature_names=FEATS)
        dva = xgb.DMatrix(va[FEATS], label=va[y], feature_names=FEATS)
        bst = xgb.train(params, dtr, 2000, evals=[(dva, "val")], early_stopping_rounds=50, verbose_eval=False)
        it = (0, bst.best_iteration + 1)
        k = fit_k(va[y].values, bst.predict(dva, iteration_range=it))
        mu = bst.predict(xgb.DMatrix(te[FEATS], feature_names=FEATS), iteration_range=it)
        base = baseline(te, s)
        yt = te[y].values
        kb = fit_k(va[y].values, baseline(va, s))
        report[s] = {
            "k": k, "k_rules": kb, "rounds": it[1],
            "loglik_model": round(float(nb_ll(yt, mu, k).mean()), 5),
            "loglik_rules": round(float(nb_ll(yt, base, kb).mean()), 5),
            "brier_ge1_model": round(float(((p_ge1(mu, k) - (yt >= 1)) ** 2).mean()), 5),
            "brier_ge1_rules": round(float(((p_ge1(base, kb) - (yt >= 1)) ** 2).mean()), 5),
            "mean_obs": round(float(yt.mean()), 4), "mean_model": round(float(mu.mean()), 4),
        }
        # Le booster est tronqué à sa meilleure itération avant d'être écrit.
        bst[: it[1]].save_model(os.path.join(out_dir, f"{s}.json"))
        print(f"   {s:9s} {report[s]}  ({time.time()-t0:.0f}s)", flush=True)

    json.dump({"trained_at": time.strftime("%Y-%m-%d"), "features": FEATS,
               "split": {"train": "<=2021", "val": 2022, "test": ">=2023"},
               "stats": report}, open(os.path.join(MODELS_DIR, "player_report.json"), "w"), indent=1)
    print("✅ modèle joueur écrit")


if __name__ == "__main__":
    main()
