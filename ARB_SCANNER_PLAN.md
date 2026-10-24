# ARB_SCANNER_PLAN.md — Scanner d'arbitrages (« surebets »)

Créé le 2026-10-23. Statut : **A0 fait, A1 commencé** (premier scan réel OK), **outils 0 crédit faits**
(sauvegarde/relecture des scans, marchés presque-arbitrage, calculatrice `arb:calc`), **A5 middles fait**.
Prochaine étape : **clé dédiée** (`ARB_ODDS_API_KEY`) — la clé partagée est presque au plancher —
puis relancer A1 pour lire la ligne « Livres (matchs cotés) » et fixer `ARB_BOOKS`.
**Les commandes à lancer, dans l'ordre : § 2.**

### Journal
- **2026-10-24 — 1er scan `--middles`** (00:07 UTC, 3 crédits, solde **3030** → plus que ~10 scans
  avant le plancher) : 14 matchs, 68 marchés comparés, 10 livres actifs (BET99 : 2 matchs
  seulement), arakiceML joint pour 14/14. Aucun arbitrage (le plus proche Σ = 1.0054, ANA @ PHI
  total 6). **33 middles candidats, tous à espérance négative** (meilleur −0.62 %) — normal sans
  `--extras` : les marchés principaux n'offrent presque que des lignes 5.5 / 6 / 6.5. Bug corrigé :
  les demi-middles (Over 5.5 + Under 6 → gagné + remboursé à 6 buts) sortaient avec une fenêtre
  vide et P = 0 % ; ils comptent maintenant dans la fenêtre, avec un seuil général −L̄/(W̄ − L̄).
  Constat : la prolongation gonfle les totaux impairs (P(7 buts) ≈ 19 % pour EDM–TOR, λ = 6.8),
  ce qui favorise les fenêtres à 5 et 7 buts.
- **2026-10-24 — A5 Middles** : `arbMiddles.ts` (pur) + 13 tests (40 au total). Over a / Under b
  (b − a ≤ 2) et handicaps qui se chevauchent, sur `totals`+`alternate_totals` et
  `spreads`+`alternate_spreads`. Probabilités de la fenêtre : arakiceML via l'API publique
  (`/games/range` pour l'id NHL, puis `/predictions/game/:id`), repli loi du marché
  (`fitMarket` → `finalScoreGrid`). `--middles`, `--model arakice|market` dans `arb:scan` ;
  middles SANS RISQUE (Σ < 1) journalisés et alertés comme des arbitrages. Démo : 2 lignes
  alternatives DraftKings ajoutées. Section § 2 « Commandes à faire » ajoutée au plan.
- **2026-10-23 — Outils 0 crédit** : chaque scan réel est sauvegardé dans `server/arb-snapshots/`
  (`--replay latest|fichier` pour le ré-analyser, `--no-save`, 500 gardés) ; `--near N` liste
  les marchés les plus proches d'un arbitrage (affichés d'office quand il n'y en a aucun) ;
  cotes américaines à côté des décimales dans l'affichage ; `npm run arb:calc` (mises,
  cotes américaines, couverture quand le 1er pari est placé et que l'autre cote a bougé) —
  `arbCalc.ts` + 9 tests (27 au total). Le scan réel du 2026-10-23 n'a pas été sauvegardé
  (antérieur à cette fonction).
- **2026-10-23 — A1 (1er scan réel)** : 3 crédits, 2 matchs, 8 marchés comparés, aucun
  arbitrage ≥ 0.5 % ; le plus proche : TBL @ COL spreads −1.5, Σ = 1.0092. Solde de la clé
  partagée après le scan : **3114** (plancher 3000) → le scanner ne peut quasiment plus
  tourner sur la clé de l'app ce mois-ci. Ajout dans le script : ligne de couverture par
  livre (« Livres (matchs cotés) » / « Sans cotes NHL »), absente du 1er scan.
- **2026-10-23 — A0** : `server/src/services/arb/arbScanner.ts` (détection, pure),
  `arbScanner.test.ts` (18 tests), `__fixtures__/arb-sample.json` (données fictives),
  `server/scripts/arb-scan.ts` (CLI), script npm `arb:scan`, variables `ARB_*` dans
  `.env.example`, `server/arb-log.jsonl` ignoré par git.

---

## 1. But

Repérer automatiquement les marchés NHL où les **meilleures cotes de 2 ou 3 livres
différents** garantissent un profit, quel que soit le résultat. On mise sur toutes les
issues opposées, chacune chez le livre qui la paie le mieux.

- **D'abord** : outil perso en ligne de commande, hors de l'app.
- **Ensuite (option)** : fonctionnalité Pro d'ArakIce, en affichage seulement (jamais d'argent dans l'app), cf. A6.

## 2. Commandes à faire

Toutes les commandes se lancent depuis **`C:\Users\irein\dev\ICEEDGE\server`**.
Repère horaire : un match de 19 h (heure de l'Est) commence vers **7 h du matin à Bali**.

### 2.1 Une seule fois

| # | À faire | Pourquoi | Crédits |
|---|---|---|---|
| 1 | `npm run arb:scan -- --demo --middles` | voir à quoi ressemble la sortie (données fictives) | 0 |
| 2 | Créer un 2e compte The Odds API, coller sa clé dans `ARB_ODDS_API_KEY=` (`server/.env`) | ne plus manger le quota de l'app | 0 |
| 3 | `npm run arb:scan` | lire la ligne « Livres (matchs cotés) » : qui a vraiment des cotes NHL | ≈ 3 |
| 4 | Mettre tes livres dans `ARB_BOOKS=` (`server/.env`), ex. `pinnacle,bet99_ca_on,betano_ca_on` | ne voir que ce que tu peux parier, là où tu es | 0 |
| 5 | (facultatif) Webhook Discord dans `ARB_DISCORD_WEBHOOK=` | recevoir les arbitrages sur ton téléphone | 0 |

### 2.2 Chaque jour de match, 1 à 2 h avant (≈ 5 h – 6 h à Bali)

```bash
npm run arb:scan -- --middles               # arbitrages + middles (≈ 3 crédits ; probabilités arakiceML gratuites)
npm run arb:scan -- --extras --middles      # 1 fois par jour : lignes alternatives, là où vivent les middles (≈ 80 crédits)
npm run arb:scan -- --watch 300             # la dernière heure, si rien : un scan toutes les 5 min (≈ 36 crédits/h), Ctrl+C pour arrêter
```

### 2.3 Au moment de parier (0 crédit)

1. Ouvre les **deux applis** et relis les cotes (l'API a du retard).
2. Calcule les mises avec les cotes que tu vois :
   ```bash
   npm run arb:calc -- +108 -100                  # cotes américaines ou décimales (2.08 2.00)
   npm run arb:calc -- +108 -100 --bankroll 500 --round 5
   ```
   Pour un **middle**, mêmes commandes : la calculatrice donne les mêmes mises (paiements égaux) ;
   la « perte si un seul gagne » qu'elle affiche est le coût hors fenêtre, c'est normal.
3. Vérifie la **mise max** acceptée des deux côtés, place le pari chez le livre « mou » d'abord,
   puis l'autre **immédiatement**.
4. Si la 2e cote a bougé entre-temps :
   ```bash
   npm run arb:calc -- --placed 490@+108 -105     # 490 $ déjà placés à +108, l'autre côté est à -105
   ```

### 2.4 Après coup (0 crédit)

```bash
npm run arb:scan -- --replay latest --min 0 --near 10 --middles   # revoir le dernier scan avec d'autres filtres
npm run arb:scan -- --replay arb-snapshots/<fichier>.json         # un scan précis (liste : dossier server/arb-snapshots)
npx vitest run src/services/arb                                   # tests du scanner (40)
```

### 2.5 Référence des options de `arb:scan`

| Option | Rôle | Défaut |
|---|---|---|
| `--bankroll` | mise totale répartie entre les issues | 1000 |
| `--round` | pas d'arrondi des mises (ce que tu tapes dans l'appli) | 1 |
| `--min` | profit minimum signalé, en % | 0.5 |
| `--books` | livres comparés (remplace `ARB_BOOKS`) | 10 livres US + CA |
| `--horizon` | `--extras`/`--props` : matchs des N prochaines heures | 12 |
| `--watch` | secondes entre deux scans (≥ 30) | un seul scan |
| `--near` | marchés « presque arbitrage » affichés (toujours, même s'il y a des arbitrages) | 3, seulement si aucun arbitrage |
| `--replay` | ré-analyse un scan sauvegardé (`latest` ou un fichier de `arb-snapshots/`) | — |
| `--no-save` | ne pas sauvegarder le scan dans `arb-snapshots/` | sauvegarde active |
| `--no-log` | ne pas écrire `arb-log.jsonl` | journal actif |
| `--middles` | ajoute la section Middles (§ 3.1) | désactivé |
| `--model` | probabilités des middles : `arakice` (modèle de l'app, repli marché) ou `market` | `arakice` |
| `--extras` / `--props` | marchés par match (alternatifs, périodes, 3-way…) / props joueurs — coûteux, § 5 | désactivés |
| `--help` | aide complète | — |

Sortie type (démo) :

```
[3] +1.96 %  Boston Bruins @ Toronto Maple Leafs  —  totals 6.5  —  dans 8 h 00
    Over 6.5                       @ 2.08 (+108)   FanDuel        → miser 490 $
    Under 6.5                      @ 2.00 (+100)   Pinnacle       → miser 510 $
    Profit garanti : 19.61 $ sur 1000 $ (mises arrondies : 19.20 $ sur 1000 $)
```

## 3. Comment ça marche

Pour chaque match et chaque marché : meilleure cote de chaque issue parmi les livres, puis

```
Σ 1/cote_i < 1   →   arbitrage, profit = 1/Σ − 1
mise_i = bankroll × (1/cote_i) / Σ     (le paiement est le même quelle que soit l'issue)
```

**Appariement des issues opposées**, déduit de la forme des données (pas de liste fermée) :

| Forme | Issues opposées | Exemples |
|---|---|---|
| Over/Under + ligne | même ligne, même joueur/équipe | `totals`, `alternate_totals`, `totals_p1`, `team_totals`, `player_shots_on_goal` |
| Handicap d'équipe | points opposés (clé = handicap du domicile) | `spreads` −1.5 ↔ +1.5, `alternate_spreads` |
| Sans ligne, 2 issues | Domicile ↔ Visiteur, Oui ↔ Non | `h2h`, `btts` |
| `*3_way*` | Domicile / Nul / Visiteur (les 3 obligatoires) | `h2h_3_way`, `h2h_3_way_p1` |

**Arrondi intelligent** : pour chaque mise, le script essaie le pas inférieur et le pas
supérieur et garde la combinaison au meilleur profit garanti (l'arrondi naïf au plus proche
peut effacer un petit arbitrage).

### 3.1 Middles (`arbMiddles.ts`)

Deux paris opposés à des **lignes différentes**, gagnants **tous les deux** si le score
tombe dans la fenêtre entre les lignes :

| Paris | Fenêtre (les deux gagnent) |
|---|---|
| Over 5.5 (livre A) + Under 6.5 (livre B) | exactement 6 buts |
| Over 5.5 + Under 7.5 | 6 ou 7 buts |
| Over 5.5 + Under 6 (demi-middle) | 6 buts : Over gagné + Under remboursé |
| Toronto −1.5 (A) + Boston +2.5 (B) | Toronto gagne par exactement 2 |

Hors fenêtre, un seul pari gagne et on perd un peu. Avec les mises à paiements égaux
(les mêmes que pour un arbitrage) et des demi-lignes :

```
seuil de rentabilité :  P(fenêtre) > Σ − 1        (Σ = 1.07 → il faut plus de 7 %)
```

**D'où viennent les probabilités** (`--model`) :
- **arakiceML** (défaut) : les probabilités publiées par l'app, `GET /api/nhl/predictions/game/:id`
  (sans authentification) : P(Over 2.5 … 7.5), moneyline, puck lines ±1.5/2.5/3.5. Score **final**,
  prolongation et fusillade comprises, comme le règlement des livres. Par différence :
  P(6 buts) = P(Over 5.5) − P(Over 6.5), P(gagne par 2) = P(−1.5) − P(−2.5). Seulement pour les
  matchs à venir ; 0 crédit pour le scanner (côté serveur, l'appel peut rafraîchir le cache des
  cotes de l'app comme une visite normale de la page du match).
- **marché** (repli, ou `--model market`) : λ ajusté sur le total principal et la moneyline
  dé-viggés (médiane de tous les livres), puis la grille `finalScoreGrid` de l'app. Hors ligne.

Les deux sont affichées côte à côte : un middle où **arakiceML voit la fenêtre plus probable que
le marché** est exactement l'avantage que le modèle peut apporter.

```
[M1] EV +3.55 %  Boston Bruins @ Toronto Maple Leafs  —  total, fenêtre : 6 buts  —  dans 8 h 00
    Over 5.5                       @ 1.75 (-133)   DraftKings     → miser 533 $
    Under 6.5                      @ 2.00 (+100)   Pinnacle       → miser 466 $
    P(6 buts) : 10.9 % marché · seuil 7.1 %
    Si 6 buts : +865.75 $ · sinon, au pire : −67.00 $ · espérance : +35.43 $ sur 999 $
    ! Pas sans risque : hors fenêtre (89 % des cas selon marché), tu perds 67.00 $.
```

⚠️ **Ce n'est PAS sans risque** (sauf mention **SANS RISQUE + bonus**, quand Σ < 1 : c'est alors
un arbitrage entre deux lignes différentes, que le scanner d'arbitrages ne voit pas). Une
espérance positive ne paie qu'**en moyenne, sur beaucoup de middles** : on perd ~7 % souvent et
on gagne gros rarement. Il faut aussi que les probabilités soient justes — c'est le risque modèle.

## 4. Garde-fous

**Gérés par le code :**
- deux clés de marché ne sont jamais mélangées (`h2h` avec prolongation ≠ `h2h_3_way` en 60 min) ;
- un groupe incomplet est ignoré (h2h contenant un « Draw », prop « Oui » sans « Non ») ;
- les lignes en quart (6.25, Asian) sont écartées : leur règlement partiel casse la garantie ;
- une cote de plus de 15 min est ignorée, de même que les matchs commencés ou qui commencent dans moins de 5 min ;
- au-delà de 8 % de profit, l'opportunité est marquée **SUSPECT** (erreur de cote probable, risque d'annulation) ;
- avertissements : même livre des deux côtés, ligne entière (remboursement possible), prop joueur (joueur absent), moneyline de période à 2 issues (règle d'égalité), arrondi qui efface le profit ;
- **plancher de crédits** `ARB_MIN_REMAINING` (3000) : sous ce solde, le scanner n'appelle plus l'API.

**À vérifier par toi, à chaque pari :**
- la cote **dans l'appli du livre** (l'API a du retard) ;
- la **mise maximale** acceptée des deux côtés, avant de placer le 1er pari ;
- la règle de règlement : prolongation et tirs de barrage, joueur absent, égalité de période ;
- ⚠️ **les cotes de DraftKings, FanDuel, BetMGM, etc. renvoyées par l'API sont celles des États-Unis.**
  Les versions ontariennes de ces livres ont leurs propres cotes. Mets dans `ARB_BOOKS`
  **seulement les livres où tu as un compte, dans la juridiction où tu es physiquement.**
  Livres canadiens couverts par The Odds API : `bet99_ca_on` et `betano_ca_on` (Ontario),
  `playnow_ca` (C.-B.). `pinnacle` = cotes internationales, à comparer avec Pinnacle Ontario.

## 5. Coût en crédits (The Odds API)

Jusqu'à 10 livres = le prix d'**une** région.

| Mode | Coût d'un scan | Rythme | Crédits / mois (10 h de matchs par jour) |
|---|---|---|---|
| Marchés principaux | 3 | toutes les 5 min (`--watch 300`) | ≈ 11 000 → plan 20K (30 $) |
| Marchés principaux | 3 | toutes les 2 min (`--watch 120`) | ≈ 27 000 → plan 100K (59 $) |
| `--extras` | ≈ 1 par marché renvoyé × match (8 matchs × ~10 ≈ 80) | 1 à 2 fois par jour de match | ≈ 3 000 – 5 000 |
| `--props` | ≈ 5 × match (≈ 40) | ponctuel | selon usage |

⚠️ **Le plan 20K actuel est déjà réparti** (affichage ≈ 4 500, collecte ≈ 450, backfill ≈ 15 000,
cf. `oddsClient.ts`). Avec la clé partagée, le scanner s'arrête sous 3000 crédits restants, mais il
mangera quand même le budget de l'app. **Recommandé : un 2e compte The Odds API** pour le
scanner → `ARB_ODDS_API_KEY` (gratuit, 500 crédits, pour A1 ; payant pour A2).

## 6. Phases

- **A0 ✅ Code** : module pur, CLI, démo, tests.
- **A1 — Premier scan réel.** `npm run arb:scan` (≈ 3 crédits). Vérifier que chaque livre de
  `DEFAULT_BOOKS` renvoie bien des cotes NHL, puis fixer `ARB_BOOKS` sur tes vrais comptes.
- **A2 — Surveillance.** Clé dédiée (`ARB_ODDS_API_KEY`), `--watch 300`, alertes Discord
  (`ARB_DISCORD_WEBHOOK`) : un message par **nouvel** arbitrage, sans doublon.
- **A3 — Marchés étendus, mesurés.** `--extras` 1 à 2 fois par jour de match pendant 2 semaines.
  Compter dans `arb-log.jsonl` quels marchés produisent des arbitrages, puis ne garder que
  ceux-là dans `ARB_EXTRA_MARKETS` (chaque marché retiré = des crédits économisés).
- **A4 — Props joueurs** si A3 montre que les marchés secondaires valent leur coût. Les props
  sont souvent les plus décalées entre livres, mais aussi les plus limitées en mise.
- **A5 ✅ Middles** (§ 3.1) : `--middles`, probabilités arakiceML ou marché, section à part,
  jamais mélangée avec les arbitrages. Suite possible : suivre dans `arb-log.jsonl` combien de
  fenêtres tombent réellement, pour vérifier la calibration d'arakiceML sur ces scores exacts.
- **A6 (option) — Fonctionnalité Pro d'ArakIce.** `arbScanner.ts` est pur et réutilisable tel quel :
  job serveur (avec `jobLock`) qui scanne avec la clé dédiée → cache Redis → route
  `GET /api/arb` (Pro) → page « Arbitrages » + push « nouvel arbitrage » pour les Pro.
  Aucun appel API par visiteur. Web seulement (Apple refuse le jeu simulé sur un compte
  développeur individuel). Liens « parier chez X » quand les codes d'affiliation existeront.

## 7. Décisions à prendre

1. **Clé** : 2e compte The Odds API dédié (recommandé) ou clé partagée avec plancher ?
2. **Livres** : lesquels, selon où tu seras physiquement pour parier ?
3. **Bankroll et pas d'arrondi** par défaut (ex. `--bankroll 500 --round 5`).
4. **Alertes** : webhook Discord, ou plus tard push via l'app (A6) ?
