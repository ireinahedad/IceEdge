# ICEEDGE — aide-mémoire des commandes

Toutes les commandes se lancent depuis `server\`.

Deux points d'entrée indépendants, qui partagent les étapes de rendu et de
montage : **les angles du jour** (`content:mine`, avec une passe de rédaction) et
**le récap d'après-match** (`content:recap`, sans rédaction). Les deux écrivent un
`posts.json` que `content:render` puis `content:video` traitent de la même façon.

---

## La journée type

```bat
cd C:\Users\irein\dev\ICEEDGE\server

npm run content:mine                          :: 1. choisir les angles
                                              ::    → ouvre content\output\<date>\review.html

::  --- coller prompts\daily-generation.md dans une session, avec candidates.json ---
::  --- déposer le posts.json obtenu dans content\output\<date>\ ---

npm run content:check -- --fix                :: 2. vérifier et recaler les durées
npm run content:render                        :: 3. produire les images
npm run content:video                         :: 4. assembler les mp4
                                              ::    → ouvre content\output\<date>\index.html

::  --- publier depuis le téléphone, légendes copiées depuis index.html ---

npm run content:log -- --posts=1,4            :: 5. journaliser ce qui est SORTI
```

Cinq à dix minutes une fois la main prise. L'étape 2 est la seule qui demande de
la lecture ; le reste s'enchaîne.

---

## Le récap d'après-match

Une soirée de hockey finie, deux vidéos. Rien à coller nulle part : le récap
ne passe pas par un modèle de langage — le score est le score.

```bat
cd C:\Users\irein\dev\ICEEDGE\server

npm run content:recap                         :: 1. lire les matchs finis
npm run content:render -- --date=<date>-recap :: 2. produire les images
npm run content:video  -- --date=<date>-recap :: 3. assembler les mp4
                                              ::    → ouvre index.html du lot
```

La date exacte s'affiche à la fin de `content:recap` : les deux commandes
suivantes sont écrites en clair, à recopier.

**Deux vidéos par soirée**, au format court :

| Vidéo | Contenu | Durée |
|---|---|---|
| `night-long` | ouverture (jour, date, affiches), puis une carte par match : logos, fiche V-D-DP, score, tirs, marqueurs G/A/P | ≤ 3 s par match |
| `<match>-short` | ouverture (jour, date, affiche), la carte du match, les trois étoiles | ~10-12 s |

`night-short` et `<match>-long` ne sont plus produits.

**La carte d'ouverture** n'a pas de bandeau en haut (la date y serait deux
fois) ni de « @ » entre les équipes.

**La carte de match** (gabarit `matchcard_card`) montre toujours UN seul match,
avec une mise en page fixe : les deux carrés de score sont toujours à la même
hauteur, au même endroit, et les lignes de marqueurs s'ajoutent vers le bas.
Sous chaque logo, la fiche de la saison APRÈS le match (victoires-défaites-
défaites en prolongation ou fusillade), recomptée depuis le calendrier du
club, toujours en trois chiffres (zéros compris). Tous les joueurs à un point ou plus sont listés ; au-delà de 11 lignes, le
match continue sur une seconde carte (`1/2`, `2/2`). Durée : 1 s + 0,35 s par
ligne, 3 s au maximum. Les trois étoiles n'apparaissent que dans `<match>-short`.

**Transition** : les récaps enchaînent leurs cartes par un glissement de 0,3 s
(`smoothleft`), sans allonger la vidéo. Les posts du jour gardent leurs coupes
franches. `content:video -- --transition=fade` change l'effet,
`--transition=none` revient aux coupes franches.

Le match retenu est **celui de la nuit**, choisi par barème : prolongation,
fusillade, un but d'écart, remontée de deux buts, blanchissage, match à sept
buts et plus. Comme pour `content:mine`, la règle est ennuyeuse et c'est le
but — la même soirée donne toujours le même choix.

```bat
npm run content:recap                         :: la nuit qui vient de finir
npm run content:recap -- --date=2026-11-04    :: forcer la soirée
npm run content:recap -- --game=MTL           :: cadrer sur un match précis
npm run content:recap -- --game=all           :: un short PAR match
npm run content:recap -- --no-night           :: le match seul, sans la soirée
npm run content:recap -- --require-all        :: refuser de sortir si un match traîne
```

Sans `--date`, le script prend **la soirée qui vient de se terminer** : il
recule de 30 heures, ce qui tombe dans la bonne journée de calendrier LNH quelle
que soit l'heure à laquelle on lance la commande depuis l'Asie.

**Les matchs non terminés sont écartés avec un avertissement.** `--require-all`
transforme cet avertissement en refus — utile pour une tâche planifiée qui ne
doit pas publier un tableau des scores incomplet.

Trois choses à savoir :

- **`content:check` ne s'applique pas** aux récaps, et c'est voulu : ce garde-fou
  vise un rédacteur, et il n'y en a pas ici. Le seul de ses contrôles qui garde
  un sens — le vocabulaire interdit — est rejoué par `content:recap` lui-même,
  sur la même liste (`server\scripts\lib\compliance.ts`).
- **`content:log` refuse les récaps.** `history.json` ne sert qu'à empêcher
  `content:mine` de reproposer un sujet ; un récap traite toutes les équipes qui
  ont joué, le journaliser écarterait de la sélection quotidienne les équipes les
  plus actives, sans que rien ne le signale.
- **Les logos d'équipe** se téléchargent tout seuls dans
  `content\assets\logos\` au premier récap qui en a besoin. `content:render`,
  lui, continue de tourner sans réseau. Un logo manquant ne bloque rien : la
  carte tombe sur l'abréviation seule.

---

## Les données, tous les 3 jours

```bat
content\refresh-insights.cmd                  :: les deux jeux de données
content\refresh-insights.cmd WITH_ADVANCED    :: + historique long, 1× par saison
```

L'app doit tourner pour la partie CSV : `cd server && npm run dev` dans une autre
fenêtre. Sinon cette passe échoue seule et le reste se fait quand même.

Le `.cmd` enchaîne les scripts Python (`ml\python\content_insights*.py`) puis la
passe CSV. Cette dernière s'appelle aussi directement :

```bat
npm run content:insights
npm run content:insights -- --only=team,matchup   :: rapide, sans les alignements
```

Tâche planifiée, à installer une fois :

```bat
schtasks /create /tn "ICEEDGE content insights" /tr "C:\Users\irein\dev\ICEEDGE\content\refresh-insights.cmd" /sc daily /mo 3 /st 08:00
```

> Le nom ne doit contenir aucun de ces caractères : `\ / : * ? " < > |`

---

## Détail par commande

### `npm run content:mine` — choisir les angles

```bat
npm run content:mine
npm run content:mine -- --date=2026-11-04     :: forcer la date
npm run content:mine -- --phase=mid           :: forcer la phase de saison
npm run content:mine -- --top=20              :: plus de candidats
```

Produit `candidates.json`, `rejected.json`, `review.html` et un CSV par
graphique. **Ouvre `review.html`** : chaque candidat y montre ses chiffres, son
score décomposé en quatre barres, et le `why` qui explique sa présence. Si un
candidat te semble faux, tu vois immédiatement quelle composante l'a fait monter.

S'arrête si une source dépasse 3 jours — relance alors `refresh-insights.cmd`.

### `npm run content:recap` — la soirée qui vient de finir

```bat
npm run content:recap
npm run content:recap -- --date=2026-11-04    :: forcer la soirée
npm run content:recap -- --game=MTL           :: cadrer sur un match précis
npm run content:recap -- --game=all           :: un short PAR match
npm run content:recap -- --no-night           :: le match seul, sans la soirée
npm run content:recap -- --require-all        :: refuser de sortir si un match traîne
```

Produit `posts.json`, `candidates.json` et le dossier `content\output\<date>-recap\`.
**Pas de review.html et rien à relire** : il n'y a aucun angle à valider, seulement
des matchs joués. La suite se fait avec `--date=<date>-recap`, jamais sans.

Lit les matchs **terminés** directement à l'API de la LNH — l'app n'a pas besoin
de tourner, contrairement à `content:insights`. Les matchs encore en cours sont
écartés avec un avertissement.

Le dossier est **séparé** de celui du jour : un récap ne peut donc pas écraser le
`posts.json` du pipeline quotidien, même les soirs où les deux tournent.

Voir la section « Le récap d'après-match » plus haut pour le contenu des deux
vidéos et le choix du match.

### `npm run content:check` — le garde-fou

```bat
npm run content:check
npm run content:check -- --fix                :: recalcule les durées
npm run content:check -- --date=2026-11-04
```

À lancer **après chaque modification manuelle** de `posts.json`. Reformuler une
phrase est prévu et souhaitable, mais la durée d'un plan se déduit du nombre de
mots et pilote le montage : `--fix` la recale.

Vérifie aussi que chaque chiffre cité existe dans les données, qu'aucun mot de la
liste gambling n'a survécu, que les identifiants de hooks et de CTA existent, et
qu'aucun hook n'a servi depuis moins de 10 jours.

### `npm run content:render` — les images

```bat
npm run content:render
npm run content:render -- --preview           :: sans Playwright, pour le design
npm run content:render -- --only=suzuki       :: un seul post
npm run content:render -- --date=<date>-recap :: le lot de récaps de la soirée
```

Les cartes de récap (ouverture, carte de match, étoiles)
passent par le même rendu, avec les logos déposés par `content:recap`. `--preview`
les affiche aussi : c'est le moyen le plus rapide de vérifier qu'une soirée
chargée ne fait pas déborder un plan.

`--preview` produit `slides-preview.html` : tous les plans côte à côte en vrai
rendu réduit. Aucun navigateur à installer — sert à régler
`content\templates\_shared.css` sans attendre.

Le rendu réel demande, une seule fois :

```bat
npm i -D playwright
npx playwright install chromium
```

### `npm run content:video` — assembler

```bat
npm run content:video
npm run content:video -- --only=suzuki
npm run content:video -- --date=2026-11-04
npm run content:video -- --date=<date>-recap  :: le lot de récaps de la soirée
npm run content:video -- --music=..\content\assets\music\bed-01.mp3
npm run content:video -- --keep-segments      :: garder un mp4 par plan
```

Demande ffmpeg. Une seule fois, depuis `server\` :

```bat
npm i -D ffmpeg-static ffprobe-static
```

Le script cherche le binaire dans l'ordre : `--ffmpeg=...`, la variable
`FFMPEG_PATH`, les paquets ci-dessus, le PATH. Une installation système marche
donc aussi bien, mais elle suppose winget ou Chocolatey.

Lit `slides\manifest.json` et écrit `video.mp4` à côté : H.264, 1080×1920,
30 fps, coupes franches. Un avertissement signale une vidéo hors de la cible
12-15 s — sans bloquer. Les récaps portent leur propre cible dans `posts.json`
(un récap de nuit dure environ 2 à 4 s par match) : l'avertissement se règle sur elle, sinon il
se déclencherait sur chacun d'eux et cesserait d'être lu.

**Écrit aussi `index.html`, la page du jour.** Une carte par post : la vidéo se
lit sur place, la légende TikTok, la légende Instagram, les hashtags et la
commande de journal se copient d'un bouton. En bas, cocher les posts publiés
compose le `content:log` correspondant ; ce qui est déjà journalisé s'affiche
estompé. La page se construit depuis `posts.json`, donc `--only=` ne l'ampute
pas : les posts non montés y gardent leur place, vide.

**Muet par défaut**, le son se choisit dans TikTok ou Instagram au moment de
l'envoi : l'algorithme favorise les sons natifs. `--music` incruste une piste
(boucle + fondus) quand la vidéo doit partir sonorisée telle quelle.

### `npm run content:log` — fermer la boucle

```bat
npm run content:log -- --list                 :: voir les posts du jour
npm run content:log -- --posts=1,4            :: journaliser les publiés
npm run content:log -- --posts=suzuki         :: par fragment de nom
```

Les numéros sont ceux de `index.html` : cocher les posts sortis y compose la
commande, il n'y a rien à recompter.

**Refuse les lots `-recap`.** `history.json` ne sert qu'à l'anti-répétition de
`content:mine` ; un récap traite toutes les équipes qui ont joué, l'y inscrire
écarterait de la sélection quotidienne, pendant deux semaines, les équipes les
plus actives.

**Ne journalise que ce qui est réellement publié.** Le pipeline produit huit
scripts pour une ou deux vidéos ; journaliser les six autres écarterait des
angles que personne n'a vus.

C'est ce qui alimente l'anti-répétition : sans cette étape, 20 % du score de
sélection ne sert à rien et le compte se répétera au bout de trois semaines.

Pense à remplir `views` dans `content\data\history.json` vers J+7. Après 30 à 40
posts, le barème se recalibre sur des chiffres réels.

---

## Fichiers à connaître

| Fichier | Rôle |
|---|---|
| `content\config\rules.json` | Tous les seuils, poids et quotas. Le vrai tableau de bord. |
| `content\STYLE-GUIDE.md` | Palette, ton, budgets de mots, règles de conformité. |
| `content\library\hooks.md` | 112 hooks. Enrichir ici fait évoluer la voix. |
| `content\library\ctas.md` | 36 CTA, pour les légendes. |
| `content\library\hashtags.md` | Une forme primaire par équipe, par type de contenu. |
| `content\templates\_shared.css` | Le design des cartes. |
| `content\assets\logos\` | Logos d'équipe, déposés par `content:recap`. |
| `server\scripts\lib\compliance.ts` | Le vocabulaire interdit, partagé par `check` et `recap`. |
| `content\prompts\daily-generation.md` | Le prompt de rédaction, à coller. |
| `content\data\history.json` | Ce qui a été publié. Ne pas éditer à la main sauf `views`. |

---

## Quand ça coince

| Message | Cause | Remède |
|---|---|---|
| `Sources inutilisables` | données de plus de 3 jours | `content\refresh-insights.cmd` |
| `L'app ne répond pas` | passe CSV sans serveur | `cd server && npm run dev` |
| `Playwright absent` | rendu sans navigateur | `npm i -D playwright` puis `npx playwright install chromium` |
| `candidat introuvable` | `posts.json` d'une autre exécution | relancer `content:mine`, refaire l'étape de rédaction |
| `mot interdit "..."` | vocabulaire de pari | reformuler ; voir `STYLE-GUIDE.md` §5 |
| `hook déjà publié le ...` | moins de 10 jours | choisir un autre hook dans `hooks.md` |
| `ffmpeg introuvable` | montage sans ffmpeg | `npm i -D ffmpeg-static ffprobe-static` depuis `server\` |
| `aucun manifeste dans ...` | montage avant rendu | `npm run content:render` (sans `--preview`) |
| `aucun match TERMINÉ le ...` | récap lancé trop tôt, ou mauvaise date | attendre la fin des matchs, ou `--date=` |
| `aucune sortie pour <date>` au rendu | oubli du suffixe | `--date=<date>-recap` |
| `ERROR: The parameter is incorrect` | `:` dans un nom de tâche planifiée | renommer sans `\ / : * ? " < > \|` |
