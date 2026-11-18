"""La CLV survit-elle sans le gardien partant ni l'alignement du soir ?

Question posee le 2026-11-16 (commentaire de la section 7.8 du document
technique). Le backtest donne au modele le gardien qui a REELLEMENT commence et
les 18 patineurs REELLEMENT habilles. Or l'« ouverture » DraftKings est le
premier instantane du jour, a 15:25Z (10 h 25 a l'Est), plusieurs heures avant
la confirmation de l'alignement. Une partie de la CLV mesuree peut donc venir
d'une information que PERSONNE n'avait a ce prix-la. Le placebo de
`_clv_placebo` ne couvre pas ce cas : il corrige la regression vers la moyenne,
pas l'avance d'information.

Le test : la meme chaine, le meme protocole (`run_clv`), deux jeux de variables.

  complet (26) : le modele tel qu'il est mesure dans le document.
  matin   (19) : les 7 variables inconnues a 10 h 25 retirees, puis recherche
                 d'hyperparametres refaite par fold (comme l'ablation par
                 famille). Retirees — attaque : star_power, stars_out_weight,
                 lineup_xg, lineup_pts ; defense : goalie_gsax60, goalie_svpct,
                 goalie_backup.

Lecture fixee AVANT le run (DraftKings, moneyline, edge >= 2 %) :
  • CLV nette du placebo encore z >= 2 en « matin » -> le signal ne vient pas de
    l'information tardive, le resultat de 7.8 tient ;
  • CLV nette sous z = 2, ou qui perd plus de la moitie de sa valeur -> ce que
    7.8 mesure est d'abord la valeur de l'alignement, et il faut le dire ainsi.

« matin » est un PLANCHER, pas le modele du matin : un vrai modele du matin
utiliserait l'alignement ATTENDU (gardien probable, absences annoncees), qui
vaut mieux que rien. L'ecart entre les deux colonnes borne la part de la CLV
qui vient de l'information tardive.

Le shell de la machine coupe un appel a 180 s : le script est donc decoupe.
    python explore_marche/m2_clv_matin.py fit            # a relancer jusqu'a « COMPLET »
    python explore_marche/m2_clv_matin.py clv complet
    python explore_marche/m2_clv_matin.py clv matin
    python explore_marche/m2_clv_matin.py compare        # -> ml/models/clv_matin_report.json
"""
import json, os, pickle, sys, time
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.chdir(os.path.dirname(HERE))

import backtest_walkforward as BW
import train_score as TS

OUT = os.path.join(HERE, "out")
REPORT = f"{BW.MODELS}/clv_matin_report.json"
EDGE = 0.02
NEED = ["home_reg_score", "away_reg_score", "went_to_ot", "total_goals"]

ATK_TARDIF = ["star_power", "stars_out_weight", "lineup_xg", "lineup_pts"]
DEF_TARDIF = ["goalie_gsax60", "goalie_svpct", "goalie_backup"]
ATK_FULL, DEF_FULL = list(TS.ATK_COLS), list(TS.DEF_COLS)
VARIANTS = {
    "complet": (ATK_FULL, DEF_FULL),
    "matin": ([c for c in ATK_FULL if c not in ATK_TARDIF],
              [c for c in DEF_FULL if c not in DEF_TARDIF]),
}


def load_data():
    df = pd.read_csv(BW.DATA, low_memory=False).sort_values("date").reset_index(drop=True)
    df["season"] = df["date"].map(BW.season_of)
    return df


def clv_seasons(df, snaps):
    """Saisons retenues par `main()` pour --clv : couverture des OUVERTURES."""
    snap_keys = set(snaps)
    col = "market_home_p_open"
    in_snaps = pd.Series([(str(d), str(h), str(a)) in snap_keys for d, h, a in
                          zip(df["date"], df["home_team"], df["away_team"])],
                         index=df.index)

    def n_open(s):
        m = df["season"] == s
        n_sbro = int(df.loc[m, col].notna().sum()) if col in df.columns else 0
        return max(n_sbro, int((m & in_snaps).sum()))

    return [s for s in sorted(df["season"].unique())
            if n_open(s) >= 50 and s >= 2012 and (df["season"] < s).sum() >= 800]


def cache_path(variant, season):
    return os.path.join(OUT, f"fold_{variant}_{season}.pkl")


# ── Etape A : un fold par saison et par variante, mis en cache ───────────────
#
# On garde exactement ce dont `run_clv` a besoin : le vecteur de predictions du
# modele sur les lignes empilees de la saison testee (dans l'ordre de
# `TS.stack`), tau et P(domicile en prolongation). Rejouer la CLV ne demande
# alors plus aucun entrainement.
def stage_fit(only=None):
    df = load_data()
    snaps, _ = BW.load_snapshot_pairs()
    seasons = clv_seasons(df, snaps)
    budget = float(os.environ.get("BUDGET", "135"))
    t0 = time.time()
    todo = []
    for name, (atk, dfn) in VARIANTS.items():
        if only and name != only:
            continue
        TS.ATK_COLS, TS.DEF_COLS = list(atk), list(dfn)
        feats = TS.stacked_features()
        params = BW.base_score_params(8)
        for s in seasons:
            f = cache_path(name, s)
            if os.path.exists(f):
                continue
            if time.time() - t0 > budget:
                todo.append((name, s)); continue
            train_df = df[df["season"] < s].dropna(subset=NEED).reset_index(drop=True)
            test_df = df[df["season"] == s].dropna(subset=NEED).reset_index(drop=True)
            if len(test_df) < 50 or len(train_df) < 800:
                continue
            t1 = time.time()
            m, _, tau, p_ot = BW.fit_score_fold(train_df, feats, params, 0,
                                                search_trials=8, season=s,
                                                use_cache=True)
            s_te = TS.stack(test_df)
            pred = m.predict(TS.dm(s_te, feats, with_label=False))
            with open(f, "wb") as fh:
                pickle.dump({"pred": np.asarray(pred, float), "tau": tau,
                             "p_ot": float(p_ot), "n_test": int(len(test_df)),
                             "feats": feats}, fh)
            print(f"   [{name}] {s}-{str(s+1)[2:]:<2} {len(test_df):>6} matchs "
                  f"({time.time()-t1:.0f}s)", flush=True)
    TS.ATK_COLS, TS.DEF_COLS = ATK_FULL, DEF_FULL
    if todo:
        print(f"\n   INCOMPLET : {len(todo)} folds restants "
              f"({todo[0][0]} {todo[0][1]} ... {todo[-1][0]} {todo[-1][1]}) — relancer")
    else:
        print("\n   COMPLET : tous les folds sont en cache")


class _Replay:
    """Modele factice : rejoue les predictions du fold mises en cache."""

    def __init__(self, pred):
        self.pred = pred

    def predict(self, dmat, *a, **k):
        n = dmat.num_row()
        if n != len(self.pred):
            raise RuntimeError(f"cache desaligne : {n} lignes contre {len(self.pred)}")
        return self.pred


def _patched_fit(variant):
    def fit(train_df, feats, params, n_members, search_trials=0, season=None,
            use_cache=True):
        with open(cache_path(variant, season), "rb") as fh:
            c = pickle.load(fh)
        return _Replay(c["pred"]), [], c["tau"], c["p_ot"]
    return fit


# ── Etape B : la CLV, avec le code du projet et les folds en cache ───────────
def stage_clv(variant):
    atk, dfn = VARIANTS[variant]
    TS.ATK_COLS, TS.DEF_COLS = list(atk), list(dfn)
    df = load_data()
    snaps, snap_stats = BW.load_snapshot_pairs()
    seasons = clv_seasons(df, snaps)
    missing = [s for s in seasons if not os.path.exists(cache_path(variant, s))]
    if missing:
        print(f"   folds manquants pour {variant} : {missing} — lancer « fit »"); return
    print(f"== variante {variant} : {len(TS.stacked_features())} variables, "
          f"{len(seasons)} saisons ==", flush=True)
    real = BW.fit_score_fold
    BW.fit_score_fold = _patched_fit(variant)
    try:
        res = BW.run_clv(df, seasons, EDGE, search_trials=8, use_cache=True,
                         snaps=snaps, snap_stats=snap_stats)
    finally:
        BW.fit_score_fold = real
        TS.ATK_COLS, TS.DEF_COLS = ATK_FULL, DEF_FULL
    if res:
        res["_variante"] = {"nom": variant, "n_features": len(TS.stacked_features(atk, dfn)),
                            "retirees": ([c for c in ATK_FULL if c not in atk]
                                         + [c for c in DEF_FULL if c not in dfn])}
        BW._dump_json_atomic(res, os.path.join(OUT, f"clv_{variant}.json"))
        print(f"\nOK out/clv_{variant}.json")


def summarize(res: dict) -> dict:
    keep = ("edge", "n_bets", "hit_rate", "roi_open_pct", "roi_se_pct", "z",
            "clv_net", "clv_net_z", "roi_implied_by_close_pct")
    small = {"variante": res.get("_variante"), "by_source": {}}
    for src, blk in (res.get("by_source") or {}).items():
        entry = {}
        for market, rows in (blk.get("markets") or {}).items():
            if not isinstance(rows, list) or not rows:
                continue
            entry[market] = [
                {**{k: r.get(k) for k in keep},
                 "clv_mean": (r.get("clv") or {}).get("mean"),
                 "clv_t": (r.get("clv") or {}).get("t"),
                 "clv_share_positive": (r.get("clv") or {}).get("share_positive"),
                 "placebo_mean": (r.get("clv_placebo") or {}).get("mean")}
                for r in rows]
        if blk.get("a2_rule"):
            a2 = blk["a2_rule"]
            entry["a2_rule"] = {
                "n_bets": a2.get("n_bets"), "roi_open_pct": a2.get("roi_open_pct"),
                "clv_mean": (a2.get("clv") or {}).get("mean"),
                "clv_t": (a2.get("clv") or {}).get("t"),
                "placebo_mean": (a2.get("clv_placebo") or {}).get("mean"),
                "clv_net": a2.get("clv_net"), "clv_net_z": a2.get("clv_net_z"),
                "verdict": a2.get("verdict")}
        small["by_source"][src] = entry
    return small


def stage_compare():
    full = {}
    for name in VARIANTS:
        f = os.path.join(OUT, f"clv_{name}.json")
        if os.path.exists(f):
            full[name] = json.load(open(f, encoding="utf-8"))
        else:
            print(f"   manque out/clv_{name}.json")
    if not full:
        return
    out = {
        "question": ("la CLV survit-elle sans le gardien partant ni l'alignement "
                     "du soir, inconnus au prix d'ouverture de 10 h 25 ?"),
        "protocol": {
            "chaine": "modele de score brut (sans couche de correction), comme run_clv ; "
                      "pari si p_modele - p_ouverture >= edge",
            "variantes": {k: {"n_features": len(TS.stacked_features(a, d)),
                              "retirees": ([c for c in ATK_FULL if c not in a]
                                           + [c for c in DEF_FULL if c not in d])}
                          for k, (a, d) in VARIANTS.items()},
            "hyperparametres": "recherche refaite par fold pour chaque variante (8 essais)",
            "lecture": "CLV nette du placebo encore z >= 2 en « matin » -> le signal "
                       "ne vient pas de l'information tardive",
            "plancher": "« matin » retire toute information d'alignement ; un vrai modele "
                        "du matin utiliserait l'alignement attendu",
            "edge_reference": EDGE,
            "xgboost": __import__("xgboost").__version__,
        },
        "variantes": {k: summarize(v) for k, v in full.items()},
    }
    BW._dump_json_atomic(out, REPORT)
    print("== CLV moneyline, par source et par seuil d'edge ==")
    for src in ("oddsapi:draftkings", "sbro"):
        print(f"\n   [{src}]")
        print(f"   {'edge':>5} {'variante':>9} {'paris':>7} {'ROI ouv':>9} {'CLV':>10} "
              f"{'t':>6} {'placebo':>10} {'nette':>10} {'z net':>7}")
        for edge in (0.01, 0.02, 0.03, 0.04, 0.05):
            for name in out["variantes"]:
                rows = ((out["variantes"][name]["by_source"].get(src) or {})
                        .get("moneyline") or [])
                r = next((x for x in rows if abs(x["edge"] - edge) < 1e-9), None)
                if not r:
                    continue
                print(f"   {edge:>5.0%} {name:>9} {r['n_bets']:>7} "
                      f"{r['roi_open_pct']:>8.2f}% {(r['clv_mean'] or 0):>+10.5f} "
                      f"{(r['clv_t'] or 0):>6.2f} {(r['placebo_mean'] or 0):>+10.5f} "
                      f"{(r['clv_net'] or 0):>+10.5f} {(r['clv_net_z'] or 0):>+7.2f}")
    print("\n   Regle A2 (puck line -1.5, DraftKings) :")
    for name in out["variantes"]:
        a2 = ((out["variantes"][name]["by_source"].get("oddsapi:draftkings") or {})
              .get("a2_rule"))
        if a2:
            print(f"   {name:>9} {a2['n_bets']:>5} paris  ROI {a2['roi_open_pct']:+.2f} %  "
                  f"CLV {a2['clv_mean']:+.5f} (t {a2['clv_t']:+.2f})  "
                  f"placebo {a2['placebo_mean']:+.5f}  nette {a2['clv_net']:+.5f} "
                  f"(z {a2['clv_net_z']:+.2f})")
    print(f"\nOK {REPORT.split('/')[-1]} -> {BW.MODELS}/")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "fit"
    if cmd == "fit":
        stage_fit(sys.argv[2] if len(sys.argv) > 2 else None)
    elif cmd == "clv":
        stage_clv(sys.argv[2])
    elif cmd == "compare":
        stage_compare()
    else:
        print(__doc__)
