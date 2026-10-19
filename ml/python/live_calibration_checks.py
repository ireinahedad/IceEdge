"""
live_calibration_checks.py
==========================
Contrôles de la calibration des effets de score (`calibrate_live.py`),
documentés dans `ml/EXPLICATION_ML.md` §10.3. Ne modifie rien de servi.

  1. Courbe de validation croisée saison par saison en fonction de la force de
     rétrécissement a (grille plus fine que celle de `calibrate_live.py`).
  2. Intervalles de confiance à 95 % de chaque multiplicateur m : bootstrap
     PAR MATCH (les buts d'un même match ne sont pas indépendants), λ
     d'avant-match tenus fixes, a = celui de `liveEffects.json`.
     Variante à DEUX NIVEAUX : on tire d'abord des saisons (avec remise), puis
     des matchs dans chaque saison tirée. Elle ajoute la variation d'une
     saison à l'autre — style de jeu, et modèle d'avant-match du fold qui
     produit les λ (walk-forward, un modèle par saison).
  3. m de quelques cases clés estimé saison par saison (stabilité, dérive).

  4. Carte de chaleur de la table servie (`liveEffects.json`).

Sorties :
    ml/models/live/calibrate_live_checks.json
    ml/figures/live_cv_shrink.png
    ml/figures/live_m_heatmap.png

Usage :
    cd ml/python
    python live_calibration_checks.py            # B = 2000 tirages
    python live_calibration_checks.py --boot 500
"""

import argparse
import json
import os

import numpy as np
import pandas as pd

import calibrate_live as C

DATA = "../data"
REPORT = "../models/live/calibrate_live_checks.json"
FIG = "../figures/live_cv_shrink.png"
HEATMAP = "../figures/live_m_heatmap.png"
CV_GRID = [0, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 60, 80, 120, 160, 250, 400, 1000]
KEY_CELLS = {  # (tranche, écart) → libellé
    (7, 1): "mène de 1, 59-60'",
    (7, -1): "menée de 1, 59-60'",
    (7, 0): "égalité, 59-60'",
    (6, 2): "mène de 2, 58-59'",
}


def per_game_tables(games: pd.DataFrame, goals: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """O et E de CHAQUE match (match × tranche × écart), même découpage que calibrate_live."""
    by_game = {gid: g for gid, g in goals.groupby("game_id")}
    bounds = sorted({b for s in C.SLICES for b in s})
    n, S = len(games), len(C.SLICES)
    O, E = np.zeros((n, S, 7)), np.zeros((n, S, 7))
    for k, r in enumerate(games.itertuples(index=False)):
        g = by_game.get(r.game_id)
        events = [] if g is None else list(zip(g["time"].values, g["home_scored"].values))
        cuts = sorted(set(bounds) | {float(t) for t, _ in events})
        h = a = ev = 0
        for t0, t1 in zip(cuts[:-1], cuts[1:]):
            if t1 <= t0:
                continue
            sl, W = C.slice_of(t0), C.w_integral(t0, t1)
            E[k, sl, C.cell(h - a)] += r.lam_home * W
            E[k, sl, C.cell(a - h)] += r.lam_away * W
            while ev < len(events) and events[ev][0] <= t1:
                t, home = events[ev]
                if t == t1:
                    sg = C.slice_of(t)
                    if home:
                        O[k, sg, C.cell(h - a)] += 1; h += 1
                    else:
                        O[k, sg, C.cell(a - h)] += 1; a += 1
                ev += 1
    return O, E


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--boot", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    fx = json.load(open(C.OUT_JSON, encoding="utf-8"))
    first, last = fx["trainSeasons"]
    shrink = fx["shrink"]

    games = pd.read_csv(f"{DATA}/live_games.csv")
    goals = pd.read_csv(f"{DATA}/live_goals.csv")
    pre = pd.read_csv(f"{DATA}/live_pregame.csv")
    games = games.merge(pre[["game_id", "lam_home", "lam_away"]], on="game_id", how="inner")
    games = games[games["season"] >= first].reset_index(drop=True)
    O, E = per_game_tables(games, goals)
    season = games["season"].values
    tr = season <= last
    Ot, Et = O[tr], E[tr]
    m = C.shrunk(Ot.sum(0), Et.sum(0), shrink)
    assert np.allclose(np.round(m, 4), np.array(fx["m"])), "m ne recolle pas à liveEffects.json"

    # 1. Courbe CV.
    train = [s for s in sorted(set(season)) if s <= last]
    Os = {s: O[season == s].sum(0) for s in train}
    Es = {s: E[season == s].sum(0) for s in train}
    OT, ET = sum(Os.values()), sum(Es.values())
    flat = sum(C.poisson_ll(Os[s], Es[s], np.ones_like(OT)) for s in train)
    cv = {a: sum(C.poisson_ll(Os[s], Es[s], C.shrunk(OT - Os[s], ET - Es[s], a)) for s in train) - flat
          for a in CV_GRID}

    # 2. Bootstrap par match.
    rng = np.random.default_rng(args.seed)
    n = len(Ot)
    bs = np.empty((args.boot,) + m.shape)
    for b in range(args.boot):
        w = np.bincount(rng.integers(0, n, n), minlength=n).astype(float)
        bs[b] = C.shrunk(np.tensordot(w, Ot, 1), np.tensordot(w, Et, 1), shrink)
    lo, hi = np.percentile(bs, 2.5, 0), np.percentile(bs, 97.5, 0)
    sig = (lo > 1) | (hi < 1)

    # 2 bis. Bootstrap à deux niveaux : saisons, puis matchs dans la saison.
    season_tr = season[tr]
    seasons_tr = sorted(set(season_tr))
    idx = {s: np.where(season_tr == s)[0] for s in seasons_tr}
    b2 = max(200, args.boot // 2)
    bs2 = np.empty((b2,) + m.shape)
    for b in range(b2):
        w = np.zeros(n)
        for s in rng.choice(seasons_tr, len(seasons_tr)):
            ii = idx[s]
            w += np.bincount(rng.choice(ii, len(ii)), minlength=n)
        bs2[b] = C.shrunk(np.tensordot(w, Ot, 1), np.tensordot(w, Et, 1), shrink)
    lo2, hi2 = np.percentile(bs2, 2.5, 0), np.percentile(bs2, 97.5, 0)
    sig2 = (lo2 > 1) | (hi2 < 1)
    widen = (hi2 - lo2) / np.maximum(hi - lo, 1e-9)

    # 3. Cases clés saison par saison.
    per_season = {}
    for (i, d), lab in KEY_CELLS.items():
        j = d + 3
        per_season[lab] = {int(s): round(float(C.shrunk(O[season == s][:, i, j].sum(),
                                                         E[season == s][:, i, j].sum(), shrink)), 2)
                           for s in sorted(set(season))}

    out = {
        "generatedAt": pd.Timestamp.today().date().isoformat(),
        "trainSeasons": [first, last], "shrink": shrink, "boot": args.boot,
        "cv_gain_vs_flat": {str(a): round(v, 2) for a, v in cv.items()},
        "m": np.round(m, 3).tolist(), "ci95_low": np.round(lo, 3).tolist(),
        "ci95_high": np.round(hi, 3).tolist(), "significant": sig.tolist(),
        "n_significant": int(sig.sum()),
        "two_level": {"boot": b2, "ci95_low": np.round(lo2, 3).tolist(), "ci95_high": np.round(hi2, 3).tolist(),
                      "significant": sig2.tolist(), "n_significant": int(sig2.sum()),
                      "width_ratio_median": round(float(np.median(widen)), 2),
                      "width_ratio_range": [round(float(widen.min()), 2), round(float(widen.max()), 2)]},
        "per_season_key_cells": per_season,
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
    print(f"   {sig.sum()}/{sig.size} cases significativement ≠ 1 ; gain CV à a = {shrink} : {cv[shrink]:+.1f}")
    print(f"   deux niveaux : {sig2.sum()}/{sig2.size} cases ≠ 1 ; intervalles × {np.median(widen):.2f} (médiane)")

    # Figure.
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    a = np.array(CV_GRID, dtype=float)
    y = np.array([cv[x] for x in CV_GRID])
    x = np.where(a == 0, 0.25, a)
    fig, ax = plt.subplots(figsize=(7, 3.6), dpi=150)
    ax.plot(x, y, marker="o", color="#2b6cb0", lw=1.8, ms=4)
    ax.axvline(shrink, color="#c05621", ls="--", lw=1)
    ax.annotate(f"a = {shrink} retenu\n{cv[shrink]:+,.1f}".replace(",", " ").replace(".", ","),
                xy=(shrink, cv[shrink]), xytext=(6, 0.8 * cv[shrink]),
                arrowprops=dict(arrowstyle="->", color="#c05621"), color="#c05621")
    ax.set_xscale("log")
    ax.set_xticks([0.25, 1, 2, 5, 10, 40, 160, 1000])
    ax.set_xticklabels(["0", "1", "2", "5", "10", "40", "160", "1000"])
    ax.set_xlabel("Force du rétrécissement a (buts fictifs, échelle log)")
    ax.set_ylabel("Gain de log-vraisemblance CV\n(contre m ≡ 1)")
    ax.set_title(f"Choix de a par validation croisée saison par saison ({first}-{last})")
    ax.grid(alpha=.3)
    fig.tight_layout()
    os.makedirs(os.path.dirname(FIG), exist_ok=True)
    fig.savefig(FIG)
    plt.close(fig)
    heatmap(np.array(fx["m"]), sig, plt)
    print(f"✅ {os.path.relpath(REPORT)}  ·  figures {os.path.relpath(FIG)}, {os.path.relpath(HEATMAP)}")


def heatmap(m: np.ndarray, sig: np.ndarray, plt) -> None:
    """Table m servie : couleur = log2(m) (bleu < 1 < rouge), * = intervalle à 95 % qui exclut 1."""
    from matplotlib.colors import TwoSlopeNorm
    rows = ["0-20'", "20-40'", "40-50'", "50-55'", "55-57'", "57-58'", "58-59'", "59-60'"]
    cols = ["−3", "−2", "−1", "0", "+1", "+2", "+3"]
    z = np.log2(m)
    fig, ax = plt.subplots(figsize=(7, 4.6), dpi=150)
    im = ax.imshow(z, cmap="RdBu_r", norm=TwoSlopeNorm(vmin=-1.5, vcenter=0, vmax=3), aspect="auto")
    for i in range(m.shape[0]):
        for j in range(m.shape[1]):
            txt = f"{m[i, j]:.2f}".replace(".", ",") + ("*" if sig[i, j] else "")
            ax.text(j, i, txt, ha="center", va="center", fontsize=8.5,
                    color="white" if abs(z[i, j]) > 1.2 else "#1a202c")
    ax.set_xticks(range(7), cols)
    ax.set_yticks(range(8), rows)
    ax.set_xlabel("Écart au score vu de l'équipe qui marque (− = menée, + = mène)")
    ax.set_ylabel("Tranche (temps écoulé)")
    ax.set_title("Multiplicateur de cadence de buts m (liveEffects.json)")
    cb = fig.colorbar(im, ax=ax, fraction=0.04, pad=0.02)
    ticks = [0.5, 0.75, 1, 1.5, 2, 4, 8]
    cb.set_ticks(np.log2(ticks))
    cb.set_ticklabels([str(t).replace(".", ",") for t in ticks])
    cb.set_label("m (échelle log)")
    fig.tight_layout()
    fig.savefig(HEATMAP)
    plt.close(fig)


if __name__ == "__main__":
    main()
