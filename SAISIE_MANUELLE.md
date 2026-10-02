# Plan de saisie manuelle

Ce qui reste à faire à la main dans ICEEDGE, où, et à quelle fréquence. Tout le
reste se remplit seul (voir § 5).

---

## 1. Récapitulatif

| # | Quoi | Où | Quand | Temps |
|---|---|---|---|---|
| 1 | Synchro des blessés | `npm run injuries:sync` dans `server/`, sur le poste | chaque jour de match, au rappel de 11 h 55 (heure de l'Est) | 2 min |
| 2 | Trancher ce que la synchro n'écrit pas | **/dev/saisie** → « Qui ne joue pas ce soir ? » | juste après la synchro | 2-5 min |
| 3 | Gardiens partants (exceptions) | **/dev/saisie** → « Qui garde le but ce soir ? » | 1-2 h avant la mise au jeu | 2 min |
| 4 | Absents de dernière minute | **automatique** dès que la NHL publie l'alignement (§ 3) ; **/dev/saisie** pour ce qu'elle ne dit pas | avant la publication, ou pour corriger | 0-2 min |
| 5 | Alignement (`lineupAdj`) | **/dev/saisie** → « Options avancées » | rarement | — |
| 6 | Patinoires | `ml\data\arenas.json` + `server\src\data\arenas.ts` | 1× par saison, ou changement d'aréna | 10 min |
| 7 | Données contenu | `content\refresh-insights.cmd` | automatique (tâche Windows) + `WITH_ADVANCED` 1×/saison | — |

**Si tu n'as que 5 minutes :** lignes 1 et 3. Le gardien partant est
l'information qui déplace le plus les probabilités.

---

## 2. La synchro des blessés

```
cd C:\Users\irein\dev\ICEEDGE\server
npm run injuries:sync              ← simulation : montre ce qui serait écrit
npm run injuries:sync -- --apply   ← écrit
```

Lancée depuis le poste du user, jamais sur Railway. Une tâche planifiée envoie
la commande à 11 h 55 (heure de l'Est) les jours de match.

**Ce qu'elle fait.** Elle lit la 1re page de la liste des blessés de PoolExpert
(≈ 150 notes récentes ; les pages suivantes sont refusées aux robots, 403
mesuré le 2026-09-30, on ne les demande pas). Elle garde la dernière note de
chaque joueur, décide « absent ou non, et jusqu'à quand », retrouve le joueur
dans la LNH, calcule son importance, et le range dans les **blessés longue
durée** (`long_injuries`, `source: 'auto'`, date de fin `until`). Rien de la
note n'est stocké. Le serveur ajoute ensuite ces joueurs tout seul aux absents
du jour (IA) et au facteur Blessures (règles) de chaque match de leur équipe,
jusqu'à leur date de fin.

**Ce qu'elle ne touche jamais :** les entrées saisies à la main.

**Ce qu'elle n'écrit pas, et liste dans son rapport** (à trancher dans
/dev/saisie) :
- les **incertains** (au jour le jour, décision avant le match) ;
- les **notes non reconnues** ;
- les **introuvables** dans la LNH (espoirs, invités au camp) ;
- les joueurs dont **l'équipe diffère** entre la source et la LNH.

**Les règles à connaître :**
- **Un joueur absent de la page n'est pas « revenu »** : son entrée est gardée
  jusqu'à sa date de fin, et n'est remplacée ou retirée que par une nouvelle
  note. Le rapport liste les « gardés » et les « retirés ».
- **« Revenu au jeu » sur une entrée synchro** : le serveur s'en souvient et la
  synchro ne la remet pas pour la même note. Une nouvelle note la remet.
- **Changer l'importance d'une entrée synchro** la rend manuelle : la synchro
  ne l'écrase plus, et c'est à toi de la retirer.

**Importance** (décision du user), sur le barème du § 3 :
- attaquant : points par match, 0.02 + 0.05 × pts/m, borné 0.02-0.08 ;
- défenseur : temps de glace, 0.03 + 0.005 × (min − 16), borné 0.02-0.08 ;
- gardien : part des départs de l'équipe, 0.12 × part / 0.6, borné 0.03-0.12 ;
- saison en cours dès 10 matchs, sinon la précédente ; moins de 10 matchs LNH → 0.03.

**Pièges mesurés le 2026-09-29.** Le HTML brut met les attributs entre
apostrophes (`class='resRow'`). Les effectifs LNH (`v1/roster/…/current`)
n'incluent PAS les blessés, d'où le repli sur la recherche LNH. La liste
remonte à un an, d'où le classement des notes. Code :
`server/src/services/injurySync.ts` (règles dans `classifyNote`, durées par
défaut dans `HORIZONS`) et `server/scripts/sync-injuries.ts`.

---

## 3. Chaque jour de match — /dev/saisie

Page admin, aussi accessible depuis `/dev` et les Paramètres. Une carte par
match, une liste d'absents par équipe. Chaque enregistrement écrit à la fois le
facteur Blessures (règles) et les absents du soir (IA). La saisie est prise en
compte au plus tard 90 s après.

### Juste après la synchro

- La carte **« Blessés longue durée »** montre tout ce qui compte à chaque
  match, marqué « synchro » avec sa date de fin quand il vient de la synchro.
  **« Revenu au jeu »** retire un joueur tout de suite.
- Tranche les listes du rapport (incertains, introuvables, équipe à vérifier) :
  ajoute l'absent au match du soir si tu es sûr, sinon laisse.

### 1-2 h avant la mise au jeu — passe finale (la plus importante)

- **Gardien partant** — uniquement les **exceptions** (backup qui part, n° 1
  blessé). Laisse vide sinon : le modèle retombe sur sa moyenne pondérée par
  l'usage récent, ce qui est le bon défaut. Confirme-le (annonces officielles,
  warmup) avant de parier.
- **Absents de dernière minute** (game-time decisions, scratch au warmup) :
  **automatiques depuis le 2026-10-02** dès que la NHL publie l'alignement du
  soir (`officialLineup.ts`) — ses absents officiels rejoignent la liste, et un
  blessé de longue durée qui figure parmi les habillés n'est plus compté absent
  (il revient de blessure). Mesuré le 2026-10-01 : la NHL publie l'effectif
  ~2 h avant, les absents par morceaux à partir de ~30 min avant, et
  l'alignement définitif (20 habillés) seulement **7 à 9 min avant** la mise
  au jeu — c'est lui qui fait revenir un blessé. Avant ça, ou pour un
  absent qu'elle ne signale pas, ajoute-le ici avec son importance : **ta
  saisie du jour reste prioritaire** (un joueur que tu déclares absent l'est,
  même habillé). Le gardien partant, lui, n'est PAS dans l'alignement NHL.
- **Blessé pour plusieurs matchs ?** Coche « Blessé longue durée » : il restera
  absent à chaque match, sans rien retaper.
- Vider une saisie et réenregistrer la **retire** : c'est ainsi qu'on corrige
  un gardien annoncé qui ne part finalement pas.

Barème d'importance (désavantage infligé à SON équipe) :

| Bouton | Situation | Impact |
|---|---|---|
| Gardien n° 1 | Gardien partant absent / backup qui débute | **0.12** |
| Joueur clé | Top-6 att., top-4 D, ~20 min | **0.06** |
| Joueur de soutien | 3e-4e trio, 3e paire | **0.03** |
| Options avancées | Trios remaniés, retour intégré | `lineupAdj` ±0.02 à 0.05 |

### Après le match

Rien. Les saisies du soir deviennent inertes et se purgent seules après 15 jours
(`MANUAL_DATED_RETENTION_DAYS`) ; les entrées synchro s'arrêtent à leur date de
fin.

### Règles de jugement

- **N'entre que ce qui change réellement le match.** Un 4e trio absent des deux
  côtés ≈ neutre : ignore.
- **Ne ressaisis pas un joueur déjà listé en « Blessés longue durée »** : il
  compte déjà.
- **Cumul :** les impacts s'additionnent — 2 joueurs clés (0.06 + 0.06) pèsent
  déjà comme un gardien.
- **Doute sur l'impact :** prends le préréglage inférieur. Sur-pondérer les
  blessures fait plus de dégâts que les ignorer.
- **`lineupAdj`** sert aux effets d'alignement *hors blessures* (chimie des
  trios, fatigue cachée). Ne double-compte pas un blessé déjà saisi.
- **En séries**, les équipes cachent les blessures : fie-toi aux absences
  constatées au warmup et saisis tard.

---

## 4. Saisonnier et occasionnel

### Patinoires — `ml\data\arenas.json` + `server\src\data\arenas.ts`

Table quasi statique (fuseau, altitude, coordonnées) qui alimente les features
de voyage. À revoir en début de saison ou quand une équipe change d'aréna.
**`arenas.ts` est un miroir typé de `arenas.json` : modifie toujours les deux.**

### Données contenu — `content\refresh-insights.cmd`

Automatisé par tâche Windows (`schtasks`, tous les 3 jours à 8 h). Deux
conditions à surveiller :

- **L'app doit tourner** (`cd server && npm run dev`) pour la passe CSV, qui
  consomme les endpoints `/api/nhl`. Sinon cette passe seule échoue.
- `content\refresh-insights.cmd WITH_ADVANCED` — **1× par saison**, pour
  l'historique long (6 saisons).

`content:mine` s'arrête de lui-même si une source dépasse 3 jours : c'est le
signal que la tâche planifiée n'a pas tourné.

### Arbitres — rien à faire, sauf panne

Les deux se remplissent seuls depuis les billets Scouting the Refs
(`refereeStore.ts`) : les **assignations** du soir, et la **tendance PP** de
chaque arbitre (colonne carrière, `ref_tendency_auto`). Deux secours, par l'API
seulement (plus d'écran) :

- **Le relevé ne trouve plus les assignations** (le site a changé de gabarit) :
  `PUT /api/manual/ref-assignments/VISITEUR@MAISON` avec `{"refs":["…","…"]}`,
  prioritaire sur le relevé. Sans rien, le facteur retombe simplement en neutre.
- **Corriger la tendance d'un arbitre** : `PUT /api/manual/referees`. Une saisie
  manuelle gagne toujours sur le relevé automatique, et l'appel **remplace toute
  la table manuelle** : envoie la liste complète.

---

## 5. Ce qui n'a rien à saisir

Blessés listés par la source (synchro, § 2) · alignement officiel et absents du
soir une fois publiés par la NHL (§ 3) · arbitres (§ 4) · stats d'équipes,
de joueurs et de gardiens · calendrier · cotes (The Odds API, clé posée une fois
dans l'env) · voyage / fuseaux / altitude / road-trips · back-to-backs · repos ·
PP%/PK% (défauts gérés en début de saison, quand l'API renvoie 0) · règlement
des paris.

---

## 6. Point ouvert : un gardien absent peut compter double

Un gardien absent ajouté à la liste d'absents (0.12, facteur Blessures des
règles) et son remplaçant saisi dans « Qui garde le but ce soir ? » (feature
ML) alimentent tous deux la prédiction finale. La synchro ajoute le même cas
tout seul : un n° 1 blessé y entre à 0.12, alors que le modèle ML voit déjà son
remplaçant par l'usage récent. C'est une question de modèle, pas de saisie. À
mesurer sur un cas réel avant de s'y fier.
