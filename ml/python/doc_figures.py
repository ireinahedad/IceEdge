"""Figures des §4 à §8 de ml/EXPLICATION_ML.md, recalculées depuis les rapports.

    python doc_figures.py                 # toutes les figures
    python doc_figures.py marges matrice  # seulement celles-là (noms ci-dessous)

Aucune valeur n'est recopiée à la main : tout vient de `ml/models/*.json`, des
CSV de `ml/data/` et du code servi (`score_model.py`, `game_dynamics.py`, la
règle `_factor_of` de `ml_service.py`). Après un réentraînement ou
`refresh_data.py`, relancer ce script remet le document à jour. Une figure dont
la source manque (CSV non versionnés) est sautée avec un avertissement ; les
autres sont quand même écrites.

Sorties dans ml/figures/ :
  importance  → score_features.png      §4.1.2  importance des 26 features, par famille
  decoupage   → score_split.png         §4.1.3  découpage chronologique train / val / test
  marges      → score_margins.png       §4.1.4  écarts après 60' : observé, Poisson, moteur
  moteur      → engine_c.png            §4.1.4 bis  multiplicateur c selon l'avance et la minute
  correction  → correction_seasons.png  §4.3.2  gain de la couche de correction, saison par saison
  niveau      → level_seasons.png       §4.3 bis  buts observés / λ, saison par saison
  joueur      → player_gain.png         §4.4    modèle joueur contre la règle, par statistique
  matrice     → score_matrix.png        §5      une matrice M et quatre marchés lus dedans
  fiabilite   → pregame_reliability.png §8      fiabilité avant-match, brut contre chaîne servie

Ne dépend ni de xgboost ni de FastAPI : numpy, pandas, matplotlib.
"""
import ast
import json
import os
import sys

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from matplotlib.ticker import FuncFormatter

from game_dynamics import BUCKET_LABELS, EDGES, LEAD_CLIP, MatchDynamics, read_game_dynamics, regulation_matrix
from score_model import ScoreDistribution, joint_matrix, p_ot_for, read_ot_model

HERE = os.path.dirname(os.path.abspath(__file__))
ML = os.path.dirname(HERE)
MODELS = os.path.join(ML, "models")
DATA = os.path.join(ML, "data")
FIG = os.path.join(ML, "figures")

# Mêmes couleurs que live_reliability_figures.py : orange = ancien / brut,
# bleu = servi, gris = observé ou neutre.
BLUE, ORANGE, GREY, PURPLE = "#2b6cb0", "#c05621", "#718096", "#6b46c1"
LIGHT_BLUE, LIGHT_ORANGE = "#63a4e0", "#e3873f"
INK, MUTED = "#1a202c", "#4a5568"

plt.rcParams.update({
    "figure.dpi": 150, "font.size": 9, "axes.titlesize": 10, "axes.labelsize": 9,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.edgecolor": "#a0aec0", "axes.labelcolor": INK, "xtick.color": MUTED, "ytick.color": MUTED,
    "legend.frameon": False,
})


# ── Petits outils ────────────────────────────────────────────────────────────

def fr(x, d=1):
    """Nombre à la française : virgule décimale, espace des milliers."""
    s = f"{x:,.{d}f}".replace(",", " ").replace(".", ",")
    return s.replace("-", "−")


def pct(x, d=1):
    return f"{fr(100 * x, d)} %"


def season_label(s):
    return f"{s}-{str(s + 1)[2:]}"


def load_json(name):
    with open(os.path.join(MODELS, name), encoding="utf-8") as fh:
        return json.load(fh)


def read_csv(name, **kw):
    return pd.read_csv(os.path.join(DATA, name), low_memory=False, **kw)


def save(fig, name):
    os.makedirs(FIG, exist_ok=True)
    path = os.path.join(FIG, name)
    fig.savefig(path, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    return path


def from_source(filename, func_name):
    """Une fonction d'un module du projet, sans importer ce module (ml_service et
    train_score importent xgboost / FastAPI). La règle reste écrite à un seul
    endroit : la figure suit le code servi."""
    with open(os.path.join(HERE, filename), encoding="utf-8") as fh:
        tree = ast.parse(fh.read())
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == func_name)
    ns = {"pd": pd, "np": np}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), f"{filename}:{func_name}", "exec"), ns)
    return ns[func_name]


def pct_axis(ax, axis="y", d=0):
    f = FuncFormatter(lambda v, _: f"{fr(100 * v, d)} %")
    (ax.yaxis if axis == "y" else ax.xaxis).set_major_formatter(f)


def num_axis(ax, axis="y", d=3):
    f = FuncFormatter(lambda v, _: fr(v, d))
    (ax.yaxis if axis == "y" else ax.xaxis).set_major_formatter(f)


def engine():
    tau, c = read_game_dynamics(load_json("game_dynamics.json"))
    if c is None:
        raise ValueError("game_dynamics.json refusé par read_game_dynamics")
    return c


def games_v4(cols):
    return read_csv("nhl_games_v4.csv", usecols=cols)


# ── §4.1.2 Importance des features ───────────────────────────────────────────

FACTOR_FR = {  # libellés de l'application (client/src/app/i18n, ml.factor.*)
    "factor.attack": "Attaque", "factor.opp_defense": "Défense adverse",
    "factor.goalie": "Gardien adverse", "factor.lineup": "Alignement et étoiles",
    "factor.schedule": "Calendrier", "factor.team_strength": "Force d'équipe (ELO)",
    "factor.home_ice": "Avantage de la glace", "factor.other": "Autres",
}


def fig_importance():
    rep = load_json("score_report.json")
    factor_of = from_source("ml_service.py", "_factor_of")
    fi = pd.DataFrame(rep["feature_importances"])
    fi["family"] = fi["name"].map(factor_of)
    tot = fi.groupby("family")["importance"].sum().sort_values(ascending=False)

    labels, values, bold = [], [], []
    for fam in tot.index:
        labels.append(f"{FACTOR_FR.get(fam, fam)} — {pct(tot[fam] / fi['importance'].sum())}")
        values.append(np.nan)
        bold.append(True)
        for r in fi[fi["family"] == fam].sort_values("importance", ascending=False).itertuples():
            labels.append(r.name)
            values.append(r.importance / fi["importance"].sum())
            bold.append(False)

    y = np.arange(len(labels))
    fig, ax = plt.subplots(figsize=(7.6, 0.24 * len(labels) + 1.0))
    ax.barh(y, values, color=BLUE, height=0.7)
    ax.set_yticks(y, labels)
    for t, b in zip(ax.get_yticklabels(), bold):
        if b:
            t.set_fontweight("bold"); t.set_color(INK)
        else:
            t.set_fontfamily("monospace"); t.set_fontsize(8)
    ax.invert_yaxis()
    ax.tick_params(axis="y", length=0)
    pct_axis(ax, "x")
    ax.grid(alpha=.3, axis="x")
    ax.set_xlabel("Part du gain XGBoost (somme = 100 %)")
    ax.set_title(f"Modèle de score : les {len(fi)} features, regroupées comme les facteurs de l'application",
                 loc="left")
    return save(fig, "score_features.png")


# ── §4.1.3 Découpage chronologique ───────────────────────────────────────────

def fig_split():
    rep = load_json("score_report.json")
    split = from_source("train_score.py", "split")
    df = games_v4(["game_id", "date", "home_reg_score", "away_reg_score", "went_to_ot",
                   "total_goals", "home_win"])
    df = df.dropna().sort_values("date").reset_index(drop=True)      # comme train_score.main
    # Le dataset grossit chaque lundi : on retrouve la taille qu'il avait à
    # l'entraînement à partir des effectifs écrits dans score_report.json.
    n_tr, n_te = rep["n_train"], rep["n_test"]
    n = next((k for k in range(n_tr + n_te, len(df) + 1)
              if [len(p) for p in split(pd.DataFrame({"date": np.arange(k)}))][::2] == [n_tr, n_te]), None)
    if n is None:
        raise ValueError("découpage de score_report.json introuvable dans nhl_games_v4.csv")
    tr, va, te = split(df.iloc[:n])
    post = df.iloc[n:]
    parts = [("Entraînement", tr, BLUE), ("Validation", va, PURPLE), ("Test", te, ORANGE),
             ("Joués après l'entraînement", post, GREY)]

    seasons = sorted((df["game_id"] // 1_000_000).unique())
    fig, ax = plt.subplots(figsize=(9, 3.6))
    bottom = np.zeros(len(seasons))
    for name, part, color in parts:
        cnt = (part["game_id"] // 1_000_000).value_counts().reindex(seasons, fill_value=0).values
        if not len(part):
            continue
        lab = f"{name} : {fr(len(part), 0)} matchs ({part['date'].min()} → {part['date'].max()})"
        ax.bar(range(len(seasons)), cnt, bottom=bottom, color=color, width=0.8, label=lab,
               edgecolor="white", linewidth=1)
        bottom += cnt
    ax.set_xticks(range(len(seasons)), [season_label(s) for s in seasons], rotation=45, ha="right", fontsize=8)
    ax.set_ylabel("Matchs de saison régulière")
    ax.set_ylim(0, bottom.max() * 1.08)
    ax.grid(alpha=.3, axis="y")
    ax.legend(loc="upper left", bbox_to_anchor=(0, -0.28), ncol=2, fontsize=8)
    ax.set_title("Découpage chronologique du modèle de score : on apprend sur le passé, on juge sur l'avenir",
                 loc="left")
    return save(fig, "score_split.png")


# ── §4.1.4 Écarts de score après 60 minutes ─────────────────────────────────

def fig_margins():
    gd = load_json("game_dynamics.json")
    c = engine()
    window = gd["window_seasons"]
    pre = read_csv("live_pregame.csv")
    pre = pre[pre["season"].isin(window)]
    sc = games_v4(["game_id", "home_reg_score", "away_reg_score"]).dropna()
    g = pre.merge(sc, on="game_id")
    g = g[g["lam_home"].between(0.5, 8.0) & g["lam_away"].between(0.5, 8.0)]

    K = 4                                         # |écart| 0, 1, 2, 3, 4+
    idx = np.arange(joint_matrix(1.0, 1.0).shape[0])
    absm = np.clip(np.abs(idx[:, None] - idx[None, :]), 0, K)
    pois, eng = np.zeros(K + 1), np.zeros(K + 1)
    for lh, la in zip(g["lam_home"].values, g["lam_away"].values):
        M = joint_matrix(lh, la)
        E = regulation_matrix(lh, la, c)
        for d in range(K + 1):
            pois[d] += M[absm == d].sum()
            eng[d] += E[absm == d].sum()
    pois, eng = pois / len(g), eng / len(g)
    obs = np.bincount(np.clip(np.abs(g["home_reg_score"] - g["away_reg_score"]).astype(int), 0, K),
                      minlength=K + 1) / len(g)

    x = np.arange(K + 1)
    w = 0.27
    fig, ax = plt.subplots(figsize=(8, 3.8))
    series = [(obs, GREY, "Observé"), (pois, ORANGE, "Deux Poisson indépendantes"),
              (eng, BLUE, "Moteur de match (servi)")]
    for k, (v, color, name) in enumerate(series):
        ax.bar(x + (k - 1) * w, v, width=w - 0.02, color=color, label=name)
        for d in (0, 3):                       # les deux cases où Poisson se trompe le plus
            ax.text(x[d] + (k - 1) * w, v[d] + 0.004, pct(v[d], 1), ha="center", va="bottom",
                    fontsize=7, color=INK)
    ax.set_xticks(x, ["Nul\n(prolongation)", "±1", "±2", "±3", "±4 ou plus"])
    ax.set_xlabel("Écart de score après 60 minutes")
    ax.set_ylabel("Part des matchs")
    pct_axis(ax)
    ax.set_ylim(0, max(obs.max(), pois.max(), eng.max()) * 1.12)
    ax.grid(alpha=.3, axis="y")
    ax.legend(loc="upper left", bbox_to_anchor=(0, -0.2), ncol=3)
    ax.set_title(f"Pourquoi corriger Poisson : écarts après 60' sur {season_label(window[0])} → "
                 f"{season_label(window[-1])} ({fr(len(g), 0)} matchs, λ hors échantillon)", loc="left")
    return save(fig, "score_margins.png")


# ── §4.1.4 bis Le moteur de match : table c ─────────────────────────────────

def fig_engine():
    gd = load_json("game_dynamics.json")
    c = engine()
    labels = []
    for a, b in zip(EDGES[:-1], EDGES[1:]):
        labels.append(f"{a // 60}-{b // 60}'")
    leads = [(-2, ORANGE, "-"), (-1, LIGHT_ORANGE, "--"), (0, GREY, "-"), (1, LIGHT_BLUE, "--"), (2, BLUE, "-")]
    names = {-2: "Équipe menée de 2", -1: "Équipe menée de 1 (gardien sorti)", 0: "Égalité",
             1: "Équipe qui mène de 1 (vise le filet vide)", 2: "Équipe qui mène de 2"}
    x = np.arange(len(labels))
    fig, ax = plt.subplots(figsize=(8.6, 3.9))
    ax.axhline(1, color=GREY, lw=.8, ls=":")
    for lead, color, ls in leads:
        v = c[lead + LEAD_CLIP]
        ax.plot(x, v, color=color, ls=ls, lw=2, marker="o", ms=4, label=names[lead])
        ax.annotate(f"×{fr(v[-1], 2)}", (x[-1], v[-1]), xytext=(6, 0), textcoords="offset points",
                    va="center", fontsize=8, color=INK)
    ax.set_yscale("log")
    ticks = [0.5, 1, 2, 4, 8]
    ax.set_yticks(ticks, [f"×{fr(t, 1 if t < 1 else 0)}" for t in ticks])
    ax.minorticks_off()
    ax.set_xticks(x, labels, fontsize=8)
    ax.axvspan(3.5, len(x) - 0.5, color="#edf2f7", zorder=-1)
    ax.text(3.6, ax.get_ylim()[1] * 0.92, "minute par minute", fontsize=7.5, color=MUTED, va="top")
    ax.set_xlabel("Tranche de temps réglementaire")
    ax.set_ylabel("c : cadence de buts / cadence normale")
    ax.grid(alpha=.3, axis="y")
    ax.legend(loc="upper left", fontsize=8)
    w = gd["window_seasons"]
    ax.set_title(f"Moteur de match : la cadence de chaque équipe selon son avance et la minute "
                 f"({season_label(w[0])} → {season_label(w[-1])}, {fr(gd['diagnostics']['goals'], 0)} buts)",
                 loc="left")
    return save(fig, "engine_c.png")


# ── §4.3.2 Couche de correction, saison par saison ──────────────────────────

def fig_correction():
    rep = load_json("correction_report.json")
    bs = pd.DataFrame(rep["by_season"])
    dC, dR = bs["ll_C"] - bs["ll_raw"], bs["ll_R"] - bs["ll_raw"]
    x = np.arange(len(bs))
    fig, ax = plt.subplots(figsize=(8.6, 3.6))
    ax.bar(x - 0.2, dR, width=0.38, color=GREY, label="R : recalibration seule (contrôle)")
    ax.bar(x + 0.2, dC, width=0.38, color=BLUE, label="C : recalibration + 5 variables (servie)")
    ax.axhline(0, color=INK, lw=.8)
    labels = [season_label(s) if n >= 500 else f"{season_label(s)}\n({n} matchs)"
              for s, n in zip(bs["season"], bs["n"])]
    ax.set_xticks(x, labels, fontsize=8)
    num_axis(ax, d=3)
    ax.set_ylabel("Δ log-loss contre le brut\n(négatif = mieux)")
    ax.grid(alpha=.3, axis="y")
    ax.legend(loc="lower left", fontsize=8)
    v = rep["variants"]["C"]
    nb = len(v["seasons_better"])
    ax.set_title(f"Couche de correction en walk-forward : C meilleure que le brut {nb} saisons sur {len(bs)} "
                 f"(Δ {fr(v['delta'], 4)}, z {fr(v['z'], 1)})", loc="left")
    return save(fig, "correction_seasons.png")


# ── §4.3 bis Recalage de niveau ─────────────────────────────────────────────

def fig_level():
    rep = load_json("level_report.json")
    s = pd.DataFrame(rep["seasons"])
    fig, ax = plt.subplots(figsize=(8.2, 3.5))
    ax.axhline(1, color=GREY, lw=.8, ls=":")
    x = list(s["season"])
    ax.plot(x, s["ratio_obs_lam"], color=ORANGE, lw=2, marker="o", ms=5,
            label="Buts observés ÷ λ prévus (fin de saison)")
    ax.plot(x, s["k_end"], color=BLUE, lw=2, marker="D", ms=4, ls="--",
            label=f"k servi en fin de saison (rétréci, {rep['prior_games']} matchs fictifs)")
    try:
        cur = load_json("level_layer.json")
        ax.plot([cur["season"]], [cur["k"]], marker="D", ms=6, mfc="white", mec=BLUE, mew=1.5, ls="none",
                label=f"k actuel {season_label(cur['season'])} ({cur['n_games']} matchs au {cur['as_of']})")
        x = x + [cur["season"]]
    except (FileNotFoundError, KeyError):
        pass
    ax.set_xticks(x, [season_label(v) for v in x], fontsize=8)
    num_axis(ax, d=2)
    ax.set_ylabel("Rapport")
    ax.grid(alpha=.3, axis="y")
    ax.legend(loc="lower left", fontsize=8)
    ax.set_title(f"Recalage de niveau : buts observés ÷ buts prévus, saison par saison "
                 f"(déviance z {fr(rep['z'], 1)}, meilleure {rep['seasons_better']} saisons sur "
                 f"{rep['seasons_total']})", loc="left")
    return save(fig, "level_seasons.png")


# ── §4.4 Modèle joueur ──────────────────────────────────────────────────────

STAT_FR = {"goals": "Buts", "assists": "Passes", "points": "Points", "shots": "Tirs",
           "hits": "Mises en échec", "blocks": "Tirs bloqués", "pim": "Minutes de pénalité",
           "ppPoints": "Points en AN"}


def fig_player():
    rep = load_json("player_report.json")
    rows = []
    for s, v in rep["stats"].items():
        if "loglik_model" in v and "loglik_rules" in v:
            rows.append((STAT_FR.get(s, s), (v["loglik_model"] - v["loglik_rules"]) / abs(v["loglik_rules"]),
                         v["loglik_model"], v["loglik_rules"]))
    rows.sort(key=lambda r: r[1])
    fig, ax = plt.subplots(figsize=(7.4, 3.3))
    y = np.arange(len(rows))
    ax.barh(y, [r[1] for r in rows], color=BLUE, height=0.65)
    for k, r in enumerate(rows):
        ax.text(r[1], k, f"  {fr(r[2], 4)} contre {fr(r[3], 4)}", va="center", fontsize=7.5, color=MUTED)
    ax.set_yticks(y, [r[0] for r in rows])
    ax.tick_params(axis="y", length=0)
    pct_axis(ax, "x", d=1)
    ax.set_xlim(0, max(r[1] for r in rows) * 1.75)
    ax.grid(alpha=.3, axis="x")
    ax.set_xlabel("Gain de log-vraisemblance par joueur-match, en % de la règle")
    test = str(rep.get("split", {}).get("test", ""))
    test = f"dès {season_label(int(test[2:]))}" if test.startswith(">=") else test
    ax.set_title(f"Modèle joueur contre la règle du serveur, test {test}\n"
                 f"(log-vraisemblance par joueur-match, modèle contre règle ; plus à droite = mieux)",
                 loc="left")
    return save(fig, "player_gain.png")


# ── §5 La matrice et quatre marchés ─────────────────────────────────────────

EXAMPLE = (3.30, 2.70)      # le match fictif du §11


def fig_matrix():
    rep = load_json("score_report.json")
    gd = load_json("game_dynamics.json")
    lh, la = EXAMPLE
    dist = ScoreDistribution(lh, la, p_ot_for(read_ot_model(rep), lh, la, rep["p_ot_home"]),
                             MatchDynamics(engine(), gd["window_seasons"]))
    M = dist.M
    n = 8                                        # 0 à 7 buts affichés (le reste < 1 %)
    i, j = np.meshgrid(np.arange(n), np.arange(n), indexing="ij")
    panels = [
        ("Domicile gagne en 60 min", i > j, float(M[dist._margin > 0].sum()), "Σ cases i > j"),
        ("Nul après 60 min → prolongation", i == j, dist.p_regulation_tie(), "Σ cases i = j"),
        ("Puck line domicile −1,5", i - j >= 2, dist.p_home_cover_minus_15(), "Σ cases i − j ≥ 2"),
        ("Plus de 5,5 buts", i + j >= 6, dist.p_over(5.5), "Σ cases i + j ≥ 6"),
    ]
    vmax = M[:n, :n].max()
    fig, axes = plt.subplots(2, 2, figsize=(9, 8.4))
    for ax, (title, zone, p, formula) in zip(axes.flat, panels):
        ax.imshow(M[:n, :n], cmap="Blues", vmin=0, vmax=vmax * 1.15, origin="upper")
        for a in range(n):
            for b in range(n):
                v = M[a, b]
                inside = zone[a, b]
                if v >= 0.0045:
                    ax.text(b, a, fr(100 * v, 1), ha="center", va="center", fontsize=6.5,
                            color="white" if v > vmax * 0.6 else INK, alpha=1 if inside else 0.35)
                if inside:
                    ax.add_patch(Rectangle((b - 0.5, a - 0.5), 1, 1, fill=False, ec=ORANGE, lw=1.6))
        ax.set_xticks(range(n)); ax.set_yticks(range(n))
        ax.set_xlabel("Buts du visiteur (j)"); ax.set_ylabel("Buts du domicile (i)")
        ax.spines[:].set_visible(False)
        ax.tick_params(length=0)
        ax.set_title(f"{title}\n{formula} = {pct(p, 1)}", fontsize=9.5)
    fig.suptitle(f"Une seule matrice M, tous les marchés : λ_dom = {fr(lh, 2)}, λ_ext = {fr(la, 2)} "
                 f"(moteur de match, cases en % ; orange = cases additionnées)", fontsize=10)
    fig.tight_layout()
    return save(fig, "score_matrix.png")


# ── §8 Fiabilité avant-match ────────────────────────────────────────────────

def _reliability(p, y, bins=10):
    q = np.quantile(p, np.linspace(0, 1, bins + 1))
    b = np.clip(np.searchsorted(q, p, side="right") - 1, 0, bins - 1)
    rows = []
    for k in range(bins):
        m = b == k
        if m.sum():
            obs = y[m].mean()
            rows.append((p[m].mean(), obs, 1.96 * np.sqrt(obs * (1 - obs) / m.sum()), m.sum()))
    ece = sum(n * abs(pp - o) for pp, o, _, n in rows) / len(p)
    return rows, ece


def fig_reliability():
    sv = read_csv("served_pregame.csv")
    sv = sv[sv["p_home_corr"].notna()]
    res = games_v4(["game_id", "home_win"]).dropna()
    g = sv.merge(res, on="game_id")
    y = g["home_win"].astype(float).values
    fig, ax = plt.subplots(figsize=(5.6, 5.2))
    ax.plot([0, 1], [0, 1], color=GREY, lw=1, ls=":")
    for col, color, name, mk in (("p_home_raw", ORANGE, "Modèle de score brut", "o"),
                                 ("p_home_win", BLUE, "Chaîne servie (+ correction + niveau)", "D")):
        rows, ece = _reliability(g[col].values, y)
        ax.errorbar([r[0] for r in rows], [r[1] for r in rows], yerr=[r[2] for r in rows], color=color,
                    marker=mk, ms=5, lw=1.8, capsize=2, label=f"{name} — ECE {pct(ece, 2)}")
    lo, hi = 0.2, 0.85
    ax.set_xlim(lo, hi); ax.set_ylim(lo, hi)
    pct_axis(ax, "x"); pct_axis(ax, "y")
    ax.set_xlabel("Victoire domicile prédite (moyenne du décile)")
    ax.set_ylabel("Victoire domicile observée (± 1,96 e.t.)")
    ax.grid(alpha=.3)
    ax.legend(loc="upper left", fontsize=8)
    s0, s1 = int(g["season"].min()), int(g["season"].max())
    ax.set_title(f"Fiabilité du moneyline avant-match, walk-forward\n{season_label(s0)} → {season_label(s1)}, "
                 f"{fr(len(g), 0)} matchs, par décile de probabilité", loc="left")
    return save(fig, "pregame_reliability.png")


FIGURES = {
    "importance": fig_importance, "decoupage": fig_split, "marges": fig_margins, "moteur": fig_engine,
    "correction": fig_correction, "niveau": fig_level, "joueur": fig_player, "matrice": fig_matrix,
    "fiabilite": fig_reliability,
}


def main(names):
    unknown = [n for n in names if n not in FIGURES]
    if unknown:
        sys.exit(f"Figures inconnues : {unknown}. Choix : {', '.join(FIGURES)}")
    done, skipped = [], []
    for name in names or FIGURES:
        try:
            path = FIGURES[name]()
            done.append(os.path.relpath(path, ML))
        except FileNotFoundError as e:
            skipped.append(f"{name} (source absente : {os.path.basename(e.filename or str(e))})")
        except (KeyError, ValueError) as e:
            skipped.append(f"{name} ({type(e).__name__} : {e})")
    for p in done:
        print(f"✅ {p}")
    for s in skipped:
        print(f"⏭  {s}")
    return 1 if skipped else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
