# Plan de saisie manuelle

Tout ce qui n'est pas automatique dans ICEEDGE, où le saisir, et à quelle
fréquence. Le reste (stats équipes/joueurs/gardiens, cotes, calendrier, voyage,
altitude) se rafraîchit seul.

---

## 1. Récapitulatif

| # | Quoi | Où | Fréquence | Temps |
|---|---|---|---|---|
| 1 | Gardiens partants (exceptions) | `ml\data\starting_goalies.json` | chaque jour de match, 1-2 h avant | 2 min |
| 2 | Absents confirmés | `ml\data\scratches.json` | chaque jour de match, 1-2 h avant | 2 min |
| 3 | Blessures / alignement (facteur) | UI : Profil → carte admin | chaque jour de match, 2 passes | 5-10 min |
| 4 | Tendance PP des arbitres | `server\src\data\referees.json` | 1× en début de saison + 1 rafraîchissement mi-saison | 30 min |
| 5 | Assignation d'arbitres (secours) | `server\src\data\ref_assignments.json` | seulement si le scraper Scouting the Refs casse | 1 min/jour |
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

C'est ici que se remplissent les **deux fichiers JSON**, une fois les compos
confirmées. Les deux sont datés en **heure de l'Est** et relus automatiquement
dans les 30 s (aucun redémarrage).

**`ml\data\starting_goalies.json`** — uniquement les **exceptions** (backup qui
part, n°1 blessé). Sans entrée, le modèle retombe sur sa moyenne de gardiens
pondérée par l'usage récent, ce qui est le bon défaut quand le n°1 part.

```json
{
  "2026-01-15": { "TOR": "Joseph Woll", "MTL": "Cayden Primeau" }
}
```

**`ml\data\scratches.json`** — les absents du soir.

```json
{
  "2026-01-15": { "TOR": ["Auston Matthews"], "MTL": ["Kaiden Guhle"] }
}
```

> **Le nom doit être l'orthographe MoneyPuck** — le service Python matche par
> nom exact (insensible à la casse) contre son pool de joueurs clés (top-6
> attaquants + top-4 défenseurs). Un nom mal orthographié est ignoré en silence.

- Confirme les gardiens partants (annonces officielles / warmup). **Ne parie pas
  avant de l'avoir confirmé.**
- Trios remaniés ou retour majeur → `lineupAdj` avec une note courte
  (ex. « McDavid revient, 1er trio reformé »).

### Après le match

Rien. Les entrées sont datées et deviennent inertes. Les vieilles dates dans les
JSON ne gênent pas ; purge-les de temps en temps pour la lisibilité. Supprime une
entrée `injuries.json` seulement si elle était fausse.

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

### Arbitres — `server\src\data\referees.json` (début de saison)

⚠️ **Le fichier ne contient aujourd'hui que 6 placeholders, tous à la moyenne
(6.2) — le facteur arbitre est donc inerte.** Tant qu'il n'est pas rempli, il
n'apporte rien.

- Source : scoutingtherefs.com, section *Referee Stats* (moyennes de saison).
- Remplis `pp_per_game` = occasions de power-play accordées par match (deux
  équipes cumulées) sous cet arbitre, et ajuste `league_avg_pp_per_game`.
- Un arbitre absent de la table retombe sur la moyenne (multiplicateur 1.0,
  aucun effet) — inutile de viser l'exhaustivité, commence par les 20-25
  arbitres les plus utilisés.
- **Fréquence :** une passe en début de saison avec les chiffres de la saison
  précédente, une révision vers Noël avec les chiffres de la saison en cours.

### Assignation d'arbitres — `server\src\data\ref_assignments.json` (secours)

Normalement **automatique** : `refereeStore.ts` scrape Scouting the Refs via son
API WordPress. Le fichier manuel (clé `AWAY@HOME`) n'existe pas et n'est à créer
que si le scraper cesse de parser (changement de format du site). En cas
d'échec, tout retombe en neutre — aucune prédiction n'est cassée, le facteur
disparaît simplement.

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

## 5. ⚠️ Deux points à régler avant que tout ceci serve en production

Vérifié dans le code le 2026-08-11 — à confirmer de ton côté avant le lancement.

**a) Les quatre fichiers manuels n'existent pas dans le conteneur.**
`server\Dockerfile` ne copie que `dist/`, et `tsc` n'émet pas les `.json` de
`src/data/`. Le dossier `ml/` n'est pas dans l'image non plus. Conséquence en
prod :

| Fichier | Comportement en prod |
|---|---|
| `referees.json` | absent → tous les arbitres neutres, facteur mort (silencieux) |
| `injuries.json` | lecture → `{}` ; l'écriture admin (`PUT /api/injuries`) écrit dans `dist/data/`, qui n'existe pas → erreur, et de toute façon effacé à chaque redéploiement |
| `starting_goalies.json` / `scratches.json` | chemin `cwd/../ml/data` inexistant → zéro absent, zéro gardien |

Trois options, à trancher : copier les JSON dans l'image et monter un volume
persistant pour ceux qui s'écrivent · déplacer ces quatre tables en base
(cohérent avec le fait que `injuries.json` a déjà une UI d'écriture) · ou assumer
que la saisie manuelle est locale et que la prod tourne sans.

**b) Un gardien absent se saisit à deux endroits.**
`injuries.json` (impact 0.12, facteur glass-box) et `starting_goalies.json`
(feature ML). Les deux alimentent la prédiction finale. Il faut vérifier sur un
cas réel que l'effet ne se compte pas deux fois — je ne l'ai pas mesuré.
