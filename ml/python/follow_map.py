"""
follow_map.py — O1 « Follow Map » : DraftKings suit-il un livre de référence ?

Expérience décrite dans le Claude Doc « ArakIce — Reverse-Engineering DraftKings:
Research Assessment », section 5. Les mesures et les seuils de décision y ont été
FIGÉS AVANT toute donnée (2026-11-02) ; ce script les applique tels quels, il
n'en invente pas d'autres.

Entrée : l'export de `odds_snapshots` (`npm run odds:export-snapshots` dans
`server`), une ligne par (match, passe, livre), colonne `source` =
`oddsapi:<livre>`. Les livres parallèles n'y apparaissent que si
`ODDS_SHADOW_BOOKMAKERS` est posée sur Railway. Résultats : `games_spine.csv`.

Aucun appel réseau, aucun crédit The Odds API.

  python follow_map.py                                  # défauts ci-dessous
  python follow_map.py --csv ../data/odds_snapshots_live.csv --ref pinnacle
  python follow_map.py --since 2026-11-03 --out ../models/follow_map_report.json

Mesures (doc §5) :
  M1 couverture   part des matchs cotés par chaque livre à ≥ 4 passes
  M2 suiveur      parmi les mouvements DraftKings ≥ 1.0 pt (sans marge) entre deux
                  passes, part précédée — intervalle précédent, strictement plus
                  tôt — d'un mouvement ≥ 0.5 pt dans le même sens chez la
                  référence ; placebo = le sens inverse (DraftKings d'abord)
  M3 écarts       quand |DK − réf| ≥ 1.5 pt à une passe : part moyenne de l'écart
                  comblée par DK et par la réf d'ici la dernière passe avant le match
  M4 clôture      log-loss de la clôture de chaque livre, mêmes matchs
  M6 dévig        proportionnel / puissance / Shin : lequel ramène les prix
                  DraftKings le plus près du sans-marge de la référence
  (M5 — CLV d'arakiceML recalculé contre la clôture de référence — passe par
   `backtest_walkforward.py --clv` ; pas ici.)

Règles de décision (doc §5) :
  « suit »          M2 ≥ 50 %, ≥ 2× son placebo, et DK comble en moyenne ≥ 65 %
                    de chaque écart M3 (et plus que la référence)
  « indépendant »   M2 ≤ 25 %
  sinon             « entre les deux » → lire M2 par fenêtre avant de trancher
  coupe-circuit     référence < 60 % des matchs (M1) → consensus FanDuel +
                    BetMGM + Caesars + bourses à la place de Pinnacle
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"

DK = "draftkings"
# Consensus de repli (coupe-circuit) : livres US « marché » + bourses.
FALLBACK_CONSENSUS = ["fanduel", "betmgm", "williamhill_us", "kalshi", "polymarket",
                      "novig", "prophetx"]

MOVE_DK = 0.010      # M2 : mouvement DraftKings retenu (1.0 pt de probabilité)
MOVE_REF = 0.005     # M2 : mouvement de la référence qui « précède » (0.5 pt)
GAP_M3 = 0.015       # M3 : écart DK − réf qui ouvre un cas (1.5 pt)
MIN_PASSES_M1 = 4


# ── Dévig ────────────────────────────────────────────────────────────────────

def devig_proportional(h: np.ndarray, a: np.ndarray) -> np.ndarray:
    qh, qa = 1 / h, 1 / a
    return qh / (qh + qa)


def devig_power(h: np.ndarray, a: np.ndarray) -> np.ndarray:
    """Exposant k tel que (1/h)^k + (1/a)^k = 1, par bissection."""
    out = np.empty(len(h))
    for i, (x, y) in enumerate(zip(1 / h, 1 / a)):
        lo, hi = 1.0, 3.0
        for _ in range(60):
            k = (lo + hi) / 2
            if x ** k + y ** k > 1:
                lo = k
            else:
                hi = k
        out[i] = x ** k
    return out


def devig_shin(h: np.ndarray, a: np.ndarray) -> np.ndarray:
    """Méthode de Shin, z trouvé par bissection pour que les deux p somment à 1."""
    out = np.empty(len(h))
    for i, (x, y) in enumerate(zip(1 / h, 1 / a)):
        s = x + y

        def p(q: float, z: float) -> float:
            return (math.sqrt(z * z + 4 * (1 - z) * q * q / s) - z) / (2 * (1 - z))

        lo, hi = 0.0, 0.4
        for _ in range(60):
            z = (lo + hi) / 2
            if p(x, z) + p(y, z) > 1:
                lo = z
            else:
                hi = z
        out[i] = p(x, z)
    return out


# ── Chargement ───────────────────────────────────────────────────────────────

def load(csv: Path, since: str | None) -> pd.DataFrame:
    s = pd.read_csv(csv)
    s["book"] = s["source"].astype(str).str.replace("oddsapi:", "", regex=False)
    # `oddsapi:live` = lignes antérieures à la 038, livre inconnu : écartées.
    s = s[s["book"] != "live"]
    s = s.dropna(subset=["home_ml", "away_ml", "commence_time"])
    s["obs"] = pd.to_datetime(s["observed_at"], utc=True)
    s["ct"] = pd.to_datetime(s["commence_time"], utc=True)
    s = s[s["obs"] < s["ct"]]                       # avant-match seulement
    if since:
        s = s[s["game_date"] >= since]
    s["p"] = devig_proportional(s["home_ml"].to_numpy(float), s["away_ml"].to_numpy(float))
    s["game"] = s["game_date"].astype(str) + "|" + s["home_team"] + "|" + s["away_team"]
    return s.sort_values(["game", "obs", "book"]).reset_index(drop=True)


def pick_reference(s: pd.DataFrame, ref: str, coverage: dict) -> tuple[str, pd.DataFrame]:
    """La référence ; sous 60 % de couverture, consensus médian (coupe-circuit)."""
    if coverage.get(ref, 0.0) >= 0.60:
        return ref, s
    books = [b for b in FALLBACK_CONSENSUS if b in coverage]
    if not books:
        raise SystemExit(f"Référence « {ref} » sous 60 % de couverture et aucun livre du "
                         f"consensus de repli dans l'export ({sorted(coverage)}) — "
                         "vérifier ODDS_SHADOW_BOOKMAKERS.")
    cons = (s[s["book"].isin(books)]
            .groupby(["game", "obs"], as_index=False)
            .agg(p=("p", "median"), game_date=("game_date", "first"),
                 home_team=("home_team", "first"), away_team=("away_team", "first"),
                 ct=("ct", "first")))
    cons["book"] = "consensus"
    return "consensus", pd.concat([s, cons], ignore_index=True)


# ── Mesures ──────────────────────────────────────────────────────────────────

def m1_coverage(s: pd.DataFrame) -> dict:
    games = s["game"].nunique()
    per = s.groupby(["book", "game"])["obs"].nunique().reset_index()
    ok = per[per["obs"] >= MIN_PASSES_M1].groupby("book")["game"].nunique()
    return {b: round(n / games, 4) for b, n in ok.sort_values(ascending=False).items()}


def _wide(s: pd.DataFrame, ref: str) -> pd.DataFrame:
    """Une ligne par (match, passe) où DK ET la référence sont cotés."""
    w = s[s["book"].isin([DK, ref])].pivot_table(index=["game", "obs"], columns="book",
                                                values="p").dropna()
    return w.rename(columns={DK: "dk", ref: "ref"}).reset_index()


def m2_follower(w: pd.DataFrame) -> dict:
    w = w.copy()
    g = w.groupby("game")
    w["d_dk"] = g["dk"].diff()
    w["d_ref"] = g["ref"].diff()
    w["d_dk_prev"] = g["d_dk"].shift(1)
    w["d_ref_prev"] = g["d_ref"].shift(1)
    w["hour_et"] = w["obs"].dt.tz_convert("America/New_York").dt.hour
    w = w.dropna(subset=["d_dk_prev", "d_ref_prev"])

    def share(lead_prev: pd.Series, mover: pd.Series, big: float, small: float) -> tuple[float, int]:
        m = mover.abs() >= big
        if m.sum() == 0:
            return float("nan"), 0
        hit = (np.sign(lead_prev[m]) == np.sign(mover[m])) & (lead_prev[m].abs() >= small)
        return round(float(hit.mean()), 4), int(m.sum())

    follow, n = share(w["d_ref_prev"], w["d_dk"], MOVE_DK, MOVE_REF)
    placebo, n_p = share(w["d_dk_prev"], w["d_ref"], MOVE_DK, MOVE_REF)
    same = w[w["d_dk"].abs() >= MOVE_DK]
    simult = float(((np.sign(same["d_ref"]) == np.sign(same["d_dk"]))
                    & (same["d_ref"].abs() >= MOVE_REF)).mean()) if len(same) else float("nan")
    by_window = {}
    for name, lo, hi in [("avant 17 h ET", 0, 17), ("17 h – mise au jeu", 17, 24)]:
        sub = w[(w["hour_et"] >= lo) & (w["hour_et"] < hi)]
        by_window[name] = dict(zip(("follower_share", "n_dk_moves"),
                                   share(sub["d_ref_prev"], sub["d_dk"], MOVE_DK, MOVE_REF)))
    return {"follower_share": follow, "n_dk_moves": n,
            "placebo_dk_leads_share": placebo, "n_ref_moves": n_p,
            "same_pass_share": round(simult, 4), "by_window": by_window}


def m3_gaps(w: pd.DataFrame) -> dict:
    """Part de chaque écart ≥ 1.5 pt comblée par DK et par la réf d'ici la clôture.

    Critère : DK comble en moyenne ≥ 65 % de l'écart, et plus que la réf.
    (Précisé le 2026-11-02 sur données SYNTHÉTIQUES seulement : une part de
    « cas gagnés » est trop bruitée par les mouvements ultérieurs de la réf —
    un suiveur parfait n'y obtient que ~65 %. Aucune donnée réelle vue.)
    """
    last = (w.groupby("game").tail(1)[["game", "dk", "ref"]]
            .rename(columns={"dk": "dk_close", "ref": "ref_close"}))
    cases = w[(w["dk"] - w["ref"]).abs() >= GAP_M3].merge(last, on="game")
    cases = cases[cases["obs"] < cases.groupby("game")["obs"].transform("max")]
    if cases.empty:
        return {"n_cases": 0}
    gap = cases["ref"] - cases["dk"]
    dk_moved = ((cases["dk_close"] - cases["dk"]) / gap).clip(-1, 2)    # > 0 = vers la réf
    ref_moved = ((cases["ref"] - cases["ref_close"]) / gap).clip(-1, 2) # > 0 = vers DK
    return {"n_cases": int(len(cases)), "n_games": int(cases["game"].nunique()),
            "mean_gap_closed_by_dk": round(float(dk_moved.mean()), 4),
            "mean_gap_closed_by_ref": round(float(ref_moved.mean()), 4),
            "dk_wins_share": round(float((dk_moved > ref_moved).mean()), 4)}


def m4_close(s: pd.DataFrame, spine: Path) -> dict:
    sp = pd.read_csv(spine).rename(columns={"date": "game_date"})
    close = s.sort_values("obs").groupby(["game", "book"]).tail(1)
    close = close.merge(sp[["game_date", "home_team", "away_team", "home_score", "away_score"]],
                        on=["game_date", "home_team", "away_team"])
    close = close.dropna(subset=["home_score"])
    if close.empty:
        return {"n_games": 0}
    close["y"] = (close["home_score"] > close["away_score"]).astype(int)
    books = close.groupby("book")["game"].nunique()
    books = books[books >= 0.6 * close["game"].nunique()].index
    common = set.intersection(*(set(close.loc[close["book"] == b, "game"]) for b in books))
    c = close[close["game"].isin(common) & close["book"].isin(books)]
    p = c["p"].clip(1e-6, 1 - 1e-6)
    c = c.assign(ll=-(c["y"] * np.log(p) + (1 - c["y"]) * np.log(1 - p)))
    res = c.groupby("book")["ll"].mean().sort_values()
    return {"n_games": len(common), "log_loss": {b: round(v, 5) for b, v in res.items()},
            "note": "directionnel sous ~1 000 matchs ; trancher en fin de saison"}


def m6_devig(s: pd.DataFrame, ref: str) -> dict:
    dk = s[s["book"] == DK].set_index(["game", "obs"])
    rf = s[s["book"] == ref].set_index(["game", "obs"])["p"].rename("ref")
    j = dk.join(rf, how="inner")
    if j.empty:
        return {"n": 0}
    h, a = j["home_ml"].to_numpy(float), j["away_ml"].to_numpy(float)
    out = {"n": int(len(j))}
    for name, fn in [("proportional", devig_proportional), ("power", devig_power),
                     ("shin", devig_shin)]:
        err = fn(h, a) - j["ref"].to_numpy()
        out[name] = {"mae": round(float(np.abs(err).mean()), 5),
                     "bias": round(float(err.mean()), 5)}
    out["best"] = min(("proportional", "power", "shin"), key=lambda k: out[k]["mae"])
    margins = s.assign(ovr=1 / s["home_ml"] + 1 / s["away_ml"] - 1).groupby("book")["ovr"].median()
    out["median_overround"] = {b: round(v, 4) for b, v in margins.sort_values().items()}
    return out


def verdict(m1: dict, m2: dict, m3: dict, ref: str) -> str:
    f, pl = m2.get("follower_share"), m2.get("placebo_dk_leads_share")
    dkc, rfc = m3.get("mean_gap_closed_by_dk"), m3.get("mean_gap_closed_by_ref")
    if f is None or (isinstance(f, float) and math.isnan(f)):
        return "pas assez de mouvements DraftKings pour conclure"
    if f >= 0.50 and (pl == 0 or f >= 2 * pl) and dkc is not None and dkc >= 0.65 and dkc > rfc:
        return f"DraftKings SUIT {ref}"
    if f <= 0.25:
        return "DraftKings INDÉPENDANT"
    return "ENTRE LES DEUX — lire by_window avant de trancher"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", type=Path, default=DATA / "odds_snapshots_live.csv")
    ap.add_argument("--spine", type=Path, default=DATA / "games_spine.csv")
    ap.add_argument("--ref", default="pinnacle")
    ap.add_argument("--since", default=None, help="YYYY-MM-DD, début de l'expérience")
    ap.add_argument("--out", type=Path, default=HERE.parent / "models" / "follow_map_report.json")
    args = ap.parse_args()

    s = load(args.csv, args.since)
    if DK not in set(s["book"]):
        raise SystemExit("Aucune ligne DraftKings dans l'export — vérifier ODDS_COLLECT_BOOKMAKERS.")
    m1 = m1_coverage(s)
    ref, s = pick_reference(s, args.ref, m1)
    w = _wide(s, ref)
    m2 = m2_follower(w) if len(w) else {"follower_share": float("nan"), "n_dk_moves": 0}
    m3 = m3_gaps(w) if len(w) else {"n_cases": 0}
    report = {
        "experiment": "O1 Follow Map", "csv": str(args.csv), "since": args.since,
        "games": int(s["game"].nunique()), "books": sorted(set(s["book"]) - {"consensus"}),
        "reference": ref, "M1_coverage": m1, "M2_follower": m2, "M3_gaps": m3,
        "M4_close": m4_close(s[s["book"] != "consensus"], args.spine),
        "M6_devig": m6_devig(s, ref) if ref != "consensus" else {"note": "référence = consensus"},
    }
    report["verdict"] = verdict(m1, m2, m3, ref)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
