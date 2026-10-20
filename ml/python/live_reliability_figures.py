"""Figures du §10.6 (ml/EXPLICATION_ML.md) à partir de models/live/live_reliability.json.

    python live_reliability_figures.py   (après server/scripts/replay-live-reliability.ts)

→ figures/live_reliability.png : courbes de fiabilité, cadence fixe contre table servie,
  avant la 3e / 3e période / 5 dernières minutes ;
→ figures/live_gain_by_minute.png : gain de log-loss de la table servie, instant par instant.
"""
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
ML = os.path.dirname(HERE)
SRC = os.path.join(ML, "models", "live", sys.argv[1] if len(sys.argv) > 1 else "live_reliability.json")
FIG_REL = os.path.join(ML, "figures", "live_reliability.png")
FIG_MIN = os.path.join(ML, "figures", "live_gain_by_minute.png")
BLUE, ORANGE, GREY = "#2b6cb0", "#c05621", "#718096"
PHASES = [("early", "Avant la 3e"), ("p3", "3e, 19 à 6 min restantes"), ("late", "5 dernières minutes")]


def fr(x, d=1):
    return f"{x:.{d}f}".replace(".", ",")


def main():
    with open(SRC, encoding="utf-8") as fh:
        data = json.load(fh)
    rel = {(r["engine"], r["phase"], r["family"]): r for r in data["reliability"]}

    fig, axes = plt.subplots(1, 3, figsize=(11, 3.9), dpi=150, sharey=True)
    for ax, (ph, title) in zip(axes, PHASES):
        ax.plot([0, 1], [0, 1], color=GREY, lw=1, ls=":")
        for eng, color, name in (("p1", ORANGE, "cadence fixe"), ("p2", BLUE, "table servie")):
            r = rel[(eng, ph, "all")]
            pts = [x for x in r["rows"] if x["n"] >= 30]
            ax.errorbar([x["pred"] for x in pts], [x["obs"] for x in pts],
                        yerr=[1.96 * x["se"] for x in pts], color=color, marker="o", ms=4, lw=1.5,
                        capsize=2, label=f"{name} (ECE {fr(100 * r['ece'], 2)} %)")
        ax.set_title(title)
        ax.set_xlabel("Probabilité prédite")
        ax.set_xlim(0, 1); ax.set_ylim(0, 1)
        ax.grid(alpha=.3)
        ax.legend(fontsize=8, loc="upper left")
    axes[0].set_ylabel("Fréquence observée")
    n = f"{data['games']:,}".replace(",", " ")
    fig.suptitle(f"Fiabilité des 10 marchés en direct — rejeu de {n} matchs")
    fig.tight_layout()
    os.makedirs(os.path.dirname(FIG_REL), exist_ok=True)
    fig.savefig(FIG_REL)
    plt.close(fig)

    ms = data["moments"]
    labels = ["0'", "20'", "40'"] + [f"{60 - int(m['moment'][4:])}'" for m in ms[3:-1]] + ["59'30"]
    y = [100 * (m["logloss2"] - m["logloss1"]) / m["logloss1"] for m in ms]
    err = [100 * 1.96 * m["sePerGame"] * m["games"] / m["logloss1"] for m in ms]
    fig, ax = plt.subplots(figsize=(10, 3.8), dpi=150)
    x = range(len(ms))
    ax.bar(x, y, yerr=err, color=BLUE, capsize=2, width=.7)
    ax.axhline(0, color=GREY, lw=.8)
    ax.set_xticks(list(x), labels, fontsize=8)
    ax.set_xlabel("Temps écoulé au moment de la prédiction")
    ax.set_ylabel("Variation de log-loss (%)\ntable servie contre cadence fixe")
    ax.set_title("Où le mode direct gagne : 10 marchés, instant par instant (± 1,96 e.t. appariée)")
    ax.grid(alpha=.3, axis="y")
    fig.tight_layout()
    fig.savefig(FIG_MIN)
    plt.close(fig)
    print(f"✅ {os.path.relpath(FIG_REL)}, {os.path.relpath(FIG_MIN)}")


if __name__ == "__main__":
    main()
