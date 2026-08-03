# ICEEDGE / Arakice — guide de style contenu

Référence unique pour tout ce qui est publié. Le prompt de rédaction
(`prompts/daily-generation.md`) s'appuie dessus ; les gabarits HTML de l'étape 5
en tirent leurs couleurs.

---

## 1. Le format, et ce qu'il impose

| Paramètre | Valeur |
|---|---|
| Plateformes | TikTok + Instagram Reels |
| Format | 9:16, 1080 × 1920 |
| Durée | 15 à 25 secondes |
| Langue | Anglais uniquement |
| Voix | **Aucune.** Musique seule. |
| Structure | 4 plans (3 à 6 selon la complexité) |

**La conséquence la plus importante de tout ce document :** sans voix off, tout
passe par le **texte à l'écran**. On n'écrit pas un script parlé, on écrit des
panneaux. Un narrateur peut placer trente mots en dix secondes ; un lecteur qui
fait défiler son fil en place huit, et seulement s'ils sont gros.

### Budget de mots par plan

| Plan | Rôle | Maximum |
|---|---|---|
| 1 | Hook | **8 mots**, une seule ligne si possible |
| 2 | Le chiffre | nombre géant + libellé **4 mots** + comparaison **6 mots** |
| 3 | La preuve | **12 mots** + le graphique |
| 4 | CTA | **6 mots** |

**Le sujet n'entre dans aucun de ces budgets.** Le nom de l'entité —
`NICK SUZUKI · MTL`, `BOSTON BRUINS`, `NHL` — est affiché en haut de chaque plan
(sauf le CTA), dérivé automatiquement du candidat. Ne le réécris donc pas dans un
libellé : « at home » suffit là où « Boston at home » gaspillait un mot sur
quatre. Il est répété sur tous les plans parce qu'un spectateur n'entre pas
forcément par le premier — un plan « 71 % » qui ne nomme personne ne dit rien.

Le plan 2 a deux zones de texte distinctes, d'où deux budgets séparés : le
libellé sous le nombre, et la ligne de comparaison en dessous. Un budget global
de six mots pour les deux rendait impossible la règle « toujours donner le point
de comparaison » — les deux consignes se contredisaient, et c'est l'écriture des
premiers scripts qui l'a révélé.

Règle de durée : **2 secondes minimum par plan, plus 0.3 s par mot.** Elle vaut
pour les plans 2 et 3. Le plan 4 est fixe à 2.5 s — un logo se lit vite.

**Le plan 1 est fixe à 2 secondes**, quel que soit le nombre de mots. La formule
lui donnait jusqu'à 4.4 s, soit le temps de le lire deux fois puis d'attendre.
C'est pourtant le seul plan où le spectateur décide s'il reste : huit mots en
gros caractères se lisent en une seconde, la deuxième est une marge, la troisième
coûte des spectateurs. Un hook s'attrape, il ne se déchiffre pas.

Quatre plans donnent donc 12 à 15 secondes, et c'est volontaire. Le taux
d'achèvement compte plus que la durée sur TikTok : une vidéo de 16 secondes vue
en entier est mieux servie par l'algorithme qu'une de 30 abandonnée aux deux
tiers. Si un sujet réclame vraiment plus, on ajoute un cinquième plan plutôt que
d'allonger les quatre autres.

Jamais deux idées sur un même plan. Si une phrase contient « et », c'est
probablement deux plans.

---

## 2. Palette

Reprise des composants de l'app, pour que les vidéos et le produit se
ressemblent. Ce sont les valeurs réellement utilisées dans `client/src`.

| Rôle | Hex | Usage |
|---|---|---|
| Fond | `#0A0E0C` | Fond de tous les plans |
| Surface | `#131A12` | Cartes, encadrés |
| Accent principal | `#90C9F0` | Chiffres clés, titres, logo |
| Accent secondaire | `#86D1EA` | Dégradés, éléments graphiques |
| Texte principal | `#BFC8CC` | Corps de texte |
| Texte atténué | `#8A9EA6` | Libellés, unités, mentions |
| Positif | `#4ADE80` | Hausses, améliorations |
| Négatif | `#F87171` | Baisses, dégradations |
| Alerte | `#FACC15` | Surprises, valeurs extrêmes |

**Ne jamais utiliser le rouge et le vert pour un jugement moral.** Une baisse de
buts alloués est une amélioration : c'est du vert, même si le nombre descend.
La couleur suit le sens, pas le signe arithmétique.

Fond sombre toujours. Un fond clair sur un fil TikTok éblouit, et nos graphiques
sont conçus en clair sur sombre.

## 3. Typographie

- **Chiffres et hooks** : sans-serif très grasse, 800-900. Inter, Archivo ou
  Barlow Condensed. Un chiffre clé occupe 25 à 35 % de la hauteur de l'écran.
- **Corps** : même famille, 500-600.
- **Libellés et unités** : 500, en `#8A9EA6`, corps nettement plus petit.
- Jamais de texte dans les 12 % supérieurs ni les 18 % inférieurs de l'image :
  l'interface de TikTok et celle d'Instagram les recouvrent.

---

## 4. La voix : curieux et direct

Le compte pose une question que le spectateur ne s'était pas posée, puis y répond
avec un chiffre. Il ne crie pas, ne promet rien, ne se vante pas.

**Trois principes.**

1. **Le chiffre porte l'émotion, pas l'adjectif.** « Boston won 71% at home and
   38% on the road » est plus fort que « Boston's home/road split is INSANE ».
   Si un chiffre a besoin d'un adjectif pour impressionner, il n'était pas
   impressionnant.
2. **On montre aussi ce qui ne marche pas.** Les surprises du modèle sont du
   contenu à part entière. Un compte qui n'exhibe que ses réussites n'est pas
   crédible ; un compte qui admet une limite le devient.
3. **On ne dit jamais au spectateur quoi penser.** On lui donne le fait et le
   contexte. La conclusion lui appartient — c'est aussi ce qui nous protège.

### Vocabulaire

**Utiliser :** looked at, measured, tracked, over X games, the data shows,
across N seasons, compared to, most people miss this, nobody talks about.

**Bannir absolument :**

| Interdit | Pourquoi |
|---|---|
| bet, betting, wager, parlay, odds, line, spread | Déclenche les filtres de contenu de TikTok et d'Instagram |
| lock, guaranteed, sure thing, can't lose | Promesse de gain — interdit, et faux |
| edge, value, +EV | Vocabulaire de pari, et ça révèle le produit payant |
| easy money, free money, cash | Attire une audience non qualifiée et les signalements |
| INSANE, CRAZY, SHOCKING (en majuscules) | Ne correspond pas à la voix, et l'audience s'en méfie |
| must, need to, you have to | On n'ordonne rien |

### Comparaison

| ✗ | ✓ |
|---|---|
| This is a LOCK tonight | Boston has won 71% at home this season |
| Insane value on the under | Goalies face 2.7% fewer shots on long road trips |
| You NEED to see this stat | Almost nobody checks this one |
| Our model is never wrong | Our model gave them 82%. They lost. |

---

## 5. Conformité — la contrainte qui prime sur tout

TikTok et Instagram restreignent la promotion de jeux d'argent. Un compte
signalé perd sa portée sans avertissement et la récupère rarement.

**Ne jamais publier :**

- un pronostic, une sélection, un « pick » du jour
- une cote, une ligne, un total, un handicap
- un pourcentage d'edge ou de valeur
- un historique de gains ou de rendement
- un appel à parier, même implicite

**Ce qui est publiable, et c'est tout le principe du contenu « insight » :** des
faits de performance passée. « Les joueurs marquent 5.3 % moins en back-to-back »
est une statistique sportive. « Prends l'under sur un back-to-back » est un
conseil de pari. La frontière est nette et on reste très loin du bord.

Le CTA envoie vers `arakice.com`, jamais vers un opérateur. Aucun logo de
bookmaker, aucun visuel de mise, aucune capture de coupon.

---

## 6. Structure des vidéos

```
Plan 1 — HOOK          0.0 → 3.0 s   une phrase, fond uni, texte géant
Plan 2 — LE CHIFFRE    3.0 → 7.5 s   un nombre énorme + son libellé
Plan 3 — LA PREUVE     7.5 → 15.0 s  le graphique + une ligne de contexte
Plan 4 — CTA          15.0 → 18.0 s  logo + Full analysis in bio.
```

Variantes admises :

- **Comparaison** — dédoubler le plan 3 (deux entités côte à côte).
- **Liste** — plan 3 en classement de 5 à 10 lignes, sur 8 secondes.
- **Retournement** — insérer un plan entre 2 et 3 qui contredit l'attente.

Les trois premières secondes décident de tout. Le hook doit être lisible **sans
son et sans contexte**, par quelqu'un qui ne connaît ni le compte ni le hockey.

---

## 7. Mode rétrospectif

Hors saison (juillet-septembre), les chiffres décrivent la saison écoulée et non
la forme du moment. **Tout visuel doit alors porter le millésime**, en haut à
gauche, en `#8A9EA6` :

```
2025-26 SEASON
```

Sans cette mention, une vidéo publiée en août sur un joueur « en hausse » laisse
croire qu'il est en forme aujourd'hui. Ses chiffres datent d'avril. C'est le
genre d'imprécision qui coûte la confiance d'un compte d'analyse, et c'est le
seul type d'erreur qu'on ne peut pas rattraper par un commentaire.

---

## 8. Ce qui distingue une bonne vidéo d'une vidéo correcte

Un contenu qui marche répond à **une** question précise que le spectateur ne
s'était pas posée, avec **un** chiffre qu'il ne connaissait pas, en **moins de
30 secondes**, et se termine sans lui dire quoi faire.

Les échecs les plus fréquents, dans l'ordre :

1. Deux idées dans une vidéo. Toujours en faire deux.
2. Un hook qui exige de connaître le contexte pour être compris.
3. Un chiffre exact mais sans point de comparaison — 71 % ne veut rien dire tant
   qu'on n'a pas donné la moyenne.
4. Du texte trop long pour être lu à la vitesse du défilement.
5. Une conclusion imposée là où le fait suffisait.
