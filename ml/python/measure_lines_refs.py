"""
measure_lines_refs.py
=====================
P5 (STATUS.md §3.5 P, 2026-10-12). Deux familles qu'on ne pouvait pas tester
avant `fetch_officials_lines.py` :

A. TRIOS ET PAIRES — « ça dépend des joueurs et de leur combinaison ».
   Un trio (ou une paire de défense) produit-il PLUS que ce que ses joueurs
   valent séparément, et cet effet de combinaison se RÉPÈTE-t-il ?
   Saison par saison, à 5 contre 5 (MoneyPuck) :
     xGF%(combinaison)  = xGF / (xGF + xGA) quand les 3 (ou 2) sont ensemble ;
     attendu            = moyenne des xGF% de chaque membre SANS cette
                          combinaison (ses totaux sur la glace − ceux de la
                          combinaison), donc sans la compter deux fois ;
     synergie           = xGF%(combinaison) − attendu.
   Test de persistance : la MÊME combinaison (mêmes joueurs) sur deux saisons
   consécutives, ≥ MIN_TOI_MIN minutes ensemble chaque fois : corrélation des
   synergies. Contrôle positif : le xGF% « sans la combinaison » d'un joueur
   d'une saison à l'autre (son talent), qui DOIT persister.

B. ARBITRES — effet sur les pénalités, le temps en avantage numérique et les buts.
   Les arbitres sont connus avant le match (publiés le jour même) : pas de fuite.
   Par arbitre, écart moyen de ses matchs à la moyenne de la saison (un match
   compte pour ses deux arbitres), rétréci par le nombre de matchs.
   Test de persistance : effets estimés sur les saisons PAIRES vs IMPAIRES,
   corrélation sur les arbitres présents des deux côtés.
   Test prédictif (totaux) : pour chaque saison S, effets « buts » estimés sur
   les saisons < S, ajoutés au total servi (`served_pregame.csv`) avec un
   coefficient lui aussi ajusté sur < S ; déviance de Poisson du total.
   Critère fixé AVANT le run, celui de `measure_level.py` : z ≤ −2 (apparié
   par match) ET gain sur ≥ 70 % des saisons.
   ⚠️ `refereeStore.ts` applique déjà en production un multiplicateur
   d'avantage numérique tiré de Scouting the Refs (boîte de verre, hors ML) :
   la persistance mesurée ici dit si ce facteur a une base.

Entrées : ../data/officials.csv, ../data/raw/lines/{lines,skaters}_{saison}.csv,
          ../data/mp_team_games.csv, ../data/nhl_games_v4.csv, ../data/served_pregame.csv
Sortie  : ../models/lines_refs_report.json

Usage : cd ml/python && python measure_lines_refs.py [--lines] [--refs]
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

DATA_DIR = "../data"
LINES_DIR = f"{DATA_DIR}/raw/lines"
REPORT = "../models/lines_refs_report.json"
MIN_TOI_MIN = 100          # minutes ensemble à 5c5 pour qu'une combinaison compte
MIN_TOI_WO_MIN = 200       # minutes SANS la combinaison pour juger un membre
REF_SHRINK = 40            # pseudo-matchs de rétrécissement des effets arbitre
TEAM_FIX = {"L.A": "LAK", "N.J": "NJD", "S.J": "SJS", "T.B": "TBL"}


def corr(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    m = np.isfinite(a) & np.isfinite(b)
    if m.sum() < 3:
        return None, int(m.sum())
    r = float(np.corrcoef(a[m], b[m])[0, 1])
    return round(r, 3), int(m.sum())


def corr_block(a, b) -> dict:
    r, n = corr(a, b)
    se = 1 / math.sqrt(n - 3) if n > 3 else None          # Fisher
    return {"corr": r, "n": n, "ic95": ([round(math.tanh(math.atanh(r) - 1.96 * se), 3),
                                         round(math.tanh(math.atanh(r) + 1.96 * se), 3)]
                                        if r is not None and se and abs(r) < 1 else None)}


# ── A. Trios et paires ───────────────────────────────────────────────────────

def load_lines() -> pd.DataFrame:
    rows = []
    for path in sorted(glob.glob(f"{LINES_DIR}/lines_*.csv")):
        season = int(os.path.basename(path)[6:10])
        sk_path = f"{LINES_DIR}/skaters_{season}.csv"
        if not os.path.exists(sk_path):
            continue
        L = pd.read_csv(path)
        L = L[L["situation"] == "5on5"].copy()
        S = pd.read_csv(sk_path)
        S = S[S["situation"] == "5on5"]
        # un joueur échangé peut avoir plusieurs lignes : on somme
        on = S.groupby("playerId").agg(xgf=("OnIce_F_xGoals", "sum"), xga=("OnIce_A_xGoals", "sum"),
                                       toi=("icetime", "sum"))
        for r in L.itertuples(index=False):
            lid = str(r.lineId)
            if len(lid) % 7:
                continue
            members = [int(lid[i:i + 7]) for i in range(0, len(lid), 7)]
            k = 3 if r.position == "line" else 2
            if len(members) != k or r.icetime < MIN_TOI_MIN * 60:
                continue
            tot = r.xGoalsFor + r.xGoalsAgainst
            if tot <= 0:
                continue
            wo = []
            for m in members:
                if m not in on.index:
                    break
                p = on.loc[m]
                f, a, t = p.xgf - r.xGoalsFor, p.xga - r.xGoalsAgainst, p.toi - r.icetime
                if t < MIN_TOI_WO_MIN * 60 or f + a <= 0 or f < 0 or a < 0:
                    break
                wo.append(f / (f + a))
            if len(wo) != k:
                continue
            rows.append({"season": season, "key": "-".join(map(str, sorted(members))),
                         "kind": "trio" if k == 3 else "paire", "team": TEAM_FIX.get(r.team, r.team),
                         "toi_min": r.icetime / 60, "xgf_pct": r.xGoalsFor / tot,
                         "expected": float(np.mean(wo)), "xg_total": tot,
                         "members": members, "wo": wo})
    d = pd.DataFrame(rows)
    if not d.empty:
        d["synergy"] = d["xgf_pct"] - d["expected"]
    return d


def run_lines() -> dict:
    d = load_lines()
    if d.empty:
        return {"note": f"aucune donnée dans {LINES_DIR} — lancer fetch_officials_lines.py --lines"}
    out = {"protocole": f"5c5, combinaisons ≥ {MIN_TOI_MIN} min ensemble, membres ≥ {MIN_TOI_WO_MIN} min "
                        "sans elles ; synergie = xGF% ensemble − moyenne des xGF% sans",
           "saisons": [int(d.season.min()), int(d.season.max())]}
    for kind, g in d.groupby("kind"):
        # Ce qu'explique la qualité des membres (niveau)
        r_level, n = corr(g["expected"], g["xgf_pct"])
        # Persistance de la synergie : même combinaison, saisons consécutives
        a = g[["key", "season", "synergy", "toi_min", "xgf_pct"]]
        b = a.assign(season=a.season - 1)
        pair = a.merge(b, on=["key", "season"], suffixes=("_s", "_s1"))
        # Bruit attendu de la synergie : écart-type empirique vs taille
        top = pair.sort_values("synergy_s", ascending=False).head(max(10, len(pair) // 10))
        out[kind] = {
            "combinaisons_saisons": int(len(g)),
            "corr_attendu_vs_reel": {"corr": r_level, "n": n},
            "ecart_type_synergie": round(float(g["synergy"].std()), 4),
            "persistance_synergie": corr_block(pair["synergy_s"], pair["synergy_s1"]),
            "persistance_xgf_pct_brut": corr_block(pair["xgf_pct_s"], pair["xgf_pct_s1"]),
            "top10pct_synergie_s": {"n": int(len(top)),
                                    "synergie_moy_s": round(float(top["synergy_s"].mean()), 4),
                                    "synergie_moy_s+1": round(float(top["synergy_s1"].mean()), 4)},
        }
    # Contrôle positif : xGF% « sans la combinaison » d'un joueur, saisons consécutives
    p = d[["season", "members", "wo"]].explode(["members", "wo"]).rename(columns={"members": "pid"})
    p = p.groupby(["pid", "season"])["wo"].mean().reset_index()
    pp = p.merge(p.assign(season=p.season - 1), on=["pid", "season"], suffixes=("_s", "_s1"))
    out["controle_positif_joueur"] = corr_block(pp["wo_s"].astype(float), pp["wo_s1"].astype(float))
    return out


# ── B. Arbitres ──────────────────────────────────────────────────────────────

def load_ref_games() -> pd.DataFrame:
    off = pd.read_csv(f"{DATA_DIR}/officials.csv")
    t = pd.read_csv(f"{DATA_DIR}/mp_team_games.csv",
                    usecols=["gameId", "situation", "iceTime", "penaltiesFor", "home_or_away"])
    pen = (t[t.situation == "all"].groupby("gameId")["penaltiesFor"].sum().rename("penalties"))
    pp = (t[t.situation.isin(["5on4"])].groupby("gameId")["iceTime"].sum() / 60).rename("pp_min")
    g = pd.read_csv(f"{DATA_DIR}/nhl_games_v4.csv", low_memory=False,
                    usecols=["game_id", "season", "date", "home_reg_score", "away_reg_score"])
    d = off.merge(g, on=["game_id"], suffixes=("", "_g"))
    d = d.merge(pen, left_on="game_id", right_index=True, how="left") \
         .merge(pp, left_on="game_id", right_index=True, how="left")
    d["goals"] = d["home_reg_score"] + d["away_reg_score"]
    if os.path.exists(f"{DATA_DIR}/served_pregame.csv"):
        s = pd.read_csv(f"{DATA_DIR}/served_pregame.csv", usecols=["game_id", "lam_home", "lam_away"])
        d = d.merge(s, on="game_id", how="left")
        d["exp_goals"] = d["lam_home"] + d["lam_away"]
        d["goals_resid"] = d["goals"] - d["exp_goals"]
    d = d[(d["ref1"].fillna("") != "") & (d["ref2"].fillna("") != "")]
    return d.sort_values("date").reset_index(drop=True)


def ref_effects(d: pd.DataFrame, col: str, shrink: float = REF_SHRINK) -> pd.Series:
    """Effet de chaque arbitre : écart moyen de ses matchs à la moyenne de leur
    saison, rétréci (n / (n + shrink)). Un match compte pour ses deux arbitres."""
    x = d[["season", "ref1", "ref2", col]].dropna()
    dev = x[col] - x.groupby("season")[col].transform("mean")
    long = pd.concat([pd.DataFrame({"ref": x.ref1, "dev": dev}), pd.DataFrame({"ref": x.ref2, "dev": dev})])
    agg = long.groupby("ref")["dev"].agg(["sum", "count"])
    return (agg["sum"] / (agg["count"] + shrink)).rename(col), agg["count"]


def run_refs() -> dict:
    if not os.path.exists(f"{DATA_DIR}/officials.csv"):
        return {"note": "officials.csv absent — lancer fetch_officials_lines.py --officials"}
    d = load_ref_games()
    out = {"matchs": int(len(d)), "saisons": [int(d.season.min()), int(d.season.max())],
           "arbitres": int(pd.concat([d.ref1, d.ref2]).nunique())}
    even, odd = d[d.season % 2 == 0], d[d.season % 2 == 1]
    pers = {}
    for col in ("penalties", "pp_min", "goals", "goals_resid"):
        if col not in d:
            continue
        e_eff, e_n = ref_effects(even, col, shrink=0)
        o_eff, o_n = ref_effects(odd, col, shrink=0)
        both = pd.concat([e_eff.rename("e"), o_eff.rename("o"), e_n.rename("n_pair"),
                          o_n.rename("n_impair")], axis=1).dropna()
        both = both[(both["n_pair"] >= 100) & (both["n_impair"] >= 100)]
        sd = float(d[col].std())
        pers[col] = {**corr_block(both["e"], both["o"]),
                     "ecart_type_par_match": round(sd, 3),
                     "ecart_type_effets_arbitre": round(float(both[["e", "o"]].mean(axis=1).std()), 3)}
    out["persistance_pairs_vs_impairs"] = pers

    # Test prédictif sur le total servi, walk-forward
    if "goals_resid" in d:
        dd = d.dropna(subset=["goals_resid", "exp_goals"]).copy()

        def dev(y, mu):
            mu = np.clip(mu, 1e-6, None)
            t = np.where(y > 0, y * np.log(np.where(y > 0, y, 1.0) / mu), 0.0)
            return 2.0 * (t - (y - mu))

        deltas, by = [], []
        seasons = sorted(dd.season.unique())
        for i, s in enumerate(seasons):
            past = dd[dd.season < s]
            if past.season.nunique() < 3:
                continue
            eff, _ = ref_effects(past, "goals_resid")
            # coefficient d'échelle ajusté sur le passé (moindres carrés, borné à [0, 1])
            xp = past.ref1.map(eff).fillna(0) + past.ref2.map(eff).fillna(0)
            k = float(np.clip((xp * past.goals_resid).sum() / max((xp ** 2).sum(), 1e-9), 0, 1))
            cur = dd[dd.season == s]
            adj = k * (cur.ref1.map(eff).fillna(0) + cur.ref2.map(eff).fillna(0))
            mu0 = cur.exp_goals.to_numpy()
            mu1 = np.clip(mu0 + adj.to_numpy(), 0.5, None)
            y = cur.goals.to_numpy(float)
            dlt = dev(y, mu1) - dev(y, mu0)
            deltas.append(dlt)
            by.append({"saison": int(s), "n": int(len(cur)), "k": round(k, 3),
                       "delta_deviance": round(float(dlt.mean()), 6)})
        if deltas:
            dl = np.concatenate(deltas)
            se = float(dl.std(ddof=1) / math.sqrt(len(dl)))
            z = float(dl.mean()) / se if se > 0 else float("nan")
            better = sum(1 for r in by if r["delta_deviance"] < 0)
            out["walk_forward_total"] = {
                "n": int(len(dl)), "delta_deviance": round(float(dl.mean()), 6), "se": round(se, 6),
                "z": round(z, 2), "saisons_meilleures": f"{better}/{len(by)}",
                "verdict": ("ADOPTER" if z <= -2 and better / len(by) >= 0.7
                            else "PIRE" if z >= 2 else "NON TRANCHABLE"),
                "regle": "z <= -2 (apparié par match) ET >= 70 % des saisons", "par_saison": by}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lines", action="store_true")
    ap.add_argument("--refs", action="store_true")
    a = ap.parse_args()
    both = not (a.lines or a.refs)
    try:
        with open(REPORT, encoding="utf-8") as fh:
            rep = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        rep = {}
    rep["generated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    if a.lines or both:
        rep["lines"] = run_lines()
        print("🏒 Trios / paires :", json.dumps(rep["lines"], ensure_ascii=False, indent=1))
    if a.refs or both:
        rep["refs"] = run_refs()
        r = {k: v for k, v in rep["refs"].items() if k != "walk_forward_total"}
        print("🦓 Arbitres :", json.dumps(r, ensure_ascii=False, indent=1))
        if "walk_forward_total" in rep["refs"]:
            w = rep["refs"]["walk_forward_total"]
            print("   walk-forward total :", {k: v for k, v in w.items() if k != "par_saison"})
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump(rep, fh, ensure_ascii=False, indent=1, default=float)
    print(f"✅ {os.path.relpath(REPORT)}")


if __name__ == "__main__":
    main()
