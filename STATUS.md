# ArakIce / ICEEDGE — Project status

**Single source of truth for what remains. Updated 2026-10-07: the ML plan, QA plan, live-predictions plan and scalability audit are merged here (§3.5–3.7, §8).**

Finished work is not kept here: it lives in the Git history. The last version that listed
everything done (§1 « DONE », §4 « No longer relevant ») is `git show 0916b52:STATUS.md`.

| Mark | Meaning |
|---|---|
| ✔ | Verified today in the code or the Git history |
| 📄 | Stated as done in the docs, but it lives in a console, in production or in a mailbox — could not be checked from the repo |

> **Rule of this file.** New work goes into §3. When something is finished, **delete its line**
> (the commit that finishes it is the record). Do not open a to-do list anywhere else (`PROJECT_CONTEXT.md`, audits, plans) —
> the ML, QA, live and scalability plans were folded in here on 2026-10-07 for that reason:
> two lists always drift apart. That is how `RESTE_A_FAIRE.md` got lost on 2026-09-16
> (deleted inside an unrelated commit, `4d1cbcd`).

---

## 0. Where things stand

- **The web app is live** on arakice.com: Vercel (front), Railway (Node + Python ML), Neon
  (Postgres), Cloudflare R2 (avatars), Cloudflare DNS/proxy. 📄
- **All the pre-iOS web work is shipped**; nothing blocks the launch or the iOS start
  (C1 on a real iPhone passed 2026-10-05).
- **The web is frozen at tag `pre-ios-freeze` (2026-10-07) and iOS has started (Phase 0).** Every web
  change from here is a *shared* change, tested on web and in the iOS shell (§3.4).
- **The NHL 2026-27 regular season started on 2026-09-29** (84 games per team).

---

## 2. PARTIALLY DONE

| Item | What is done | What is missing |
|---|---|---|
| **Redis / multi-instance** | ✔ Socket.io adapter shipped and **active** (Redis service on Railway, `REDIS_URL` set — checked 2026-09-26) | ✔ `RedisRateLimitStore` written 2026-10-07; it switches on by itself when `REDIS_URL` is set (no variable to add) — only left: commit and deploy it. Needed only before a 2nd instance. |
| **Cloudflare in front of the API** | 📄 Proxy and cache headers in place | Check that it actually caches what the headers allow. |
| **Budget alerts** | ✔ All set (confirmed 2026-10-07) | Thresholds in `MONITORING.md`. |
| **Load testing** | ✔ In-process benches, all green | Real visitor latency against a pre-prod (`loadtest/s1-landing.js`) never run — there is no pre-prod. |
| **QA** | ✔ I1, I2 (7/7), static campaigns; ✔ dynamic campaign on a local stack (2026-09-26, 90/90) | What needs the real world: devices (C2–C3), Google (I4), Neon restore drill (§3.7). |
| **Client tests** | ✔ `typecheck` in CI | No test runner in `client/`. The socket block filter (`visibleMessages` in `RoomChat`) has no guard. |
| **SEO match pages** | ✔ Generated and deployed daily | Link `/match` from the app (✔ nothing links to it), submit `sitemap-games.xml` in Search Console, translate `/matchup/`, `/props/` and hubs to French. |
| **Content engine** | ✔ Pipeline + daily recap copying to Google Drive | ✔ Recap files committed. Install the scheduled task (§3.11). |

---

## 3. STILL TO DO

### 3.2 At the start of the NHL 2026-27 season (started 2026-09-29)

- [ ] **SEO follow-up**: re-read indexing in Search Console around 2026-10-16 (click "Validate fix"
      on "Redirect error" if still listed); revise `client/scripts/props-allowlist.json` from that
      export (mirror every change in the exclusion regex of `client/vercel.json`).

### 3.3 At the first sale

- [ ] Vercel Pro (Hobby forbids commercial use).
- [ ] Sentry: move off the Developer plan if the monthly error quota gets close (Stats → Usage).
- [ ] Raise Railway's hard limit (25 $) and the GitHub Models budget (0 $ blocks Pro LLM calls).
- [ ] Verify Cloudflare caching in front of `api.arakice.com`.
- [ ] After launch: empty `PRO_PROMO_CODES`, redeploy, check an old code returns 400.

### 3.4 iOS app — `APPLE_PLAN.md` (started 2026-10-07)

- [x] Freeze tagged `pre-ios-freeze` on 2026-10-07 (gate G1–G4 closed). §3.12 deferred past the
      freeze: it ships as a shared change.

✔ No Capacitor dependency, no `client/ios/`.

- [x] Phase 0 — ✔ Developer Program (Individual), app record, bundle ID `com.arakice.arakice`,
      API key, Small Business Program (2026-10-09).
- [ ] Phase 1 — ✔ answers prepared in `docs/ios/APP_STORE_COMPLIANCE.md` + manifest draft (2026-10-09).
      Left: enter age rating (18+), App Privacy labels and export compliance in App Store Connect.
      Decide R18 (NHL logos/photos on iOS, 5.2.1) before Phase 8.
- [ ] Phase 2 — ✔ 2026-10-09: `npm run build:ios` (no bookmaker in the bundle, guarded), iOS FAQ
      copy, responsible-gambling note (web + iOS), SEO links hidden on iOS, R9 done.
      R10 decided 2026-10-09: bookmaker buttons OFF on the web too (`VITE_BOOKMAKER_LINKS`, default
      off; set `true` in Vercel to bring them back once there is an affiliate deal). Left: store
      metadata with Phase 8; consider renaming the `best-nhl-betting-software` SEO page.
- [ ] Phase 3 — ✔ code done 2026-10-09: Capacitor 8 (SPM), `client/ios/`, Keychain `tokenStore`,
      `X-Client: native` on /auth, CORS `capacitor://localhost`, external links in Safari sheet,
      CSP meta, `h-dvh`, icon/splash. Left: first build on cloud macOS CI (Phase 7), then the
      real-iPhone checks below. After `git pull` on Windows: `cd client && npm install`.
- [ ] On a real notched iPhone: every page (safe areas now active), the chat input row, tap
      targets, lock the screen 5 min and come back, airplane mode, very slow network.
- [ ] Phase 4 — native features (APNs push first, share sheet, offline, haptics, universal links).
- [ ] Phase 5 — IAP (deferred: v1 ships without Pro on iOS). Decide before submitting whether
      locked Pro sections without a call-to-action are acceptable.
- [ ] Phase 6 — in-app account deletion: ✔ built on the web (`1244bac`); check it in the iOS shell.
- [ ] Phase 7 (moved before 4) — ✔ workflow `ios-release.yml`, Apple Distribution certificate +
      `ArakIce App Store` profile (both expire **2027-10-09**), GitHub secrets + variables
      (2026-10-09). **First run in progress** → then install via TestFlight on the iPhone.
      Delete the four `.txt` files in `ios-signing/` once the secrets work.
- [ ] Phases 8–9 — store assets, TestFlight external round, submission.

### 3.5 ML — prediction model

Order, dates and commands first; the detail of each item follows. Measured conclusions not to
re-test and the ML code map are in §8.

- [ ] **Weekly data refresh**: ✔ task installed (2026-10-05). After each run, commit + push
      `ml/models/inference_state.json`, `elo_ratings.json` and `level_layer.json`.
- [ ] Re-train monthly during the season, then re-run
      `backtest_walkforward.py --correction --write-layer` (the correction layer sits on the score
      model's output; a new model needs a new layer).
- [ ] The six `base_prob` markets are ~7 pts too low on clear favourites — do not bet on them.

#### Order

```
maintenant → févr. 27   A1 — 2023-24 (nov., déc.) puis fin 2022-23 (janv., févr.).
                        Ensuite --clv / --derived sur 4 saisons modernes, avec
                        le modèle corrigé, cotes live réexportées juste avant.

ensuite                 A2 et A3 (CLV puck line) dès que les données existent,
                        puis A6.

après la saison 2026-27 S4 — γ, puis ⑤ (classifieur en repli, puis supprimé).
                        A4 (fenêtre gardien) avec une saison de snapshots.
```


#### A1. Backfill payant The Odds API — 2 saisons restantes

Faits : 2025-26 et 2024-25 (DraftKings, `h2h,spreads`). Plan 20K, la clé est
partagée avec l'app : **≤ 10 000 crédits de backfill par mois, réserve de
compte 6 000** (`--odds-api-budget` / `--odds-api-keep`). Un run arrêté par un
plafond se relance tel quel le mois suivant : le cache rend gratuits les appels
déjà payés.

Une commande par mois, le 1er, depuis `ml/python` avec `ODDS_API_KEY` posée :

```bash
# [ ] 1er novembre 2026 — 2023-24, partie A (~670 matchs, ~9 300 crédits)
python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings \
    --odds-api-from 2023-10-10 --odds-api-to 2024-01-14 \
    --odds-api-budget 10000 --odds-api-keep 6000
# [ ] 1er décembre 2026 — 2023-24, partie B (~640 matchs, ~9 000)
python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings \
    --odds-api-from 2024-01-15 --odds-api-to 2024-04-18 \
    --odds-api-budget 10000 --odds-api-keep 6000
# [ ] 1er janvier 2027 — 2022-23, partie A (~500 matchs, ~7 200)
python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings \
    --odds-api-from 2022-11-28 --odds-api-to 2023-02-12 \
    --odds-api-budget 10000 --odds-api-keep 6000
# [ ] 1er février 2027 — 2022-23, partie B (~470 matchs, ~6 300)
python fetch_data_v4.py --only odds --from-local --odds-api-book draftkings \
    --odds-api-from 2023-02-13 --odds-api-to 2023-04-14 \
    --odds-api-budget 10000 --odds-api-keep 6000
```

Après chaque run : vérifier la ligne de crédits restants dans le journal, puis
`python build_dataset.py`. ⚠️ 2022-23 aura deux sources (SBRO jusqu'au 27 nov.,
DraftKings ensuite) : les séparer par la colonne `source` d'`odds.csv`.

#### A2. Puck line — évaluer la règle figée, sans miser

Rappel du constat (détail en §8.1) : tout le ROI vient de la jambe
−1.5, choisie après coup, ~51 paris par saison — un ROI ne tranchera jamais,
seul le CLV le peut.

> **Règle A2 (figée le 2026-08-08, avant toute donnée 2026-27).** Miser la jambe
> qui donne les 1.5 buts, quand `p_modèle − p_marché ≥ 0.04`. Mise à plat.
> Aucun autre filtre, aucun autre seuil. Succès = **ROI > 0** (et CLV > marge),
> pas « ROI ≈ 20 % ».

- [ ] Rejouer la règle sur 4 saisons modernes quand A1 est fini (`--derived`).
- [ ] L'évaluer en **CLV** (A3), pas en ROI.
- [ ] Ne rien miser d'ici là. « Non réfuté » n'est pas « établi ».

#### A3. CLV — le chemin critique

- [ ] **CLV de la puck line**, sur les relevés DraftKings du backfill (A1) et la
      collecte live 2026-27. SBRO ne donne qu'un prix de puck line par match :
      pas de CLV possible sur l'historique.
- [ ] Relancer `--clv` avec le modèle **corrigé** (correction + niveau) : le
      +4.30 % à l'ouverture a été mesuré avec le modèle d'août.
- [ ] Surveiller la collecte live : export du 2026-10-07, 42 matchs, puck line
      sur 27 (trous du 30 sept. au 3 oct., complet depuis le 4). Réexporter
      avant chaque run : `npm run odds:export` et `npm run odds:export-snapshots`
      (dans `server`), puis `python fetch_data_v4.py --only odds --from-local`.

**Pièges déjà rencontrés, à garder en tête :**

- **Toujours lire le CLV net du placebo.** On sélectionne sur
  `p_modèle − p_ouverture` et on mesure `p_clôture − p_ouverture` : les deux
  partagent le bruit de l'ouverture, donc un modèle sans information produit un
  CLV positif (régression vers la moyenne). C'est le placebo qui a démasqué les
  totaux.
- **La barre est « CLV > marge », pas « CLV > 0 »** : le CLV se mesure sur des
  probabilités dévigées, le ROI paie la marge (~4.4 %).
- **Une ligne qui bouge change de pari** (total : 17.7 % des matchs). Ces paris
  comptent dans le ROI, pas dans le CLV, et le nombre écarté est imprimé.

#### A4. La fenêtre de confirmation du gardien

P3 a établi que le talent du gardien est réel (0.165 but/match entre quartiles,
à xG subi plat) mais que sa **forme est imprévisible** (r = +0.038). On a donc
cherché au mauvais endroit : l'information exploitable n'est pas de prédire la
performance du partant, c'est de **savoir qui part avant que le marché ait fini
d'ajuster**.

Les partants sont confirmés 1 à 2 h avant la mise au jeu. Avec des snapshots à
5 minutes, on peut enfin mesurer : de combien la ligne bouge à la confirmation,
et en combien de temps. Si l'ajustement prend 20 minutes, la fenêtre existe ;
s'il est instantané, il n'y a rien et on le saura.

C'est une mesure préalable, pas une stratégie — elle dit s'il y a lieu de
construire quoi que ce soit.

- [ ] Extraire la trajectoire des lignes autour de l'heure de confirmation

#### A6. Marchés que le modèle price déjà et qu'on ne vérifie pas

`score_model.py` produit team totals, prolongation, écarts alternatifs (±2.5) —
priçables mais jamais confrontés à des prix réels, faute de données. The Odds
API en couvre une partie. À regarder **après** A1 et A2, pas avant : ouvrir un
nouveau front avant d'avoir tranché la puck line multiplierait les tests sans
multiplier les données.

#### S4 ⑤ et γ — après la saison 2026-27

##### S4 ⑤. Supprimer le classifieur — REPORTÉ APRÈS LA SAISON 2026-27

**Ce qui est servi aujourd'hui** (`ml_service.py`, ~l. 2520) :
modèle de score → `_apply_correction` → `_align_distribution` → `_apply_level`.
Le classifieur `game_model.json` ne sert plus qu'à deux choses : **repli** quand
`_build_score_distribution` rend `None`, et **comparaison**
(`probability_classifier`, calculé sans cotes).

**Pourquoi attendre.**

1. **Il n'y a pas de résultat, il y a une parité.** 0.6642 contre 0.6653 sur
   4 304 matchs — dans le bruit. « Équivalents » justifie ⑤ comme
   simplification, pas comme gain.
2. **⑤ supprimerait le seul moyen de trancher.** Quand 2026-27 entrera dans
   `nhl_games_v4.csv`, relancer `build_dataset.py` puis les deux entraînements
   donne une comparaison sur des matchs qu'aucun des deux n'a vus. Ça ne marche
   que si les deux modèles existent encore.
3. **Le gain est de la maintenance** (838 Ko, ~250 lignes), pas de la précision.

**Forme retenue (« option 1 »)** : classifieur rétrogradé en repli pur pour une
release, puis supprimé au déploiement suivant si rien n'a bougé.

**Ce que ⑤ devra faire, dans l'ordre :**

- [ ] Retirer `_blend_w` et le chemin de mélange classifieur ⊕ marché dans
      `ml_service.py` (~l. 2441) — mort par la décision « pas de cotes en
      entrée », même en repli.
- [ ] `double_chance` : remplacer l'heuristique `ot_rate` sur `win_diff` par
      `dist.p_regulation_tie()` et `_score_p_ot`, que la distribution donne
      exactement. (`winning_margin` est déjà tiré de la distribution.)
- [ ] **Ne pas supprimer `train.py` en bloc** : `backtest_walkforward.py` et
      `backtest.py` font `import train as T` (`split`, `log_loss_np`,
      `fit_logistic`, `apply_logistic`, `_logit`, `select_features`). Déplacer
      ces utilitaires d'abord, puis retirer la moitié « game ».
- [ ] Vérifier route par route que l'app ne lit plus `probability_classifier`
      ni `model_type` « XGBoost » avant de les retirer.

> **⚠️ Option écartée, à ne pas re-proposer :** « durcir
> `_build_score_distribution` pour qu'il ne rende jamais `None` ». Ça revient à
> retirer le garde-fou `0,5 ≤ λ ≤ 8,0`, qui attrape un vecteur de features mal
> rempli : mieux vaut une heuristique médiocre qu'un prix absurde servi avec
> assurance.

> **⚠️ `backtest_walkforward.py` (chemin d'ablation de l'élagage) n'est PAS corrigé,
> délibérément.** Un `ScoreDistribution` y est construit sans `p_ot`. L'élagage est
> clos : corriger rendrait ses chiffres non comparables, et la mémoïsation
> `_ablation_cache_key` (suffixe `|v2`) mélangerait anciens et nouveaux
> résultats. Si l'élagage rouvre : corriger la ligne ET passer la clé en `|v3`.

##### ⏸️ γ — étirer l'écart de λ : reporté après la saison 2026-27

Le correctif de fond, s'il faut y venir : `S = λ_dom + λ_ext` **conservé**,
`δ = log λ_dom − log λ_ext` remplacé par `γ·δ`, un seul paramètre ajusté sur la
validation. Les totaux restent intacts par construction et tous les marchés
dérivés héritent de la correction de façon cohérente.

**Pourquoi on n'y va pas maintenant.** Après la correction de prolongation, la
pente vaut 1,105 ± 0,075 : elle **n'est plus** significativement > 1, alors que
le bin de queue échoue encore. Les deux tests se contredisent, et la raison est
l'effectif — 228 matchs au-dessus de 0,75. Ajuster γ là-dessus, c'est ajuster un
paramètre sur du bruit, exactement ce qu'on a conclu pour l'élagage. Le mode
`--reliability` mesure déjà tout ce qu'il faudra pour trancher quand la saison
2026-27 sera dans le dataset ; et il faudra alors vérifier que γ ne dégrade pas
la puck line, aujourd'hui saine.

#### Live predictions (in-game)

Règle tenue depuis le début : **rien n'est activé sans gain mesuré au rejeu**, et aucune
constante qui n'a pas été mesurée sur de vrais matchs.

##### 1. Avantage numérique en cours — pas fait

Les fichiers de tirs MoneyPuck ne donnent pas le temps passé en avantage (il n'y a que les
tirs), donc le multiplicateur ne peut pas en être mesuré. Il faut :

1. Les pénalités du play-by-play NHL (`v1/gamecenter/{id}/play-by-play`, ~1 300 matchs par
   saison) pour reconstruire les intervalles 5 c. 4, 5 c. 3, 4 c. 4.
2. La même vraisemblance d'exposition que `calibrate_live.py` (cadence = λ × w(t) × m(…)),
   avec un facteur par situation.
3. Un rejeu (`server/scripts/replay-live.ts`) : n'activer que si la log-loss baisse.

Déjà en place côté Node : `situationCode` est vérifié (`1451` = domicile à 5 contre 4) et la
feuille de match porte `situation.secondsRemaining`.

##### 2. Pas encore passés par le moteur à effets de score

Cartes P1/P2 (Skellam) et « les deux marquent » (binomiale négative) restent sur le calcul de
la phase 1. Les effets pèsent surtout en fin de 3e, où ces cartes sont déjà décidées : faible
priorité.

##### 3. À re-vérifier après la saison 2026-27

Le rejeu montrait 2 cases pires sur 50 : totaux > 5,5 et > 6,5 **à la mise au jeu**, à cause du
niveau d'avant-match trop haut. Le recalage de niveau (`measure_level.py`, 2026-10-04) devrait
les corriger : relancer `live_pregame.py && measure_level.py`, puis le rejeu.

##### Refaire les mesures

1. Réseau : `curl -sI https://moneypuck.com/` et `curl -sI https://api-web.nhle.com/v1/schedule/now`.
   ⚠️ Avast intercepte le HTTPS sur le poste : exporter sa racine en PEM et poser
   `REQUESTS_CA_BUNDLE` (Python) / `NODE_EXTRA_CA_CERTS` (Node), ou exclure ces domaines.
2. `fetch_live_goals.py` → `live_pregame.py` → `calibrate_live.py`, puis
   `cd server && npx ts-node --transpile-only scripts/replay-live.ts` (~15 min pour 3 saisons).
   Garder les saisons de test au-delà de `--last-train` (le rejeu refuse sinon).

### 3.6 Scalability and costs — only on trigger

Target: 500 → 5 000 concurrent users without a rebuild. Vercel Pro and Cloudflare in front of
Railway are launch items (§3.3). Full history: `git show 8ec98f0:AUDIT_SCALABILITE_COUTS.md`.

#### State

**Plus de code à écrire pour aller de 500 à 5 000 simultanés.** Les alertes de budget sont posées.
La campagne de charge (14 bancs, scénarios S1-S7, 27 ✓ / 1 ✗ puis B12 vert avec Redis) a tourné
sur le poste de développement, amont et Postgres simulés : elle prouve la mécanique (caches,
déduplication, bornes), **pas la capacité réelle de Railway et Neon**.

| Domaine | 500 | 5 000 | Reste |
|---|---|---|---|
| Vercel | 🟢 | 🟢 | Plan Pro (ligne 9) |
| Service ML | 🟢 | 🟠 | RAM (ligne U) |
| Neon | 🟢 | 🟠 | Scale-to-zero ou permanent (ligne 7 bis) |
| Railway / Node | 🟢 | 🟠 | 2ᵉ instance (lignes D, Q) |
| CDN | 🟢 | 🟢 | Cloudflare (ligne 11) |
| Tout le reste | 🟢 | 🟢 | — |

#### On trigger

| # | Action | Déclencheur | Effort | Coût |
|---|---|---|---|---|
| ☐ U | Vérifier la RAM du service ML dans Railway : 2 workers uvicorn (~300-500 Mo chacun) ne tiennent pas dans 512 Mo | **avant le premier pic réel** | 15 min | variable |
| ☐ D | Redis provisionné et `REDIS_URL` posé (§2). Reste : commiter et déployer le compteur de rate-limit Redis (code du 2026-10-07). Il s'active seul avec `REDIS_URL` ; `RATE_LIMIT_STORE` n'est qu'un affichage de la bannière, aucune variable à définir | avant la 2ᵉ instance | 5 min | 0 € |
| ☐ Q | 2ᵉ instance Railway — sans sticky sessions, client en `transports: ['websocket']` ; prérequis : D | CPU > ~70 % en régime | 4 h | +5-20 €/mois |
| ☐ E | Migrer les avatars data-URI historiques vers R2 (le code est en place) | ~500 utilisateurs avec avatar | 2 h | 0 € |
| ☐ I | TanStack Query côté client — aucune déduplication, l'accueil relance ~7 appels | facture Railway visible | 2 j | 0 € |
| ☐ 7 bis | Décider : scale-to-zero Neon (readiness sans DB, probes espacées) ou compute permanent assumé | hors-saison NHL | 2 h | −10 à −50 €/mois |
| ☐ S | `fetchGamesRange` : clé de cache sur semaines calendaires | prolifération de clés dans `/api/dev/metrics` | 2 h | 0 € |
| ☐ T | Cache des prompts LLM identiques (TTL 1 h) — baisse le coût réel, pas la garantie du plafond | usage LLM significatif | 4 h | 0 € |
| ☐ V | Échantillonner les logs 2xx | première facture de logs | 1 h | 0 € |
| ☐ W | Purge Tailwind (CSS à 124 ko) | — | 2 h | 0 € |

Settled: `writeLimiter` is keyed per account since 2026-08-24 (`userOrIpKey`) and no longer
counts reads since 2026-09-26.

#### Not verified

1. **Configuration Railway réelle** (RAM/vCPU, replicas) — décide la ligne U.
2. **Neon sous charge réelle**, et autosuspend activé ou non — décide la ligne 7 bis.
3. **Métriques de production** de la saison en cours : un export Railway/Sentry de 7 jours remplacerait les estimations par des mesures. Prochaine étape utile.
4. **Usage réel du LLM** (OpenAI) par utilisateur — sans effet sur la facture grâce au plafond, décide la ligne T.

### 3.7 QA still to run

Done: static campaigns, I1, I2 (7/7), dynamic QA on a local stack (2026-09-26), F1/F2/F6, C1,
I4, I6, C4. P1/P2/P5 closed without firing at production (decision 2026-10-06). Detail of those
campaigns: `git show 9b9a907:QA_TEST_PLAN.md`.

Règles inchangées : **pas de staging**. On teste en production avec des comptes jetables, le Pro
s'obtient par code promo et jamais par un vrai paiement. L'authentification se teste sur
arakice.com, pas sur un aperçu `*.vercel.app`.

#### 1. P4 — Performance mobile (Lighthouse) · Haute · ✔ CLS réglé (2026-10-07)

PSI mobile sur arakice.com le 2026-10-06 à 09:21, après déploiement : **59**
(FCP 3,4 s · LCP 3,8 s · TBT 0 ms · **CLS 0,481** · SI 4,3 s). Avant : 58, LCP 4,2 s, SI 5,3 s.
Attendu : LCP < 2,5 s, CLS < 0,1.

- **CLS : cause trouvée et corrigée (non déployé)**. Chaque carte de match mesurait 92 px pendant le
  chargement, puis 99 px quand les pastilles de cote (`FairOddsPill`, 22 px) apparaissaient avec
  `/api/predict/game/…/bundle` ; chaque carte poussait les suivantes de 7 px de plus. `FairOddsPill`
  accepte maintenant `reserve`, qui garde la place pendant le chargement (utilisé par `LandingCards`).
  Vérifié en prod en simulant le correctif : 99 px avant et après.
- **Forced reflow de 749 ms (701 nœuds) : corrigé (non déployé)**. Le défilement automatique de
  `TeamCarousel` lisait `scrollLeft`, `scrollWidth` et `clientWidth` à chaque image ; après chaque
  mise à jour du DOM par React (arrivée d'un `bundle`), cette lecture forçait une mise en page du
  document entier. Les tailles sont maintenant mises en cache (`ResizeObserver`), la boucle ne lit plus
  rien, le recalage passe par `onScroll`, et le défilement attend 4 s après le chargement.
- **Déployé le 2026-10-07** — PSI mobile ensuite : 3,5 s FCP · 4,3 s LCP · 0 ms TBT · **CLS 0,222** ·
  5,3 s SI. CLS divisé par deux, mais reste > 0,1 : le swap Oswald grandissait chaque ligne de 6 px.
- **Polices auto-hébergées (`60bbb89`, 2026-10-07)** : `public/fonts` (Oswald/Inter variables,
  Merriweather 700, latin + latin-ext), `preload`, faces « Fallback » calées sur les métriques
  (écart mesuré ≤ 1 % en largeur, 0 px en hauteur), cache 1 an sur `/fonts/`. Les pages SEO
  statiques gardent Google Fonts.
- **PSI mobile après les polices (2026-10-07)** : 2,7 s FCP · 3,5 s LCP · 0 ms TBT · **CLS 0,043** ✔.
- Reste (optionnel) : LCP 3,5 s > 2,5 s — le paragraphe « Best Parlay » est rendu en JS.
- LCP = paragraphe « Best Parlay », 1,7 s de délai de rendu (contenu rendu en JS).

#### 2. Vérifications après le lot du 2026-09-26 · Haute

- [ ] Provoquer une 500 et vérifier que l'événement Sentry affiche `authorization: [Filtered]` et
      `cookie: [Filtered]`.

#### 3. Appareils réels · Moyenne

| # | Test | Attendu | Fait |
|---|---|---|---|
| C2 | Firefox, Safari, Edge (desktop) + Android Chrome | Rendu et interactions Radix/Recharts identiques, aucune erreur console bloquante, graphiques Charts corrects, partage d'image (`html-to-image`) fonctionnel | Chromium desktop ✔ (2026-10-06, 9 routes) ; iPhone Safari ✔ (C1) |
| C3 | Notifications push (PWA) | Abonnement, réception et clic fonctionnent là où c'est supporté ; dégradation propre ailleurs (restrictions iOS) ; ajout à l'écran d'accueil et permission refusée testés | — |

#### 4. SEO — restes de C4 · Moyenne

- [ ] **Commiter les 53 pages `/matchup/*` hors sitemap corrigées le 2026-10-06** (phrase « only
      road win » fausse). Les 137 pages du sitemap sont déjà justes en prod. `seo:gen` ne repasse pas
      sur les paires sorties de l'horizon de 3 semaines.
- [ ] Titres trop longs, tronqués par Google au-delà d'environ 60 caractères : `/matchup/*`
      (70–85 c, `seo-gen.mjs`) et pages `/fr/match/*` (jusqu'à 96 c, `gameday-gen.mjs`).
- [ ] Descriptions de 176 à 191 caractères sur `/nhl-predictions-today`, `/best-nhl-picks-today`,
      `/nhl-ai-predictions` et `/best-nhl-betting-software` (à garder sous 160).
- [ ] Le script Cloudflare `static.cloudflareinsights.com/beacon.min.js` est bloqué par la CSP sur
      chaque page (une erreur console partout, Best Practices 92). Couper Web Analytics dans
      Cloudflare, ou ajouter le domaine à `script-src` et `connect-src`.

#### 5. Après une vraie fréquentation du chat

`npm run moderation:dry-run` (serveur) : relire ce que le filtre aurait refusé.

### 3.8 Technical deadlines

- [ ] `@sentry/node` 11 — later, not before its first patch releases. Its `dataCollection`
      default sends request bodies, cookies and SQL: set it explicitly when upgrading.

### 3.9 Cloudflare / accounts — all manual, in your own sessions

- [ ] R6 (optional) · *Full (strict)* for `arakice.com` and `www` only. First check that Vercel's
      certificate is valid behind the proxy: Vercel → Project → Settings → Domains shows both with
      a valid certificate, and `curl -vI https://arakice.com` shows a Let's Encrypt/Vercel cert
      issued < 90 days ago. Then Cloudflare → Rules → Configuration Rules → hostname
      `arakice.com` or `www.arakice.com` → SSL *Strict*. Leave the zone default on *Full*.
      **Never** for `api` (Railway).
- [ ] R8 (optional, not before launch) · `cdn.arakice.com` for R2 — together with an `UPDATE` of
      `avatar_url`, or not at all.

### 3.10 Low-priority code polish (post-freeze)

- Kept on purpose: two routers on `/api/users` (merge moves public URLs — after the iOS freeze,
  see `app.ts`) · server starting without a DB (readiness 503 keeps Railway from routing to it —
  correct) · `backdrop-filter` on the nav (measure on a device first) · friendship/following
  feature (own plan).

### 3.11 Content engine — `content/HANDOFF.md` §8

- [ ] Install the daily-recap scheduled task (`install-daily-recap.ps1`) — the files are committed.
- [ ] Re-read TikTok/Instagram rules on betting-related content before the first post.
- [ ] Check `#utahmammoth` against the franchise's official account.
- [ ] Add `faceoffs_taken` to `build-content-insights.ts`.

### 3.12 Real bet365 odds + Best Bets ranking (added 2026-09-25)

> **Deferred past the iOS freeze (2026-10-07).** Changes the Best Bets screen and `odds.routes.ts`:
> ship it as a shared change, tested on web and in the iOS shell.

Context: **The Odds API has no bet365 for the NHL.** Its only bet365 key is `bet365_au`
(Australia, AFL/NRL only). So `oddsClient.ts` never finds `bet365` and `pickBookmaker` falls back
to *the first book in the list* — the odds behind EV and value-bet alerts come from an arbitrary
book that can change per game. The client proxy (`odds.routes.ts`) returns zero odds while
`ODDS_BOOKMAKERS` / `ODDS_REGIONS` are unset.

Cheapest providers with bet365 (approx., converted at ~1 £ ≈ 1.35 US$, ~1 US$ ≈ 1.37 CA$ — check at checkout):

| Provider | Plan | ≈ US$/mo | ≈ CA$/mo | bet365 NHL + props |
|---|---|---|---|---|
| odds-api.io | Solo (2 books) | 65 | ~89 | **yes — confirmed 2026-09-25** |
| SharpAPI | Hobby (5 books) | 79 | ~108 | NHL yes, props not stated |
| SportsGameOdds | Pro | 299 | ~410 | yes (7-day trial) |

- [ ] **Test with the free key first** (odds-api.io/dashboard, no card; 2 books, 100 req/h,
      pre-match only — live needs a paid plan): pick bet365 + a second book, pull one NHL event,
      check the moneyline / puck line / totals / player-prop keys and compare a few prices with
      bet365.ca by hand (the "global" feed may differ from Canadian prices).
- [ ] Choose the 2nd book. The sheet also lists **`bet365 NJ`** (US feed) with the exact NHL
      markets we use (Anytime Goalscorer, Points O/U, Shots on Goal O/U, Power Play Points O/U) —
      useful if the "global" `Bet365` prop keys turn out messy. No Pinnacle in their catalogue;
      the sharp option for NHL is **Circa** (ML / spread / totals, pre-match only).
- [ ] Subscribe to Solo, then replace The Odds API in `server/src/services/oddsClient.ts` and
      `server/src/routes/odds.routes.ts` (keep the cache / quota / stale-fallback behaviour).
- [ ] Make `pickBookmaker` deterministic (one configured book, never "first in list") and
      expose which book priced each bet.
- [ ] **Best Bets ranking**: once real odds exist on every market, rank by expected value
      (`probability × real odds`) and show the real bet365 odds instead of the fair odds
      (`100 / pct`). Update the explanation line (`home.bbExplainMl` / `home.bbExplainRules`).
      Until then the list stays ranked by probability.

---

### 3.13 Bet builder IA (natural-language slip) — leftovers
- [ ] Check migration 039 is on Neon (`npm run db:migrate:all` is idempotent — run it if unsure).
- [ ] On production, try the 6 real phrases with the real model: a team, a total, a player, a
      goalie, a double phrase, and one only the LLM understands (e.g. « Suzuki 3+ tirs »).

## 5. Could not verify from here

Everything that lives outside the repo: what is set in Railway / Vercel / Neon / Cloudflare /
Sentry / Stripe consoles; which migrations are applied to Neon; whether the latest commits are
deployed (this clone has no remote-tracking branches); whether CI is green right now (the
local `node_modules` are Windows-only, so tests and builds were not run for this review);
how the rebuilt prediction pages look with real data (built and type-checked, but not
opened in a browser — there is no pre-prod and this session cannot reach the API); Search Console state; results of the 2026-09-22
odds-logger check.

---

## 6. Rules not to undo

Carried over from `RESTE_A_FAIRE.md`, `PRE_IOS_PLAN.md` (deleted — `git show 0916b52:PRE_IOS_PLAN.md`) and the pre-freeze audit.

**Production and consoles**
- A value typed in Railway is not a value in service until "Deploy" — trust only the
  `[Server] Réglages effectifs` banner of the **running** container.
- `NHL_USE_MOCK=true` silently stops all settlement; `DORMANT=true` silently stops odds collection.
- DNS: `api` → `zhynah7t.up.railway.app`; apex CNAME `cname.vercel-dns.com`; never import a
  zone from a scan; never delete the `google-site-verification` TXT.
- Cloudflare: zone in *Full*, never *Full (strict)* for `api`, never *Always Use HTTPS*.
- ML service stays *Unexposed* (no public domain); ignore Railway's agent suggestion.
- Where things are: Neon project **ArakIce** is in the **llgarage** organization; Railway project
  **harmonious-perception** (services `IceEdge`, `courageous-analysis`, Redis) is in the
  **ireinahedad's Projects** workspace. Other Neon/Railway accounts you see are not ArakIce.
- Railway `IceEdge`: keep healthcheck `/health/ready` and teardown draining 15 s. A **Rollback**
  restores the image *and the variables* of that deployment.
- Vercel: after any Instant Rollback, **Promote** the newest deployment again, or `master` pushes
  (and the daily SEO pages) stop going live.
- Neon production branch is **protected**: an in-place Restore may require unprotecting it first
  (Settings → General); re-protect afterwards.
- Sentry: do not follow the "Configure Express SDK" wizard; `SENTRY_TRACES_SAMPLE_RATE` absent on purpose.
  Keep `beforeSend: scrubEvent` in `instrument.ts` — without it events carry the refresh cookie.
- `db:migrate:all` applies the whole backlog — check the target line and `PUBLIC_SLIPS_SINCE` first.
- `ENABLE_DEV_ROUTES=true` in production is **intentional** (decided 2026-09-26): the moderation
  queue (`/api/dev/reports`) and `/dev/ml` live under `/api/dev`. Every route there requires
  `authenticate` + `requireRole('admin')`. Turning it off breaks moderation.
- No staging (decided 2026-09-26): QA on production uses throwaway accounts, and Pro is granted by
  promo code, never by a real payment. Delete the throwaway accounts afterwards (Settings → delete).
- Test auth on the real domain, not on a `*.vercel.app` preview (third-party cookie there).
- The support Gmail is `support.arakice@gmail.com`; the dead one was `arakice.support@gmail.com`. Do not "fix" one into the other.

**Code**
- User-facing French is in « vous » everywhere (decided 2026-10-05). Only admin pages
  (`/dev/*`) and text addressed to the model itself stay in « tu ».
- No local prediction fallback, ever: on failure show "—" and a banner.
- Rule percentages come from the server only (`/predictions/game|team|player`). A tile with no
  server number is hidden; add new markets in `nhlPredictions.ts`, never as a client list.
- Live game markets carry NO `factors` / `pctScale`: the client would otherwise recompute every
  tile from pre-game factors and user weights, erasing the score. A new game market must handle
  the `live` branch of `computeGameMarkets` (value from the live grid, 0/100 when decided).
- Live predictions are informational only: never let them touch settlement, `locks_at` or the
  started-game refusal in `slip.service.ts`.
- Live display rule (owner, 2026-10-01): a number recalculated on the game state = `live: true` =
  solid white; anything computed before the game is shown paler under the top-of-page note —
  never passed off as live. No new model constant that is not measured on real games.
- `useNHLData` must return stable functions (`useCallback`) — unstable ones caused the `/nhl-predictions` loop.
- Never put a secret behind `VITE_`; never log the Odds API URL (key in query string).
- `sendError` reports 5xx to Sentry except 501/503 — do not add 503 (one event per request
  during an outage). `writeLimiter` skips GET/HEAD/OPTIONS on purpose.
- `PATCH /users/:id` is admin-only: an owner email change without verification is an account
  takeover path. Profile edits go through `PATCH /users/me`.
- `vite.config.ts`: React keeps its own chunk, listed before `charts` — otherwise Rollup puts
  React inside `charts` and every page downloads recharts.
- Grace-window liveness means "a token born after this rotation", not "any live token".
- `ci.yml`: keep `master` in the triggers, do not widen to all branches.
- Removing a route does not remove its chunk: use `const X = flag ? lazy(...) : null`.
- Refresh-token rotation: the grace window is three mechanisms (in-flight promise, DB
  fallback, `sessionStillAlive`) — read R3bis.2 of `git show 0916b52:PRE_IOS_PLAN.md` before touching it.
  Never make the server rotation stricter without the client coalescing.
- Chat moderation decisions (reports cascade with the message, block routes have no
  `requireOwnerOrAdmin` on purpose, block list is one-way, hidden = hidden for the author
  too, socket not filtered server-side) — see R4 of `git show 0916b52:PRE_IOS_PLAN.md`.
- Chat length limit lives in three places (`RoomChat`, `chat.service.ts`, zod schema).
- Prove a typecheck is active by inserting a deliberate error.
- Tennis stays removed; `SportContext` stays mono-sport.
- SEO hubs render their links server-side; never go back to JS rendering. Never put
  `[skip ci]` in the SEO Action's commit message (Vercel would skip the deploy).
- Split big files by script with three checks (syntax, internal imports, line multiset).

**Repo**
- `git config core.autocrlf input`; `npm ci`, never `npm install`.
- Tests/builds run in a fresh Linux install (cloud container), not through the bridge.
- Through the bridge, use `git --no-optional-locks status`: a plain `git status` writes
  `.git/index.lock`, and the bridge cannot delete it — your next Windows `git` then fails.
- Dynamic QA: `loadtest/qa-dynamic/` against a local stack only (the script refuses Neon /
  arakice.com).

---

## 7. Document map

| Document | Role |
|---|---|
| `STATUS.md` | This file — what remains |
| `PROJECT_CONTEXT.md` | Architecture, conventions, API, setup |
| `DEPLOYMENT.md`, `MONITORING.md`, `BACKUP_DR.md`, `SECRET_ROTATION.md`, `SAISIE_MANUELLE.md` | Runbooks |
| `APPLE_PLAN.md` | iOS roadmap (not started) |
| `ml/EXPLICATION_ML.md` | How every ML number is computed |
| §8 of this file | ML measured conclusions + ML code map (was `ml/REFACTOR_PLAN.md`) |
| `loadtest/*`, `loadtest/qa-dynamic/` | Load-test and dynamic QA procedures |
| `content/*` | Content engine docs |

**Finished documents are deleted; Git keeps them.** Code comments still cite some of them — read
them with `git show <commit>:<path>`:

| Document | Read it with |
|---|---|
| `PRE_IOS_PLAN.md` (web work before iOS: R2–R7, R3bis auth, R4 chat moderation) | `git show 0916b52:PRE_IOS_PLAN.md` |
| `SLIP_COMMANDE_PLAN.md` (Bet builder IA design) | `git show 0916b52:SLIP_COMMANDE_PLAN.md` |
| `RAPPORT_TESTS_CHARGE_2026-09-18.md` (load-test report) | `git show 0916b52:RAPPORT_TESTS_CHARGE_2026-09-18.md` |
| `ml/INCOHERENCES_ML.md` (21 ML train/serve fixes, « INCOHERENCES_ML §N ») | `git show ad0eba9:ml/INCOHERENCES_ML.md` |
| Full versions of the trimmed plans, `STATUS.md` §1 « DONE » | `git show 0916b52:<path>` |
| `ml/REFACTOR_PLAN.md`, `QA_TEST_PLAN.md`, `LIVE_PREDICTIONS_PLAN.md`, `AUDIT_SCALABILITE_COUTS.md` (merged into §3.5–3.7 and §8 on 2026-10-07) | `git log -p -- <path>` (code comments still cite them) |
| `AUDIT_PRE_FREEZE_IOS.md`, `PRODUCTION_READINESS_AUDIT.md` | deleted 2026-09-24 |
| `RESTE_A_FAIRE.md` | `git show 4d1cbcd~1:RESTE_A_FAIRE.md` |

---

## 8. ML reference — measured conclusions and code map

Not a to-do list: what has been measured (do not re-test it) and where the code is. Read it
before touching the model. How each number is computed: `ml/EXPLICATION_ML.md`.

### 8.1 Acquis — à ne PAS refaire

Ces résultats ont coûté cher à mesurer et sont solides. Les redécouvrir serait
du temps perdu ; les ignorer serait pire.

| Question | Réponse mesurée | Comment |
|---|---|---|
| Peut-on battre le moneyline ? | **Non.** La cote de clôture dévigée est le meilleur estimateur disponible. | 3 chemins indépendants : résidu de marché (arrêt précoce à 0-88 arbres), 117 features, dimensionnement Kelly. Walk-forward 7-9 saisons. |
| Plus de features aide-t-il ? | **Non.** 13 features (0.66819) battent 117 (0.67064), qui font moins bien qu'un ELO nu. | Sélection sans fuite, walk-forward 7 saisons. Les 104 supprimées coûtaient 0.00245 de log-loss en variance pure. |
| Le total de buts est-il prédictible ? | **Quasi pas.** MAE 1.86 contre 1.90 pour une constante. | Le gain de P2 n'était pas la précision mais la *calibration* des marchés dérivés. |
| Faut-il un Poisson bivarié ? | **Non.** Dispersion 1.013/0.991, corrélation dom↔ext **−0.048** — le bivarié standard ne modélise que du positif. | Mesuré sur 21 517 matchs. |
| La correction de marge τ est-elle nécessaire ? | **Oui.** Le Poisson brut sous-estime les nuls de 6 points ; τ ramène à 0.2 point. | Signature du filet désert : excès sur 0 et ±3, déficit sur ±1 et ±2. |
| σ (ensemble bootstrap) dit-elle où le modèle se trompe ? | **Non** en général. Elle dit où l'edge *sélectionné* est gonflé (malédiction du vainqueur, p ≈ 0.04). Non actionnable : l'edge corrigé est négatif partout. | 20 membres, σ_max calibré hors échantillon. |
| La forme d'un gardien est-elle prévisible ? | **Non.** r = +0.038 d'un match au suivant. Mais le *talent* est réel : 0.165 but/match entre Q1 et Q4, à xG subi plat. | 45 222 départs. |
| Les totaux sont-ils jouables ? | **Non.** ROI −2.75 % sur 8 833 paris à prix réels. (Le modèle récupère ~1.7 pt sur une marge de 4.4 % : du signal, pas assez.) | 9 saisons, prix de clôture SBRO. |
| Peut-on élaguer les 22 features du modèle de score ? | **Non tranchable.** Retirer les 12 features au niveau du hasard coûte +0.00019 de log-loss puck line, pour une erreur-type de 0.00024. Il faudrait ≈ 154 saisons. | Ablation par permutation 14 saisons + contrôle par suppression réelle (2026-08-23). |
| Les 4 features ajoutées le 2026-09-28 aident-elles ? (`atk_ev_xgf_pct_l`, `def_b2b`, `def_rest_days`, `def_goalie_backup`) | **Oui — AMÉLIORE.** 26 features contre les 22 du run de référence d'août : log-loss puck line **−0.00056 ± 0.00022** (bruit des sentinelles 0.00021), meilleure sur 11 saisons sur 14 ; déviance −0.0018, moneyline −0.0011, tous deux bien au-delà du bruit. Le modèle servi les contient déjà. | `--confirm-score-features`, walk-forward 14 saisons (2026-10-07). `score_feature_confirmation.json`. |
| La puck line est-elle jouable ? | **Non tranché, et la question a changé de forme.** Sans la fuite d'hyperparamètres : +2.10 % à edge ≥4 % (z 1.50). Mais **tout vient de la jambe −1.5** : 463 paris à +20.09 % (z 3.05), pendant que les 3 482 paris +1.5 font −0.30 %. | Walk-forward 9 saisons, prix de clôture réels, sélection par fold (2026-08-08). Voir A2. |
| Bat-on la ligne d'OUVERTURE au moneyline ? | **Presque, et c'est nouveau.** Le CLV est réel (net du placebo +0.0133 à edge ≥4 %, placebo +0.0002), mais la clôture ne valorise ces paris qu'à **−0.25 %** à edge ≥4 % et **+0.44 %** à ≥5 % : le modèle bat l'ouverture d'environ une marge, pas plus. Le +4.30 % réalisé dépasse cela de 1.6-2.3 σ et la dissection l'attribue à la queue (tercile d'edge 1.60/0.36/**10.93 %**, 44 paris sur 3 751 le renversent). | `--clv`, 9 saisons, 19 644 paris aux prix d'ouverture (2026-08-23). Voir A3. |
| Une couche posée sur la victoire du modèle de score améliore-t-elle le moneyline ? | **Oui — ADOPTÉE (2026-10-02).** Logistique sur `logit p` + 7 features (`b2b_diff`, `ev_xgf_pct_s/l_diff`, `lineup_xg_diff`, `star_power_diff`, `xg_matchup_diff`, `elo_diff`) : log-loss **−0.0021** (z −3.2, meilleure sur ~82 % des saisons). Écart à la clôture ramené de +0.0014 à **−0.0004** : le modèle est désormais **à parité** avec la clôture — pas au-dessus, −0.0004 est du bruit. Elle ne touche que la victoire ; `_align_distribution` recale ensuite la matrice pour que tous les marchés restent cohérents. | `--market-gap` puis `--correction`, walk-forward strict 11 saisons, critère fixé avant le run. `correction_layer.json`. |
| Le niveau de buts dérive-t-il dans la saison ? | **Oui — recalage ADOPTÉ (2026-10-04).** Le modèle surestimait les buts de ~4 % depuis 2022 (observés/λ = 0.955-0.969). Un k par saison, rétréci vers 1 (n0 = 200 matchs) : déviance du total **−0.0032** (z −3.2, 8 saisons sur 11) ; P(> 5.5) 2023-26 : 58.4 % → 55.8 % pour 56.0 % observé. Ne touche que le total, pas la victoire. | `measure_level.py`, `level_report.json`. k recalculé chaque lundi par `refresh_data.py` → `level_layer.json`. |
| Faut-il mélanger la cote du marché dans la prédiction ? | **Non — décision du 2026-10-07.** Mesuré : score seul 0.67093, mélange score ⊕ marché 0.67077, marché seul **0.67047** (2 628 matchs de test). Le mélange ne bat pas le marché, et il rétrécirait par construction l'écart modèle − marché que mesurent les best bets, la règle A2 et le CLV. | `score_report.json` → `blend`. Ancien mélange du classifieur sur 2025-26 : 0.6843 contre 0.6822 pour le marché. |
| Le CLV des TOTAUX vaut-il quelque chose ? | **Non, et c'est un artefact.** Son CLV net est **inférieur à son propre placebo** à tous les seuils (+0.0020 contre +0.0030) : entièrement de la régression vers la moyenne. La clôture les valorise à −3.2 % constant. | Même run. Le placebo est ce qui l'a révélé. |

> **Sur 2022-23, à savoir avant d'interpréter A2.** Cette saison ne compte que
> 342 matchs dans `odds.csv`, et ce n'est pas un trou de couverture de la puck
> line : l'archive SBRO **s'arrête au 2022-11-27**, toutes colonnes confondues.
> C'est l'une des deux saisons négatives d'A2, et elle ne pèse que sept semaines
> de début de saison — la période où les fenêtres glissantes de forme sont à
> peine remplies. Ce n'est pas une saison, c'est un octobre-novembre.
> (Vérifié le 2026-08-23 ; question ouverte depuis A2, close.)

**Trois règles de méthode issues de ces mesures :**

- Comparer une valeur servie à la **saison courante**, jamais à la moyenne
  historique — la ligue marque 6.254 buts/match en 2025-26 contre 5.848 sur
  tout l'historique.
- Un ROI positif n'est crédible que **réparti** : dans le temps, à travers les
  cotes, à travers les équipes, et sans tenir à quelques gains. `dissect()`
  dans `backtest_walkforward.py` teste les quatre.
- **Les cotes ne sont jamais une ENTRÉE du modèle, seulement un ÉTALON.** Elles
  servent à mesurer (log-loss contre la clôture, ROI, CLV), jamais à produire la
  probabilité servie. Un modèle qui contient le marché ne peut plus dire où le
  marché se trompe.

### 8.2 Où en est le code

```
fetch_data_v4.py       spine + MoneyPuck + cotes (SBRO ≤2022-11-27, Odds API ≥2020)
refresh_data.py        mise à jour hebdo en saison (calendrier, MoneyPuck,
                       build_dataset, inference_state, elo, level_layer) —
                       lancé par ml/refresh-data.cmd, ne touche pas odds.csv
build_dataset.py       features + cibles réglementaires/prolongation
train_score.py         Poisson empilé équipe-match + τ + P(dom en OT)   ← le cœur
score_model.py         distribution → tous les marchés dérivables ; level_k,
                       lambdas_for_home_win (recalage sur la victoire corrigée)
measure_level.py       mesure du recalage de niveau des buts → level_report.json
train_player.py        un booster count:poisson par stat de patineur
                       (+ face-à-face joueur vs adversaire) → models/player/
train.py               classifieur moneyline — repli seulement (S4 ⑤) ;
                       ses utilitaires (split, log_loss_np, fit_logistic…)
                       sont importés par backtest*.py
ml_service.py          service FastAPI : score → correction → recalage →
                       niveau ; classifieur en repli et en comparaison
backtest_walkforward.py walk-forward, marchés dérivés, CLV, dissection,
                       --market-gap / --correction (couche de correction)
backtest.py            ancien backtest, conservé
live_pregame.py        λ et P avant-match rejoués sur l'historique → live_pregame.csv
calibrate_live.py      calibration du modèle en direct
fetch_live_goals.py    buts horodatés pour le direct
content_insights*.py   insights éditoriaux (SEO / contenu), hors prédiction
compare_*.py, probe_odds_books.py   contrôles ponctuels des sources de cotes
```

Fichiers servis (`ml/models/`) : `score_model.json` + `score_report.json`,
`correction_layer.json`, `level_layer.json`, `inference_state.json`,
`elo_ratings.json`, `player/*.json` + `player_state.json`, et `game_model.json`
(repli, voir S4 ⑤).

Cotes live : `server` → `npm run odds:export` (→ `data/odds_live_log.csv`) et
`npm run odds:export-snapshots` (→ `data/odds_snapshots_hist.csv`), puis
`python fetch_data_v4.py --only odds --from-local`.
