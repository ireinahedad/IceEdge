# ICEEDGE — aide-mémoire des commandes

Toutes les commandes se lancent depuis `server\`.

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

::  --- publier depuis le téléphone ---

npm run content:log -- --posts=1,4            :: 5. journaliser ce qui est SORTI
```

Cinq à dix minutes une fois la main prise. L'étape 2 est la seule qui demande de
la lecture ; le reste s'enchaîne.

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
```

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
14-18 s — sans bloquer.

**Muet par défaut**, le son se choisit dans TikTok ou Instagram au moment de
l'envoi : l'algorithme favorise les sons natifs. `--music` incruste une piste
(boucle + fondus) quand la vidéo doit partir sonorisée telle quelle.

### `npm run content:log` — fermer la boucle

```bat
npm run content:log -- --list                 :: voir les posts du jour
npm run content:log -- --posts=1,4            :: journaliser les publiés
npm run content:log -- --posts=suzuki         :: par fragment de nom
```

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
| `ERROR: The parameter is incorrect` | `:` dans un nom de tâche planifiée | renommer sans `\ / : * ? " < > \|` |
