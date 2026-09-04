# Plan de saisie manuelle

Tout ce qui n'est pas automatique dans ICEEDGE, où le saisir, et à quelle
fréquence. Le reste (stats équipes/joueurs/gardiens, cotes, calendrier, voyage,
altitude) se rafraîchit seul.

---

## 1. Récapitulatif

> **Changement du 2026-09-04 — tout est en base, plus dans des fichiers.**
> Les quatre tables manuelles vivaient dans des `.json` que le build ne copiait
> jamais dans l'image du serveur : elles étaient **mortes en production**, en
> silence, et l'écriture admin répondait 500. Voir la migration
> `server/src/db/migrations/034_manual_data.sql`. Concrètement, pour toi :
> la saisie se fait maintenant depuis l'app (Profil → Paramètres → **Saisie
> manuelle**), donc **depuis ton téléphone**, et elle survit aux
> redéploiements.

| # | Quoi | Où | Fréquence | Temps |
|---|---|---|---|---|
| 1 | Gardiens partants (exceptions) | UI : Profil → Saisie manuelle → **Compos du soir** | chaque jour de match, 1-2 h avant | 2 min |
| 2 | Absents confirmés | UI : Profil → Saisie manuelle → **Compos du soir** | chaque jour de match, 1-2 h avant | 2 min |
| 3 | Blessures / alignement (facteur) | UI : Profil → Saisie manuelle → **Blessures** | chaque jour de match, 2 passes | 5-10 min |
| 4 | Tendance PP des arbitres | API `PUT /api/manual/referees` | 1× en début de saison + 1 rafraîchissement mi-saison | 30 min |
| 5 | Assignation d'arbitres (secours) | API `PUT /api/manual/ref-assignments/:cle` | seulement si le scraper Scouting the Refs casse | 1 min/jour |
| 6 | Patinoires | `ml\data\arenas.json` + `server\src\data\arenas.ts` | 1× par saison, ou déménagement/rénovation | 10 min |
| 7 | Rafraîchissement des données contenu | `content\refresh-insights.cmd` | tous les 3 jours (tâche planifiée) + `WITH_ADVANCED` 1×/saison | automatique |

**Si tu n'as que 5 minutes :** lignes 1 et 2. Le gardien partant est l'information
qui déplace le plus les probabilités.

---

## 2. Chaque jour de match

### Le matin (9 h-11 h) — première passe

- Ouvre la liste des matchs du jour dans la carte admin (Profil → « Blessures /
  Alignement », compte admin requis).
- Pour chaque match où tu comptes parier : saisis les blessés **déjà connus**
  (IR/LTIR). Sources : rapport de blessures NHL.com, DailyFaceoff (Line
  Combinations), TSN/Sportsnet.
- **Ne devine pas les gardiens.** Laisse vide.

Barème d'impact (0-1, désavantage infligé à SON équipe) :

| Situation | Impact |
|---|---|
| Gardien partant absent / backup qui débute | **0.12** |
| Joueur clé absent (top-6 att., top-4 D, ~20 min) | **0.06** |
| Role player absent (3e-4e trio, 3e paire) | **0.03** |
| Trios remaniés, retour intégré, gardien confirmé favorable | `lineupAdj` ±0.02 à 0.05 |

### Après les morning skates (12 h-15 h) — mise à jour ciblée

- DailyFaceoff publie les gardiens probables. Si un **backup** débute, ajoute le
  titulaire absent à 0.12 côté de son équipe.
- Game-time decisions annoncés → ajoute/retire les joueurs concernés.

### 1-2 h avant la mise au jeu — passe finale (la plus importante)

C'est ici que se remplit l'onglet **Compos du soir**, une fois les compos
confirmées. Il liste toutes les équipes qui jouent ce jour-là, groupées par
match, avec deux champs par équipe. La date est en **heure de l'Est** et la
saisie est relue automatiquement dans les 30 s (aucun redémarrage).

- **Gardien partant** — uniquement les **exceptions** (backup qui part, n°1
  blessé). Laisse vide sinon : le modèle retombe alors sur sa moyenne de
  gardiens pondérée par l'usage récent, ce qui est le bon défaut.
- **Absents** — séparés par des virgules : `Auston Matthews, Kaiden Guhle`.

Vider un champ et réenregistrer **retire** la saisie : c'est ainsi qu'on corrige
un gardien annoncé qui ne part finalement pas.

> **Le nom doit être l'orthographe MoneyPuck** — le service Python matche par
> nom exact (insensible à la casse) contre son pool de joueurs clés (top-6
> attaquants + top-4 défenseurs). Un nom mal orthographié est ignoré en silence.

> Depuis un poste plutôt que le téléphone, la même chose en une commande :
> ```bash
> curl -X PUT https://api.arakice.com/api/manual/lineups/2026-01-15 \
>   -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
>   -d '{"goalies":{"TOR":"Joseph Woll"},"scratches":{"MTL":["Kaiden Guhle"]}}'
> ```

- Confirme les gardiens partants (annonces officielles / warmup). **Ne parie pas
  avant de l'avoir confirmé.**
- Trios remaniés ou retour majeur → `lineupAdj` avec une note courte
  (ex. « McDavid revient, 1er trio reformé »).

### Après le match

Rien. Les entrées datées deviennent inertes, et le job de nettoyage quotidien
purge celles de plus de 15 jours (`MANUAL_DATED_RETENTION_DAYS`) — il n'y a plus
de fichier à ranger à la main. Supprime une entrée de blessures seulement si elle
était fausse.

### Règles de jugement

- **N'entre que ce qui change réellement le match.** Un 4e trio absent des deux
  côtés ≈ neutre : ignore.
- **Cumul :** les impacts s'additionnent — 2 joueurs clés (0.06 + 0.06) pèsent
  déjà comme un gardien.
- **Doute sur l'impact :** prends le préréglage inférieur. Sur-pondérer les
  blessures fait plus de dégâts que les ignorer.
- **`lineupAdj`** sert aux effets d'alignement *hors blessures* (chimie des
  trios, fatigue cachée). Ne double-compte pas un blessé déjà saisi.

---

## 3. Saisonnier et occasionnel

### Arbitres — `PUT /api/manual/referees` (début de saison)

⚠️ **La table est VIDE — le facteur arbitre est donc inerte.** Elle l'était déjà
avant : l'ancien `referees.json` ne contenait que 6 placeholders tous posés à la
moyenne exacte (6.2), donc un multiplicateur de 1.0 et aucun effet. Ils n'ont
volontairement pas été repris en base : une table qui a l'air remplie sans l'être
est pire que vide. Tant que les vrais chiffres n'y sont pas, ce facteur n'apporte
rien.

- Source : scoutingtherefs.com, section *Referee Stats* (moyennes de saison).
- `ppPerGame` = occasions de power-play accordées par match (deux équipes
  cumulées) sous cet arbitre ; `leagueAvgPpPerGame` = la moyenne de la ligue.
- Un arbitre absent de la table retombe sur la moyenne (multiplicateur 1.0,
  aucun effet) — inutile de viser l'exhaustivité, commence par les 20-25
  arbitres les plus utilisés.
- L'appel **remplace la table entière** (transaction) : envoie toujours la liste
  complète. C'est voulu — une table à moitié à jour est pire qu'une table
  ancienne mais cohérente.
- **Fréquence :** une passe en début de saison avec les chiffres de la saison
  précédente, une révision vers Noël avec les chiffres de la saison en cours.

```bash
curl -X PUT https://api.arakice.com/api/manual/referees \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "leagueAvgPpPerGame": 6.2,
    "referees": [
      { "name": "Wes McCauley",     "ppPerGame": 6.9 },
      { "name": "Kelly Sutherland", "ppPerGame": 5.6 }
    ]
  }'
```

### Assignation d'arbitres — `PUT /api/manual/ref-assignments/:cle` (secours)

Normalement **automatique** : `refereeStore.ts` scrape Scouting the Refs via son
API WordPress. La saisie manuelle (clé `VISITEUR@MAISON`) est vide et n'est à
remplir que si le scraper cesse de parser (changement de format du site). En cas
d'échec, tout retombe en neutre — aucune prédiction n'est cassée, le facteur
disparaît simplement.

```bash
curl -X PUT https://api.arakice.com/api/manual/ref-assignments/TOR@BOS \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"refs":["Wes McCauley","Garrett Rank"]}'
```

> Le parser n'a **jamais été validé sur du vrai HTML** (site injoignable depuis
> le sandbox). À vérifier une fois lors d'une vraie journée de match.

### Patinoires — `ml\data\arenas.json` + `server\src\data\arenas.ts`

Table quasi statique (fuseau, altitude, coordonnées) qui alimente les features de
voyage. À revoir en début de saison ou quand une équipe change d'aréna.
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

---

## 4. Ce qui n'a rien à saisir

Stats d'équipes, de joueurs et de gardiens · calendrier · cotes (The Odds API,
clé posée une fois dans l'env) · voyage / fuseaux / altitude / road-trips ·
back-to-backs · repos · PP%/PK% (défauts gérés en début de saison, quand l'API
renvoie 0) · règlement des paris.

En séries : les équipes cachent les blessures. Fie-toi aux absences constatées au
warmup et saisis tard.

---

## 5. État des deux points bloquants

**a) Les quatre tables manuelles étaient mortes en production — RÉGLÉ le 2026-09-04.**

Le diagnostic du 2026-08-11 était juste, et pire que prévu : `server\Dockerfile`
ne copie que `dist/`, `tsc` n'émet pas les `.json` de `src/data/`, et le dossier
`ml/` n'est pas dans l'image. Vérifié dans le `dist/` réel : il ne contenait que
les `.js`. Conséquence, silencieuse dans les quatre cas :

| Fichier | Comportement en prod |
|---|---|
| `referees.json` | absent → tous les arbitres neutres, facteur mort |
| `injuries.json` | lecture → `{}` ; `PUT /api/injuries` écrivait dans un `dist/data/` inexistant → **500**, et de toute façon effacé à chaque redéploiement |
| `starting_goalies.json` / `scratches.json` | chemin `cwd/../ml/data` inexistant → zéro absent, zéro gardien |

**Option retenue : les quatre tables en base** (migration
`034_manual_data.sql`). C'est la seule qui règle les trois problèmes à la fois —
présence dans l'image, persistance au redéploiement, partage entre instances.
Copier les JSON dans l'image n'aurait réglé que la lecture : le système de
fichiers d'un conteneur est éphémère, donc toute saisie faite depuis la carte
admin aurait disparu au déploiement suivant.

Ce qui change pour toi :

- La saisie se fait dans l'app (Profil → Paramètres → **Saisie manuelle**), donc
  **depuis le téléphone**, ce qui rend enfin faisable la passe de 1-2 h avant la
  mise au jeu — les matchs sont le soir en Amérique.
- Les anciens `.json` ont été supprimés du dépôt : il n'y a plus deux sources de
  vérité possibles.
- Les entrées datées se purgent toutes seules après 15 jours.
- Les variables `SCRATCHES_PATH` et `STARTING_GOALIES_PATH` n'existent plus.

⚠️ **La migration doit être appliquée en production** (`npm run db:migrate:all`
avec le `DATABASE_URL` de prod) avant le déploiement du serveur, sinon toutes les
lectures échouent et retombent en neutre — avec, cette fois, un `warn` dans les
logs.

**b) Un gardien absent se saisit toujours à deux endroits.** — NON RÉGLÉ.

L'onglet **Blessures** (impact 0.12, facteur glass-box) et l'onglet **Compos du
soir** (feature ML) alimentent tous deux la prédiction finale. Le passage en base
n'a rien changé à ce point : c'est une question de modèle, pas de stockage. À
mesurer sur un cas réel avant de s'y fier — un gardien saisi des deux côtés peut
compter double.
