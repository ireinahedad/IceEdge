# ARB_SCANNER_PLAN.md — Scanner d'arbitrages (« surebets »)

Créé le 2026-10-23. Statut : **A0 fait côté code** (module pur + script + démo + 18 tests).
Prochaine étape : **A1**, premier scan réel (`npm run arb:scan`, ≈ 3 crédits), puis choisir `ARB_BOOKS`.

### Journal
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

## 2. Utilisation

```bash
cd server
npm run arb:scan -- --demo                 # données fictives, 0 crédit
npm run arb:scan                           # 1 scan réel, marchés principaux (≈ 3 crédits)
npm run arb:scan -- --watch 300            # re-scan toutes les 5 min (Ctrl+C pour arrêter)
npm run arb:scan -- --extras               # + 3-way, alternatifs, périodes, totaux d'équipe, BTTS
npm run arb:scan -- --props                # + props joueurs (points, buts, passes, tirs, arrêts)
npm run arb:scan -- --bankroll 500 --round 5 --min 1 --books pinnacle,bet99_ca_on,betano_ca_on
npm run arb:scan -- --help
```

| Option | Rôle | Défaut |
|---|---|---|
| `--bankroll` | mise totale répartie entre les issues | 1000 |
| `--round` | pas d'arrondi des mises (ce que tu tapes dans l'appli) | 1 |
| `--min` | profit minimum signalé, en % | 0.5 |
| `--books` | livres comparés (remplace `ARB_BOOKS`) | 10 livres US + CA |
| `--horizon` | `--extras`/`--props` : matchs des N prochaines heures | 12 |
| `--watch` | secondes entre deux scans (≥ 30) | un seul scan |
| `--no-log` | ne pas écrire `arb-log.jsonl` | journal actif |

Sortie type (démo) :

```
[3] +1.96 %  Boston Bruins @ Toronto Maple Leafs  —  totals 6.5  —  dans 8 h 00
    Over 6.5                       @  2.08  FanDuel        → miser 490 $
    Under 6.5                      @  2.00  Pinnacle       → miser 510 $
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
- **A5 (option) — Middles.** Over 5.5 chez A + Under 6.5 chez B : on gagne les deux si le score
  tombe pile entre les deux. **Pas sans risque** (petite perte sinon) : à afficher à part,
  jamais mélangé avec les arbitrages.
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
