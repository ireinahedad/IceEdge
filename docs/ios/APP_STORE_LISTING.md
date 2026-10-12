# App Store Connect — fiche produit (APPLE_PLAN 8.4, 8.6, 8.7)

**Créé :** 2026-10-11 · Concerne le **build iOS v1** (pas d'achat Pro, pas de liens bookmakers,
voir `APP_STORE_COMPLIANCE.md`). Longueurs vérifiées par script, pas estimées.

Règles suivies (APPLE_PLAN 2.4 / 8.4) :
- Vocabulaire **analyse / prédiction**, jamais « parier », « cote », « sportsbook », « bet ».
- **Pas de « NHL » ni de noms d'équipes** dans le nom, le sous-titre ou les mots-clés (5.2.1 :
  marques sans licence). Dans la description, seulement dans la mention « non affilié ».
- **Pas de Pro dans la fiche** : en v1, rien ne s'achète sur iOS, et une fiche ne peut pas
  renvoyer vers l'abonnement web (3.1.1 / 3.1.3). On ne décrit que ce qu'un compte gratuit voit.
- Mots-clés : ne pas répéter un mot déjà dans le nom ou le sous-titre (Apple les indexe déjà),
  virgules sans espaces, singulier suffit.
- Sur la boutique **Canada**, Apple indexe ensemble les mots-clés en-CA et fr-CA : les deux
  listes ci-dessous ne se recoupent pas, pour couvrir 2 × 100 caractères de termes distincts.

---

## Champs communs

| Champ | Valeur |
|---|---|
| Catégorie principale | Sports |
| Catégorie secondaire | Reference (ou laisser vide) |
| Classification | 18+ (voir `APP_STORE_COMPLIANCE.md` §4) |
| Support URL | https://arakice.com/support |
| Marketing URL | https://arakice.com |
| Privacy Policy URL | https://arakice.com/privacy |
| Copyright | 2026 Ireina Hedad |

---

## English (U.S.) — langue principale

**Name** (30 max)
```
ArakIce: Hockey Predictions
```

**Subtitle** (30 max)
```
AI stats & game probabilities
```

**Promotional Text** (170 max — modifiable sans nouvelle version)
```
The new season is here. See the model's win probability for every game tonight, build your picks, and find out who reads the ice best in your league.
```

**Keywords** (100 max)
```
analytics,forecast,pick,model,goalie,goals,standings,playoffs,puck,leaderboard,data,score,trend
```

**Description** (4000 max)
```
ArakIce turns pro hockey stats into clear, honest probabilities. Every game on tonight's slate gets a prediction from two engines working side by side: a statistical rules model and a machine-learning model trained on years of past games.

PREDICTIONS FOR EVERY GAME
• Win probability for each team, updated with the latest form, injuries and goaltending
• Goal totals, scoring and period outcomes, all priced by the same model
• Player projections: goals, points and shots
• Plain-language explanations of the factors behind each number

BUILD AND TRACK YOUR PICKS
• Combine several selections and see their combined probability instantly
• Follow your picks live and get a notification when they settle
• Keep a record of your results over the season and see where your reads are strongest

STATS THAT MATTER
• Team and player stats, standings and today's schedule
• Charts that show trends at a glance instead of walls of numbers

PLAY WITH YOUR FRIENDS
• Join leagues, compare records on the leaderboard and talk hockey in real-time chat rooms
• Report messages and block users at any time

MADE FOR IPHONE
• Home-screen widget with your picks in progress
• Share any pick as a clean image card
• Dark interface built for game night

IMPORTANT
ArakIce is an analytics and entertainment app. It does not accept wagers, hold money or connect to any gambling operator, and no real money is used in the app. Predictions are probabilities, not guarantees. You must be 18 or older to use ArakIce.

ArakIce is an independent app and is not affiliated with or endorsed by the National Hockey League or any team.

Terms of Use: https://arakice.com/terms
Privacy Policy: https://arakice.com/privacy
```

---

## Français (Canada)

**Nom** (30 max)
```
ArakIce : Prédictions hockey
```

**Sous-titre** (30 max)
```
Stats et probabilités par IA
```

**Texte promotionnel** (170 max)
```
La saison est lancée. Découvre la probabilité de victoire de chaque match du soir, crée tes sélections et vois qui lit le mieux le jeu dans ta ligue.
```

**Mots-clés** (100 max)
```
analyse,statistique,pronostic,prévision,gardien,but,classement,séries,rondelle,ligue,modèle,match
```

**Description** (4000 max)
```
ArakIce transforme les statistiques du hockey professionnel en probabilités claires et honnêtes. Chaque match du soir reçoit une prédiction de deux moteurs qui travaillent ensemble : un modèle statistique à base de règles et un modèle d'apprentissage automatique entraîné sur plusieurs saisons de matchs.

DES PRÉDICTIONS POUR CHAQUE MATCH
• Probabilité de victoire de chaque équipe, mise à jour selon la forme, les blessures et les gardiens
• Total de buts, marqueurs et résultats par période, calculés par le même modèle
• Projections des joueurs : buts, points et tirs
• Les facteurs derrière chaque chiffre, expliqués simplement

CRÉE ET SUIS TES SÉLECTIONS
• Combine plusieurs sélections et vois leur probabilité combinée tout de suite
• Suis tes sélections en direct et reçois une notification à leur dénouement
• Garde l'historique de tes résultats de la saison et vois où tes lectures sont les plus justes

LES STATS QUI COMPTENT
• Stats d'équipes et de joueurs, classements et matchs du jour
• Des graphiques qui montrent les tendances d'un coup d'œil

JOUE AVEC TES AMIS
• Rejoins des ligues, compare ton bilan au classement et parle hockey dans des salons de discussion en temps réel
• Signale un message ou bloque un utilisateur à tout moment

PENSÉE POUR L'IPHONE
• Widget d'écran d'accueil avec tes sélections en cours
• Partage n'importe quelle sélection en image
• Interface sombre, faite pour les soirs de match

IMPORTANT
ArakIce est une application d'analyse et de divertissement. Elle n'accepte aucune mise, ne détient aucun argent et n'est reliée à aucun opérateur de jeux d'argent ; aucun argent réel n'est utilisé dans l'application. Les prédictions sont des probabilités, pas des garanties. Tu dois avoir 18 ans ou plus pour utiliser ArakIce.

ArakIce est une application indépendante, non affiliée à la Ligue nationale de hockey ni à aucune équipe, et non approuvée par celles-ci.

Conditions d'utilisation : https://arakice.com/terms
Politique de confidentialité : https://arakice.com/privacy
```

---

## À vérifier avant de coller dans App Store Connect

- [ ] **Widget, notifications, partage** : n'apparaissent dans la description que s'ils sont dans
      le build soumis (4.2 / 4.6 pas encore testés sur l'iPhone — STATUS Phase 4). Sinon, retirer
      la ligne : décrire une fonction absente = rejet 2.3.1.
- [ ] **Projections joueurs, totaux de buts, périodes** : vérifier qu'un compte gratuit iOS les voit
      (« Tous les marchés » est Pro). Retirer ce qui est Pro.
- [ ] **Analyse IA** : volontairement absente de la description, parce que le gratuit a un
      disjoncteur global (`llmQuota.service.ts`). L'ajouter seulement si elle reste fiable en gratuit.
- [ ] **Tutoiement** (fr) : choisi pour coller à l'app (« Dis-nous ce qui ne va pas »).
- [ ] Le nom « ArakIce: Hockey Predictions » doit être libre sur l'App Store.
