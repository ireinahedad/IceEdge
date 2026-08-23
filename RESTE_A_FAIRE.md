# ARAKICE / ICEEDGE — Ce qui reste

**Créé le 2026-08-10 · mis à jour le 2026-08-21** (A5 clos, §2 — la suite ML
est A3/CLV). Ce document regroupe **tout ce qui n'est pas fait**, tiré
des 6 plans et audits du dépôt. Il ne raconte pas ce qui a été livré — l'historique
Git et `PROJECT_CONTEXT.md` s'en chargent.

**Trois plans ont été supprimés** parce qu'ils étaient terminés ; leur restant est
ici et leur contenu durable a été déplacé (détail en dernière section) :

| Supprimé | Pourquoi | Où est parti le contenu durable |
|---|---|---|
| `PLAN.md` | Sections 1-5 livrées ; §6 (Share) livrée depuis, §7 (Opportunities) morte, §8 remplacée par les audits | rien à garder |
| `DEPLOY_PLAN.md` | Redondant avec `DEPLOYMENT.md` | `DEPLOYMENT.md` §4 (hôte canonique) et §6 (checklist) |
| `MARKETPLACE_PLAN.md` | Livré le 2026-08-09 | `DEPLOYMENT.md` §7 (invariants + annexe marketplace) |

**Toujours vivants, à tenir à jour :** `ml/REFACTOR_PLAN.md`, `QA_TEST_PLAN.md`,
`AUDIT_SCALABILITE_COUTS.md`, `PRODUCTION_READINESS_AUDIT.md` (ce dernier est
désormais entièrement absorbé — cf. § « Audit de production : soldé »).

---

## 1. Bloquant avant lancement

Rien ici ne demande de conception ; tout demande **ta machine ou une console**.

| # | Quoi | Où | Pourquoi ça bloque |
|---|---|---|---|
| **B0** | ⚠️ `cd client && npm install && npm run build` | local | **42 dépendances ont été retirées de `package.json` le 2026-08-10** — le `package-lock.json` n'est plus en phase. Le build validé plus tôt l'a été *avant* cette coupe : il ne prouve plus rien. À refaire en premier. |
| B3 | Tir de charge **S1 de validation** : `NHL_USE_MOCK=true` vérifié dans les logs de démarrage, 50 VUs | préprod | Les deux premiers tirs ont mesuré une API NHL morte. Un critère vert peut vouloir dire que le code n'a pas tourné. `AUDIT_SCALABILITE_COUTS.md` §5. |
| B4 | Parcours critiques **F1, F2, I1, I2** en staging | staging | Auth complète, gating Pro, chaîne ML, CORS+cookie cross-site. `QA_TEST_PLAN.md` §1-2. |
| B5 | **C1** — parcours mobile iOS Safari (login → prédiction → paiement) | appareil réel | Safari iOS est la source n°1 de bugs cookies/`SameSite`/PWA. |
| B6 | Poser les **alertes de budget** dans les consoles (Railway, Neon, Odds, LLM, Stripe, Sentry, R2) | consoles | Seuils déjà documentés dans `MONITORING.md`. Hard limits là où ils existent. |
| B7 | Définir `SENTRY_DSN` sur le service **ML** Railway | console | Variable propre à ce service ; le code est prêt et no-op sans elle. |
| B8 | Confirmer la présence de **toutes** les variables d'env dans Railway/Vercel | consoles | Les `.env.example` sont complets ; leur miroir en prod ne l'est pas vérifié. |
| B9 | **Vérifier côté UI** qu'aucune cote factice n'est présentée comme réelle | client | Côté serveur c'est réglé (panne odds → `[]`, jamais de cote inventée). |

**Reportés au lancement officiel, sciemment** — pas des oublis :

- **Vercel Pro** (~20 $/mo). Le plan Hobby interdit l'usage commercial. Le risque
  commence **à la première vente**, pas au premier utilisateur.
- **Cloudflare devant Railway.** Les en-têtes de cache sont posés ; c'est ce qui
  manque pour qu'un CDN serve à quelque chose. Réduit aussi l'egress facturé.

---

## 2. ML — le chemin critique

Source : `ml/REFACTOR_PLAN.md`, qui reste la référence. **A5 est clos depuis le
2026-08-21** (résultat négatif, détail ci-dessous), donc l'ordre restant est
**A3 puis S4**. S4 était retenu tant que le modèle pouvait encore changer de
features ; ce n'est plus le cas, il reste seulement le dernier parce qu'il est
le seul chantier qui touche ce que voit l'app.

### ✅ A5 — clos le 2026-08-21 : les features ne sont pas départageables

**Conclusion, à ne pas re-tester.** L'élagage a été mesuré puis testé, et le
résultat est négatif au sens propre : ce n'est pas « garder les 22 features est
optimal », c'est **« 14 saisons ne permettent pas de dire lesquelles retirer »**.
Le jeu de features est revenu à son état d'origine (13 ATK + 7 DEF), avec la
conclusion écrite en tête de `train_score.py` pour que personne ne recommence.

Le contrôle par suppression réelle a retiré les 12 features au niveau du hasard :

```
Δ log-loss puck line   +0,00019  ±  0,00024   (erreur-type, 14 saisons)
t = 0,82 · 8 saisons dégradées sur 14, ce que le pile ou face donne 39,5 % du temps
```

**L'écart est plus petit que sa propre barre d'erreur.** L'écart-type
inter-saisons vaut 0,00089 : il faudrait **≈ 154 saisons** pour résoudre un effet
de cette taille, ≈ 25 pour un effet de 0,0005. Le critère pré-enregistré rend
`DÉGRADE` (garde-fou sur le compte des signes) et on s'y tient — mais la leçon
qui compte est ailleurs : **aucun sous-groupe ne sera plus résoluble**, puisqu'un
effet plus petit exige encore plus de saisons. Continuer par sous-groupes aurait
été un tapis roulant.

Les métriques secondaires, chacune contre son propre bruit, disent pourquoi la
puck line reste muette : **déviance +0,00089** (±0,00037, nettement pire) contre
**log-loss moneyline −0,00054** (±0,00015, nettement mieux). Les 12 colonnes
portent le **niveau** de λ, pas l'**écart** entre les deux équipes ; la puck line
dépend de l'écart, donc elle se retrouve entre les deux.

> **Ce que ça coûte de garder les 22.** P5 avait mesuré 0,00245 de log-loss pour
> 104 features en trop sur le classifieur. Ici il s'agit de 12, dont l'effet
> mesuré vaut 0,0002. Négligeable — c'est la raison de ne pas y revenir.

**Livré au passage et réutilisable :** le mode `--confirm-score-features`
(1 entraînement par saison au lieu de 26, sentinelles conservées, hyperparamètres
re-cherchés pour le jeu réduit, critère écrit avant le run) et, dans sa sortie,
l'erreur-type et le test des signes à côté du verdict. Trois corrections issues
du run : le crash JSON sur `numpy.int64`, le bruit calculé **par métrique** (la
déviance et la log-loss ne sont pas sur la même échelle) et le drapeau de
désaccord qui en découle.

> **Ordre du plan mis à jour :** A5 étant clos, la suite est **A3 (CLV)**, déjà
> chemin critique depuis A2. S4 reste en dernier, et il n'est plus bloqué — le
> modèle de score ne changera plus de features.

<details>
<summary>Le détail de la mesure A5 (conservé pour référence)</summary>


**Débloqué le 2026-08-18.** Le fichier tronqué de 356 octets n'était pas un
calcul perdu : le run du 2026-08-09 était **complet dans le cache**, seule
l'écriture du rapport avait été coupée. `score_feature_selection.json` a été
**reconstruit depuis `score_ablation_cache.json`** (364 entrées v2, différences
exactes de valeurs mises en cache, aucun réentraînement). Il fait maintenant
74 875 octets et couvre les 14 saisons 2012-2025. Seul `n_games` par saison
manque — il n'était pas mis en cache. **Aucun fit à relancer.**

**Les sentinelles d'abord, comme prévu.** Trois features de bruit pur passées
dans le même tuyau : parts positives **50 %, 57,1 %, 64,3 %**. La médiane à
57,1 % est proche des 50 % attendus → la procédure est saine, le biais résiduel
est faible. Le maximum, **64,3 %, est la barre** ; le seuil de conservation était
pré-enregistré à 70 %.

**Verdicts** (part des 14 saisons où la permutation dégrade la log-loss puck line) :

| Feature | Part + | Gain moyen | Verdict |
|---|---|---|---|
| `elo_atk_minus_def` | **92,9 %** | 0,001193 | GARDER |
| `def_ev_xga60_s` | **85,7 %** | 0,000306 | GARDER |
| `atk_lineup_pts` | **78,6 %** | 0,000480 | GARDER |
| `atk_ev_xgf_pct_s` | 71,4 % | 0,000247 | GARDER |
| `atk_stars_out_weight` | 71,4 % | 0,000203 | GARDER |
| `def_goalie_svpct` | 71,4 % | 0,000179 | GARDER |
| `atk_finishing_s` · `def_goalie_gsax60` · `atk_ev_xgf60_s` | 64,3 % | ≤ 0,000183 | RETIRER — **exactement à la barre** |
| `is_home` | 57,1 % | 0,000246 | STRUCTUREL (gardée sans vote) |
| `atk_star_power` · `atk_xgf60_l` · `def_xga60_l` · `atk_rest_days` | 57,1 % | ≤ 0,000164 | RETIRER |
| `def_pk_xga60_s` · `def_xga60_s` · `atk_lineup_xg` | 50,0 % | ≤ 0,000083 | RETIRER |
| `def_ga_s` · `atk_xgf60_s` · `atk_pp_xgf60_s` | 42,9 % | ≤ 0,000130 | RETIRER |
| `atk_b2b` | 35,7 % | −0,000002 | RETIRER |
| `atk_gf_s` | 21,4 % | 0,000015 | RETIRER |

**Étalonnage du hasard, fourni par le rapport lui-même :** sous l'hypothèse
nulle, une feature isolée passe la barre avec p = 0,0898 ; sur 21 candidates cela
fait **1,89 conservation fausse attendue**. Six ont passé. Le signal est réel,
mais il faut lire « 6 gardées » comme « ~4 vraies et ~2 chanceuses », pas comme
six certitudes — et le rapport ne dit pas lesquelles.

> **Le piège à ne pas manquer : l'ablation est marginale, l'élagage est
> collectif.** Chaque verdict mesure ce qu'apporte une feature *les autres étant
> présentes*. Trois mesures de tir attaquant corrélées (`atk_xgf60_s`,
> `atk_ev_xgf60_s`, `atk_xgf60_l`) se partagent le crédit et sortent toutes les
> trois faibles — ce qui ne prouve pas que les retirer **toutes ensemble** soit
> sans coût. Même configuration pour `atk_star_power` et `atk_lineup_xg`, dont le
> commentaire de `train_score.py` dit explicitement qu'elles sont
> complémentaires, et qui tombent maintenant toutes les deux. Le réentraînement
> de confirmation n'est pas une formalité : c'est **le** test de cette hypothèse.

- [x] Rapport reconstruit depuis le cache · sentinelles lues en premier
- [x] Élagage appliqué (12 features à ≤ 57,1 %), contrôlé, puis **annulé** au vu
      du verdict — cf. la conclusion en tête de section
- [x] `train_score.py` revenu aux 13 ATK + 7 DEF d'origine, conclusion documentée
- [x] Rien à faire côté service : `ml_service.py:323` lit la liste des features
      dans `score_report.json`. Comme le jeu n'a pas bougé au final, **aucun
      réentraînement n'est nécessaire** — `score_model.json` reste valide.

</details>


### A3 — CLV (chemin critique) — collecte livrée le 2026-08-21

A2 a rendu ce poste obligatoire : ~51 paris par saison ne permettront **jamais**
de conclure sur un ROI. Le CLV se mesure comme un écart de prix sur chaque pari,
donc il converge en quelques centaines de paris.

**Ce qui bloquait n'était pas le stockage, c'était le quota.** Un appel à The
Odds API ramène déjà tous les matchs du jour : garder chaque passage ne coûte pas
un crédit de plus, le collecteur les jetait simplement. Mais le budget était
dépassé et le calendrier mal placé :

```
Quota gratuit 500/mois − ODDS_USER_RESERVE 150 = 350 pour la collecte
Avant : setInterval(6 h) → 4 passes × 3 crédits = 12/jour = 360/mois  ✗
Après : 2 passes complètes + 4 passes spreads   = 10/jour = 300/mois  ✓
```

`COLLECT_COST` valait 3 parce qu'une passe demande trois marchés
(`h2h,spreads,totals`), facturés un crédit chacun. **Une passe `spreads` seule
coûte 1 crédit** — et la puck line est le seul marché encore vivant (A2). D'où
six observations par jour pour moins cher que quatre.

Le second défaut était plus grave pour cette mesure précise : `setInterval(6 h)`
démarrait au lancement du processus, donc **la phase dépendait de l'heure du
dernier déploiement Railway**. Le dernier prix observé avant un match de 19 h ET
pouvait dater de six heures. Une « clôture » à T−5 h n'en est pas une, et le
biais va dans le sens optimiste : une ligne qui a moins bougé paraît plus souvent
du bon côté.

- [x] **Migration 031, `odds_snapshots`** — série temporelle, rien n'est jamais
      réécrit. `observed_at` identique pour toute une passe (calculé côté Node,
      pas `NOW()` ligne à ligne) pour que « l'état du marché à 18 h 45 » soit
      regroupable. `commence_time` stockée : les matchs d'une soirée s'étalent de
      19 h à 22 h 30 ET, donc le « T−3 h » est propre à chaque match.
      ~18 000 lignes par saison.
- [x] **`odds_log` inchangé** — c'est le contrat de `fetch_data_v4.py` et de
      `npm run odds:export`. Le logger écrit les deux ; aucun consommateur
      existant ne bouge.
- [x] **Calendrier calé sur l'heure de l'Est** : complètes à 11 h (l'ouverture
      utile, les lignes du soir sont affichées) et 17 h ; `spreads` à 18 h 45,
      19 h 45, 21 h 45 et 22 h 45. Chaque créneau se replanifie après coup, donc
      les passes peuvent être inégalement espacées.
- [x] **Deux bogues corrigés au passage.** L'ancienne version lançait une passe
      20 s après *chaque* démarrage : 3 crédits offerts à chaque redéploiement
      Railway (désormais opt-in via `ODDS_LOG_RUN_AT_BOOT`, pour vérifier la
      chaîne une fois). Et les colonnes `*_open` n'étaient jamais rattrapées : si
      un book n'avait pas encore affiché un marché à la première passe, son
      ouverture restait nulle **pour toujours**, puisque seules les colonnes de
      clôture étaient mises à jour.

> **Ce qu'on perd, assumé :** le moneyline et les totaux n'ont plus de clôture
> stricte — leur dernier prix est celui de 17 h. Ils gardent leur ouverture, ce
> qui suffit à mesurer le mouvement, et aucune stratégie vivante ne les price.

- [ ] **Sur ta machine :** appliquer les migrations **028 et 031**
      (`npm run db:migrate:all`), puis `npm test`
- [ ] **Prod :** poser `ODDS_LOG_ENABLED=true` et `ODDS_USER_RESERVE` sur
      Railway. Optionnellement `ODDS_LOG_RUN_AT_BOOT=true` le temps d'un
      déploiement pour voir une passe complète dans les logs, **puis le retirer**.
#### ⚠️ Le plan se trompait : les ouvertures existent déjà

La case « colonnes `*_open` réelles dans `odds.csv`, aujourd'hui vides » était
**fausse**. Vérifié dans le fichier : `home_ml_open`, `away_ml_open`,
`total_open` et les prix over/under d'ouverture sont remplis à **100 %** sur
10 591 lignes. La remarque « un snapshot pré-match n'est pas une ouverture » ne
concernait que le chemin The Odds API (commentaire de `fetch_data_v4.py:723`) —
elle s'est propagée dans le plan comme si elle valait pour tout le fichier.
`_parse_sbro_html` lit bien les colonnes d'ouverture des pages SBRO, et
`build_dataset.py` en dérive `market_home_p_open` et `market_over_p_open`,
dévigées. **Tout est dans `nhl_games_v4.csv` depuis le début.**

| Saisons avec ouverture | 2014-15 → 2021-22 (complètes) + 2022-23 (partielle) |
|---|---|
| Matchs exploitables | ~9 800 |
| Lignes de total inchangées ouverture→clôture | 82,3 % |
| Écart-type du mouvement moneyline | 0,0315 en probabilité |

- [x] **Mode `--clv` livré le 2026-08-21.** Deux mesures séparées : le **ROI aux
      prix d'ouverture** (« le modèle bat-il le repère faible ? ») et le **CLV**
      (le prix pris est-il meilleur que la clôture ?). Il imprime aussi la
      comparaison d'écarts-types qui justifie tout le poste — combien de paris
      pour conclure sur un ROI contre combien pour conclure sur un CLV, sur les
      mêmes paris.
#### Premier run du 2026-08-21 — et le contrôle qui manquait

19 644 paris moneyline et 19 638 paris totaux sur 9 saisons.

| edge ≥ | paris | ROI ouverture | z | CLV brut |
|---|---|---|---|---|
| 2 % | 6 475 | −0,93 % | −0,65 | +0,0103 |
| 3 % | 4 988 | +2,11 % | 1,26 | +0,0117 |
| **4 %** | **3 751** | **+4,30 %** | **2,16** | +0,0135 |
| 5 % | 2 760 | +4,30 % | 1,80 | +0,0153 |

Totaux : ROI négatif à tous les seuils (−2,1 % à −0,9 %). Rien de neuf, cohérent
avec le verdict « condamnés ».

**L'apparente contradiction — CLV très positif, ROI négatif — n'en est pas une.**
Le CLV se mesure sur des probabilités **dévigées**, le ROI paie la **marge de
4,43 %**. Un CLV de +1,03 point sur un pari à ~45 % vaut environ +2,3 % de mise
brute ; moins la marge, cela fait ≈ −2,1 %. Observé : −0,93 % (± 1,4 %). Les deux
chiffres sont cohérents. **La barre à franchir n'est pas « CLV > 0 », c'est
« CLV > la marge ».**

**En revanche le CLV brut est inutilisable tel quel, et c'est mon omission.** On
sélectionne sur `p_modèle − p_ouverture`, puis on mesure `p_clôture − p_ouverture`
— les deux partagent `p_ouverture`, qui porte du bruit. La sélection retient
préférentiellement les matchs où l'ouverture est trop basse, **y compris par pur
hasard**, et la clôture y remonte mécaniquement. **Un modèle sans aucune
information produit un CLV positif et massivement significatif.** La signature
est dans le tableau : le CLV monte avec le seuil d'edge (+0,0085 → +0,0153) —
mais une vraie compétence produirait exactement la même courbe. Les deux sont
indiscernables dans la sortie brute.

- [x] **Placebo livré le 2026-08-21**, sur le modèle des sentinelles d'A5 : on
      permute les probabilités du modèle **entre les matchs** d'une même saison
      — il ne sait donc plus rien du match qu'il price — et on refait la même
      sélection, **à effectif égal** (pas à seuil égal : un modèle permuté est
      décorrélé du marché, ses edges sont plus dispersés). Vérifié sur données
      simulées : un modèle sans information sort un CLV brut de +0,0040 pour un
      placebo de +0,0041 → **net −0,0001** ; un modèle parfait sort +0,0539
      contre un placebo de +0,0085 → **net +0,0454**. Le contrôle sépare bien
      les deux.
- [x] **Dissection du ROI à l'ouverture** branchée sur `dissect()`, le même
      outil qu'A2 : stabilité par saison, jackknife, tranches de cote, tranches
      d'edge, concentration par équipe, `wins_to_flip`. Le seuil de 4 % est le
      **meilleur de cinq testés** — le sélectionner après coup gonfle le z, la
      dissection est là pour ça.

- [ ] **Sur ta machine :** relancer `python backtest_walkforward.py --clv`. Le
      tableau porte maintenant trois colonnes de plus — `placebo`, `net` — et un
      verdict explicite. **Ne rien conclure du CLV avant d'avoir lu la colonne
      `net`.**

> **Ce que ce mode ne peut PAS mesurer, et c'est le point qui compte.** L'archive
> SBRO ne donne **qu'un seul prix de puck line par match**, pas une paire
> ouverture/clôture — contrairement au moneyline et aux totaux. **Le CLV de la
> règle A2 n'est donc pas mesurable sur l'historique** : il attend la collecte
> live. Le mode le dit à l'écran plutôt que d'omettre silencieusement le marché.
>
> Ce qui ne le rend pas inutile pour autant : il répond à la question 1 d'A3
> (« si le modèle ne bat pas non plus l'ouverture, le dossier moneyline est clos
> pour de bon ») et il **rode l'outil sur de vraies données avant la saison** —
> découvrir un bogue de mesure en janvier, sur trois mois de collecte
> irremplaçable, serait le pire moment.

> **Piège traité, qu'une version naïve raterait :** la ligne de total bouge dans
> 17,7 % des cas. Quand elle bouge, `market_over_p_open` et
> `market_over_p_close` ne décrivent pas le même pari et leur différence n'est
> pas un CLV. Ces paris comptent dans le ROI, pas dans le CLV, et le nombre
> écarté est imprimé.

> **Le calendrier joue en notre faveur pour une fois.** `isSeasonActive()`
> interroge `/v4/sports`, qui est hors quota, et la NHL est inactive en août :
> activer maintenant ne coûte **aucun crédit**. La pré-saison commence fin
> septembre — c'est la vraie échéance.

### A2 — puck line : règle figée, à évaluer

La règle est pré-enregistrée (miser la jambe qui **donne** les 1.5 buts quand
`p_modèle − p_marché ≥ 0.04`, mise à plat, critère **ROI > 0** et non « ≈ 20 % »).

- [x] **Résolu le 2026-08-21 : 2022-23 n'a pas un problème de puck line, elle
      s'arrête.** Les 342 lignes ne sont pas une couverture partielle du marché,
      c'est **tout ce que `odds.csv` contient pour cette saison** : du
      2022-10-07 au **2022-11-27**, puis plus rien. L'archive SBRO a cessé
      d'être mise à jour en cours de saison — cohérent avec la page d'index qui
      annonce « will not be updated ». Rien à réparer côté parsing.
      **Ce que ça change pour A2**, en revanche : 2022-23 est l'une des deux
      saisons négatives, et elle ne pèse que **sept semaines de début de
      saison** — la période où les features de forme sont les plus faibles
      (fenêtres glissantes à peine remplies) et où le marché est le moins
      efficace. Ce n'est pas une saison, c'est un octobre-novembre. En tenir
      compte avant d'y voir une contradiction du résultat.
- [ ] Évaluer la règle en **CLV** (via A3), pas en ROI
- [ ] **Ne rien miser d'ici là.** « Non réfuté » n'est pas « établi ».

### A1bis — collecte gratuite (livré, reste l'activation)

> Fusionné avec A3 ci-dessus depuis le 2026-08-21 : c'est la même mise en
> service, et il y a désormais **deux** migrations à appliquer (028 et 031).

- [ ] **Local :** `npm run db:migrate:all` (028 + 031), puis `npm test`
- [ ] **Prod :** poser `ODDS_LOG_ENABLED=true` et `ODDS_USER_RESERVE`

> **Le compteur tourne.** Chaque journée de match non collectée est définitivement
> perdue — la cote de clôture d'hier n'existe plus nulle part.

### S4 — servir le moneyline depuis le modèle de score

Conception faite, **code non commencé volontairement**. Ne pas démarrer avant A5.

- [ ] Blend `score ⊕ marché` dans `train_score.py`, poids dans `score_report.json`
- [ ] Décomposition λ pour `feature_importances` (`pred_contribs`, 7 groupes)
- [ ] `confidence` depuis |λ_dom − λ_ext|, calibrée sur la distribution actuelle
- [ ] `base_prob = dist.p_home_win()` pour les marchés non dérivables
      (`last_team_score`, `period{1,2,3}_winner`, `winning_margin`, `double_chance`)
- [ ] Puis suppression du classifieur, **route par route**

> Le piège de S4 : le blend marché est **vivant** (`featureEngineering.ts:238`
> passe les cotes). Supprimer le classifieur supprimerait le blend, et P1 a mesuré
> le marché seul meilleur que les deux modèles nus. C'est pour ça qu'on réajuste
> le blend au lieu de le perdre.

### 🔴 A1 — backfill payant : décidé le 2026-08-21, chemin critique

**Pourquoi maintenant.** Il n'existe plus **aucune** donnée hors échantillon :
SBRO s'arrête au 2022-11-27, la collecte live ne produira rien avant octobre. Or
trois résultats l'attendent — le ROI moneyline à l'ouverture, la règle A2, et le
CLV de la puck line qui est **impossible** sur SBRO (un seul prix par match).

**Tarifs revérifiés à la source** (ceux du plan dataient du 2026-08-04) : le plan
à **30 $ / 20 000 crédits inclut l'historique**, ce qu'on ne savait pas — mais il
ne couvre que ~0,9 saison. Le calcul, refait :

```
appel historique = 10 × marchés × régions → 30 crédits (h2h+spreads+totals, 1 région)
~4 appels/jour de match → 120 crédits/jour → ~22 000 crédits/saison
2023-24 + 2024-25 + 2025-26              → ~67 000 crédits
```

→ **plan 100K à 59 $, un mois, ~33 % de marge, puis résiliation.**
(L'ancien chiffre du plan, « ~33 000 la saison », était faux.)

**🐛 Trouvé avant de dépenser : le fetcher jetait la moitié de ce qu'il paie.**
`fetch_odds_api` visite déjà ~4 snapshots par jour de match et **ne gardait que
le dernier** — exactement le même défaut que le collecteur live. Un backfill
lancé tel quel aurait rendu des clôtures seules, donc **aucun CLV**, donc aucune
confirmation possible du résultat qui motive la dépense. Corrigé : tous les
snapshots partent dans `odds_snapshots_hist.csv`, au schéma de la migration 031,
**sans un crédit de plus**.

- [ ] `--odds-api-dry-run` sur la plage visée — ne dépense rien, chiffre tout
- [ ] **~300 crédits** sur une plage de recouvrement (2021-22, couverte par les
      deux sources) pour comparer marge et niveau de prix. Un ROI qui
      n'apparaîtrait que d'un côté de la jointure serait un artefact de source.
- [ ] Backfill 2023-10-01 → 2026-06-30 avec `--odds-api-budget`
- [ ] `build_dataset.py`, puis `--clv` et `--derived` sur des saisons jamais vues
- [ ] **Résilier** — le cache disque rend toute reprise gratuite

### En attente

- **A6** — team totals, prolongation, écarts ±2.5 : priçables, jamais confrontés
  à des prix réels. À regarder **après** le backfill et A2.

### A4 — fenêtre de confirmation du gardien

Mesure préalable, pas une stratégie : elle dit s'il y a lieu de construire.

- [ ] Extraire la trajectoire des lignes autour de l'heure de confirmation

---

## 3. Scalabilité — déclenchés sur seuil

Source : `AUDIT_SCALABILITE_COUTS.md` §3. **Rien ici n'est requis pour 500
simultanés.**

| # | Quoi | Déclencheur | Effort |
|---|---|---|---|
| **D** 🔴 | **Redis (Upstash)** : adapter Socket.io + `RedisRateLimitStore` (déjà écrit, à brancher) + quota LLM Free | **avant la 2ᵉ instance** | 1 j |
| E | Migrer les data-URI d'avatars déjà en base vers R2 — code et variables en place | ~500 utilisateurs avec avatar | 2 h |
| Q | 2ᵉ instance Railway + sticky sessions | CPU > ~70 % en régime | 4 h |
| 7 bis | **Décider** : scale-to-zero Neon **ou** compute permanent assumé. Aujourd'hui : le coût des deux, le bénéfice d'aucun | hors-saison NHL | 2 h |
| U | RAM du service ML : 2 workers uvicorn à ~300-500 Mo RSS chacun ne tiennent pas dans 512 Mo | avant le premier pic réel | 15 min |
| I | TanStack Query côté client — `fetch` brut partout, aucune déduplication | quand la facture Railway devient visible | 2 j |
| R | `apiLimiter` : clé par `userId` quand authentifié, IP en repli (NAT mobile) | premiers signalements de 429 | 2 h |
| S | `fetchGamesRange` : clé de cache sur semaines calendaires | prolifération de clés dans `/api/dev/metrics` | 2 h |
| T | Cache de prompts LLM identiques | quand l'usage LLM devient significatif | 4 h |
| V | Échantillonner les logs 2xx | à la première facture de logs | 1 h |
| W | Purge Tailwind — le CSS pèse 124 ko (le JS est déjà découpé par route) | — | 2 h |

**Écarté sciemment** — décision produit, pas oubli : Redis tant qu'il n'y a
qu'une instance, et les TTL différenciés Tennis (ligne O).

**Non traité, repéré ligne X :** les **4 `fetch` bruts vers `STATS_BASE`**
(classements, sommaires de saison) contournent `fetchNHL` et restent **sans
timeout**. Ils n'étaient pas exercés par S1. À faire si un tir les met en cause.

**Amélioration optionnelle, repérée RES-2 :** servir le **cache d'odds périmé**
plutôt que `[]` pendant une panne de The Odds API — évite un écran sans cotes.

---

## 4. QA — campagnes à exécuter

Source : `QA_TEST_PLAN.md`, qui garde le détail (résultat attendu, notes, pièges).
Sécurité et résilience sont **validées en statique** ; ce qui reste est dynamique.

**Fonctionnel** — F1 auth complète · F2 gating Pro bout en bout · F3 slip +
settlement · F4 prédictions NHL du jour · F5 Best Bets / value bet scan ·
F6 récupération de mot de passe · F7 tennis

**Intégration** — I1 chaîne ML Front→Node→FastAPI · I2 CORS + cookie cross-site ·
I3 webhook Stripe idempotent · I4 Google OAuth · I5 socket.io · I6 pipeline
données externes → features

**Performance** — P1 charge sur l'endpoint ML (définir le p95 accepté) ·
P2 cache et quotas externes · P4 Lighthouse mobile · P5 pool Postgres
(**vérifier d'abord que `DATABASE_URL` pointe sur `-pooler`**, sinon le test
échoue pour la mauvaise raison) · P3 rate limiting en multi-instance

**Compatibilité** — C1 mobile iOS/Android · C4 pages SEO statiques sur crawlers ·
C2 cross-navigateur desktop · C3 push web

**Vérifications dynamiques de sécurité** (le statique est passé) — test IDOR à
2 comptes · JWT expiré/altéré rejeté et refresh non rejouable après logout ·
en-têtes **CSP réellement servis par Vercel** (l'API n'y peut rien, c'est le front)

**Tests de résilience à provoquer** — couper le ML · couper The Odds API et
retirer `scratches.json` · redeploy Railway sous trafic · webhook Stripe rejoué

**Reprise** — exécuter un **vrai test de restauration** de la base (`BACKUP_DR.md`
existe, il n'a jamais été joué) et **documenter + tester une fois** le rollback
Railway/Vercel.

---

## 5. Décisions — toutes tranchées

**Purge de l'historique Git : abandonnée (2026-08-10).** Le mot de passe présent
dans l'historique est celui d'une base **locale**, sans valeur pour un attaquant.
Point clos, ne pas le rouvrir. Le scanner gitleaks du CI empêche qu'un vrai secret
y entre à l'avenir.

### 🐛 Trouvé pendant le ménage : la synchro des poids de règles n'est pas câblée

Ce n'est pas du code mort, c'est une fonctionnalité **à moitié construite** — et
c'est pour ça que `applyServerFamilyWeights` a été gardée alors qu'elle n'a aucun
appelant.

Le serveur a tout : colonne `user_profiles.rule_weights` (migration **017**), lue
en `ruleWeights` par `profile.service.ts` et écrivable via `PATCH /api/profile`.
Côté client, `RuleFactorEditor` n'écrit que dans `localStorage` et **rien ne lit
jamais la valeur du compte**. Conséquence : les poids ne suivent pas l'utilisateur
d'un appareil à l'autre, alors que la base les stocke.

- [ ] Appeler `applyServerFamilyWeights(profile.ruleWeights)` au chargement du profil
- [ ] Pousser le store vers `PATCH /api/profile` quand `RuleFactorEditor` sauvegarde

### Codes promo — tranché le 2026-08-10 : pas de changement de schéma

Les codes sont **réservés au lancement** et doivent cesser de fonctionner ensuite.
Le mécanisme existant suffit : `promoCatalog()` (`subscription.service.ts`) lit
`PRO_PROMO_CODES` et, si la variable est absente **en production**, le catalogue
est vide — tout code est rejeté en 400, avec un `logger.warn`.

**Retirer les codes = vider `PRO_PROMO_CODES` sur Railway et redéployer.** Rien à
coder, pas de table `promo_redemptions`.

> Ce qu'il faut accepter en attendant : tant que la variable porte un code, il
> reste utilisable par **plusieurs comptes** — il n'y a pas de plafond d'usage.
> C'est sans conséquence pour des codes de lancement distribués sciemment ; ça ne
> le serait plus si les codes devenaient individuels. Le jour où ça change, il
> faudra la table (`max_uses` / `expires_at`), et ce sera un changement de schéma.

- [ ] **Après le lancement :** vider `PRO_PROMO_CODES` sur Railway, redéployer,
      et vérifier qu'un ancien code renvoie bien 400.

---

## 6. Ménage du 2026-08-10 — ce qui a été fait, ce qu'il te reste

### Supprimé du code (0 importeur, prouvé par analyse transitive)

**Le kit `client/src/app/components/ui/` en entier — 49 fichiers.** C'était un
dump shadcn/ui complet dont **rien dans l'application n'importait quoi que ce
soit** : les seuls importeurs des composants `ui/*` étaient d'autres fichiers
`ui/*`. Aucune occurrence de `@/components` dans tout le client.

**7 fichiers de code projet :**

| Fichier | Pourquoi mort |
|---|---|
| `services/affiliateService.ts` | Remplacé par `services/bookmakers.ts` (multi-book Bet365 + Stake, codes affiliés par book) |
| `pages/TennisPredictionsPage.tsx` · `pages/TennisPlayerPage.tsx` | 0 route, 0 importeur. **Attention : le tennis n'est pas mort** — `TennisStatsPage` reste rendu par `StatsPage` via le toggle de sport. Seules les deux pages de *prédiction* tennis étaient orphelines. |
| `data/hockeyProps.ts` | Module vide de 10 lignes. Les props joueur et futures sont générés dynamiquement depuis `/api/nhl/players` et `/api/nhl/standings` |
| `components/RulesWeightsCard.tsx` | 151 lignes, jamais montées |
| `components/brand/IceBackground.tsx` | 132 lignes, jamais montées |
| `components/ui/Balatro.jsx` | 127 lignes + `Balatro.css`, jamais montées |

**Gardé délibérément :** `server/src/middleware/redisRateLimitStore.ts`. Il
apparaît orphelin, mais c'est le stub prévu pour la ligne D — le brancher est
« une ligne par limiteur » précisément parce qu'il existe déjà.

### `package.json` — 42 dépendances sur 50 retirées

Chaque dépendance a été testée individuellement contre le code survivant
(`src/`, `scripts/`, `index.html`, `vite.config`). Après la coupe : **8 restantes,
0 inutilisée**.

**Gardées, chacune avec un consommateur réel :** `@sentry/react`, `html-to-image`,
`lucide-react`, `react-router`, `recharts` (`ChartPage`), `socket.io-client`,
`sonner` (`App.tsx`, `ProfilePage`, `RoomList`, `CreateRoomModal`,
`InjuriesAdminCard`, `RuleFactorEditor`), `tw-animate-css`.

**Retirées :** les 26 `@radix-ui/react-*`, `class-variance-authority`, `clsx`,
`cmdk`, `date-fns`, `embla-carousel-react`, `input-otp`, `motion`, `next-themes`,
`react-day-picker`, `react-hook-form`, `react-popper`, `@popperjs/core`,
`react-resizable-panels`, `react-responsive-masonry`, `tailwind-merge`, `vaul`.

> `motion` méritait une vérification à part vu les animations de l'app : la seule
> occurrence dans le dépôt était un **commentaire** de `routes.tsx`. `clsx` et
> `tailwind-merge` ne servaient qu'au helper `cn` de `ui/utils.ts`, parti avec le
> kit.

**→ `npm install` obligatoire** pour resynchroniser le lockfile (ligne B0 du §1).
Je ne l'ai pas lancé : `node_modules` a été installé sous Windows et le sandbox
n'aurait pas produit un lockfile valide pour ta machine.

Pour réintroduire un composant shadcn plus tard : `npx shadcn@latest add <nom>`.
Rien n'est perdu.

### Exports morts : 15 supprimés, 5 gardés exprès

Le premier scan en annonçait 108 — il n'incluait pas `server/scripts/` parmi les
consommateurs, donc il proposait de supprimer des fonctions dont dépendent les
commandes npm (`notify:slips`, `odds:export`). Corrigé, il en restait 19.

**Supprimés (15) :** `TENNIS_CATEGORY_LABELS`, `TENNIS_CATEGORY_ICONS`,
`getTennisMarketsByCategory`, `lastNGamesOptions`, `probToOdds`, `getLLMUsage`,
`decimalToWinPct`, `fetchAvailableSports`, `sendToUser`, et l'ancien modèle de
poids à six facteurs de `ruleWeightsService` (`WEIGHT_META`, `FACTOR_COLORS`,
`getWeights`, `isCustom`, `applyServerWeights` + leurs dépendances privées).

> Deux suppressions valent mieux qu'un simple gain de lignes : `probToOdds` était
> un **doublon exact** de `probToOddsLabel` (privée, dans `predictionApiService`),
> et `decimalToWinPct` inversait une cote isolée là où `HockeyLanding` dévigue la
> paire. Deux conversions concurrentes finissent toujours par diverger.

**Gardés (5), avec un commentaire disant pourquoi :** `clearBestBetsCache`,
`clearLeaderboardCache`, `stopOddsLogger`, `snapshot` (oddsQuota) — les points
d'entrée dont un test d'intégration a besoin — et `applyServerFamilyWeights`
(cf. le bug ci-dessus).

### Découpage des fichiers > 500 lignes — en cours

Méthode : **extraction de plages de lignes par script**, jamais à la main. Le
corps du code est identique à l'original ; seuls les imports et les `export` sont
ajoutés. Trois contrôles automatiques à chaque fichier : syntaxe, résolution de
chaque import interne, et **comparaison des multiensembles de lignes avant/après**
(c'est celui qui prouve qu'aucune ligne n'a été perdue ni altérée). Un détecteur
d'imports circulaires a été ajouté après le premier faux positif.

| Fichier | Avant | Après | Plus gros morceau | Build |
|---|---|---|---|---|
| `ChartPage.tsx` | 3106 | 11 fichiers (`pages/charts/`) | `GameCharts.tsx` 457 | ✅ vert |
| `PredictionPage.tsx` | 2367 | 10 fichiers (`pages/prediction/`) | `PredictionSheet.tsx` 491 | ✅ vert |
| `HockeyLanding.tsx` | 1468 | 5 fichiers (`pages/landing/`) | `LandingCards.tsx` 471 | ✅ vert |
| `ProfilePage.tsx` | 866 | 3 fichiers (`pages/profile/`) | `SettingsTab.tsx` 509 | ✅ vert |
| `BetBuilderPage.tsx` | 739 | 3 fichiers (`pages/bet/`) | `MySlipsTab.tsx` 288 | ⏳ à builder |

Dans les cinq cas le fichier d'origine ne garde que l'aiguillage et **reste le
seul export public** — `routes.tsx` est inchangé. **8 546 lignes réparties, zéro
ligne perdue** (vérifié fichier par fichier).

> Trois pièges rencontrés, tous attrapés par les contrôles et aucun par la
> relecture : le script a d'abord écrasé son propre fichier source (depuis, il lit
> une copie) ; l'extraction d'identifiants attrapait les noms **cités dans les
> commentaires**, fabriquant des imports circulaires imaginaires (elle passe
> désormais par l'AST) ; et les imports **à effet de bord** (`import "x.css"`)
> n'ayant aucun binding, ils étaient silencieusement supprimés — la page aurait
> perdu ses styles sans qu'aucun test ne bronche. Le script les réinjecte dans la
> coquille et refuse de tourner s'il en trouve un sans coquille désignée.

#### Ce qui dépasse encore 500 lignes — et pourquoi je m'y suis arrêté

| Fichier | Lignes | Pourquoi ce n'est pas un découpage mécanique |
|---|---|---|
| `i18n/index.tsx` | 855 | Dictionnaire de traductions. Le découper par domaine est faisable mais c'est du rangement, pas de la structure. |
| `data/betMarkets.ts` | 628 | Table de données. Même remarque. |
| `pages/NHLPredictionsPage.tsx` | 589 | Jamais analysé — candidat sérieux pour la suite. |
| `pages/TennisStatsPage.tsx` | 578 | Idem, mais le tennis est en périmètre réduit : à faire seulement si on le garde. |
| `components/MLPredictionCard.tsx` | 541 | Idem. |
| `components/MarketSelectorSheet.tsx` | 519 | Idem. |
| `profile/SettingsTab.tsx` | 509 | **453 lignes de code réel.** Un seul composant portant ~20 `useState` partagés par toutes ses sections. Les séparer = faire descendre ces états en props, donc un vrai refactoring — à faire avec le navigateur ouvert, pas à l'aveugle. |

### Documentation corrigée au passage

- `DEPLOYMENT.md` §4 : la **valeur littérale de `VITE_ODDS_API_KEY`** a été
  remplacée par un placeholder, avec la note expliquant pourquoi `VITE_*` est
  public par construction et pourquoi le proxy serveur existe.
  **Si cette clé était réelle et que le dépôt a circulé : la révoquer et la
  régénérer.**
- `DEPLOYMENT.md` §7 : la procédure disait « courriel + bandeau in-app » alors
  que la décision du 2026-08-09 est **courriel uniquement**. Corrigé, et la
  commande `npm run notify:slips` ajoutée.
- Les en-têtes de `content_insights.py` et `content_insights_team_player.py`
  citaient `totals_model.json`, supprimé par S2. Remplacé par `score_model.json`.
- `client/ATTRIBUTIONS.md` : l'attribution shadcn/ui a été retirée — le kit ne
  fait plus partie du produit. La ligne à remettre en cas de réintroduction est
  gardée en commentaire dans le fichier.
- `routes.tsx` : le commentaire M1 citait `motion` et `ogl` comme libs lourdes
  découpées par route. Ni l'une ni l'autre n'est plus une dépendance.

### Côté ML

- **`ml/data/raw/odds/download_dataset.py` et `build_dataset_extra.py` supprimés.**
  Ils produisaient `nhl_data_extensive.csv`, dont les colonnes de paris sont
  factices (chaque match 2004-2018 : `favorite_moneyline -105`, `over_under 5.5`,
  `spread -1.5`), et leur lecteur avait déjà disparu avec S5.
- **`ml/models/score_ensemble/` sorti du dépôt** (`git rm -r --cached`) et ajouté
  à `.gitignore` — 8.9 Mo. **Les 20 membres restent sur ton disque**, et
  `ml_service.py` les chargera si le dossier est là : le chargement était déjà
  entièrement facultatif, et l'image Docker les excluait depuis S1. Régénérables
  par `python train_score.py --ensemble 20`.
- **Deux cases de `REFACTOR_PLAN.md` étaient déjà faites :**
  `ml/models/totals_model.json` et `feature_importance_totals.json` n'existent
  plus sur le disque. La case S2 « sur ta machine » peut être cochée.

---

## 7. Audit de production : soldé

`PRODUCTION_READINESS_AUDIT.md` (2026-07-20) est conservé comme trace, mais
**toutes ses recommandations sont traitées**. Vérifié dans le code aujourd'hui pour
les quatre qui restaient ambiguës :

- **H8** (hacher les refresh tokens) → fait, `auth.service.ts` les stocke hachés
- **M2** (registre de migrations) → fait, `migrate-all.ts` tient `schema_migrations`,
  une transaction par fichier
- **M4** (transactions multi-écritures) → fait, `auth.service.ts` ouvre
  `BEGIN`/`COMMIT` et les helpers acceptent le client de l'appelant
- **M7** (index composite chat) → fait, migration `019_chat_pagination_index.sql`
  crée `(room_id, sent_at DESC)`
- **M1** (code splitting) → fait, le JS est découpé par route ; reste le CSS
  Tailwind (ligne W ci-dessus)

Seul survivant, et il est déjà dans ce document : **M6 / la CSP réellement servie
par Vercel** (§4), et la question de la purge d'historique Git (§5.4).
