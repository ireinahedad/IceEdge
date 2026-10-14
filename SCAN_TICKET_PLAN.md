# SCAN_TICKET_PLAN.md — « Scanner un ticket »

Créé le 2026-10-14. Statut : **S0 commencé (infrastructure + 1re capture), S1 fait côté code** (2026-10-14).
Prochaine étape : captures du user (S0, EN + FR), build TestFlight avec `ocr_lab` pour Vision (S1), puis S2.

### Journal
- **2026-10-14 — S0** : `__fixtures__/slipScan/` (format `fixture.ts`, README, test
  `slipScanFixtures.test.ts`), 1re fixture réelle `bet365-fr-dark-001`. Ce qu'elle
  corrige dans le plan : (a) bet365 **en français** dès la v1 (« Plus de 5.5 buts »,
  « 1+ points », « Pari personnalisé ») ; (b) la carte du match vient **après** les
  jambes (§ 3.3 supposait l'ancre avant) ; (c) la cote d'un « Pari personnalisé »
  couvre **tout le groupe**, pas une jambe → vérité organisée en groupes ; (d) `WAS`
  pour Washington ; (e) « Nicholas » vs « Nick » Suzuki ; (f) pas de cote totale
  affichée ; (g) l'heure sous la date n'est pas l'heure du match.
- **2026-10-14 — S1** : `services/ocr/` (`ocrService`, `ocrCore` pur, `tesseractOcr`,
  `visionOcr`), `VisionOcrPlugin.swift` (enregistré, pbxproj), assets Tesseract
  auto-hébergés (`scripts/ocr-assets.mjs` → `public/ocr/`, non versionné, élagué du
  build iOS), CSP web : **`'wasm-unsafe-eval'` ajouté à `script-src`** (vérifié :
  sans lui le wasm est refusé). Banc `npm run ocr:bench` + `vision-ocr.swift` (Mac).
  Tesseract sur la 1re capture : 100 % des lignes de jambes, cotes exactes, ~3,5 s
  (Node) / ~1,7-2,5 s (Chromium). Segmentation `SPARSE_TEXT` (corrigé le jour même → `AUTO`, voir plus bas) (sépare les colonnes
  comme Vision).
- **2026-10-14 — D5, D6** : anglais + français dès la v1 (§ 3.1, § 3.4, § 7) ;
  « Labo OCR » (`pages/OcrLabPage.tsx`, `/dev/ocr`) pour mesurer Vision sur l'iPhone :
  choisir des captures → lignes + boîtes + temps → « Partager le JSON » (un objet
  `{ nom: OcrResult }` à ranger dans `ocr/vision/`). Captures du user attendues le 2026-10-15.

Le joueur importe une **capture d'écran** de son ticket (v1 : bet365 et DraftKings).
ICEEDGE reconnaît chaque jambe, affiche la probabilité du modèle, la proba implicite
de la cote, l'edge, et la probabilité du coupon entier (corrélation incluse).
- **2026-10-14 — 4 nouvelles fixtures** (5 au total) : `bet365-en-dark-001`,
  `bet365-fr-dark-002`, `draftkings-en-dark-001`, `draftkings-en-dark-002`. Banc
  Tesseract : 100 % des lignes de jambes, **100 % des cotes**, ~3,7 s. Segmentation
  repassée de `SPARSE_TEXT` à **`AUTO`** : `SPARSE_TEXT` lisait `−122` « =122 » et
  ratait `−125` dans les cases de cote DraftKings (90 % des cotes). Leçons pour S2 :
  - **Un ticket bet365 en français garde des libellés de marché en anglais**
    (« 1+ Shots on Goal », « Team Total ») → table EN+FR **fusionnée**, pas choisie
    par langue (D5 renforcé).
  - **« 1+ Shots on Goal » = plus de 0.5 tirs : hors `MARKET_LINES.shots_ou`** (1.5+).
    8 jambes sur 22 des fixtures tombent en `unsupported_line` (D4) — c'est le prop
    le plus courant ; S8 (élargir les lignes) remonte en priorité.
  - DraftKings met le match **au-dessus** (carte de partage) ou **en dessous, sur deux
    lignes** (onglet Social) : pas de position fixe → l'ancre du match se cherche des
    deux côtés.
  - Carte de match **coupée** en bas d'écran → `game: null`, déduire du calendrier.
  - « Sebastian Antero Aho » (CAR) ≠ Sebastian Aho (NYI) : le match départage.
  - « −130 » avec un signe moins Unicode ; « 3+ | Nom Shots on Goal » (seuil avant le nom).
  - ⚠️ L'onglet DraftKings affiche « SPORTSBOOK » : ce mot est interdit dans le bundle
    iOS (garde de `build-ios.mjs`), la liste de bruit de `slipScan.ts` ne doit pas
    l'écrire en clair.
- **2026-10-14 — D7** : pas d'API à la place des captures (voir § 9).
---

## 0. Principes (décisions du user, 2026-10-14)

- **Captures d'écran seulement.** Pas de photo de ticket papier.
- **Zéro coût de modèle de vision.** OCR **sur l'appareil**, gratuit et illimité.
  Le seul coût possible est le **repli LLM texte** sur un bloc illisible (D3), dans
  les quotas existants du Bet builder IA.
- **Efficace** : objectif mesuré au § 7, sur un jeu de vraies captures.
- **L'image ne quitte jamais le téléphone.** Partent seulement les requêtes de
  prédiction habituelles (`/predict/single`, `/predict/parlay`), identiques à celles
  d'une jambe ajoutée à la main, le décompte du quota de scans (D2), et — seulement
  pour un bloc que l'analyseur local n'a pas compris — le **texte nettoyé de ce bloc**
  vers le repli LLM (D3).
- **Règle d'or reprise de `slipCommand.ts`** : dans le doute, on ne devine pas. Une
  jambe ambiguë ou mal lue est montrée comme telle, avec des choix cliquables.

---

## 1. Ce qui existe déjà et sera réutilisé tel quel

| Brique | Fichier | Rôle dans le scan |
|---|---|---|
| Analyseur local | `server/src/services/slipCommand.ts` | alias d'équipes (`TEAM_ALIASES`), joueurs, fautes (`editDistance`, `findSpellingFixes`), ambiguïtés (« quel Hughes ? ») |
| Garde-fou | `validateIntent` (même fichier) | toute intention issue du scan passe par lui, comme celles du LLM |
| Contexte | `slipCommandContext.ts` | matchs à venir + joueurs + date NHL du jour (pas l'horloge de Bali) |
| Construction de jambe | `client/src/app/services/buildLeg.ts` | même jambe qu'à la main : même `id`, `gameId`, probabilité |
| Coupon | `context/BetContext.tsx` + `server/src/services/parlay.ts` | incompatibles / doublons / implications en local ; corrélation même-match par le serveur (loi jointe des scores) ; `SlipNotices` |
| Noms Odds API | `oddsTeamNames.ts` | noms complets → abréviations |
| Repli LLM texte | `server/src/services/slipCommandLlm.ts` + `llm.routes.ts` | blocs `unreadable` (D3), même garde-fou `validateIntent` |
| Quotas | `server/src/services/llmQuota.service.ts` | appels gratuits / Pro du repli LLM ; modèle pour le compteur de scans (D2) |
| Pattern plugin natif | `ios/App/App/StoreKitPlugin.swift`, `WidgetBridgePlugin.swift` | même façon d'ajouter le plugin OCR iOS |

**Conséquence :** le scan est un nouveau **front-end** de la chaîne existante
(image → texte → intentions). La probabilité, le coupon et la corrélation ne sont
pas réécrits.

```
capture ──OCR appareil──► lignes {texte, boîte, confiance}
        ──slipScan.ts──► blocs (1 bloc = 1 jambe) + cotes
        ──résolveurs slipCommand──► SlipIntent[] ──validateIntent──►
        ──écran de vérification──► buildLeg ──► BetContext (coupon, corrélation)
```

---

## 2. Couche OCR — gratuite, sur l'appareil

Interface unique `client/src/app/services/ocr/ocrService.ts` :
`recognize(image: Blob) → { lines: { text, box: {x,y,w,h}, confidence }[], width, height }`

### 2.1 iOS — Apple Vision (prioritaire : c'est là que vivent les captures)

- Nouveau `ios/App/App/VisionOcrPlugin.swift` (`CAPBridgedPlugin`, enregistré dans
  `MainViewController` comme les deux autres).
- `VNRecognizeTextRequest`, `recognitionLevel = .accurate`, langues `en-US`, `fr-CA`,
  `usesLanguageCorrection = false` (sinon « -110 » ou « o5.5 » se font « corriger »).
- Renvoie les boîtes normalisées → le JS fait la segmentation (partagée avec le web).
- Qualité excellente sur capture d'écran, ~200-500 ms, aucun coût, hors ligne.
- Build : CI macOS cloud comme d'habitude (`docs/ios/CI_SETUP.md`), test par TestFlight.

### 2.2 Web — Tesseract.js (repli)

- **Chargé à la demande** (`import()` dynamique au premier scan) : ne pèse rien sur
  le LCP ni sur le bundle principal.
- Données de langue `eng` **auto-hébergées** dans `client/public/ocr/` (pas de CDN :
  CSP + disponibilité), worker dans un Web Worker.
- **Prétraitement indispensable** (canvas) : agrandir ×2, niveaux de gris, **inverser
  si fond sombre** (les apps de paris sont en thème sombre et Tesseract lit mal le
  texte clair sur fond foncé), binarisation légère.
- Plus lent (2-5 s) et un peu moins précis que Vision : acceptable pour le web.

### 2.3 Import de l'image

- `<input type="file" accept="image/*">` : fonctionne dans la WKWebView, ouvre le
  sélecteur de photos iOS (PHPicker) **sans permission photothèque** → pas de
  nouvelle clé `Info.plist`, pas de changement des privacy labels.
- Coller une image (web, `paste`) en bonus.
- V2 : **extension de partage iOS** (partager la capture depuis l'app du bookmaker
  directement vers ICEEDGE) — § 8.

---

## 3. `slipScan.ts` — du texte OCR aux intentions

Nouveau module **partagé** `server/src/services/slipScan.ts`, mêmes règles que
`slipCommand.ts` : aucune dépendance Node, aucun appel réseau, importé tel quel par le
client, **testé côté serveur**.

### 3.1 Nettoyage
- Jeter le bruit d'interface et **les données personnelles** : mise, gain potentiel,
  solde, n° de pari, heure, boutons (« Cash Out », « Bet Placed », « Share »…).
  Ces lignes ne sont jamais conservées ni envoyées.
- Normaliser, **en anglais ET en français** (D5) : `o5.5`/`O 5.5`/`Over 5.5`/`Plus de 5.5`,
  `u`/`Under`/`Moins de`, `+1.5`/`-1.5`, `½`, `5,5` → `5.5`, **`N+` → plus de N−0.5**
  (« 1+ points », « 2+ Shots on Goal »), accents retirés (`normalizeName`), tirets
  et signes moins Unicode, espaces insécables.

### 3.2 Cotes
- Américaines (`-110`, `+145`), décimales (`1.91`), fractionnaires (`10/11`).
- Format détecté une fois par ticket (cohérence), puis proba implicite.
- Distinguer cote de jambe et **cote totale** du parlay (souvent en bas, près de
  la mise).

### 3.3 Segmentation en jambes
Sur les boîtes (position verticale), pas sur le texte brut :
- **Ancres** : ligne « équipe @/vs équipe » (le match) et cote alignée à droite.
- Un bloc = les lignes entre deux ancres, regroupées par proximité verticale.
- Gabarits légers **par bookmaker** (détectés par mots-clés : « bet365 »,
  « SGP », « Same Game Parlay », libellés propres) quand la règle générique ne
  suffit pas.

### 3.4 Vocabulaire bookmaker → marchés ICEEDGE
Table `BOOK_MARKET_ALIASES`, **anglais et français dès la v1** (D5) — un ticket
dans une langue comme dans l'autre doit donner les mêmes jambes. La langue du ticket
est détectée une fois (mots-clés), mais la table reste fusionnée : un ticket bet365
en français garde des libellés anglais (« Share », « Cash Out »).

| Libellés anglais | Libellés français (✓ = vu sur une vraie capture) | `marketType` |
|---|---|---|
| Moneyline, Money Line, To Win, Match Winner (incl. OT) | Ligne d'argent, Vainqueur du match, Gagnant (incl. prol.) | `moneyline` |
| 60 Min Line, 3-Way, Regulation Time Result | Résultat 60 min, Temps réglementaire, 3 issues | `regulation_result` |
| Puck Line, Spread | Ligne de puck, Écart, Handicap | `puck_line` |
| Total, Total Goals, Game Total, Over/Under X Goals | Total de buts, **Plus de X buts ✓**, Moins de X buts | `total_goals` |
| Team Total, {Team} Total Goals | Total de l'équipe, Buts {équipe} | `team_total_goals` |
| Both Teams to Score | Les deux équipes marquent | `both_teams_score` |
| Will Game Go to OT | Prolongation, Le match ira-t-il en prolongation | `game_to_ot` |
| Anytime Goalscorer, To Score, Anytime Goal | Buteur à tout moment, Marquer un but | `anytime_goal` |
| First Goalscorer | Premier buteur | `first_goal_scorer` |
| Shots on Goal, Player Shots, N+ Shots | Tirs au but, Tirs cadrés | `shots_ou` |
| Points, Player Points, N+ Points | **Points, N+ points ✓** | `points_ou` |
| Assists | Passes, Aides | `assists_ou` |
| Saves, Goalie Saves | Arrêts, Arrêts du gardien | `goalie_saves_ou` |

Les libellés français sans ✓ sont des suppositions : chacun doit être confirmé par
une capture avant de servir (sinon il reste hors de la table). Piège déjà vu : le
sous-titre bet365 « Total de points » sous « Plus de 5.5 buts » — c'est la ligne
principale qui décide du marché, pas le sous-titre.

Ce sont les 13 marchés de `SLIP_COMMAND_MARKETS`. Le reste (périodes, PIM, hits…)
→ « non couvert » en v1 (§ 3.6).

### 3.5 Résolution
- **Ne pas fabriquer une phrase pour la repasser à `parseSlipCommand`** : fragile
  (sauf pour le repli LLM, § 3.7, qui reçoit le texte brut nettoyé du bloc).
  Exporter de `slipCommand.ts` ses résolveurs d'équipe / de joueur / de match
  (aujourd'hui internes) et construire les `SlipIntent` directement.
- Le match lu sur le ticket contraint la résolution du joueur (roster des deux
  équipes seulement) → presque plus d'homonymes.
- Chaque intention passe par `validateIntent`.

### 3.6 États d'une jambe scannée
| État | Affichage |
|---|---|
| `ok` | jambe chiffrée |
| `ambiguous` | choix cliquables (même UI que « quel Hughes ? » / fautes) |
| `unsupported_market` | « Marché non couvert par ICEEDGE » + texte lu |
| `no_game` | match introuvable / déjà commencé |
| `unreadable` | bloc non compris par l'analyseur local → repli LLM (§ 3.7) ; si le LLM échoue aussi : texte brut affiché, correction manuelle |
| `unsupported_line` (D4) | ligne absente de `MARKET_LINES` : **« Ligne non couverte »** en v1, pas d'élargissement |

### 3.7 Repli LLM texte (D3 : gardé)
- Uniquement pour les blocs `unreadable`, **après** l'analyseur local, jamais à sa place.
- Envoyé : le **texte nettoyé d'un bloc** (sans mise, solde, n° de pari), jamais l'image,
  jamais le ticket entier. Un appel par ticket regroupant tous les blocs illisibles
  (borne : `SLIP_COMMAND_MAX_PARTS`), pour ne consommer qu'une unité de quota.
- Passe par `slipCommandLlm` et ses quotas existants (appels gratuits du jour /
  Pro, disjoncteur séparé). Quota épuisé → le bloc reste `unreadable`, correction
  manuelle, aucune erreur bloquante.
- La sortie du LLM passe par `validateIntent` comme toute intention. Une jambe venue
  du LLM est marquée discrètement (« lue par l'IA, vérifie-la ») à l'étape de vérification.
- Désactivable par variable d'env (même mécanique que `features.aiBetBuilder`).

---

## 4. Écran — `ScanSlipSheet.tsx`

Entrée : bouton **« Scanner un ticket »** à côté du Bet builder IA (BetBuilderPage),
plus un raccourci dans le coupon vide.

1. **Importer** la capture → spinner « Lecture du ticket… » (100 % local).
2. **Vérifier** : une carte par jambe reconnue, avec son état (§ 3.6), la cote lue
   (modifiable), et un lien « corriger » qui rouvre `MarketSelectorSheet`
   pré-rempli. Étape obligatoire : elle rattrape les erreurs d'OCR.
3. **Analyse** par jambe : proba modèle · proba implicite · **edge**, badge
   **« maillon faible »** sur la jambe à l'edge le plus bas.
4. **Coupon** : probabilité combinée (via `BetContext`, corrélation même-match
   incluse, `SlipNotices` pour impossible / doublon / indépendance), comparée à la
   cote totale du ticket → **EV du ticket**.
   - Jambes non couvertes : « probabilité partielle — 3 jambes sur 4 », jamais un
     chiffre présenté comme complet.
5. **Actions** : « Charger dans mon coupon » (suivi, règlement, XP comme
   d'habitude) · partager la carte d'analyse (PNG existant, 4.3).

Tailwind inline, `max-w-[430px]`, textes dans `i18n/index.tsx` (fr/en).
Formulation : analyse uniquement, aucune incitation à miser (review Apple,
`docs/ios/APP_STORE_COMPLIANCE.md`).

---

## 5. Cotes et edge

- `edge = p_modèle − p_implicite` (proba implicite brute de la cote du ticket,
  marge incluse : c'est le prix que le joueur paie réellement).
- Cohérent avec la décision existante : **les cotes ne sont jamais une entrée du
  modèle**, seulement un étalon.
- Pour un SGP, la cote du bookmaker intègre sa propre corrélation : on compare
  à notre probabilité **raffinée** (`/predict/parlay`), pas au produit des jambes.

---

## 6. Vie privée et conformité

- OCR et analyse du texte **sur l'appareil**. Aucune image stockée ou envoyée.
  Les lignes « mise / solde / n° de pari » sont jetées dès le nettoyage.
- Exception : le texte nettoyé des blocs illisibles part vers le repli LLM (§ 3.7),
  sur le même chemin que le Bet builder IA (déjà couvert par les privacy labels et
  la politique de confidentialité — à revérifier à S2, sans rien stocker du texte).
- Pas d'accès photothèque (PHPicker) → `PrivacyInfo.xcprivacy` et privacy labels
  inchangés.
- Télémétrie éventuelle : **compteurs seulement** (jambes ok / ambiguës / non
  couvertes, bookmaker détecté), jamais de texte.

---

## 7. Tests et mesure d'efficacité

- **Jeu de fixtures** : 40-60 vraies captures (bet365 et DraftKings, ~moitié chacun ;
  **anglais et français, ~moitié chacun** (D5) ; thème sombre et clair ; simples,
  parlays, SGP, props). Les cibles ci-dessous se mesurent par langue.
- Pour chacune : sortie OCR sauvegardée en JSON (`server/src/services/__fixtures__/slipScan/`)
  + vérité attendue (jambes, cotes). Le parseur se teste **sans OCR**, comme
  `slipCommand.test.ts`.
- Script de mesure : % de jambes correctement reconnues de bout en bout, % de
  cotes exactes, **% de jambes fausses présentées comme `ok`** (doit rester ≈ 0 :
  mieux vaut « ambigu » qu'une mauvaise jambe).
- Cibles v1 : ≥ 90 % des jambes couvertes reconnues sur iOS (Vision), ≥ 80 % sur
  web (Tesseract), 0 jambe fausse silencieuse sur le jeu de test. Mesurer
  **séparément** l'analyseur local seul et local + repli LLM, pour savoir ce que
  coûte le repli et le réduire en améliorant les gabarits.
- Comparer Vision vs Tesseract sur les mêmes captures (étape 1).

---

## 8. Étapes (une livraison chacune)

| # | Étape | Contenu | Estimation |
|---|---|---|---|
| S0 | Fixtures | collecter les captures, figer les vérités attendues | 1 j (user + moi) |
| S1 | OCR | `ocrService` + Tesseract web (prétraitement) + `VisionOcrPlugin.swift` ; banc de comparaison | 1-2 j |
| S2 | Parseur | `slipScan.ts` : nettoyage, cotes, segmentation, vocabulaire ; export des résolveurs de `slipCommand.ts` ; tests sur fixtures | 2-3 j |
| S3 | Écran + quota | `ScanSlipSheet` : import, vérification, analyse, chargement dans le coupon, i18n ; compteur de scans (D2) et repli LLM (§ 3.7) | 2-3 j |
| S4 | Edge / EV | proba implicite, maillon faible, EV du ticket, probabilité partielle | 0,5-1 j |
| S5 | Mesure & polish | script de précision, cas ratés → gabarits par bookmaker | 1 j |
| S6 (V2) | Extension de partage iOS | partager la capture depuis l'app du bookmaker vers ICEEDGE | 1-2 j |
| S7 (V2) | FanDuel, Mise-o-jeu / FR | nouveaux gabarits + fixtures | 1 j / bookmaker |
| S8 (V2) | Lignes hors menu | vérifier le pricing des demi-lignes quelconques (props joueur surtout), puis élargir pour le scan | 1 j |
| S9 (V2) | Plus de marchés | périodes, PIM (avec l'effet arbitre prévu), hits, blocs… | selon besoin |

---

## 9. Décisions (tranchées par le user le 2026-10-14)

- **D1 — Bookmakers v1 : bet365 + DraftKings.** Gabarits, vocabulaire et fixtures
  pour ces deux-là seulement. Un autre bookmaker passe par les règles génériques
  (ancres + vocabulaire), sans garantie ; FanDuel / Mise-o-jeu en V2 (S7).
- **D5 — Langues v1 : anglais ET français** (user, 2026-10-14). Vocabulaire,
  normalisation et fixtures dans les deux langues dès S2 (plus de « anglais d'abord »).
  OCR : Vision est réglé `en-US` + `fr-FR` ; Tesseract garde `eng` seul — il lit le
  français sans les accents (« PERSONNALISE »), sans conséquence puisque le parseur
  les retire (`normalizeName`), et `fra` doublerait le téléchargement. À revoir si
  le banc montre des mots français mal lus.
- **D7 — Pas d'API de lecture des paris** (2026-10-14). bet365 et DraftKings n'ont
  pas d'API publique pour lire les paris d'un joueur. Les agrégateurs (SharpSports,
  etc.) existent mais demandent de **connecter le compte du bookmaker** dans ICEEDGE
  (accès aux paris, souvent au solde), sont payants et sur contrat, et ramènent dans
  l'app iOS ce que l'APPLE_PLAN § 4 en a retiré (lien avec les bookmakers). Les liens
  de partage obligeraient à aller lire les pages du bookmaker (CGU, et l'image ne
  resterait plus sur le téléphone). On garde la capture + OCR local ; l'API
  d'agrégateur reste une piste V2 pour le **web**, si un partenariat se présente.
- **D6 — Banc Vision : écran « Labo OCR » dans un build TestFlight** (user, 2026-10-14).
  `/dev/ocr`, admin uniquement, lien dans les Réglages. Sur iOS il n'existe que si le
  workflow « iOS → TestFlight » est lancé avec la case `ocr_lab` (VITE_OCR_LAB=true) ;
  ce build-là ne part pas en review (écran caché, Guideline 2.3.1).
- **D2 — Accès : 3 scans gratuits, puis illimité en Pro.**
  - Le décompte doit être **côté serveur** (l'OCR est local, le client n'est pas
    une source de vérité) : petit compteur sur le modèle de `llmQuota.service.ts`
    (nouvelle migration), consommé au moment où l'analyse démarre, **pas** à
    l'import (une capture illisible ou annulée ne doit pas coûter un scan).
  - Scan réservé aux utilisateurs connectés (sinon le compteur est contournable).
  - Paywall Pro existant (`requirePro` / IAP iOS / Stripe web) quand les 3 sont
    utilisés.
  - ⚠️ À confirmer au début de S3 : **3 au total** ou **3 par jour** ? Le plan
    suppose 3 par jour (même logique que les appels gratuits du Bet builder IA) ;
    le compteur doit pouvoir faire l'un ou l'autre par une constante.
- **D3 — Repli LLM texte : gardé** (§ 3.7). Pas d'image, texte nettoyé des blocs
  illisibles seulement, dans les quotas existants.
- **D4 — Lignes hors menu : « Ligne non couverte » pour l'instant.**
  `validateIntent` reste limité à `MARKET_LINES` ; l'élargissement est reporté
  (S8, V2).
