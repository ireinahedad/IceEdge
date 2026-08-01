# ICEEDGE — Content Engine

Transforme les données du moteur de prédiction en vidéos courtes publiables,
en quelques minutes par jour.

**Les commandes sont dans `COMMANDS.md`.** Ce document explique l'architecture et
les raisons des choix — à lire quand on veut modifier quelque chose, pas pour
faire tourner le pipeline.

---

## 0. Décisions verrouillées

| Paramètre | Choix |
|---|---|
| Langue | Anglais uniquement |
| Plateformes | TikTok + Instagram Reels |
| Format | 9:16, 1080 × 1920, 14 à 18 secondes |
| Voix | **Aucune** — musique seule |
| Rendu | HTML/CSS → PNG via Playwright |
| Montage | ffmpeg |
| Publication | génération automatique, envoi manuel |
| Images de joueurs | aucune — typographie et logos d'équipe |
| Cadence | 1 à 2 vidéos par jour en saison |

### Pourquoi ni Figma ni Canva

- **Canva Connect API** — l'autofill de brand template exige une organisation
  **Canva Enterprise**. Les plans payants n'ont qu'un accès d'essai limité au
  développement.
- **Figma REST API** — lecture seule pour le contenu. Créer un design passe par
  un *plugin*, qui ne tourne que dans une instance Figma ouverte à l'écran.
  Incompatible avec une tâche planifiée.
- **HTML → PNG** — gratuit, illimité, versionné avec le code. Un gabarit se
  règle en l'ouvrant dans Chrome, et le PNG est identique à ce qu'on y voit.

Figma garde un rôle en amont : dessine une maquette, elle est traduite une fois
en gabarit HTML, puis remplie à l'infini.

### Pourquoi pas de publication automatique

TikTok Direct Post exige un audit d'application, Instagram Reels l'App Review
Meta — deux à quatre semaines chacun, plus l'hébergement public des vidéos et
l'entretien des jetons OAuth. Reporté tant que le volume ne le justifie pas.

---

## 1. Vue d'ensemble

```
        ┌─ tous les 3 jours ───────┐        ┌─ 1×/saison ─┐
        │  refresh-insights.cmd    │        │  advanced   │
        └────────────┬─────────────┘        └──────┬──────┘
                     └────────────┬────────────────┘
                                  ▼
              ml/data/*.json  +  content/data/*.csv       ÉTAPE 1
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │  ÉTAPE 2  mine-stories   │  règles déterministes
                    └────────────┬─────────────┘
                                 ▼
                 candidates.json + charts/*.csv + review.html
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │  ÉTAPE 4  rédaction      │  prompt collé à la main
                    └────────────┬─────────────┘
                                 ▼
                           posts.json  →  check-posts
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │  ÉTAPE 5  render-slides  │  PNG + séquences animées
                    └────────────┬─────────────┘
                                 ▼
                    ┌──────────────────────────┐
                    │  ÉTAPE 6  build-video    │  ffmpeg → mp4
                    └────────────┬─────────────┘
                                 ▼
                        envoi manuel → TikTok / IG
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │  ÉTAPE 7  log-post       │  anti-répétition
                    └──────────────────────────┘
```

Chaque étape est un script indépendant qui lit et écrit des fichiers. **Pas
d'état caché** : quand une étape déraille, on ouvre son fichier de sortie.

---

## 2. ÉTAPE 1 — Les données

Contenu « insight » : pas de pronostic, pas de cote. Uniquement de la
performance mesurée. C'est ce qui passe les filtres gambling des plateformes.

### Deux jeux, deux natures

**`ml/data/content_insights*.json`** — facteurs situationnels sur l'historique
long (2008-2025), produits par les scripts Python. Voyage, repos, altitude,
back-to-back. Contenu intemporel, réutilisable toute l'année.

**`content/data/content_insight_*.csv`** — forme actuelle, produits par
`build-content-insights.ts` qui interroge `/api/nhl` sur l'app en cours
d'exécution. 615 patineurs, 63 gardiens, 32 équipes, 992 confrontations.

### Fenêtre de données

| Fichier | Fenêtre |
|---|---|
| `content_insight_player.csv` | saison en cours + précédente |
| `content_insight_goalie.csv` | saison en cours + précédente |
| `content_insight_team.csv` | saison en cours + précédente |
| `content_insight_matchup.csv` | saison en cours + précédente |
| `content_insight_advanced.csv` | **exception** — jusqu'à 6 saisons |

Une stat de 2019 dans une vidéo de janvier 2026 est fausse au sens éditorial même
si elle est exacte au sens factuel. La contrainte est appliquée dans le code, et
`content_insight_meta.json` la répète en clair.

`advanced` sert aux trajectoires de carrière. **Ne jamais y puiser pour un
contenu « forme actuelle ».**

### Couverture : les alignements complets

Les fichiers joueurs viennent de `/teams/:abbr/player-seasons` — les 32
alignements, tout le monde. Une version antérieure tirait le top 100 par points :
elle ne couvrait que les premiers trios, alors que les profils dont personne ne
parle (4e trio, désavantage numérique, homme de mises au jeu) portent le mieux
une vidéo.

Limite connue : c'est l'alignement du jour. Un joueur parti de la ligue
n'apparaît pas.

### Format : CSV plat, aucun classement pré-calculé

Une ligne par entité. Trier une colonne suffit à produire un top 10, alors qu'un
classement figé ne sert qu'une fois. Un CSV s'ouvre dans Excel, se jette dans
n'importe quel outil de graphique et se lit tel quel dans un prompt.

- **player.csv** — le rythme (points par match) est la colonne qui compte, pas le
  total : un joueur blessé 20 matchs n'est pas « en baisse », il a moins joué.
  `toi_delta` bouge avant les points. `above_min_gp` marque les échantillons
  suffisants — colonne plutôt que filtre, pour garder la ligne disponible.
- **team.csv** — écarts saison/saison + splits domicile / extérieur / 10 derniers
  / matchs à 1 but / série en cours.
- **matchup.csv** — format long, une ligne par paire. Les colonnes `combined_*`
  agrègent deux saisons : une paire se joue 3-4 fois par an, donc sur une seule
  saison l'échantillon est trop mince pour être racontable.
- **advanced.csv** — format long (une ligne par joueur ET par saison), le format
  natif d'une courbe temporelle.

### Rigueur statistique

`ml/python/insights_common.py` est le socle partagé des trois scripts Python.
Quatre garde-fous, appliqués partout de la même façon.

**Abréviations.** MoneyPuck a changé de convention en 2021 : `L.A` (2008-2020) et
`LAK` (2021-2025) sont la même équipe sous deux noms, idem N.J/NJD, S.J/SJS,
T.B/TBL. Sans normalisation, une franchise est coupée en deux et peut apparaître
aux deux extrémités d'un même classement.

**Franchises déménagées.** `nhl_games_v4.csv` fait l'inverse : il réétiquette
rétroactivement Atlanta en WPG et Arizona en UTA. « UTA depuis 2008 » décrit une
équipe qui n'existait pas. On re-scinde par saison ; ATL et ARI portent alors
`is_active: false` et sortent des classements d'équipes actuelles.

**Signification.** Trier par écart absolu sélectionne mécaniquement les plus
petits échantillons — c'est ainsi qu'un gardien retraité avec n=18 finit premier.
Chaque écart est testé contre son propre complément (jamais contre une moyenne
qui l'inclut), puis corrigé par Benjamini-Hochberg à q=0.10.

**Facteurs colinéaires.** `3in4 = 0` et `rest_days ∈ (3,7]` décrivent les mêmes
matchs — avec 3 jours de repos on ne peut pas être en 3-en-4. Un seul sort.

Seuils : `MIN_N_LEAGUE` 300, `MIN_N_TEAM` 150, `MIN_N_GOALIE_POOLED` 500,
`MIN_N_SKATER_POOLED` 5 000, `MIN_EFFECT_PCT` 2.0, `MIN_TEAM_SEASONS` 8,
`FDR_Q` 0.10. Les recalés sont conservés dans `content_insights_rejected.json`
avec leur p-value.

### Deux vides volontaires — ne pas les combler

**Les totaux (over/under) ne donnent aucun signal.** Le meilleur p-value du
groupe est 0.0104, insuffisant face au nombre de comparaisons. La section sort
vide avec une note. L'insight « altitude → +9.5 points de over » reposait sur 138
matchs et a disparu. Piste non explorée : tous les facteurs testés touchent au
déplacement ; gardiens partants, rythme de jeu et arbitres restent à essayer.

**Les splits de gardiens individuels sont indétectables.** Le % d'arrêts varie
trop d'un match à l'autre pour qu'un effet ressorte sur les quelques centaines de
départs d'une carrière. `analyze_goalies` regroupe donc toute la ligue.

Assouplir les seuils pour remplir ces vides recréerait exactement le problème
qu'ils corrigent.

### Analyses groupées

Sur 774 091 matchs-joueurs, **tout devient statistiquement significatif** : au
premier essai, 21 tests sur 21 passaient. Le test cesse alors de discriminer et
c'est `MIN_EFFECT_PCT` qui prend le relais — un écart de 0.3 % est certain et
sans intérêt.

Ce qui ressort, cohérent sur trois métriques indépendantes :

| Situation | Points | Buts attendus | Tirs cadrés |
|---|---|---|---|
| Getaway game | −5.8 % | −4.8 % | −2.4 % |
| Back-to-back | −5.3 % | −4.5 % | −2.2 % |
| Loin de la maison 3 j+ | −4.8 % | −4.1 % | −2.5 % |
| Road trip long | −4.3 % | −4.1 % | −2.7 % |

Que les xG baissent autant que les points écarte l'explication par la malchance
au tir : les occasions elles-mêmes disparaissent.

**Le résultat le plus utile est négatif.** Le temps de glace, testé comme
contrôle, ne bouge pas. Les entraîneurs ne raccourcissent donc pas leur banc : à
minutes égales, les joueurs produisent moins. Sans ce test, toute la section
serait ambiguë — et c'est l'objection qu'un commentaire renverrait aussitôt.
**Toujours le mentionner dans une vidéo sur la fatigue.**

### Règle d'identité : le CSV NHL fait autorité

Les deux jeux ne définissent pas « actif » pareil : le Python retient qui a joué
en 2025-26 (98 gardiens), le CSV qui figure sur un alignement aujourd'hui (63).
Un agent libre non signé ne porte aucun contenu.

`mine-stories.ts` écarte donc tout insight nommant une entité absente des CSV.
Les analyses groupées ne sont pas concernées : elles ne nomment personne.

---

## 3. ÉTAPE 2 — Story mining

`server/scripts/mine-stories.ts`, piloté par `content/config/rules.json`.
Produit `candidates.json`, `rejected.json`, `review.html` et un CSV par
graphique — les étapes 2 et 3 du plan initial sont fusionnées.

### Pourquoi des règles et pas un modèle

Un modèle à qui on donne 615 lignes de CSV hallucine des chiffres, choisit
toujours les mêmes vedettes, et ne donne pas deux fois le même résultat. Les
règles sont ennuyeuses, et c'est la qualité recherchée : le même fichier donne
les mêmes candidats, chaque sélection porte un `why` lisible, et un choix qui
déplaît se corrige en changeant un seuil.

Le modèle intervient à l'étape 4, une fois les faits verrouillés. **Il rédige, il
ne sélectionne pas.**

### Anatomie d'un candidat

```jsonc
{
  "id": "2026-08-01-breakout_pace-nick-suzuki",
  "template": "breakout_pace",
  "entity": { "type": "player", "name": "…", "team": "MTL" },
  "facts": { "ppg": 1.23, "gp": 82, … },   // vérifiés, jamais inventés
  "score": 98,
  "score_breakdown": { "amplitude": 96, "robustesse": 100, … },
  "why": ["ppg > 0.55 (valeur : 1.23)", "…"],
  "chart": { "kind": "line_career", "file": "charts/….csv" }
}
```

Le bloc `facts` est **la seule chose que verra le rédacteur**. Tout champ absent
est un chiffre qu'il inventera ou un angle qu'il abandonnera — d'où l'inclusion
systématique des champs descriptifs (équipes, score, date, libellé).

### Scoring

Somme pondérée sur 100 : amplitude 0.40, robustesse 0.25, nouveauté 0.20,
notoriété 0.15.

- **Amplitude** — de combien la règle est dépassée, normalisé par le `scale` de
  chaque règle.
- **Robustesse** — taille d'échantillon. Un petit échantillon ne disqualifie pas,
  il **plafonne** le score à 65.
- **Nouveauté** — trois fenêtres distinctes : 14 jours pour une personne (en deçà
  l'audience croit revoir la même vidéo), 4 jours pour une équipe (enchaîner
  trois vidéos sur Montréal transforme le compte en page de partisans), 3 jours
  pour un gabarit (le format devient prévisible avant le sujet).
- **Notoriété** — trois paliers d'équipes. Bonus léger et assumé.

`prefer_active` retire 20 points à un joueur retraité sur les records de tous les
temps — une pénalité et non une exclusion, parce qu'un record filtré sur les
actifs n'est plus un record.

### Quotas par famille

Sans quotas, les 10 retenus sont **tous** de la famille `form`. Cause
structurelle : un contenu de ligue n'a pas d'équipe, donc notoriété neutre à 50
contre 100 pour un candidat des Bruins — 7.5 points de handicap, assez pour
exclure du top 10 les angles les plus réutilisables du système.

`output.family_quotas` réserve : 5 `form`, 2 `evergreen`, 1 `matchup`,
1 `retrospective`, 1 `career`. Les quotas non pourvus sont redistribués au
meilleur score restant — **aucune place ne se perd**.

### Phases de saison

`gp_min` vaut 10 en octobre et 40 en avril, et la liste des familles ouvertes
change. Hors saison, le **mode rétrospectif** ouvre `form` mais impose le passé
et le millésime à l'écran ; `streak` reste fermée, parce qu'un bilan se raconte
au passé et une série au présent.

### Historique et déterminisme

L'historique lu pour le scoring est limité aux entrées **strictement antérieures**
au jour traité : sinon le score d'un candidat dépendrait de l'ordre dans lequel
les scripts ont été lancés.

« Déjà publié » est traité séparément, par une **exclusion ferme sans limite de
date**. Une pénalité de score, même lourde, finit par être compensée par une
amplitude qui monte.

### Contraintes de règles à connaître

- **`faceoff_specialist` exige `position == C`.** Le CSV ne fournit pas le nombre
  de mises au jeu prises, seulement le pourcentage : un ailier qui en prend six et
  les gagne toutes affiche 100 %. La position est le seul substitut au volume.
  Correctif de fond à terme : ajouter `faceoffs_taken` en amont.
- **`career_best_season` doit filtrer sur `is_current_season`.** Le drapeau
  `is_career_best_ppg` seul est vrai pour 525 lignes sur 2 748 — chaque joueur a
  forcément une meilleure saison quelque part. Et l'amplitude ne doit pas porter
  sur `ppg_vs_career_best`, qui vaut toujours 0 sur une saison-record.
- **`one_goal_clutch` mesure surtout du hasard.** Bon contenu, mauvaise base de
  pari : le script ne doit jamais le présenter comme une tendance à venir.
- **`career_decline` est désactivée.** Nommer un joueur en déclin attire des
  commentaires hostiles sans rien construire.

### Types de graphiques

`bar_rank`, `bar_compare`, `split_pair`, `line_career`, `scatter`. Chaque
candidat retenu reçoit un CSV de 5 à 12 lignes — pas les 615 de départ. Le CSV
existe aussi pour toi : il s'ouvre dans Figma ou Excel si tu veux soigner un
visuel à la main.

---

## 4. ÉTAPE 4 — Rédaction

Manuelle : `content/prompts/daily-generation.md` collé dans une session avec
`candidates.json`. Cinq minutes, et c'est la dernière barrière avant publication.

### La contrainte qui commande tout

**Pas de voix off ⇒ ce ne sont pas des scripts parlés mais du texte à l'écran.**
Un narrateur place trente mots en dix secondes ; un lecteur qui fait défiler son
fil en place huit, et seulement s'ils sont gros.

| Plan | Rôle | Budget |
|---|---|---|
| 1 | Hook | 8 mots |
| 2 | Le chiffre | `label` ≤ 4 mots, `sub` ≤ 6 mots |
| 3 | La preuve | 12 mots |
| 4 | CTA | logo seul, durée fixe 2.5 s |

Durée d'un plan : `2.0 + 0.3 × mots`. La vidéo fait 14 à 18 secondes — c'est
court exprès, le taux d'achèvement compte plus que la durée.

### Règles de fond

**Aucun chiffre hors du bloc `facts`.** La contrainte est structurelle : le
rédacteur ne voit pas les CSV.

**Aucune affirmation que les données ne prouvent pas.** Plus facile à enfreindre
que la précédente, parce qu'une affirmation se glisse dans une tournure. Deux
formes à surveiller : les superlatifs (*worst*, *best*, *only*), qui supposent un
classement complet, et les tournures causales (*because*, *before X did*), qui
supposent un lien qu'une statistique descriptive n'établit jamais.

**Conformité.** Aucun pronostic, aucune cote, aucun mot de la liste gambling —
y compris dans les hashtags. Une seule occurrence peut faire classer le compte
comme promotion de jeux d'argent, et la portée perdue ne revient pas.

La frontière : « Les joueurs marquent 5.3 % moins en back-to-back » est une
statistique sportive. « Prends l'under sur un back-to-back » est un conseil de
pari.

### Reformuler à la main

Prévu et souhaitable — c'est là que ton oreille bat la bibliothèque. Après
modification, `npm run content:check -- --fix` recale les durées, qui pilotent le
montage.

### `check-posts` — pourquoi il existe

L'étape 4 est la seule qui passe par un modèle, donc la seule où un chiffre peut
naître hors des données, et elle est manuelle. Le script rejoue mécaniquement
chaque contrainte. Une règle qu'on ne vérifie pas mécaniquement n'est pas une
règle, c'est une intention.

---

## 5. ÉTAPE 5 — Rendu

`server/scripts/render-slides.ts` + `content/templates/`.

**`--preview` produit une galerie HTML sans navigateur** : tous les plans côte à
côte en vrai rendu réduit à 19 %. Ce ne sont pas des maquettes — chaque vignette
est le document réel dans une iframe. Les 150 Mo de Chromium ne devraient pas se
mettre entre toi et un ajustement de police.

**Pas de librairie de graphiques.** Les cinq formes sont générées en SVG dans le
script. Les classements sont en barres **horizontales** : en 9:16 les libellés se
lisent sans être inclinés.

**Zones de sécurité** — rien d'important dans les 230 px du haut ni les 345 px du
bas : TikTok y pose sa description et ses boutons, Instagram sa barre de
progression. Variables `--safe-top` et `--safe-bottom`.

**Logo** : `content/assets/logo-360.png`, 73 Ko. Ne pas y substituer
`arakice-icon-512.png`, qui est la version **opaque** — son fond clair ferait un
carré sur une carte sombre.

### Animation

Trois gabarits sur cinq sont animés : `stat_card`, `chart_card`, `compare_card`.
Le hook et le CTA restent fixes — une phrase et un logo n'ont rien à gagner à
bouger. Le mouvement est réservé aux plans où un chiffre ou une forme *porte* le
sens.

**Pilotée par une progression, pas par le temps.** `_anim.js` expose
`setProgress(t)`, t ∈ [0, 1], et le rendu l'appelle image par image. Capturer une
animation qui tourne en temps réel obligerait à espérer que la capture tombe au
bon moment : deux exécutions donneraient deux vidéos différentes. Ici l'état est
une fonction pure de `t`.

État par défaut `t = 1` : l'aperçu et le rendu statique montrent l'image finale
sans rien appeler.

Ce qui bouge : le chiffre grandit de 0.82 à 1 et se compte (sauf quand ce n'est
pas une grandeur — « 7-0 » est un score) ; les barres poussent depuis leur bord ;
la courbe se trace ; libellé et comparaison arrivent **après** le chiffre, parce
qu'on lit la valeur puis ce qu'elle mesure.

Seule la phase animée est capturée : 1.4 s à 30 im/s, soit 42 images par plan au
lieu de ~115. Le reste est un arrêt sur la dernière image, que ffmpeg produit
sans coût. Chaque post reçoit un `slides/manifest.json` qui dit quoi figer et
combien de temps.

---

## 6. ÉTAPE 6 — Montage

`server/scripts/build-video.ts`, appelant ffmpeg.

Entrée : `slides/manifest.json` + les PNG et séquences. Sortie : `video.mp4`,
H.264, 9:16, 30 fps, 14 à 18 secondes — sous les 90 secondes que l'API Instagram
impose aux Reels, utile si la publication automatique arrive un jour.

Coupes franches entre les plans plutôt que fondus : le rythme sec convient au
format et se cale sur la musique.

### Un segment par plan, puis concaténation sans réencodage

Un filtergraph unique couvrant cinq entrées hétérogènes — images fixes et
séquences mêlées — est illisible et casse au premier plan ajouté. Chaque plan
s'encode donc seul dans `slides/_segments/`, et l'assemblage final ne fait que
recopier des flux déjà conformes. Une vidéo qui déraille se diagnostique en
ouvrant son segment : `--keep-segments` les conserve.

Le corollaire : les réglages d'encodage doivent être **identiques d'un segment à
l'autre**, sinon la concaténation en `-c copy` refuse les flux. Ils vivent dans
la constante `VIDEO_ARGS`, à un seul endroit.

L'arrêt sur la dernière image d'un plan animé est produit par `tpad`, pas par un
second segment. L'étape 5 ne capture que la phase animée ; le gel qui suit ne
coûte aucune image supplémentaire.

**CRF 18, plus haut que nécessaire à l'œil.** Les plateformes réencodent à la
réception et les artefacts s'empilent — ce sont les arêtes de la typographie qui
partent en premier. Deux mégaoctets de plus à l'envoi ne coûtent rien.

### D'où vient ffmpeg

Une installation système suppose winget ou Chocolatey — absents d'un Windows par
défaut — puis une modification du PATH et un terminal rouvert. `ffmpeg-static` et
`ffprobe-static` posent un binaire dans `node_modules` et se réinstallent avec le
projet : même contrat que Playwright à l'étape 5.

ffprobe est facultatif. Il ne sert qu'à mesurer la durée réelle du fichier
produit pour la comparer à la durée attendue ; sans lui le montage est identique,
seul le contrôle disparaît.

### Muet par défaut

TikTok et Instagram favorisent les sons natifs choisis dans l'application au
moment de l'envoi. Une piste incrustée coûte de la portée et ne se change plus.
`--music=chemin.mp3` reste disponible — boucle sur la durée, fondus aux deux
bouts — pour les cas où la vidéo doit partir sonorisée telle quelle. La décision
se prend à l'envoi, pas dans le code.

---

## 7. ÉTAPE 7 — Paquet et journal

À construire : un `index.html` par jour rassemblant les vidéos, leurs légendes
sélectionnables et un bouton de copie, pour valider en une minute au lieu
d'ouvrir six fichiers.

`log-post.ts` existe déjà. Il ne journalise **que ce qui est publié** : le
pipeline produit huit scripts pour une ou deux vidéos, et journaliser les six
autres écarterait des angles que personne n'a vus.

Remplir `views` vers J+7. Après 30 à 40 posts, le barème se recalibre sur des
chiffres réels plutôt que sur des intuitions.

**À trancher :** comment les fichiers arrivent sur le téléphone. Un dossier
Dropbox ou Drive synchronisé sur `content/output/` est le moins pénible.

---

## 8. Points ouverts

- **Étape 7** — page de revue quotidienne.
- **Transfert vers le téléphone.**
- **`#utahmammoth` à vérifier** sur le compte officiel de la franchise. Un
  hashtag d'équipe périmé signale un compte qui ne suit pas la ligue.
- **Règles des plateformes sur le contenu lié aux paris** — à relire avant le
  premier envoi. Le contenu « insight » est conçu pour rester du bon côté, mais
  autant connaître la ligne.
- **`faceoffs_taken`** à ajouter dans `build-content-insights.ts` pour remplacer
  le filtre par position.
- **Facteurs non testés sur les totaux** — gardiens partants, rythme de jeu,
  arbitres.

### Écartés volontairement

`library/captions.md` — le prompt produit des légendes correctes en ligne, une
bibliothèque n'apporterait rien tant qu'on n'a pas vu ce qui marche.
Réinjection des candidats `skipped` — un jumeau qui revient dans deux semaines
n'est pas un problème.

---

## 9. Notes techniques

- `content/output/` est dans `.gitignore`. `content/data/history.json` et
  `content/config/rules.json` sont versionnés.
- Aucun code de production n'est modifié : tous les scripts sont des clients des
  endpoints publics `/api/nhl`.
- Playwright est une `devDependency` ; le binaire Chromium s'installe à part.
- ffmpeg est résolu dans l'ordre : `--ffmpeg=`, `FFMPEG_PATH`, les paquets
  `ffmpeg-static` / `ffprobe-static`, le PATH. Aucun n'est déclaré dans
  `package.json` : le PATH reste valable, et personne ne doit télécharger 80 Mo
  pour un `npm install` sur la partie serveur.
- Le mount du bac à sable tronque certaines opérations de fichiers — construire
  et tester sur la machine de l'utilisatrice.
