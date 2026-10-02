"""
measure_returnee.py — le joueur qui revient de blessure (2026-10-02)
==================================================================

Hypothèse posée : « le bookmaker calcule la cote avec les derniers matchs de
l'équipe SANS le joueur ; le modèle devrait prendre les derniers matchs AVEC
lui ». Deux mesures, critère avant de regarder : n'adopter que ce qui bat la
référence sur la majorité des saisons avec |z| ≥ 2.

Définition d'un RETOUR, pour une équipe T au match g :
  • le joueur joue g pour T et a manqué les K matchs précédents de T, d'affilée
    (K ≥ MIN_MISSED, ≤ 60 — au-delà ce n'est plus un retour) ;
  • avant l'absence c'était un régulier : ≥ 10 matchs avec T, temps de glace
    EWMA ≥ MIN_TOI minutes. Plusieurs retours le même soir : le plus important.

1. FORME « AVEC LUI ». Les EWMA d'équipe de build_dataset.py (hl 6 / 20,
   décalées) recalculées sur les seuls matchs de T où il a joué, remplaçant
   (α = 1) ou mélangées à 50 % (α = 0,5) avec la forme normale — à
   l'entraînement comme au test. Walk-forward du classifieur, hyperparamètres
   fixés, 2012 → 2025.

2. LE MARCHÉ. Sur les matchs cotés où une seule équipe récupère un joueur :
   victoires réelles de cette équipe − probabilité implicite dévigée de
   clôture. > 0 = le marché la sous-cote (ce que suppose l'hypothèse).

Résultat (2026-10-02) :
   1. aucun gain, pour les quatre seuils et les deux mélanges (|z| < 1) ;
   2. pas de sous-cotation : ±0 à 3+ matchs manqués ; après 8+ matchs, ces
      équipes gagnent même MOINS que le marché ne le prévoit (−2,6 points,
      z −1,9). L'hypothèse n'est pas retenue.
   Ce qui a été corrigé à la place : le service ML ne pouvait pas compter un
   joueur absent depuis plus de 25 matchs le soir de son retour (bassin
   `skater_pool` + alignement officiel, cf. build_dataset.py).

Usage :
    cd ml/python
    python measure_returnee.py          # ~15 min → ../models/returnee_report.json
"""
import json

import numpy as np
import pandas as pd
import xgboost as xgb

import train as T
from build_dataset import mp_date, norm_team

DATA = "../data"
MODELS = "../models"
SHORT_HL, LONG_HL = 6, 20
MIN_GP, MAX_MISSED = 10, 60
CONFIGS = [(3, 16.0), (5, 19.0), (8, 16.0), (10, 19.0)]     # (matchs manqués ≥, TOI ≥ min)
NEED = {"xgf60": "s", "xga60": "s", "finishing": "s", "win": "s", "ev_cf_pct": "s", "ev_xgf_pct": "sl"}


def team_games() -> pd.DataFrame:
    """Valeurs brutes par équipe-match (mêmes formules que build_dataset.py)."""
    mp = pd.read_csv(f"{DATA}/mp_team_games.csv", low_memory=False)
    mp["team"] = mp["playerTeam"].map(norm_team)
    mp["date"] = mp["gameDate"].map(mp_date)
    a = mp[mp["situation"] == "all"].set_index(["team", "gameId"])
    e = mp[mp["situation"] == "5on5"].set_index(["team", "gameId"])
    h = a["iceTime"].replace(0, np.nan) / 3600
    tg = pd.DataFrame({
        "date": a["date"],
        "xgf60": a["xGoalsFor"] / h, "xga60": a["xGoalsAgainst"] / h,
        "finishing": a["goalsFor"] - a["xGoalsFor"],
        "win": (a["goalsFor"] > a["goalsAgainst"]).astype(float),
        "ev_cf_pct": e["shotAttemptsFor"] / (e["shotAttemptsFor"] + e["shotAttemptsAgainst"]).replace(0, np.nan),
        "ev_xgf_pct": e["xGoalsFor"] / (e["xGoalsFor"] + e["xGoalsAgainst"]).replace(0, np.nan),
    })
    return tg.reset_index().sort_values(["team", "date", "gameId"]).reset_index(drop=True)


def skater_presence() -> pd.DataFrame:
    sk = pd.read_csv(f"{DATA}/mp_skater_games.csv", low_memory=False,
                     usecols=["playerId", "playerTeam", "gameId", "gameDate", "situation", "icetime"])
    sk = sk[(sk["situation"] == "all") & (sk["icetime"] > 0)].copy()
    sk["team"] = sk["playerTeam"].map(norm_team)
    sk = sk.sort_values(["playerId", "gameDate", "gameId"])
    sk["toi_prior"] = sk.groupby("playerId")["icetime"].transform(
        lambda s: s.shift(1).ewm(halflife=20, min_periods=2).mean()) / 60.0
    return sk


def ewm_last(vals, hl, minp=3):
    """Dernière valeur d'une EWMA pandas (adjust=True) sur `vals`, NaN ignorés."""
    v = vals[~np.isnan(vals)]
    if len(v) < minp:
        return np.nan
    w = 0.5 ** (np.arange(len(v))[::-1] / hl)
    return float((w * v).sum() / w.sum())


def returns(tg: pd.DataFrame, sk: pd.DataFrame, min_missed: int, min_toi: float) -> pd.DataFrame:
    toi = dict(zip(zip(sk["playerId"], sk["gameId"]), sk["toi_prior"]))
    rows = []
    for team, g in tg.groupby("team", sort=False):
        gids = g["gameId"].to_numpy()
        idx_of = {gid: i for i, gid in enumerate(gids)}
        vals = {c: g[c].to_numpy(dtype=float) for c in NEED}
        per_player = sk[sk["team"] == team].groupby("playerId")["gameId"].apply(
            lambda s: sorted(idx_of[x] for x in s if x in idx_of))
        for pid, idxs in per_player.items():
            idxs = np.array(idxs)
            for j in range(MIN_GP, len(idxs)):
                gap = idxs[j] - idxs[j - 1] - 1
                tp = toi.get((pid, gids[idxs[j - 1]]), np.nan)
                if gap < min_missed or gap > MAX_MISSED or not (tp >= min_toi):
                    continue
                hist = idxs[:j]
                row = {"team": team, "gameId": int(gids[idxs[j]]), "missed": int(gap), "toi": float(tp)}
                for c, kinds in NEED.items():
                    for k, hl in (("s", SHORT_HL), ("l", LONG_HL)):
                        if k in kinds:
                            row[f"{c}_{k}_w"] = ewm_last(vals[c][hist], hl)
                rows.append(row)
    r = pd.DataFrame(rows)
    return r.sort_values("toi", ascending=False).drop_duplicates(["team", "gameId"])


def with_form(df: pd.DataFrame, wcols: list, alpha: float) -> pd.DataFrame:
    d = df.copy()
    for side in ("home", "away"):
        for c in wcols:
            base, w = f"{side}_{c[:-2]}", d[f"{side}_{c}"]
            d[base] = np.where(w.notna(), alpha * w + (1 - alpha) * d[base], d[base])
    for c in ("ev_xgf_pct_s", "ev_cf_pct_s", "ev_xgf_pct_l", "finishing_s", "win_s"):
        d[f"{c}_diff"] = d[f"home_{c}"] - d[f"away_{c}"]
    d["xg_matchup_diff"] = (d["home_xgf60_s"] - d["away_xga60_s"]) - (d["away_xgf60_s"] - d["home_xga60_s"])
    return d


def walk(d: pd.DataFrame, P: dict, seasons: list) -> dict:
    y = d["home_win"].astype(float).values
    F = list(T.CORE_FEATURES)
    per = {}
    for S in seasons:
        tr, te = d.index[d["season"] < S], d.index[d["season"] == S]
        n_fit = int(len(tr) * 0.85)
        mk = lambda idx: xgb.DMatrix(d.loc[idx, F].astype(float), label=y[idx], missing=np.nan)
        b = xgb.train(P, mk(tr[:n_fit]), 2000, evals=[(mk(tr[n_fit:]), "v")],
                      early_stopping_rounds=60, verbose_eval=False)
        p = np.clip(b.predict(mk(te), iteration_range=(0, b.best_iteration + 1)), 1e-7, 1 - 1e-7)
        per[S] = -(y[te] * np.log(p) + (1 - y[te]) * np.log(1 - p))
    return per


def main():
    tg, sk = team_games(), skater_presence()
    games = pd.read_csv(f"{DATA}/nhl_games_v4.csv", low_memory=False) \
        .sort_values(["date", "game_id"]).reset_index(drop=True)
    P = dict(json.load(open(f"{MODELS}/training_report.json", encoding="utf-8"))["game_model"]["params"])
    P.update({"objective": "binary:logistic", "eval_metric": "logloss", "seed": 42, "tree_method": "hist"})
    seasons = sorted(int(s) for s in games["season"].unique() if s >= 2012)
    base = walk(games, P, seasons)
    print(f"référence : log-loss {np.concatenate(list(base.values())).mean():.5f}")
    report = {"form_with_player": {}, "market": {}}

    for min_missed, min_toi in CONFIGS:
        key = f"missed>={min_missed}_toi>={int(min_toi)}"
        r = returns(tg, sk, min_missed, min_toi)
        wcols = [c for c in r.columns if c.endswith("_w")]
        df = games.copy()
        for side in ("home", "away"):
            df = df.merge(r[["team", "gameId"] + wcols].rename(columns={
                "team": f"{side}_team", "gameId": "game_id", **{c: f"{side}_{c}" for c in wcols}}),
                on=[f"{side}_team", "game_id"], how="left")
        parity = float((with_form(df, wcols, 0.0)["xg_matchup_diff"] - games["xg_matchup_diff"]).abs().max())
        assert parity < 1e-9, f"α = 0 doit redonner le dataset ({parity})"
        entry = {"n_returns": int(len(r)), "median_missed": float(r["missed"].median())}
        for alpha in (1.0, 0.5):
            per = walk(with_form(df, wcols, alpha), P, seasons)
            ds = np.array([per[S].mean() - base[S].mean() for S in seasons])
            delta = float(np.concatenate([per[S] - base[S] for S in seasons]).mean())
            se = float(ds.std(ddof=1) / np.sqrt(len(ds)))
            entry[f"alpha={alpha}"] = {"delta": round(delta, 6), "se": round(se, 6), "z": round(delta / se, 2),
                                       "seasons_better": int((ds < 0).sum()), "n_seasons": len(ds)}
            print(f"{key} α={alpha}: Δ {delta:+.5f} ± {se:.5f} (z {delta/se:+.2f}, {int((ds < 0).sum())}/{len(ds)})",
                  flush=True)
        report["form_with_player"][key] = entry

        # 2. le marché
        s = set(zip(r["team"], r["gameId"]))
        h = np.array([(t, g) in s for t, g in zip(games["home_team"], games["game_id"])])
        a = np.array([(t, g) in s for t, g in zip(games["away_team"], games["game_id"])])
        one = games["market_home_p_close"].notna().to_numpy() & (h ^ a)
        g1 = games[one]
        p_ret = np.where(h[one], g1["market_home_p_close"], 1 - g1["market_home_p_close"])
        won = np.where(h[one], g1["home_win"], 1 - g1["home_win"]).astype(float)
        gap = won - p_ret
        se = gap.std(ddof=1) / np.sqrt(len(gap))
        report["market"][key] = {"n": int(len(gap)), "win_rate": round(float(won.mean()), 4),
                                 "market_p": round(float(p_ret.mean()), 4), "gap": round(float(gap.mean()), 4),
                                 "se": round(float(se), 4), "z": round(float(gap.mean() / se), 2)}
        print(f"{key} marché : n={len(gap)} victoires {won.mean():.3f} marché {p_ret.mean():.3f} "
              f"écart {gap.mean():+.4f} ± {se:.4f}", flush=True)

    path = f"{MODELS}/returnee_report.json"
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"✅ {path}")


if __name__ == "__main__":
    main()
