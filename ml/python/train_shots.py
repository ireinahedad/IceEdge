"""
train_shots.py — modèle de TIRS d'équipe (λ_tirs) et arrêts du gardien.
Piste 3 de « ICEEDGE — Des buts attendus à tous les paris » (2026-10-15).

    python train_shots.py            # mesure, puis écrit le modèle si la règle passe
    python train_shots.py --force    # écrit même si une règle échoue (déconseillé)

Entrées : ../data/nhl_games_v4.csv (features d'avant-match, build_dataset.py),
          ../data/mp_team_games.csv (tirs cadrés par match),
          ../data/mp_goalie_games.csv (tirs reçus / buts des gardiens).
Sorties (MODELS_DIR) :
    shots_model.json     XGBoost count:poisson, lignes équipe-match
    shots_report.json    features, dispersions, coefficient du partant, mesures

── Le modèle ──────────────────────────────────────────────────────────────
Comme le modèle de score : chaque match donne deux lignes « équipe-match »,
features orientées attaque (tirs pour, xG, possession, AN, repos…) / défense
(tirs contre, xG contre, possession, PK, gardien…), plus domicile et écart
d'ELO. Cible : tirs cadrés du match ENTIER (prolongation comprise), ce sur
quoi se règlent les arrêts. Découpage = `train_score.split` (chronologique).
Les tirs baissent depuis 2022-23 (31,3 → 26,9 par équipe-match) : λ est
recalé dans la saison exactement comme les buts (`level_k`, 200 matchs
fictifs), fichier `shots_level_layer.json` rafraîchi par refresh_data.py.

── Arrêts du gardien ──────────────────────────────────────────────────────
μ_arrêts = λ_tirs(adversaire) × % d'arrêts du gardien (état d'inférence,
celui du modèle de score) × c, où c = 0,97 corrige le partant qui ne finit pas
toujours le match (ajusté sur la validation). Binomiale négative, k ajusté en
validation. Remplace la règle de playerRates.ts (arrêts de la saison rétrécis
vers 24 × tirs de l'adversaire / 30, k = 25), qui sous-estimait : 43 % prévus
pour « plus de 24,5 » contre 53 % observés en test.

── Règles (posées avant le premier run) ───────────────────────────────────
λ_tirs et arrêts : adoptés si Δ log-vraisemblance (BN, k ajusté en
validation) contre la règle > 0 en validation ET en test, z ≥ 2 en test. Le
recalage de niveau : adopté s'il améliore la log-vraisemblance en validation
ET en test. Mesure du 2026-10-15 : tirs d'équipe z 9,3 ; arrêts z 11,8 ;
recalage de niveau meilleur sur les deux tranches. Les tirs d'un PATINEUR
tirés de λ_tirs ont été rejetés (explore_shots/shots_players.py, z −5) : le
modèle joueur reste leur source.
"""
from __future__ import annotations
import argparse, json, os, time
import numpy as np
import pandas as pd
import xgboost as xgb
from scipy.special import gammaln
from scipy.stats import nbinom

import train_score as T
from score_model import level_k

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
MODELS_DIR = os.environ.get("MODELS_DIR") or os.path.join(HERE, "..", "models")

ATK = ["sog_f_s", "sog_f_l", "xgf60_s", "xgf60_l", "ev_cf_pct_s", "ev_cf_pct_l", "ev_xgf_pct_s",
       "pp_xgf60_s", "gf_s", "win_s", "rest_days", "b2b", "lineup_xg"]
DEF = ["sog_a_s", "sog_a_l", "xga60_s", "xga60_l", "ev_cf_pct_s", "ev_cf_pct_l", "pk_xga60_s",
       "win_s", "rest_days", "b2b", "goalie_svpct"]
FEATS = [f"atk_{c}" for c in ATK] + [f"def_{c}" for c in DEF] + ["is_home", "elo_atk_minus_def"]
PARAMS = dict(objective="count:poisson", eval_metric="poisson-nloglik", eta=0.03, max_depth=4,
              min_child_weight=10, subsample=0.8, colsample_bytree=0.8, reg_lambda=3.0,
              max_delta_step=0.7, seed=7, nthread=os.cpu_count() or 2)
K_GRID = [2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 400, 1e5]
LEVEL_PRIOR_GAMES = 200.0
SV_DEFAULT = 0.905
SHOTS_LEVEL_LAYER = "shots_level_layer.json"


# ══════════════════════════════════════════════════════════════════════════════
# Outils
# ══════════════════════════════════════════════════════════════════════════════

def nb_ll(y, mu, k):
    mu = np.maximum(mu, 1e-6)
    if k >= 1e4:
        return y * np.log(mu) - mu - gammaln(y + 1)
    return (gammaln(y + k) - gammaln(k) - gammaln(y + 1) + k * np.log(k / (k + mu)) + y * np.log(mu / (k + mu)))


def fit_k(y, mu):
    return max(K_GRID, key=lambda k: nb_ll(y, mu, k).mean())


def zstat(d):
    return float(d.mean() / (d.std(ddof=1) / np.sqrt(len(d))))


def season_of_date(d) -> int:
    s = str(d)
    return int(s[:4]) if int(s[5:7]) >= 8 else int(s[:4]) - 1


def attach_shots(df: pd.DataFrame, team_games_path: str) -> pd.DataFrame:
    """Ajoute home_shots / away_shots (tirs cadrés, match entier) depuis MoneyPuck."""
    tg = pd.read_csv(team_games_path, usecols=["gameId", "home_or_away", "situation", "shotsOnGoalFor"])
    tg = tg[tg.situation == "all"]
    sh = tg.pivot_table(index="gameId", columns="home_or_away", values="shotsOnGoalFor", aggfunc="first")
    df = df.copy()
    df["home_shots"] = df.game_id.map(sh.get("HOME"))
    df["away_shots"] = df.game_id.map(sh.get("AWAY"))
    return df


def team_rows(d: pd.DataFrame) -> pd.DataFrame:
    """Un match → deux lignes équipe-match (attaque = l'équipe qui tire)."""
    out = []
    for atk, dfn, is_home in (("home", "away", 1), ("away", "home", 0)):
        r = pd.DataFrame(index=d.index)
        for c in ATK:
            r[f"atk_{c}"] = d.get(f"{atk}_{c}")
        for c in DEF:
            r[f"def_{c}"] = d.get(f"{dfn}_{c}")
        r["is_home"] = float(is_home)
        r["elo_atk_minus_def"] = d[f"{atk}_elo"] - d[f"{dfn}_elo"]
        r["y"] = d[f"{atk}_shots"].astype(float) if f"{atk}_shots" in d else np.nan
        r["game_id"], r["date"], r["side"] = d.game_id.values, d.date.values, atk
        r["season"] = d.season.values if "season" in d else d.date.map(season_of_date).values
        out.append(r)
    return pd.concat(out, ignore_index=True)


def dmatrix(r: pd.DataFrame, label: bool = True) -> xgb.DMatrix:
    return xgb.DMatrix(r[FEATS].astype(np.float32), label=r.y if label else None,
                       feature_names=FEATS, missing=np.nan)


def causal_level(r: pd.DataFrame, pred: np.ndarray, n0: float = LEVEL_PRIOR_GAMES) -> np.ndarray:
    """k de chaque ligne : tirs observés / prévus des matchs de la saison DÉJÀ joués (jours précédents)."""
    d = pd.DataFrame({"date": r.date.values, "season": r.season.values, "obs": r.y.values, "pred": pred})
    d["i"] = np.arange(len(d))
    k = np.ones(len(d))
    for _, g in d.sort_values("date").groupby("season", sort=False):
        day = g.groupby("date")[["obs", "pred"]].sum()
        day["n"] = g.groupby("date").size() / 2.0
        cum = day.cumsum().shift(1).fillna(0.0)
        for dt_, idx in g.groupby("date").i:
            c = cum.loc[dt_]
            k[idx.values] = level_k(c.obs, c.pred, int(c.n), n0) if c.n > 0 else 1.0
    return k


def starters(goalie_games_path: str) -> pd.DataFrame:
    """Gardien partant (plus de temps de glace) de chaque équipe-match, ses arrêts,
    et ses arrêts / matchs de la saison AVANT ce match (pour la règle servie)."""
    G = pd.read_csv(goalie_games_path)
    G = G[G.situation == "all"].copy()
    G["saves"] = G.ongoal - G.goals
    G["side"] = G.home_or_away.str.lower()
    G = G.sort_values(["playerId", "gameDate", "gameId"])
    gs = G.groupby(["playerId", "season"])
    G["sv_cum"] = gs.saves.transform(lambda s: s.shift(1).cumsum()).fillna(0)
    G["gp_cum"] = gs.cumcount()
    G = G.sort_values(["gameId", "side", "icetime"], ascending=[True, True, False])
    return G.drop_duplicates(["gameId", "side"])[["gameId", "side", "playerId", "saves", "sv_cum",
                                                  "gp_cum", "icetime"]]


def verdict(name, yv, av, bv, ka, kb, yt, at, bt, extra=None):
    dv = nb_ll(yv, bv, kb) - nb_ll(yv, av, ka)
    dt = nb_ll(yt, bt, kb) - nb_ll(yt, at, ka)
    r = {"k_A": ka, "k_B": kb, "n_val": int(len(yv)), "n_test": int(len(yt)),
         "dll_val": round(float(dv.mean()), 6), "z_val": round(zstat(dv), 2),
         "dll_test": round(float(dt.mean()), 6), "z_test": round(zstat(dt), 2),
         "mean_obs_test": round(float(yt.mean()), 3), "mean_A_test": round(float(at.mean()), 3),
         "mean_B_test": round(float(bt.mean()), 3),
         "mae_A_test": round(float(np.abs(yt - at).mean()), 4), "mae_B_test": round(float(np.abs(yt - bt).mean()), 4)}
    r["adopt"] = bool(r["dll_val"] > 0 and r["dll_test"] > 0 and r["z_test"] >= 2)
    if extra:
        r.update(extra)
    print(f"   {name:24s} val Δ {r['dll_val']:+.5f} (z {r['z_val']:+.1f})  test Δ {r['dll_test']:+.5f} "
          f"(z {r['z_test']:+.1f})  MAE {r['mae_A_test']}→{r['mae_B_test']}  → {'ADOPTER' if r['adopt'] else 'non'}",
          flush=True)
    return r


# ══════════════════════════════════════════════════════════════════════════════
# Entraînement + mesure
# ══════════════════════════════════════════════════════════════════════════════

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="écrit le modèle même si une règle échoue")
    args = ap.parse_args()
    t0 = time.time()
    df = pd.read_csv(os.path.join(DATA_DIR, "nhl_games_v4.csv"), low_memory=False)
    df = df.dropna(subset=["home_reg_score", "away_reg_score", "went_to_ot", "total_goals", "home_win", "date"])
    df = attach_shots(df, os.path.join(DATA_DIR, "mp_team_games.csv"))
    df = df.dropna(subset=["home_shots", "away_shots"]).reset_index(drop=True)
    tr, va, te = T.split(df)
    print(f"🏒 {len(df)} matchs avec tirs ; entraînement {len(tr)}, validation {len(va)} "
          f"({va.date.min()} → {va.date.max()}), test {len(te)} ({te.date.min()} → {te.date.max()})")
    R = {"tr": team_rows(tr), "va": team_rows(va), "te": team_rows(te)}
    bst = xgb.train(PARAMS, dmatrix(R["tr"]), 3000, evals=[(dmatrix(R["va"]), "val")],
                    early_stopping_rounds=60, verbose_eval=False)
    it = (0, bst.best_iteration + 1)
    for n in R:
        R[n]["mu_raw"] = bst.predict(dmatrix(R[n], False), iteration_range=it)
    print(f"   modèle de tirs : {it[1]} arbres ({time.time()-t0:.0f}s)")

    # Règle multiplicative de référence : pour(att) × contre(déf) / ligue (60 jours, causal).
    allr = pd.concat(list(R.values()), ignore_index=True)
    daily = allr.groupby("date").y.agg(["sum", "count"]).sort_index()
    roll = daily.rolling(60, min_periods=1).sum().shift(1)
    league = (roll["sum"] / roll["count"]).bfill()
    for n in ("va", "te"):
        r = R[n]
        r["mu_rule"] = r.atk_sog_f_s.values * r.def_sog_a_s.values / r.date.map(league).fillna(30.0).values
        r["k_lvl"] = causal_level(r, r.mu_raw.values)
        r["mu"] = r.mu_raw * r.k_lvl
    v, t = R["va"], R["te"]
    rep = {"trained_at": time.strftime("%Y-%m-%d"), "features": FEATS, "rounds": it[1], "params": PARAMS,
           "split": {"val": [str(va.date.min()), str(va.date.max())], "test": [str(te.date.min()), str(te.date.max())]},
           "rule": "adopter si Δ log-vraisemblance BN (modèle − règle) > 0 en validation ET en test, z ≥ 2 en test"}
    k_rule, k_team = fit_k(v.y.values, v.mu_rule.values), fit_k(v.y.values, v.mu.values)
    rep["team_shots"] = verdict("tirs d'équipe", v.y.values, v.mu_rule.values, v.mu.values, k_rule, k_team,
                                t.y.values, t.mu_rule.values, t.mu.values)
    k_raw = fit_k(v.y.values, v.mu_raw.values)
    lv = nb_ll(v.y.values, v.mu.values, k_team) - nb_ll(v.y.values, v.mu_raw.values, k_raw)
    lt = nb_ll(t.y.values, t.mu.values, k_team) - nb_ll(t.y.values, t.mu_raw.values, k_raw)
    rep["level"] = {"prior_games": LEVEL_PRIOR_GAMES, "dll_val": round(float(lv.mean()), 6),
                    "dll_test": round(float(lt.mean()), 6), "z_test": round(zstat(lt), 2),
                    "verdict": "ADOPTER" if lv.mean() > 0 and lt.mean() > 0 else "REJETER"}
    print(f"   recalage de niveau : val Δ {lv.mean():+.5f}, test Δ {lt.mean():+.5f} → {rep['level']['verdict']}")
    rep["team_shots_by_season_test"] = {
        int(s): {"obs": round(float(g.y.mean()), 2), "model": round(float(g.mu.mean()), 2),
                 "rule": round(float(g.mu_rule.mean()), 2)} for s, g in t.groupby("season")}

    # ── Arrêts du gardien partant ────────────────────────────────────────────
    S = starters(os.path.join(DATA_DIR, "mp_goalie_games.csv"))
    sv_of = {}
    for n, d in (("va", va), ("te", te)):
        for side in ("home", "away"):
            sv_of.update({(g, side): s for g, s in zip(d.game_id, d[f"{side}_goalie_svpct"])})
    G = {}
    for n in ("va", "te"):
        r = R[n][["game_id", "side", "mu", "atk_sog_f_s"]].copy()
        r["gside"] = np.where(r.side == "home", "away", "home")      # le gardien d'en face reçoit ces tirs
        m = r.merge(S, left_on=["game_id", "gside"], right_on=["gameId", "side"], suffixes=("", "_g"))
        m["sv"] = [sv_of.get((g, s), np.nan) for g, s in zip(m.game_id, m.gside)]
        m["mu_rule"] = ((m.sv_cum + 4 * 24) / (m.gp_cum + 4)) * np.clip(m.atk_sog_f_s / 30.0, 0.85, 1.15)
        m["mu_model"] = m.mu * m.sv.fillna(SV_DEFAULT)
        G[n] = m.dropna(subset=["saves", "mu_rule", "mu_model"])
    v, t = G["va"], G["te"]
    c_sv = float(v.saves.sum() / v.mu_model.sum())
    for m in (v, t):
        m["mu_model"] = m.mu_model * c_sv
    k_saves = fit_k(v.saves.values, v.mu_model.values)
    rep["saves_scale"] = round(c_sv, 4)
    rep["goalie_saves"] = verdict("arrêts du gardien", v.saves.values, v.mu_rule.values, v.mu_model.values,
                                  25, k_saves, t.saves.values, t.mu_rule.values, t.mu_model.values,
                                  {"full_game_share_test": round(float((t.icetime >= 3500).mean()), 3)})
    lines = {}
    for line in (24.5, 27.5, 29.5):
        y = (t.saves.values > line).astype(float)
        pa = nbinom.sf(np.floor(line), 25, 25 / (25 + t.mu_rule.values))
        pb = nbinom.sf(np.floor(line), k_saves, k_saves / (k_saves + t.mu_model.values))
        lines[str(line)] = {"obs": round(float(y.mean()), 4), "p_rule": round(float(pa.mean()), 4),
                            "p_model": round(float(pb.mean()), 4),
                            "brier_rule": round(float(((pa - y) ** 2).mean()), 5),
                            "brier_model": round(float(((pb - y) ** 2).mean()), 5)}
    rep["goalie_saves_lines_test"] = lines
    print(f"   lignes d'arrêts (test) : " + ", ".join(
        f"{k_}: obs {v_['obs']:.0%} règle {v_['p_rule']:.0%} modèle {v_['p_model']:.0%}" for k_, v_ in lines.items()))

    rep["k_team"] = k_team
    rep["k_saves"] = k_saves
    ok = rep["team_shots"]["adopt"] and rep["goalie_saves"]["adopt"]
    rep["verdict"] = "ADOPTER" if ok else "REJETER"
    if ok or args.force:
        bst[: it[1]].save_model(os.path.join(MODELS_DIR, "shots_model.json"))
        with open(os.path.join(MODELS_DIR, "shots_report.json"), "w", encoding="utf-8") as fh:
            json.dump(rep, fh, ensure_ascii=False, indent=1)
        print(f"✅ shots_model.json + shots_report.json → {MODELS_DIR} ({time.time()-t0:.0f}s)")
    else:
        print("⛔ règle non passée — rien n'est écrit (--force pour écrire quand même)")


# ══════════════════════════════════════════════════════════════════════════════
# Recalage de niveau hebdomadaire (refresh_data.py, étape 5ter)
# ══════════════════════════════════════════════════════════════════════════════

def refresh_shots_level(season: int, models_dir: str, data_path: str, team_games_path: str) -> dict:
    """k des tirs pour la saison `season` → `shots_level_layer.json`.

    Même format et mêmes garde-fous que `level_layer.json` (lu par
    `score_model.read_level_layer`) : écrit TOUJOURS un fichier, k = 1 quand la
    mesure n'est pas adoptée, le modèle illisible ou la saison vide.
    """
    from datetime import datetime, timezone
    out = {"season": int(season), "k": 1.0, "obs_sum": 0.0, "lam_sum": 0.0, "n_games": 0,
           "prior_games": LEVEL_PRIOR_GAMES, "verdict": "REJETER", "as_of": None,
           "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "note": ""}
    try:
        with open(os.path.join(models_dir, "shots_report.json"), encoding="utf-8") as fh:
            rep = json.load(fh)
        if list(rep["features"]) != FEATS:
            raise ValueError("features de shots_report.json ≠ train_shots.FEATS")
        out["verdict"] = rep.get("level", {}).get("verdict", "REJETER")
        out["prior_games"] = float(rep.get("level", {}).get("prior_games", LEVEL_PRIOR_GAMES))
        if out["verdict"] == "ADOPTER":
            bst = xgb.Booster()
            bst.load_model(os.path.join(models_dir, "shots_model.json"))
            df = pd.read_csv(data_path, low_memory=False)
            df = df[df["date"].map(season_of_date) == season]
            df = attach_shots(df, team_games_path).dropna(subset=["home_shots", "away_shots"])
            if len(df):
                r = team_rows(df.reset_index(drop=True))
                mu = bst.predict(dmatrix(r, False))
                okm = (mu >= 10) & (mu <= 60)          # ligne mal remplie : ne compte pas
                out["obs_sum"] = round(float(r.y.values[okm].sum()), 6)
                out["lam_sum"] = round(float(mu[okm].sum()), 6)
                out["n_games"] = int(okm.sum() // 2)
                out["as_of"] = str(r.date[okm].max()) if okm.any() else None
            out["k"] = level_k(out["obs_sum"], out["lam_sum"], out["n_games"], out["prior_games"])
            if out["n_games"] == 0:
                out["note"] = "aucun match joué cette saison — k = 1"
        else:
            out["note"] = "recalage non adopté — k = 1"
    except Exception as e:
        out.update(k=1.0, obs_sum=0.0, lam_sum=0.0, n_games=0, verdict="REJETER",
                   note=f"calcul impossible ({e}) — k = 1")
    with open(os.path.join(models_dir, SHOTS_LEVEL_LAYER), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
    ratio = out["obs_sum"] / out["lam_sum"] if out["lam_sum"] else float("nan")
    print(f"\n📏 Recalage des tirs {season}-{str(season + 1)[2:]} : k = {out['k']:.4f} "
          f"({out['n_games']} matchs, tirs/λ {ratio:.3f})" + (f" — {out['note']}" if out["note"] else ""))
    return out


if __name__ == "__main__":
    main()
