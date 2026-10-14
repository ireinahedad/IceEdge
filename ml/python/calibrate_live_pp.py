"""
calibrate_live_pp.py
====================
Effet MESURÉ de la situation numérique EN COURS (avantage numérique, 4 c. 4) sur la
cadence de buts, pour les prédictions en direct (`STATUS.md` §3.5, Live, point 1).

── Ce qui est mesuré ────────────────────────────────────────────────────────

Le moteur en direct (`evolveLiveScore`) fait marquer chaque équipe à la cadence

    λ_avant-match × w(t) × m(écart, tranche)            (calibrate_live.py)

λ est une MOYENNE qui contient déjà les avantages numériques d'un match ordinaire.
Quand on SAIT qu'une équipe est à 5 c. 4 pour encore 1 min 20, sa cadence sur ce
laps n'est plus la moyenne. On mesure un facteur g par situation, vue de l'équipe :

    EV   patineurs égaux à 5          PP1  un patineur de plus     SH1  un de moins
    EVS  égaux à 4 ou 3               PP2  deux de plus (5 c. 3)   SH2  deux de moins

    cadence = λ × w(t) × m(écart, tranche) × g(situation)

m est FIGÉ (celui de `liveEffects.json`) ; seul g est ajusté, par maximum de
vraisemblance d'exposition (g = buts / exposition, case par case), puis normalisé
pour que sa moyenne pondérée par l'exposition vaille 1 sur l'entraînement — la
cadence d'un moment SANS information de situation reste λ × w × m, comme aujourd'hui.

Gardien retiré : l'attaquant supplémentaire n'est pas compté (6 c. 5 → EV). Le
gardien retiré est déjà dans m (cases « −1, fin de 3e »).

Situation : fonction en escalier du `situationCode` du play-by-play
(`fetch_live_pbp.py`) ; un but est compté dans la situation de SON événement.

Sortie (`--write` seulement) : la clé `pp` de server/src/services/prediction/liveEffects.json.
⚠️ Rejeu du 2026-10-13 : AUCUN gain (pénalités de compensation, STATUS.md §3.5) — la clé a été
retirée ; ne la réécrire qu'avec un nouveau rejeu gagnant. Rapport : ml/models/live/calibrate_live_pp_report.json.

Usage :
    cd ml/python
    python fetch_live_pbp.py ... && python fetch_live_pbp.py --build     # d'abord
    python calibrate_live_pp.py                      # train 2018-19 → 2022-23, test après
    python calibrate_live_pp.py --write              # + clé pp de liveEffects.json
    python calibrate_live_pp.py --moments            # situations aux instants du rejeu
                                                     # → ml/data/live_pp_moments.csv
"""

import argparse
import datetime as dt
import json
import os

import numpy as np
import pandas as pd

from calibrate_live import DATA, OUT_JSON, SLICES, cell, slice_of, w_integral

REPORT = "../models/live/calibrate_live_pp_report.json"
CATS = ["EV", "EVS", "PP1", "PP2", "SH1", "SH2"]


def norm_code(c) -> str:
    return str(int(c)).zfill(4) if str(c).strip() not in ("", "nan") else ""


def skaters(code: str) -> tuple[int, int] | None:
    """(patineurs domicile, patineurs visiteur), attaquant supplémentaire retiré."""
    if len(code) != 4 or not code.isdigit():
        return None
    ag, as_, hs, hg = (int(x) for x in code)
    if hg == 0: hs -= 1
    if ag == 0: as_ -= 1
    if not (3 <= hs <= 6 and 3 <= as_ <= 6):
        return None
    return hs, as_


def category(own: int, opp: int) -> str:
    d = own - opp
    if d == 0:
        return "EV" if own >= 5 else "EVS"
    if d == 1: return "PP1"
    if d >= 2: return "PP2"
    if d == -1: return "SH1"
    return "SH2"


def exposure(games: pd.DataFrame, states: pd.DataFrame, goals: pd.DataFrame, m: np.ndarray):
    """Par saison : O[cat], X[cat] = Σ λ·w·m (exposition sans g), par équipe."""
    st_by = {g: s for g, s in states.groupby("game_id")}
    go_by = {g: s for g, s in goals.groupby("game_id")}
    bounds = sorted({b for s in SLICES for b in s})
    out: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    ci = {c: i for i, c in enumerate(CATS)}
    skipped = 0
    for r in games.itertuples(index=False):
        O, X = out.setdefault(int(r.season), (np.zeros(len(CATS)), np.zeros(len(CATS))))
        s = st_by.get(r.game_id)
        if s is None:
            skipped += 1; continue
        s = s.sort_values("t", kind="stable")
        sit_t = s["t"].to_numpy(float); sit_c = [skaters(norm_code(c)) for c in s["code"]]
        g = go_by.get(r.game_id)
        gl = [] if g is None else sorted(zip(g["t"].to_numpy(float), g["home_scored"].to_numpy(int),
                                             [skaters(norm_code(c)) for c in g["code"]]), key=lambda x: x[0])
        cuts = sorted(set(bounds) | set(sit_t.tolist()) | {t for t, _, _ in gl})
        cuts = [c for c in cuts if 0 <= c <= 3600]
        h = a = 0; gi = 0
        for t0, t1 in zip(cuts[:-1], cuts[1:]):
            if t1 <= t0:
                continue
            k = np.searchsorted(sit_t, t0, side="right") - 1
            sk = sit_c[k] if k >= 0 else (5, 5)
            sk = sk or (5, 5)
            sl = slice_of(t0); W = w_integral(t0, t1)
            X[ci[category(sk[0], sk[1])]] += r.lam_home * W * m[sl, cell(h - a)]
            X[ci[category(sk[1], sk[0])]] += r.lam_away * W * m[sl, cell(a - h)]
            while gi < len(gl) and gl[gi][0] <= t1:
                tg, home, gsk = gl[gi]
                if tg == t1:
                    gsk = gsk or sk
                    if home: O[ci[category(gsk[0], gsk[1])]] += 1; h += 1
                    else:    O[ci[category(gsk[1], gsk[0])]] += 1; a += 1
                gi += 1
    return out, skipped


# ── Situations aux instants du rejeu (`server/scripts/replay-live.ts`) ──────────
#
# Ce que la feuille de match donnerait à cet instant : `situationCode` en cours et
# temps restant de la pénalité (`situation.secondsRemaining`). Le temps restant est
# RECONSTRUIT à partir des pénalités et des buts déjà passés (heure + durée
# nominale, mineure effacée par un but en avantage) — jamais à partir du moment où
# la situation a réellement pris fin, qui dirait si un but va tomber.
MOMENTS = [0, 1200, 2400, 3300, 3480]       # ⚠️ jumeau de MOMENTS (replay-live.ts)
MANPOWER = {"MIN", "MAJ", "BEN", "MAT"}     # MIS, GAM, PS : pas d'infériorité numérique


def active_penalties(pens: list, goals: list, t: float) -> dict[int, list[float]]:
    """Fin nominale des pénalités qui courent encore à t, par équipe (1 = domicile)."""
    active: dict[int, list[float]] = {0: [], 1: []}
    events = [(pt, 0, tm, du) for pt, tm, du, k in pens if k in MANPOWER and du > 0 and pt <= t]
    events += [(gt, 1, home, gsk) for gt, home, gsk in goals if gt < t]
    for et, kind, a, b in sorted(events, key=lambda e: (e[0], e[1])):
        for side in (0, 1):
            active[side] = [x for x in active[side] if x > et]
        if kind == 0:
            active[a].append(et + b * 60)
        else:
            home, gsk = a, b
            other = 0 if home else 1
            if gsk and ((home and gsk[0] > gsk[1]) or (not home and gsk[1] > gsk[0])):
                # But en avantage : la mineure (≤ 2 min restantes) qui finit le plus tôt est effacée.
                minors = sorted(x for x in active[other] if x - et <= 120)
                if minors:
                    active[other].remove(minors[0])
    for side in (0, 1):
        active[side] = [x for x in active[side] if x > t]
    return active


def write_moments(seasons: list[int]) -> None:
    games = pd.read_csv(f"{DATA}/live_games.csv")
    games = games[games["season"].isin(seasons)]
    states = pd.read_csv(f"{DATA}/live_states.csv")
    pens = pd.read_csv(f"{DATA}/live_penalties.csv")
    goals = pd.read_csv(f"{DATA}/live_pbp_goals.csv")
    st_by = {g: s.sort_values("t", kind="stable") for g, s in states.groupby("game_id")}
    pe_by = {g: list(zip(s["t"], s["home_team"], s["duration"], s["kind"])) for g, s in pens.groupby("game_id")}
    go_by = {g: [(t, h, skaters(norm_code(c))) for t, h, c in zip(s["t"], s["home_scored"], s["code"])]
             for g, s in goals.groupby("game_id")}
    rows = []
    for gid in games["game_id"]:
        s = st_by.get(gid)
        if s is None:
            continue
        ts = s["t"].to_numpy(float); codes = [norm_code(c) for c in s["code"]]
        pe, go = pe_by.get(gid, []), go_by.get(gid, [])

        def at(t: float):
            k = np.searchsorted(ts, t, side="right") - 1
            code = codes[k] if k >= 0 else "1551"
            sk = skaters(code)
            if not sk or (sk[0] == sk[1] and sk[0] >= 5):
                return code, 0, None
            act = active_penalties(pe, go, t)
            if sk[0] < sk[1]:   cand = act[1]
            elif sk[1] < sk[0]: cand = act[0]
            else:               cand = act[0] + act[1]
            if not cand:
                return code, 0, None
            return code, int(round(min(cand) - t)), sk

        moments = [(f"m{e}", e) for e in MOMENTS]
        # Début du premier avantage numérique du match (5 s après), hors bornes de période.
        for t, c in zip(ts, codes):
            sk = skaters(c)
            if sk and sk[0] != sk[1] and 0 < t < 3590 and (t + 5) % 1200 != 0:
                moments.append(("ppStart", float(t) + 5)); break
        for mid, e in moments:
            code, left, sk = at(e)
            rows.append([gid, mid, e, code, left])
    out = pd.DataFrame(rows, columns=["game_id", "moment", "elapsed", "code", "seconds_left"])
    out.to_csv(f"{DATA}/live_pp_moments.csv", index=False)
    on = out[out["seconds_left"] > 0]
    print(f"✅ {len(out)} instants ({out['game_id'].nunique()} matchs), dont {len(on)} en situation "
          f"→ data/live_pp_moments.csv")
    print("   " + "  ".join(f"{m}: {int((g['seconds_left'] > 0).sum())}/{len(g)}" for m, g in out.groupby("moment")))


def poisson_ll(O, X, g):
    mu = np.maximum(X * g, 1e-12)
    return float((O * np.log(mu) - mu).sum())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--first-train", type=int, default=2018)
    ap.add_argument("--last-train", type=int, default=2022)
    ap.add_argument("--write", action="store_true", help="écrire la clé pp dans liveEffects.json")
    ap.add_argument("--moments", action="store_true", help="situations aux instants du rejeu")
    a = ap.parse_args()
    if a.moments:
        write_moments([s for s in range(a.last_train + 1, 2100)]); return

    fx = json.load(open(OUT_JSON, encoding="utf-8"))
    m = np.array(fx["m"], dtype=float)
    games = pd.read_csv(f"{DATA}/live_games.csv")
    pre = pd.read_csv(f"{DATA}/live_pregame.csv")
    states = pd.read_csv(f"{DATA}/live_states.csv")
    goals = pd.read_csv(f"{DATA}/live_pbp_goals.csv")
    games = games.merge(pre[["game_id", "lam_home", "lam_away"]], on="game_id", how="inner")
    games = games[games["season"] >= a.first_train]
    games = games[games["game_id"].isin(set(states["game_id"]))]
    tables, skipped = exposure(games, states, goals, m)
    print(f"   {len(games)} matchs (play-by-play + λ d'avant-match)")

    train = [s for s in sorted(tables) if s <= a.last_train]
    test = [s for s in sorted(tables) if s > a.last_train]
    O = sum(tables[s][0] for s in train); X = sum(tables[s][1] for s in train)
    raw = O / np.maximum(X, 1e-12)
    g = raw / ((raw * X).sum() / X.sum())          # moyenne pondérée par l'exposition = 1
    share = X / X.sum()

    print("\n   situation   part du temps   buts   g (normalisé)   ± 1,96 e.t.")
    for i, c in enumerate(CATS):
        se = g[i] / np.sqrt(max(O[i], 1))
        print(f"   {c:>9} {100 * share[i]:13.2f} % {int(O[i]):6d} {g[i]:15.3f}   ± {1.96 * se:.3f}")

    # Stabilité : g par saison d'entraînement (sans normalisation commune).
    per_season = {}
    for s in train:
        Os, Xs = tables[s]
        rs = Os / np.maximum(Xs, 1e-12)
        per_season[s] = (rs / ((rs * Xs).sum() / Xs.sum())).round(3).tolist()
    print("\n   par saison : " + "  ".join(f"{s}: PP1 {v[2]:.2f} SH1 {v[4]:.2f}" for s, v in per_season.items()))

    test_rows = {}
    for s in test:
        Os, Xs = tables[s]
        flat = (Os.sum() / Xs.sum())               # même niveau global : seul le partage est jugé
        test_rows[s] = {"ll_g": poisson_ll(Os, Xs, g * flat), "ll_flat": poisson_ll(Os, Xs, np.full(len(CATS), flat)),
                        "goals": int(Os.sum())}
        r = test_rows[s]
        print(f"   test {s}-{str(s + 1)[2:]} : gain log-vrais. {r['ll_g'] - r['ll_flat']:+.1f} ({r['goals']} buts)")

    pp = {
        "description": ("Facteur de cadence de buts d'une équipe selon la situation numérique EN COURS, "
                        "vue de l'équipe (EV 5c5, EVS 4c4/3c3, PP1/PP2 un/deux patineurs de plus, "
                        "SH1/SH2 de moins). Moyenne pondérée par le temps = 1. Mesuré par "
                        "calibrate_live_pp.py, ne pas éditer à la main."),
        "generatedAt": dt.date.today().isoformat(),
        "trainSeasons": [train[0], train[-1]],
        "g": {c: round(float(g[i]), 4) for i, c in enumerate(CATS)},
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump({**pp, "timeShare": {c: round(float(share[i]), 5) for i, c in enumerate(CATS)},
                   "observed": {c: int(O[i]) for i, c in enumerate(CATS)},
                   "perSeason": {str(k): v for k, v in per_season.items()},
                   "test": {str(k): v for k, v in test_rows.items()}}, fh, indent=2, ensure_ascii=False)
    if a.write:
        fx["pp"] = pp
        with open(OUT_JSON, "w", encoding="utf-8") as fh:
            json.dump(fx, fh, indent=2, ensure_ascii=False)
        print(f"\n✅ clé pp → {os.path.relpath(OUT_JSON)}")
    print(f"   rapport {os.path.relpath(REPORT)}")


if __name__ == "__main__":
    main()
