# Plan de saisie manuelle — Blessures & Alignement

Quoi remplir, quand, et avec quelles sources. Interface : **Profil → carte « Blessures / Alignement »** (compte admin requis). Une entrée = un match du jour ; l'effet est immédiat sur les prédictions (le fichier `injuries.json` est relu à chaque calcul).

---

## Ce qui se remplit à la main (et rien d'autre)

| Donnée | Champ | Impact suggéré |
|---|---|---|
| Gardien partant absent / backup qui débute | Joueur (side domicile ou visiteur) | **0.12** |
| Joueur clé absent (top-6 attaquant, top-4 D, ~20 min/match) | Joueur | **0.06** |
| Role player absent (3e-4e trio, 3e paire) | Joueur | **0.03** |
| Trios remaniés, retour de blessure intégré, gardien confirmé favorable | `lineupAdj` + note | ±0.02 à 0.05 |

Tout le reste (stats équipes, joueurs, gardiens, cotes) est automatique. La cote du marché exige juste `ODDS_API_KEY` dans `server/.env` (une fois).

---

## Routine un jour de match

**Le matin (9h-11h) — première passe, 5 min**
1. Ouvre la liste des matchs du jour dans la carte admin.
2. Pour chaque match où tu comptes parier : entre les blessés déjà connus (IR/LTIR). Sources : NHL.com injury report, DailyFaceoff.com (page Line Combinations), TSN/Sportsnet.
3. Ne devine pas les gardiens partants à ce stade — laisse vide.

**Après les morning skates (12h-15h) — mise à jour ciblée, 5 min**
4. DailyFaceoff publie les gardiens probables : si un **backup** débute, ajoute le titulaire absent à 0.12 côté de son équipe.
5. Game-time decisions annoncés → ajoute/retire les joueurs concernés.

**1-2 h avant la mise au jeu — passe finale (la plus importante)**
6. Confirme les gardiens partants (annonces officielles / warmup). C'est l'info qui bouge le plus les probabilités — ne parie pas avant de l'avoir confirmée.
7. Trios remaniés ou retour majeur annoncé → règle `lineupAdj` avec une note courte (ex. « McDavid revient, 1er trio reformé »).

**Après le match**
8. Rien à faire : l'entrée est liée au match du jour et devient inerte. Supprime-la seulement si elle était erronée.

---

## Règles de jugement

- **N'entre que ce qui change réellement le match.** Un 4e trio absent des deux côtés ≈ neutre : ignore.
- **Cumul** : plusieurs absents s'additionnent — 2 joueurs clés (0.06 + 0.06) pèsent déjà comme un gardien.
- **Doute sur l'impact** : prends le préréglage inférieur. Le modèle est calibré ; sur-pondérer les blessures fait plus de dégâts que les ignorer.
- **Pas le temps ?** Fais seulement la passe gardiens (étapes 4 et 6). C'est 80 % de la valeur de la saisie manuelle.
- **`lineupAdj`** sert aux effets d'alignement *hors blessures* (chimie des trios, fatigue cachée). Ne double-compte pas un blessé déjà saisi.

---

## Hors saison de jeu / début de saison

- Début de saison : les PP%/PK% de l'API peuvent être à 0 pendant quelques matchs — c'est géré par des défauts, rien à saisir.
- Séries éliminatoires : les équipes cachent les blessures ; fie-toi aux absences constatées au warmup, saisis tard.
