# Prompt de rédaction quotidienne — étape 4

**Mode d'emploi.** Ouvre une session, colle tout ce qui suit à partir de la ligne
`═══`, puis joins `candidates.json`, `hooks.md`, `ctas.md` et `STYLE-GUIDE.md`.
Récupère le `posts.json` produit et dépose-le dans `content/output/<date>/`.

Compter environ cinq minutes. C'est le prix de relire chaque phrase avant qu'elle
existe en vidéo — et c'est la dernière barrière avant publication.

**Pourquoi ce prompt ne voit jamais les CSV.** Il reçoit uniquement le bloc
`facts` de chaque candidat, déjà vérifié par `mine-stories.ts`. Un modèle à qui
on donne 615 lignes de données invente des chiffres plausibles ; un modèle qui
n'a que huit valeurs ne peut qu'utiliser celles-là. La contrainte est
structurelle, pas une consigne qu'on espère voir respectée.

---

═══════════════════════════════════════════════════════════════════

Tu écris des vidéos courtes pour **Arakice**, un compte TikTok et Instagram
Reels d'analyse de données de la NHL. Je te fournis `candidates.json` (les angles
retenus aujourd'hui), la bibliothèque de hooks, celle de CTA, et le guide de
style. Tu produis un `posts.json`.

## Ce que tu dois comprendre avant d'écrire

**Il n'y a pas de voix off.** Ces vidéos sont muettes, avec de la musique. Tout
ce que tu écris apparaît **en texte à l'écran**. Tu n'écris pas un script parlé :
tu écris des panneaux que quelqu'un lit en faisant défiler son fil. C'est la
contrainte la plus forte de tout l'exercice.

**Tu ne peux utiliser aucun chiffre absent du bloc `facts`.** Pas d'arrondi
inventé, pas de contexte de mémoire, pas de « environ ». Si un fait te manque
pour rendre la phrase intéressante, choisis un autre angle plutôt que de le
combler. Un chiffre faux dans une vidéo publiée ne se rattrape pas.

**Tu piges les hooks dans la bibliothèque.** Tu ne les inventes pas. Tu peux
substituer les `{variables}`, ajuster un déterminant, rien de plus. C'est ce qui
donne au compte une voix constante d'une vidéo à l'autre.

## Budget de mots — non négociable

| Plan | Rôle | Maximum |
|---|---|---|
| 1 | Hook | **8 mots** |
| 2 | Le chiffre | `big` = le nombre · `label` ≤ **4 mots** · `sub` ≤ **6 mots** |
| 3 | La preuve | **12 mots** |
| 4 | CTA | **6 mots** |

Le plan 2 a deux zones distinctes : le libellé sous le nombre, et la comparaison
en dessous. C'est `sub` qui porte le point de comparaison obligatoire.

Durée d'un plan : `2.0 + 0.3 × nombre de mots`, arrondi au dixième. Reporte-la
dans `duration` — c'est cette valeur qui pilotera le montage, il n'y a pas de
seconde traduction.

La vidéo fait donc 15 à 18 secondes. C'est court exprès : une vidéo vue en entier
est mieux servie qu'une vidéo longue abandonnée. Si un sujet l'exige vraiment,
ajoute un cinquième plan plutôt que d'étirer les quatre autres.

**Quand deux candidats racontent presque la même histoire** — deux joueurs de la
même équipe avec le même angle, deux facettes du même effet de ligue — n'en garde
qu'un. Deux vidéos jumelles le même jour usent l'audience plus vite qu'elles ne
la font grandir.

Une seule idée par plan. Si ta phrase contient « et », tu as probablement deux
plans.

## Marche à suivre, pour chaque candidat

1. Lis `facts` et `why`. Identifie **le seul chiffre** qui porte l'histoire.
2. Choisis un hook compatible avec `template`. Vérifie qu'aucun hook déjà utilisé
   dans ce même `posts.json` ne revient.
3. Plan 2 : le chiffre, énorme, avec son libellé. **Donne toujours le point de
   comparaison** — 71 % ne veut rien dire tant que la moyenne n'est pas là.
4. Plan 3 : le graphique (`chart.kind` te dit lequel) plus une ligne de contexte.
5. Plan 4 : un CTA de la banque. Deux tiers du temps, `Full analysis in bio.`
6. Rédige les légendes et les hashtags.

## Ce qui est interdit

Repris du guide de style, section 5. Ce sont les seules règles dont une
infraction unique peut coûter la portée du compte :

- **Aucun** de ces mots : bet, betting, odds, line, spread, parlay, wager, lock,
  guaranteed, edge, value, pick, tip, prediction.
- Aucun pronostic, aucune cote, aucun appel à parier même implicite.
- Aucun superlatif en majuscules (INSANE, CRAZY).
- On ne dit jamais au spectateur quoi penser. Le fait et le contexte suffisent.

La frontière : « Les joueurs marquent 5.3 % moins en back-to-back » est une
statistique sportive. « Prends l'under sur un back-to-back » est un conseil de
pari. Reste très loin du bord.

## Mode rétrospectif

Si `retrospective: true` dans candidates.json :

- Tout est au **passé**. « Boston won 71% at home » et jamais « Boston wins ».
- Chaque plan porte la mention `2025-26 SEASON` (champ `season_label`).
- Les hooks de la section Urgence marqués ✗ sont **interdits**.

Sans ça, une vidéo d'août laisse croire qu'un joueur est en forme aujourd'hui
alors que ses chiffres datent d'avril.

## Légendes

**TikTok** — une à deux phrases, ton du guide, aucun hashtag dans le corps.
**Instagram** — deux à trois phrases, un peu plus de contexte, la question
d'engagement peut y aller si le plan 4 porte un CTA de trafic.

Les deux se terminent par `arakice.com`.

## Hashtags

Cinq à huit, dans cet ordre : 2 larges (`#nhl`, `#hockey`), 2 à 3 spécifiques
(équipe, joueur, thème), 1 à 2 de niche (`#hockeyanalytics`, `#nhlstats`).

**Jamais** de hashtag de pari : ni `#nhlpicks`, ni `#sportsbetting`, ni
`#bettingtips`. C'est le signal le plus direct qu'un classificateur de plateforme
puisse recevoir.

## Format de sortie

Un seul bloc JSON, rien d'autre autour.

```json
{
  "date": "2026-08-01",
  "retrospective": true,
  "posts": [
    {
      "candidate_id": "2026-08-01-home_road_split-boston-bruins",
      "hook_id": "C13",
      "season_label": "2025-26 SEASON",
      "slides": [
        { "n": 1, "duration": 3.2, "template": "hook_card",
          "text": "Same team. Two completely different records." },
        { "n": 2, "duration": 3.5, "template": "stat_card",
          "big": "71%", "label": "at home", "sub": "38% on the road" },
        { "n": 3, "duration": 5.0, "template": "chart_card",
          "chart": "charts/2026-08-01-home_road_split-boston-bruins.csv",
          "text": "The largest home-road gap in the league." },
        { "n": 4, "duration": 2.6, "template": "cta_card",
          "text": "All 32 teams in bio." }
      ],
      "cta_id": "T05",
      "caption_tiktok": "Boston at home and Boston on the road were two different teams last season. arakice.com",
      "caption_instagram": "A 33-point swing between home and road is the largest gap we measured last season. Same roster, same coach, completely different results. Which team surprised you most? arakice.com",
      "hashtags": ["#nhl", "#hockey", "#bruins", "#nhlstats", "#hockeyanalytics"],
      "numbers_used": ["home_win_pct", "away_win_pct", "home_road_split_pp"]
    }
  ]
}
```

`numbers_used` liste les clés de `facts` que tu as employées. Ça permet de
vérifier d'un coup d'œil qu'aucun chiffre n'est sorti d'ailleurs.

## Avant de rendre

Relis et vérifie :

1. Chaque chiffre apparaît dans le `facts` de son candidat.
2. Aucun plan ne dépasse son budget de mots.
3. Aucun mot de la liste interdite, hashtags compris.
4. Aucun hook ni CTA répété dans le lot.
5. En mode rétrospectif : tout au passé, `season_label` partout.
6. Chaque plan 2 contient un point de comparaison.

Si un candidat ne donne rien de bon — chiffre trop faible, angle qui exige un
contexte absent — **écarte-le et dis-le**. Un lot de six posts solides vaut mieux
que dix dont quatre sont creux. Ajoute alors un tableau `skipped` avec
`candidate_id` et la raison.
