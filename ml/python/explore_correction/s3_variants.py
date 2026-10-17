"""Pistes 3 à 6 — variantes de la couche C, même protocole walk-forward.

  3. ÉLAGAGE / B vs C
     C6  = C sans `xg_matchup_diff` (z −0,5 dans la couche servie)
     C5  = C6 sans `ev_xgf_pct_l_diff` (z 0,7)
     B   = C sans `elo_diff` (le modèle de score lit déjà l'ELO)
  4. FATIGUE / VOYAGE (calculé, jamais utilisé — §3.6)
     C+voy    : + `distance_km_diff`, `tz_shift_diff`, `tz_abs_diff` (|décalage| dom − ext)
     C+3en4   : + `three_in_four_diff` (3e match en 4 soirs)
     C+repos  : + `rest_days_diff`
     C+b2bG   : + `b2b_backup_diff` (dos-à-dos ET gardien de relève)
  5. PÉRIODE DE LA SAISON
     C+tôt    : + `elo_diff × tôt`, `ev_xgf_pct_s_diff × tôt`, avec tôt = exp(−gp_min / 15)
               (l'ELO devrait peser plus quand les moyennes sur 10-20 matchs sont vides)
  6. DÉRIVE
     C_hl3, C_hl5 : saisons passées pondérées, demi-vie 3 / 5 saisons
     C_w6         : fenêtre glissante, 6 dernières saisons seulement

RÈGLES FIXÉES AVANT LE RUN.
  • Ajouts (4, 5) et pondérations (6) : adoptés s'ils battent C à z ≤ −2,5
    (≈ Bonferroni pour ~8 essais) ET sur ≥ 70 % des saisons.
  • Élagage (3, C6, C5) : parcimonie — la version plus simple remplace C si elle
    ne perd pas à z ≥ +1 contre C ET bat toujours le brut au critère d'origine
    (z ≤ −2, ≥ 70 % des saisons).
  • B : remplace C seulement si elle bat C (z ≤ −2) — retirer une variable à
    z 4 n'est pas de la parcimonie.
"""
from lab import *
from lab import _std

G = load()
raw = G["p_ml"].to_numpy()

# ── variables supplémentaires ───────────────────────────────────────────────
df = pd.read_csv(BW.DATA, low_memory=False, usecols=["game_id", "date", "home_team", "away_team"])
long = pd.concat([pd.DataFrame({"game_id": df.game_id, "team": df[f"{s}_team"], "side": s,
                                "d": pd.to_datetime(df.date)}) for s in ("home", "away")])
long = long.sort_values(["team", "d"]).reset_index(drop=True)
prev1 = long.groupby("team")["d"].shift(1)
prev2 = long.groupby("team")["d"].shift(2)
long["three_in_four"] = ((long["d"] - prev2).dt.days <= 3).astype(float)
t34 = long.pivot_table(index="game_id", columns="side", values="three_in_four", aggfunc="first")
G["three_in_four_diff"] = (G["game_id"].map(t34["home"]) - G["game_id"].map(t34["away"])).astype(float)
G["tz_abs_diff"] = G["home_tz_shift"].abs() - G["away_tz_shift"].abs()
G["b2b_backup_diff"] = (G["home_b2b"] * (G["home_backup"] == 1)).astype(float) \
                       - (G["away_b2b"] * (G["away_backup"] == 1)).astype(float)
early = np.exp(-G["gp_min_f"].fillna(0) / 15.0)
G["elo_x_early"] = G["elo_diff"] * early
G["xgf_s_x_early"] = G["ev_xgf_pct_s_diff"] * early


def hl_weight(h):
    return lambda P, s: 0.5 ** ((s - 1 - P["season"].to_numpy()) / h)


def window(k):
    return lambda P, s: (P["season"].to_numpy() >= s - k).astype(float)


V = {
    "C":       dict(feats=C7),
    "C6":      dict(feats=[c for c in C7 if c != "xg_matchup_diff"]),
    "C5":      dict(feats=[c for c in C7 if c not in ("xg_matchup_diff", "ev_xgf_pct_l_diff")]),
    "B":       dict(feats=[c for c in C7 if c != "elo_diff"]),
    "C+voy":   dict(feats=C7 + ["distance_km_diff", "tz_shift_diff", "tz_abs_diff"]),
    "C+3en4":  dict(feats=C7 + ["three_in_four_diff"]),
    "C+repos": dict(feats=C7 + ["rest_days_diff"]),
    "C+b2bG":  dict(feats=C7 + ["b2b_backup_diff"]),
    "C+tôt":   dict(feats=C7 + ["elo_x_early", "xgf_s_x_early"]),
    "C_hl3":   dict(feats=C7, weight=hl_weight(3)),
    "C_hl5":   dict(feats=C7, weight=hl_weight(5)),
    "C_w6":    dict(feats=C7, weight=window(6)),
}
kind = {"C6": "élagage", "C5": "élagage", "B": "B"}
P = {k: as_vector(G, walk_forward(G, v["feats"], weight=v.get("weight"), name=k)) for k, v in V.items()}

out = {"protocol": __doc__.strip().split("\n\n")[1:], "variants": {}}
print(f"{'':<8} {'vs C':>10} {'z':>6} {'saisons':>8}   {'vs brut':>10} {'z':>6}  verdict")
for k, p in P.items():
    vc, vb = compare(G, p, P["C"], k), compare(G, p, raw, k)
    if k == "C":
        v = "-"
    elif kind.get(k) == "élagage":
        v = "ADOPTER (parcimonie)" if (vc["z"] or 0) < 1 and verdict(vb) == "ADOPTER" else "GARDER C"
    elif k == "B":
        v = "ADOPTER" if verdict(vc) == "ADOPTER" else "GARDER C"
    else:
        v = verdict(vc, z=-2.5)
    out["variants"][k] = {"vs_C": vc, "vs_raw": vb, "verdict": v}
    print(f"{k:<8} {vc['delta']:>+10.5f} {vc['z'] or 0:>+6.2f} {vc['seasons_better']:>4}/{vc['n_seasons']}"
          f"   {vb['delta']:>+10.5f} {vb['z']:>+6.2f}  {v}")

# Stabilité des coefficients de C d'un fold à l'autre (piste 6)
seasons = sorted(G.season.unique())
coefs = {}
for i, s in enumerate(seasons):
    if i < MIN_PAST:
        continue
    tr = np.flatnonzero(G.season.isin(seasons[:i]).to_numpy())
    B_, R_ = design(G, C7, tr)
    R_, _ = _std(R_, R_[:1])
    b, se = BW._logistic_offset(G.y.to_numpy()[tr], np.column_stack([B_, R_]), np.zeros(len(tr)))
    coefs[int(s)] = [round(float(x), 4) for x in b]
out["coef_by_fold"] = {"order": ["const", "logit_p"] + C7, **coefs}
print("\nCoefficients de C par fold (const, logit p, puis", C7, ")")
for s, c in coefs.items():
    print(" ", s, c)

# Effet de chaque variable de fatigue SAISON PAR SAISON (pour la dérive de b2b)
print("\nb2b_diff au-delà du modèle, saison par saison (coef par écart-type, z) :")
byb = {}
for s in seasons:
    m = (G.season == s).to_numpy()
    x = G.loc[m, "b2b_diff"].astype(float).to_numpy()
    xs = (x - x.mean()) / x.std()
    b, se = BW._logistic_offset(G.y.to_numpy()[m], np.column_stack([G.lp.to_numpy()[m], xs]), np.zeros(m.sum()))
    byb[int(s)] = [round(float(b[2]), 3), round(float(b[2] / se[2]), 2)]
    print(" ", s, byb[int(s)])
out["b2b_by_season"] = byb
dump("s3_variants_report.json", out)
