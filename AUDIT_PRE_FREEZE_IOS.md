# Audit pré-freeze iOS — ArakIce / IceEdge

**Date :** 2026-09-04 · **Périmètre :** `client/` (52 k lignes TS/TSX), `server/` (TS/Express), `.github/`, config de build
**Méthode :** lecture intégrale des routes, services, contextes et middlewares ; `tsc --noEmit` client + serveur (0 erreur) ; inspection de `dist/`, `public/`, CI, Dockerfile, CSP.

## État — 2026-09-08

**14 correctifs appliqués** (13 committés — le lot sécurité serveur est parti
dans `f91f2ba` —, le 14ᵉ en attente de relecture), dont 3 des 4 findings
CRITICAL. Sur les 11 blocants du § 10, **4 sont faits** ; les 7
autres sont tous côté iOS / App Store. La migration `034` est appliquée en
production.

**Mise à jour 2026-09-08.** Le CRITICAL qui restait (la barre de navigation sous
l'indicateur d'accueil) est corrigé : **plus aucun CRITICAL ouvert**. Quatre
HIGH sont tombés le 2026-09-06 — délais de requête et bouton « Réessayer »,
`/share/:id` supprimée, Pro retiré du build iOS, plancher de 11 px sur le texte.

Le 2026-09-08, **huit MEDIUM de plus** : `autoComplete` et accessibilité des
formulaires, `<html lang>` et détection de langue, `email_verified` Google,
jeton d'accès hors de l'URL + Sentry masqué, 401 LLM qui déconnectait,
bulle de chat optimiste sur échec, cotes fictives retirées, `typecheck` client
dans la CI, et le `.fuse_hidden…` sorti de l'arborescence.
**Le groupe 🟠 « Importants » du § 10 est désormais vide.**

**Lot du 2026-09-08 (2ᵉ passage) — sécurité serveur, le dernier trou ouvert.**
`systemPrompt` ne vient plus du client : `taskType` est une énumération fermée
et le texte vit dans `services/llmPrompts.ts`. Avec lui, la validation zod est
complétée sur le chat, `/push/subscribe` et `/subscription/redeem` ; le proxy
odds — seul `fetch` sortant du serveur encore sans borne de temps — reçoit un
délai de 8 s ; et `NHL_USE_MOCK` est ignoré en production sans un second
interrupteur explicite. **Il ne reste plus rien d'ouvert en § 1 « Sécurité »
hors le 🟢 « Divers », lui-même réduit à deux lignes.**

**Lot du 2026-09-08 (3ᵉ passage) — ce que le doigt touche.** Sept 🟡 de plus,
tous côté client : les 4 `confirm()` et l'`alert()` remplacés par
`ConfirmDialog` et `toast` (et **traduits** — ils étaient en anglais en dur),
les trois réglages tactiles iOS, `maxLength` + compteur sur le chat, le partage
d'image qui échouait sans un mot, l'auto-scroll qui empêchait de remonter lire,
la course entre l'historique HTTP et le socket, et l'avatar qui disparaissait de
la nav à chaque rechargement.

🔴 **Le seul blocant restant n'est pas du code : l'adresse de support rebondit.**
C'est le contact Guideline 1.2 et l'adresse par laquelle Apple joint le
propriétaire. Envoyer un vrai mail et confirmer qu'il arrive, **avant**
`git tag pre-ios-freeze`.

🟠 **Reste un HIGH, explicitement de phase 3 :** `tokenStore` natif
(`@capacitor/preferences`) — sans lui le build iOS perd la session toutes les
15 minutes. La couture serveur est déjà prête.

**Lot du 2026-09-11 — performance ressentie (§ 5).** Les deux 🟡 qui coûtaient
un aller-retour réseau sont tombés. Le calcul du parlay revient dans
`BetContext` : le serveur ne faisait qu'une multiplication, la formule est
recopiée à l'identique, arrondi compris, et le chiffre s'affiche maintenant
dans le même rendu que la jambe ajoutée. Et le jeton d'accès se renouvelle
**avant** d'expirer (60 s de marge, vérifié à l'envoi et non par un minuteur —
iOS suspend les minuteurs en arrière-plan), ce qui retire le 401 du premier
appel au retour dans l'application ; le handshake du socket lit le même jeton
frais. 🔴 **À relire en priorité :** ce lot change une ligne de la couche
d'authentification — un refresh qui échoue *sans réponse du serveur* n'efface
plus la session. Détails en § 5.

**Lot du 2026-09-11 (2ᵉ passage) — le chat vu par quelqu'un qui n'a pas de
compte (§ 6).** Le socket accepte désormais un handshake sans jeton, en lecture
seule et sur les salons publics uniquement : un visiteur voit les messages
arriver au lieu d'un historique figé à « 0 en ligne », et ne lit plus « session
expirée » alors qu'il n'a jamais eu de session. Un jeton *présent mais refusé*
reste refusé — c'est ce qui garde le refresh du socket vivant. Aucun changement
côté client. C'est le premier écran d'un relecteur Apple non connecté.

Tout ce qui touchait à la sécurité serveur est traité.

**Comment lire les titres :**

| Titre | Sens |
|---|---|
| `✅ CORRIGÉ · [HIGH]` | traité ; le bloc dit ce qui a été fait et ce qu'il reste à faire de ton côté |
| `🟡 PARTIELLEMENT CORRIGÉ · [MEDIUM]` | une partie est traitée, le bloc distingue ✅ et ⬜ ; la pastille reste celle de la gravité |
| `🔴 [CRITICAL]` · `🟠 [HIGH]` · `🟡 [MEDIUM]` · `🟢 [LOW]` | ouvert, par gravité |

Un titre qui commence par une pastille de couleur est donc **ouvert** ; un titre
qui commence par ✅ ne l'est plus. Le § 9 liste les dix lots de correctifs avec
leurs fichiers.

**Vérification :** `tsc --noEmit` propre client et serveur · suite serveur
**348 tests, 29 fichiers** · `vite build` web et `VITE_TARGET=ios` · les trois
règles tactiles **lues dans le CSS bâti**, à la bonne profondeur de couche ·
migration 034 rejouée contre un Postgres 16 réel.

---

## 1. Sécurité

### ✅ CORRIGÉ · [CRITICAL] La regex des previews Vercel autorisait n'importe quel compte Vercel
**Fichier :** `server/src/cors.ts`

- **Problème :** `vercelPreview = /^https:\/\/ice-edge[a-z0-9-]*\.vercel\.app$/i` accepte `https://ice-edge-nimportequoi.vercel.app`. Or un sous-domaine `<projet>.vercel.app` est attribué **au premier arrivé, sur n'importe quel compte Vercel**. Il suffisait de créer un projet nommé `ice-edge-x` pour obtenir une origine autorisée par ton API.
- **Impact :** avec `cors({ credentials: true })` et le cookie de refresh en `SameSite=None`, une page hébergée sur cette origine pouvait faire `fetch('https://api.arakice.com/api/auth/refresh', {credentials:'include'})` **et lire la réponse** — donc repartir avec un `access_token` valide et un refresh token tourné. **Prise de contrôle de compte complète, sans XSS**, pour tout visiteur connecté qui ouvre le lien.
- **Solution appliquée :** la regex exige désormais le slug d'équipe (`-ireina-hedad-s-projects`), qui n'est pas attribuable à un tiers. Surchargeable par `VERCEL_TEAM_SLUG`. Le domaine de production reste déclaré explicitement dans `CORS_ORIGIN`.
- **À faire de ton côté :** vérifier que `CORS_ORIGIN` contient bien `https://arakice.com` (+ `https://www.arakice.com` si utilisé) et tester une preview après déploiement.

### ✅ CORRIGÉ · [HIGH] Fuite d'informations internes dans les réponses d'erreur
**Fichiers :** `ml.routes.ts`, `llm.routes.ts`, `odds.routes.ts`, `app.ts` (leaderboard), `auth.routes.ts`, `profile.routes.ts`, `chat.routes.ts`, `slip.routes.ts`

- **Problème :** le handler d'erreur global d'`app.ts` masque correctement les 5xx en production (`'Internal server error'`). Mais **presque toutes les routes répondent elles-mêmes** avec `res.status(err.status ?? 500).json({ error: err.message })` — elles court-circuitent donc cette protection. Cas les plus parlants :
  - `POST /api/predict/ml` → `{ error: 'ML service unavailable', detail: err.message }` (expose l'URL/hôte du service ML)
  - `POST /api/llm` → `message: 'Database migration 005 not applied. Run: psql -d IceedgeDB -f src/db/migrations/005_openai_key.sql'` (nom de base + arborescence)
  - `POST /api/llm` → relaie le corps d'erreur **brut** du fournisseur (`raw`), qui peut contenir des identifiants d'organisation
- **Impact :** cartographie gratuite de ton infrastructure pour un attaquant. Aucune de ces chaînes n'aide un utilisateur.
- **Solution appliquée (2026-09-04) :** un module unique, `server/src/httpError.ts`, et **93 handlers réécrits**.
  - `sendError(res, err)` applique la règle : 4xx → message tel quel (il est écrit pour être lu) ; 5xx → message fixe en production, vrai message en dev. Le gestionnaire global d'`app.ts` passe par la **même** fonction, donc il n'existe plus qu'une seule définition de « ce qu'on a le droit de dire ».
  - **Les 5xx sont journalisés** avec le `request-id` de la requête. Masquer un message sans le garder aurait échangé une fuite contre un aveuglement — c'était le vrai risque de ce correctif.
  - Le statut ne vient plus de `err.status ?? 500` naïvement : une valeur qui n'est pas un code HTTP valide (une erreur `pg` porte `code: '23505'`, un `AbortError` ne porte rien) retombe sur 500, donc sur le chemin muet. Le webhook Stripe faisait exactement l'inverse — `err.status ?? 400` transformait toute erreur inattendue en 4xx et lui rendait donc son message.
  - Fuites nommées, supprimées : `detail` sur `/api/predict/ml` (adresse du service Python) et sur les 502/504 de `/api/llm` ; le message `psql -d IceedgeDB -f src/db/migrations/005_openai_key.sql` ; le corps d'erreur **brut** du fournisseur LLM (`raw`), qui pouvait être une page HTML avec des noms d'hôtes internes.
  - Un cas garde son message, délibérément : quand l'appel LLM est facturé sur la **clé OpenAI de l'utilisateur**, l'erreur du fournisseur parle de SA clé (« Incorrect API key provided ») et l'aide à corriger. Le nouveau champ `billedTo` sur `ProviderCall` fait la distinction ; sur le chemin Pro, facturé à l'opérateur, le message reste générique.
  - 15 tests de régression (`httpError.test.ts`), dont un qui rejoue la fuite réelle : `NHL API timeout (8000 ms) for https://api-web.nhle.com/v1/score/…` ne doit plus quitter le serveur — mais doit rester entier dans le journal.

### ✅ CORRIGÉ · [HIGH] `GET /api/users/me` renvoie la clé OpenAI en clair
**Fichiers :** `server/src/services/profile.service.ts`, `client/src/app/pages/profile/SettingsTab.tsx`, `client/src/app/types/user.tsx`, `client/src/app/services/userService.ts`

- **Problème :** `openaiApiKey: profile.openaiApiKey ? decryptSecret(...) : null`. La clé est chiffrée au repos (bien), puis **déchiffrée et renvoyée intégralement au client à chaque chargement de profil**.
- **Impact :** la clé traverse le réseau à chaque montage du profil, vit dans la mémoire JS de l'onglet, et devient capturable par n'importe quelle extension, outil de débogage ou intégration analytique. Le chiffrement au repos ne protège plus grand-chose si le secret ressort à la demande.
- **Solution appliquée (2026-09-04) :** la clé devient **en écriture seule**.
  - Le SELECT du profil ne lit plus la colonne du tout : il calcule `(up.openai_api_key IS NOT NULL) AS "hasOpenaiKey"`. Le chiffré ne quitte donc même plus la base pour cette requête, et `profile.service` n'importe plus `decryptSecret` — la seule lecture du clair vit dans `llm.routes.ts`, au moment de s'en servir.
  - **Pas de « quatre derniers caractères »**, contrairement à ce que je recommandais : les calculer obligerait à déchiffrer à chaque chargement de profil, donc à faire ressortir le secret de la base pour un gain d'affichage. L'écran dit « une clé est enregistrée » avec **Remplacer** et **Retirer** — on ne relit pas une clé d'API, on la remplace.
  - **Le piège que ce correctif crée**, traité des deux côtés : le champ étant désormais vide au chargement, un `openaiApiKey: openaiKey.trim() || null` envoyé à chaque enregistrement **effacerait la clé dès qu'on modifie sa bio**.
    - *Côté client* : la clé n'est transmise que si l'utilisateur en a saisi une nouvelle ou demandé le retrait ; sinon le champ est absent du PATCH.
    - *Côté serveur* : `null` ne touche plus la colonne. Seule la chaîne vide efface. Un bundle client resté en cache pendant le déploiement — qui, lui, envoie `null` à chaque enregistrement — ne peut donc plus détruire la clé de son propriétaire. La fenêtre était étroite et la perte définitive ; la refermer coûtait une ligne.
  - `UserProfile` perd `openaiApiKey` et gagne `hasOpenaiKey` ; le type de `updateProfile` le garde en écriture (`& { openaiApiKey?: string | null }`), ce qui rend l'asymétrie visible dans les types plutôt que dans un commentaire.
  - 7 tests de régression (`profile.service.test.ts`), dont un qui vérifie **la requête SQL elle-même** : les assertions de forme passeraient encore si quelqu'un remettait `up.openai_api_key AS "openaiApiKey"` dans le SELECT en oubliant de le recopier dans l'objet rendu — le chiffré quitterait alors de nouveau la base, prêt à ressortir à la première ligne de débogage.

### ✅ CORRIGÉ · [MEDIUM] Google : `email_verified` n'est pas vérifié avant le rattachement de compte
**Fichiers :** `server/src/services/auth.service.ts`, `routes/auth.routes.ts`, `client/.../LoginPage.tsx`

- **Problème :** l'interface `GoogleUserInfo` ne lisait pas `email_verified`, et `loginWithGoogle` rattachait un compte Google à un compte mot-de-passe existant **sur la seule égalité d'adresse e-mail**.
- **Impact :** si Google renvoie une adresse non vérifiée, le rattachement donne accès à un compte existant.
- **Solution appliquée — refus PAR DÉFAUT, pas seulement sur `false`**, contrairement à ce que je recommandais : le test est `email_verified !== true`. Un `=== false` ne casserait aucun parcours (l'endpoint OIDC `oauth2/v3/userinfo` renvoie toujours le champ) et rouvrirait le trou en silence le jour où il cesserait de le renvoyer. Le sens de la panne est choisi : une connexion Google cassée se voit immédiatement et l'e-mail/mot de passe reste disponible, alors qu'une prise de contrôle de compte ne se voit jamais.
- **Le garde s'exécute AVANT `pool.connect()`** — le refus précède la transaction, donc aucun rattachement partiel n'est possible.
- **Ce qui rend ce choix tenable en exploitation :** un code d'erreur distinct (`google_unverified`) qui remonte jusqu'à l'écran de connexion. Si le garde se met un jour à tout refuser, la cause est écrite dans l'URL au lieu d'être noyée dans un `google_failed` générique.
- **Effet de bord corrigé au passage :** `google_denied` et `google_failed` existaient depuis toujours côté serveur et **rien ne les lisait** — un refus Google ramenait sur un formulaire muet. Les trois ont maintenant une phrase, et le paramètre est retiré de l'URL après lecture.
- **4 tests** (`googleLogin.test.ts`), dont le seul qui compte vraiment : **une adresse vérifiée doit atteindre la base**. Sans lui, un garde qui refuserait tout le monde passerait les trois autres. Suite serveur : **330 verts, 28 fichiers**.

### ✅ CORRIGÉ · [MEDIUM] `POST /api/push/unsubscribe` — IDOR
**Fichiers :** `server/src/routes/push.routes.ts`, `server/src/services/push.service.ts`

- **Problème :** `removeSubscription(endpoint)` supprimait par endpoint seul. N'importe quel compte authentifié pouvait désabonner un **autre** utilisateur.
- **Impact :** notifications coupées pour la victime, sans qu'elle sache pourquoi. Difficulté d'exploitation faible (l'endpoint est opaque) mais la faille d'autorisation est réelle.
- **Solution appliquée :** `DELETE … WHERE endpoint = $1 AND user_id = $2`.

### ✅ CORRIGÉ · [MEDIUM] `/api/predict/*` : public, sans validation, et coûteux
**Fichiers :** `server/src/routes/ml.routes.ts`, `server/src/validation/schemas.ts`, `server/src/middleware/rateLimit.middleware.ts`, `server/src/routes/ml.routes.test.ts` *(nouveau)*

- **Problème :** `POST /single`, `/parlay`, `/factors`, `/player-prop`, `/futures`, `/ml` et `GET /best-bets` étaient ouverts à tous, sans schéma zod. Ils déclenchent des appels vers l'API NHL, `buildRealFactors`, `buildGameFeatures` et le service ML Python.
- **Impact :** amplification — une requête entrante gratuite génère plusieurs requêtes sortantes coûteuses. Seul `apiLimiter` (300/min) freinait. `/parlay` acceptait des `probability` non validées (`NaN` → `combinedProbability: NaN` renvoyé au client, et affiché).
- **Solution appliquée :**
  - **`validateBody` sur les six routes POST**, avec six schémas dans `validation/schemas.ts` : bornes sur `line`, `probability ∈ [0,100]`, identifiants NHL à 40 caractères, enums fermées pour `type` et `propType`. Le corps invalide est refusé **avant le premier appel sortant** — c'est tout l'objet de l'item, et c'est ce que le nouveau `ml.routes.test.ts` vérifie explicitement (`expect(buildGameFeatures).not.toHaveBeenCalled()`), parce qu'un schéma correct mais non câblé ne protège rien.
  - **`predictLimiter` — 60/min/compte en production — sur `/ml` et `/factors`**, les deux routes qui construisent des variables puis appellent le service Python. Même clé que `apiLimiter` (`userOrIpKey` : par compte si le jeton est valide, par IP sinon). 60 laisse trois fois la plus grosse rafale légitime, les 20 appels que `BestBetsSection` déclenche d'un coup sur la landing.
- **Ce qui a été écarté, et pourquoi :**
  - **Pas d'`optionalAuthenticate`.** Il n'apporterait rien : `userOrIpKey` vérifie déjà la signature du jeton pour établir la clé du limiteur. Et **exiger un compte est exclu** — la landing appelle `/predict/ml` et `/predict/single` sans session ; ce serait retirer la fonctionnalité au visiteur.
  - **`marketType` reste une chaîne bornée (`/^[a-z0-9_]{1,40}$/`), pas une enum.** `computeProbability` traite `last_goal_scorer`, **qui n'est pas dans l'union `BetMarketType`** : une enum bâtie sur l'union refuserait un marché que le moteur sait calculer, et chaque nouveau marché devrait être déclaré à deux endroits — une omission se paierait en 400 en production. Le moteur retombe déjà sur 50 % pour un marché inconnu.
  - **Plafond de parlay à 30 jambes, pas 20.** `slipSubmitSchema` en accepte 30 : refuser de calculer la probabilité combinée d'un coupon par ailleurs soumettable serait une régression.
  - **Rien sur `GET /best-bets`** : `limit`, `days` et `maxPlayers` sont **déjà** bornés dans `getBestBets` (`num(v, défaut, lo, hi)`), et `source` y est déjà réduit à `'ml' | 'rules'`.
- **⚠️ Ce que ça ne corrige pas :** les routes restent publiques, donc N comptes valent N × 60 depuis une même adresse. La barrière déplacée est celle de la création de comptes, pas celle-ci — même arbitrage assumé que pour `apiLimiter`.

### ✅ CORRIGÉ · [MEDIUM] `systemPrompt` piloté par le client sur le chemin Pro
**Fichiers :** `server/src/services/llmPrompts.ts` *(nouveau)*, `routes/llm.routes.ts`, `routes/llm.routes.test.ts` *(nouveau)*, `client/.../llmService.ts`, `client/.../PredictionSheet.tsx`

- **Problème :** `prompt` **et** `systemPrompt` venaient du corps de requête, et le chemin Pro utilise le jeton de l'opérateur, **facturé à toi**.
  > *Note 2026-09-09 :* ce jeton était alors `GITHUB_MODELS_TOKEN`. GitHub Models
  > ayant fermé le 30 juillet 2026, le chemin Pro passe maintenant par
  > `OPENAI_API_KEY`. Le problème décrit et sa correction restent inchangés.
- **Impact :** tout compte Pro (y compris via essai gratuit ou code promo) disposait d'un proxy LLM généraliste à tes frais, dans la limite du quota mensuel. Le quota borne la dépense, pas l'usage détourné.
- **Solution appliquée (2026-09-08) :** le client n'envoie plus qu'un `taskType` pris dans une **énumération fermée** (`LLM_TASK_TYPES`) et une langue. Le texte des invites est déplacé — **non réécrit** — du composant client vers `services/llmPrompts.ts`, qui devient leur seule définition.
  - **Le même verrou sur LES DEUX chemins**, pas seulement sur le chemin Pro. Sur la clé personnelle d'un utilisateur, une invite libre ne coûte rien à l'opérateur, donc « laisser passer » était défendable — mais c'était garder deux formes de la requête, dont une seule est testée. Une seule règle : l'invite système vient du serveur.
  - **Un `systemPrompt` encore présent dans le corps est ignoré en silence**, et un `taskType` absent retombe sur la seule tâche existante. C'est la fenêtre de déploiement : client et serveur partent séparément, donc un ancien bundle continue d'envoyer l'ancien corps. Un 400 aurait cassé le bouton « Analyse IA » le temps du déploiement. ⚠️ **Le jour où il y aura une deuxième tâche, ce défaut devra devenir un 400** — deviner la tâche demandée n'aurait alors plus de sens.
  - **La langue retombe sur `Accept-Language`** quand le corps ne la porte pas, pour que ce même ancien bundle ne bascule pas les francophones en anglais.
  - `LLM_MAX_SYSTEM_CHARS` disparaît : la taille de l'invite est désormais connue à la compilation.
- **⚠️ Ce que ça ne corrige PAS**, et qu'il ne faut pas croire corrigé : **le `prompt` utilisateur reste libre** — c'est la question de la personne, on ne peut pas la fermer. Ce qui a changé, c'est que l'invite système ancre le modèle sur l'analyse de paris LNH au lieu d'être choisie par l'appelant. Les vraies bornes de la dépense restent le plafond mensuel (`llmQuota.service`) et `llmLimiter` (10 req/min/compte).
- **5 tests** (`llm.routes.test.ts`). Celui qui compte **lit le corps JSON réellement POSTé au fournisseur** : un `systemPrompt` retiré de la lecture du corps mais réinjecté ailleurs passerait toutes les autres assertions. Vérifié aussi dans le bundle bâti — ni `systemPrompt` ni le texte de l'invite n'apparaissent plus dans `dist/assets/`.

### ✅ CORRIGÉ · [MEDIUM] Jeton d'accès dans l'URL + Sentry sans `beforeSend`
**Fichiers :** `server/src/routes/auth.routes.ts`, `client/src/main.tsx`, `client/.../AuthCallback.tsx`

- **Problème :** le serveur redirigeait vers `/auth/callback?access_token=eyJ…`, et `Sentry.init` n'avait **pas** de `beforeSend` alors que Sentry attache l'URL de la page à chaque événement **et** à chaque fil d'Ariane de navigation.
- **Solution appliquée, trois couches, dans cet ordre :**
  1. **Le fragment** (`#access_token=`) : jamais envoyé au serveur, donc absent des journaux d'accès, de l'en-tête `Referer` des sous-ressources, et de l'URL que Sentry attache.
  2. **`history.replaceState` en tout premier** dans l'effet d'`AuthCallback`, avant même le décodage : à partir de là, ni l'URL affichée ni l'historique ne portent de jeton.
  3. **`beforeSend` ET `beforeBreadcrumb`** qui masquent `access_token=` et `refresh_token=`. Les deux, pas l'un : masquer l'URL de l'événement en laissant les fils d'Ariane ne sert à rien. Regex sur la chaîne plutôt que parcours d'`URL` — la valeur doit disparaître même d'une URL malformée, et un `URL()` qui lève ferait perdre l'événement entier.
- ⚠️ **Le repli sur `?access_token=` est conservé dans `AuthCallback`** : client et serveur se déploient séparément, donc pendant la fenêtre de déploiement un client neuf peut recevoir une redirection de l'ancien serveur. **À retirer** une fois le serveur déployé et stabilisé.

### ✅ CORRIGÉ · [MEDIUM] Validation zod partielle
`validateBody` n'était posé que sur auth, slips, avatar et profil.

- ✅ **Traité :** toute la saisie manuelle. `PUT /api/injuries/:key` n'avait aucune validation — la route recopiait les tableaux du corps dans un fichier — et ses remplaçantes `/api/manual/*` ont quatre schémas bornés (barème d'impact, plage de `lineupAdj`, nombre d'équipes, longueur des noms), plus une validation des clés d'URL, qui entrent dans une clé primaire et dans une clé de cache.
- ✅ **Traité :** tout `/api/predict/*` (six schémas + `predictLimiter`, voir le bloc plus haut).
- ✅ **Traité le 2026-09-08 :** le chat (`/rooms`, `/rooms/join`, `/messages`, `/reactions`, `/report`), `/api/push/subscribe` + `/unsubscribe`, et `/api/subscription/redeem`. Huit schémas de plus dans `validation/schemas.ts`, 13 assertions.
  - **Là où il n'y avait AUCUNE compensation** : `push/subscribe`. L'`endpoint` du navigateur était écrit en base sans aucune borne **et sert de clé unique** (`ON CONFLICT (endpoint)`) — rien n'empêchait un mégaoctet de texte d'entrer dans un index. Il est maintenant une URL `https` d'au plus 2 000 caractères. Le code promo, lui, est comparé à un catalogue en mémoire (donc il n'atteint jamais la base), mais n'était borné ni en taille ni en alphabet.
  - **Le chat était déjà défendu**, et ces schémas ne le remplacent pas. Ce qu'ils changent est ailleurs : **un `slice()` accepte en silence**. Un client qui envoyait 3 000 caractères recevait un message tronqué sans jamais l'apprendre ; il reçoit maintenant un 400 qui dit la limite.
  - ⚠️ **`chat.service.ts` n'a été allégé d'AUCUNE vérification**, et ne doit pas l'être : les mêmes fonctions servent le **chemin socket**, qui ne passe par aucun de ces schémas. Une borne qui a l'air en double ne l'est pas.
  - `pin` et `role` n'ont volontairement pas de schéma : la route coerce déjà (`!!req.body.pinned`) et `setRole` valide son énumération.

### 🟢 [LOW] Divers
- **Deux routeurs montés sur `/api/users`** (`profileRoutes` puis `userRoutes`) : une route ajoutée dans le second peut être silencieusement masquée par le premier, et `authenticate` s'exécute deux fois sur `/me/*`. Fusionner ou préfixer. ⬜ **Ouvert.**
- ✅ **CORRIGÉ le 2026-09-08 — `NHL_USE_MOCK` bridé en production** (`services/nhlApiClient.ts`). Il servait des matchs, des équipes et des joueurs **inventés** à de vrais visiteurs sans qu'aucune réponse HTTP ne le dise — le même mode d'échec que les cotes fictives de `/api/odds/live`, et **ça s'est déjà produit** : le relevé du 2026-08-29 l'a trouvé à `true` en production.
  - En production il faut désormais **deux** variables : `NHL_USE_MOCK=true` **et** `ALLOW_MOCK_IN_PRODUCTION=true`. Deux plutôt qu'un refus sec parce que le risque à couvrir est l'**erreur**, pas l'intention — le tir de charge B3 a besoin des données mockées et doit rester possible. Poser les deux n'est pas un geste de distraction.
  - `NHL_USE_MOCK=true` ignoré écrit une ligne de niveau **erreur** au démarrage, en `console.error` (ce module est importé avant que le logger n'existe).
  - La bannière `[Server] Réglages effectifs` affiche maintenant la valeur **effective**, pas la variable brute — même raison que pour `ENABLE_DEV_ROUTES`. C'est cette ligne que lit le préflight du tir de charge B3.
  - ⬜ **`EMAIL_VERIFICATION_DISABLED` reste ouvert**, écarté de ce lot sur décision du user (2026-09-08). À brider de la même façon, ou à vérifier en console avant de soumettre.
  - ⬜ **`ENABLE_DEV_ROUTES` n'est pas bridé, et c'est délibéré** : c'est un opt-in documenté, déjà gardé par `authenticate + requireRole('admin')`. Il reste une case de la checklist finale, pas un correctif.
- ✅ **CORRIGÉ le 2026-09-08 — timeout de 8 s sur le proxy odds** (`ODDS_FETCH_TIMEOUT_MS`). C'était le seul `fetch` sortant du serveur sans borne de temps.
  - ⚠️ **Le coût réel était plus élevé que « une connexion bloquée »** : ces routes passent par `TtlCache.wrap`, qui **dédoublonne les requêtes concurrentes sur une clé froide**. Tous les visiteurs demandant les mêmes cotes attendent la MÊME promesse — un seul amont pendu les gelait tous, et **aucun n'aurait jamais reçu le repli stale prévu**, puisque la promesse ne rejetait pas. Le délai est ce qui transforme cette panne muette en un rejet, donc en une réponse stale.
  - 8 s : au-dessus du temps de réponse observé de The Odds API, sous les 15 s du client, pour que le repli stale parte avant que le navigateur n'abandonne.
  - ⚠️ **Ne pas annoter le retour de `fetchOdds`** : ce fichier importe `Response` d'**Express**, donc `Promise<Response>` y désigne la réponse sortante et `tsc` rend six erreurs déroutantes. Le type inféré est le bon.

---

## 2. iOS / Mobile

### ✅ CORRIGÉ · [CRITICAL] `viewport-fit=cover` manquant — toutes les safe areas valaient 0
**Fichier :** `client/index.html`

- **Problème :** `<meta name="viewport" content="width=device-width, initial-scale=1.0">`. **Sans `viewport-fit=cover`, `env(safe-area-inset-*)` vaut 0 px sur iPhone.** Les 14 endroits du code qui font `paddingTop: "env(safe-area-inset-top, 0px)"` étaient donc **entièrement inopérants**.
- **Impact :** aggravé par `apple-mobile-web-app-status-bar-style: black-translucent`, déjà présent : en PWA installée, le contenu passe **déjà aujourd'hui** sous la barre d'état. Dans le WKWebView Capacitor, il passera sous l'encoche **et** sous l'indicateur d'accueil.
- **Solution appliquée :** `viewport-fit=cover` ajouté. **À vérifier visuellement sur un iPhone à encoche** : maintenant que les insets sont réels, les en-têtes vont descendre — c'est le comportement voulu, mais l'espacement mérite un coup d'œil.

### ✅ CORRIGÉ · [CRITICAL] La barre de navigation ignore la safe area du bas
**Fichiers :** `BottomNav.tsx`, `bet/betParts.tsx`, `BetBuilderPage.tsx` + les 11 pages qui réservent la place de la barre

- **Problème :** `className="fixed bottom-3 …"` — 12 px du bas, sans `env(safe-area-inset-bottom)`. Sur iPhone l'indicateur d'accueil occupe 34 pt.
- **Impact :** la barre chevauche l'indicateur d'accueil ; les onglets du bas deviennent difficiles à toucher et le geste de retour à l'accueil se déclenche à leur place. C'est **le** défaut que les testeurs remarquent en premier.
- **Solution appliquée**, en trois temps parce que **trois choses** se calent sur le bas de l'écran, pas une :
  1. `BottomNav` : `bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))"` en style inline (la classe `bottom-3` est retirée). L'inset **s'ajoute** à l'écart de 12 px, il ne le remplace pas.
  2. `LockSlipCTA` (`/bet`, le second bloc flottant) est calé sur la barre : `bottom-[68px]` → `bottom-[calc(68px+env(safe-area-inset-bottom,0px))]`, sinon il redescend sur elle.
  3. Les marges basses des pages, qui réservaient une place devenue trop courte : `pb-24` → `pb-[calc(6rem+env(safe-area-inset-bottom,0px))]` (7 pages), `pb-28` → `pb-[calc(7rem+…)]` (4 pages), et les deux `paddingBottom` de `BetBuilderPage` — dont celui **mesuré** au `ResizeObserver` — passent en `calc(… + env(safe-area-inset-bottom, 0px))`.
- **Vérifié :** `npm run typecheck` propre ; `vite build` web **et** `VITE_TARGET=ios vite build` passent ; le CSS émis contient bien `.pb-[calc(6rem+env(safe-area-inset-bottom,0px))]{padding-bottom:calc(6rem + env(safe-area-inset-bottom,0px))}` et la règle en `68px` — la valeur arbitraire Tailwind avec `env()` génère donc réellement la règle, ce qu'un `typecheck` seul n'aurait pas prouvé.
- ⚠️ **Reste à voir à l'écran sur un iPhone à encoche.** Rien n'est déployé.
- ⚠️ Repéré au passage, **non corrigé** (hors périmètre) : dans l'onglet *My Slips*, `MySlipsTab` porte `pb-32` **à l'intérieur** du conteneur qui a déjà 112 px — les deux s'additionnent, ~240 px de vide en bas. Sans effet sur la safe area, à trancher séparément.

### ✅ CORRIGÉ · [HIGH] Champs de saisie sous 16 px → zoom automatique iOS
**Fichier :** `client/src/styles/theme.css` (une seule règle, aucun composant touché)

- **Problème :** Safari/WKWebView **zoome la page** quand on met le focus sur un champ dont la `font-size` est < 16 px, et ne dézoome pas ensuite.
- **Impact :** à chaque tap sur « e-mail », « mot de passe » ou l'input du chat, la page saute et reste zoomée. C'est le comportement qui dit le plus clairement « ceci est un site web dans une coquille ».
- **Périmètre réel, mesuré :** **35 champs** — les 10 de `LoginPage` (par sa constante `inputCls`, `text-sm`), l'input du chat (`text-xs` = 12 px), `RoomList`, `PlayerSearchBar`, le `textarea` de signalement, les sélecteurs des pages Charts (`text-[11px]`), `SettingsTab`, et les 7 du tableau de bord ML (hors build iOS, mais comptés).
- **⚠️ Pourquoi `@layer base` ne suffisait pas :** `theme.css` **avait déjà** `input { font-size: var(--text-base) }` — dans `@layer base`, donc écrasé par `text-xs`/`text-sm`, comme son propre commentaire l'annonce. La règle ajoutée est **hors de toute `@layer`** : une règle sans couche l'emporte sur n'importe quelle règle en couche, quelle que soit la spécificité. C'est ce qui permet de battre `text-xs` **sans `!important`**, et c'est ce qui fait gagner les sélecteurs `textarea` et `select`, dont la spécificité seule perdrait.
- **Solution appliquée :** limitée aux appareils tactiles, `@media (hover: none) and (pointer: coarse)`, sur décision du user — le défaut n'existe que là et le bureau garde exactement son design. Contrepartie assumée : un champ ne fait pas la même taille sur un écran et sur un téléphone. Les types sans texte saisissable (`checkbox`, `radio`, `range`, `file`, `color`) sont exclus.
- **Vérifié :** `typecheck` propre, `vite build` web **et** `VITE_TARGET=ios` passent, la règle sort bien dans le CSS bâti, et un contrôle par script confirme qu'elle y est **à la profondeur 0, hors couche**, alors que `.text-xs` est dans `@layer utilities` — c'est ce qui prouve la cascade, pas la lecture du source.
- **`maximum-scale=1` n'a pas été utilisé** : ça casse le zoom d'accessibilité et Apple le relève.
- ⚠️ **Reste à voir à l'écran** : l'input du chat passe de 12 à 16 px sur téléphone, sa rangée va grandir un peu.

### ✅ CORRIGÉ · [HIGH] Cibles tactiles sous 44 pt
**Fichiers :** `styles/theme.css` (la classe `.tap-44`) + 43 boutons dans 26 fichiers

- **Impact :** taux d'erreur de tap élevé, en particulier pour l'envoi de message. Le minimum HIG est 44×44 pt.
- **⚠️ Le chiffre de 41 était un comptage de `grep`, pas une mesure.** Les boutons ont été **mesurés** un par un dans Chromium (les classes réelles, le CSS bâti, une fenêtre de 390 px). Ce que ça a changé :
  - **La barre du bas n'est PAS en défaut** : ses onglets font **52×47**, pas 43×31 — l'icône, l'écart et le libellé de 9 px s'additionnent. La checklist demandait de les élargir : c'était inutile.
  - Les deux gros boutons du coupon (`Add leg`, `Lock slip`) font déjà **44** de haut, ainsi que le bouton « parcourir » du coupon vide et les lignes de résultat de recherche (**55**).
  - À l'inverse, **le grep manquait des cibles plus petites que tout ce qu'il listait** : les flèches `←` de 9 en-têtes, les `✕` d'effacement, le 📌 de la liste des salons, et surtout le **🗑️** de suppression d'un message (un emoji en `text-[11px]`, sans aucune classe de taille — la plus petite cible de l'app).
- **Solution appliquée, en deux mécanismes** parce qu'un seul ne marchait pas :
  1. **`.tap-44`** (36 boutons) — un pseudo-élément centré d'au moins 44×44 étend la **zone tactile** sans occuper la moindre place : le bouton garde sa taille visible. C'est ce qu'il faut partout où le bouton a un fond ou une bordure (rond de suppression d'une jambe, pastilles de couleur d'un salon, boutons de fermeture des feuilles, `+` d'ajout au coupon, pastilles de texte serrées).
  2. **Vrais `min-w-[44px] min-h-[44px]`** (7 boutons) là où l'agrandissement ne se voit pas ou est souhaitable : envoi du chat, retour et `⋯` de l'en-tête du chat, retour de `SchedulePage` et de `NHLPredictionsPage`, flèches de mois. Moins de magie, et ça se vérifie à l'inspecteur.
- **⚠️ Deux règles pour poser `.tap-44` à l'avenir** (elles sont écrites dans le CSS) : jamais sur un élément `overflow-hidden` (le pseudo serait rogné — c'est pourquoi l'avatar de `MessageBubble` a perdu le sien, son image portant déjà `rounded-full`), et jamais sur deux boutons collés (la zone déborde et volerait le tap du voisin).
- **Vérifié, par test de frappe et pas par lecture :** dans Chromium en profil iPhone (`pointer: coarse`), un point à 21 px du centre — donc **hors** d'un bouton de 28 px — renvoie bien le bouton via `elementFromPoint` ; le même point sur un bouton témoin sans la classe renvoie son parent. Les variantes `min-w`/`min-h` mesurent bien 44×44. `typecheck` propre, `vite build` web et `VITE_TARGET=ios` passent.
- ⚠️ **Non déployé, non essayé au doigt.** Les liens de texte (« mot de passe oublié », Conditions, Confidentialité) ont été laissés tels quels : cibles conventionnelles, et leurs zones de 44 se chevaucheraient entre elles.

### 🟠 [HIGH] Le stockage natif des jetons n'existe pas encore
**Fichier :** `client/src/app/services/tokenStore.ts`

- **Problème :** le serveur a déjà tout le chemin natif (`X-Client: native`, `isNativeClient`, refresh dans le corps — R3.1/R3.2, propre et bien gardé). Côté client, `tokenStore` n'a **qu'une implémentation web**, et `@capacitor/preferences` n'est pas dans `package.json`.
- **Impact :** en l'état, le build iOS perd la session **toutes les 15 minutes** (WKWebView jette le cookie `SameSite=None`) sans aucun moyen de récupérer.
- **Solution recommandée :** c'est du travail de phase 3, mais il doit être **dans le plan de freeze**, pas après. La couture est déjà prête (`TokenStore` est une interface, toutes les méthodes sont `async`) — il ne manque que `nativeStore`.

### ✅ CORRIGÉ · [HIGH] Le chat ne survit pas au retour au premier plan
**Fichiers :** `useChatSocket.ts`, `RoomChat.tsx`, `authService.ts`, `i18n/index.tsx`

Trois défauts qui se cumulent, tous visibles dès le premier verrouillage d'écran :
1. **Aucune resynchronisation après reconnexion.** Le handler `connect` fait `socket.emit('join_room')` et rien d'autre. Les messages arrivés pendant que l'app était en arrière-plan sont **perdus définitivement** — trou silencieux dans la conversation.
2. **Aucun écouteur `connect_error`.** Le jeton d'accès expire au bout de 15 min ; le serveur refuse alors le handshake (`Invalid or expired token`) et **rien ne déclenche de refresh**. Socket.io réessaie en boucle, le chat est mort, l'utilisateur ne voit qu'un point gris.
3. **`room_error` est émis par le serveur mais jamais écouté côté client.** Un accès refusé laisse l'utilisateur dans un salon qui ne reçoit rien, sans message.

**Solution appliquée.** Le hook expose `resyncKey`, un compteur ; `RoomChat` l'a mis dans les dépendances de son effet d'historique. C'est tout le mécanisme — aucun appel réseau n'entre dans le hook, la page reste seule à parler à l'API.

- **`resyncKey` monte sur une RE-connexion** (jamais sur la première : la page charge déjà l'historique) **et sur le retour au premier plan**. Ce `visibilitychange` n'était dans aucun des trois points et c'est pourtant le cas du titre : iOS gèle la WKWebView, la socket peut se croire vivante au réveil et le ping de socket.io met une vingtaine de secondes à découvrir qu'elle est morte. Au retour, on relance la socket si elle est tombée et on redemande l'historique sans attendre.
- **Une resynchro FUSIONNE** (`mergeMessages`), elle n'écrase pas : écraser perdrait les messages optimistes encore en vol et tout ce qui précède la fenêtre d'historique. Union par identifiant, le serveur faisant foi, tri sur `sentAt`. Elle ne repasse pas l'écran en « chargement » (il clignoterait à chaque retour) et n'affiche pas son échec (on récupère déjà d'une coupure ; le prochain retour au premier plan réessaiera).
- **`connect_error`** ne réagit qu'aux messages d'authentification — le reste est une panne réseau que socket.io retente très bien seul. Un seul refresh par cycle, réarmé par un `connect` réussi : sans ce garde, chaque tentative de reconnexion relancerait une rotation de jeton.
- **⚠️ Le refresh passe par `refreshSession()`, un export neuf de `authService` qui délègue à `tryRefresh`**, donc à la coalescence R3bis.1 — pas à `doRefresh`. Un second chemin de refresh ferait revenir la tempête de rotations du 2026-09-03.
- **`room_error` et la session morte** s'affichent dans le bandeau `errorMsg` qui existait déjà, avec trois clés i18n neuves. Aucune UI nouvelle.
- **⚠️ Changer de salon remet `resyncKey` à zéro pendant le rendu** (le patron React d'ajustement d'état), sinon l'effet de la page croirait revenir d'une coupure et **fusionnerait l'historique du nouveau salon dans les messages de l'ancien**.
- **⚠️ Connu et assumé :** un message supprimé pendant l'absence n'est pas dans l'historique rechargé, donc la fusion le laisse affiché jusqu'au prochain `message_deleted` ou au prochain montage. C'est le prix de ne rien perdre.

**Vérifié — et cette fois par des tests, pas par relecture.** `client/` n'a aucun runner ; un banc d'essai jetable a été monté dans le conteneur (esbuild qui bundle le **vrai** `useChatSocket.ts`, avec `socket.io-client`, `authService` et `tokenStore` remplacés par des doublures, rendu dans Chromium par Playwright). **19 assertions, toutes vertes** : la 1re connexion ne resynchronise pas, la reconnexion oui, le retour au premier plan aussi et il rappelle `connect()` quand la socket est morte, l'onglet caché ne déclenche rien, une erreur réseau ne provoque aucun refresh, un jeton expiré en provoque exactement un, un second refus n'en relance pas et lève le bandeau, un `connect` réussi réarme le droit au refresh et efface le bandeau, `room_error` remonte, la fusion garde l'optimiste et trie, et le changement de salon remet le compteur à zéro. `typecheck` propre, `vite build` web et `VITE_TARGET=ios` passent.

⚠️ **Le banc a été supprimé le 2026-09-08 ; ce paragraphe est désormais la seule trace de son passage au vert.** Il vivait dans `.claude-tmp/banc-chat/`, rien ne le lançait, et le garder aurait fini par faire croire à un garde-fou qui ne tourne pas. Le décompte et la liste des 19 assertions ci-dessus disent ce qui a été prouvé, et à quelle date ; les refaire demande de remonter la recette esbuild + Playwright, pas de retrouver le dossier. Rien n'est déployé ni essayé sur un vrai téléphone.

### ✅ CORRIGÉ · [HIGH] Le coupon est perdu à chaque mise en arrière-plan
**Fichier :** `client/src/app/context/BetContext.tsx`

- **Problème :** `useState<BetLeg[]>([])`, aucune persistance.
- **Impact :** iOS purge régulièrement les WKWebView en arrière-plan. Un utilisateur qui construit un coupon à 5 jambes, reçoit un appel et revient **repart de zéro**. Sur le web, un simple rechargement suffit aussi.
- **Solution appliquée :** `localStorage` sous la clé `iceedge_slip`, relu par un initialiseur paresseux de `useState`, réécrit par un `useEffect` sur `legs`. `@capacitor/preferences` n'est **pas** utilisé : il n'est pas dans `package.json` et relève de la phase 3 ; localStorage fonctionne dans la WKWebView.
- **TTL de 12 heures, mesuré depuis la jambe la plus récemment ajoutée** — donc un coupon en cours de construction n'expire jamais sous les doigts de son auteur. Ce n'est pas une garantie de fraîcheur (les probabilités dorment avec le coupon, c'est le serveur qui valide au verrouillage) : c'est une limite de bon sens, douze heures couvrant une soirée interrompue et pas un coupon d'avant-hier.
- **Ce qui est relu vient du disque, donc rien n'est fait sur parole :** un champ `v: 1` (une version inconnue est jetée, pas devinée), un filtre de forme sur chaque jambe (`id`, `marketType`, `probability`, `addedAt`), et un `try/catch` qui couvre le JSON cassé comme la navigation privée de Safari. Un coupon vide **retire** la clé au lieu d'y laisser un tableau.
- **Vérifié au banc d'essai** (même recette esbuild + Playwright que le hook de chat, jetable cette fois, servi en HTTP parce que `localStorage` n'existe pas sur `file://`) : **13 assertions vertes** — restauration à 5 min, encore restauré à 11 h 30, jeté à 13 h, TTL calculé sur la jambe la plus récente, JSON cassé sans exception, `v: 2` jeté, `legs` non-tableau jeté, jambes malformées filtrées sans perdre la bonne, écriture avec `v: 1`, survie au rechargement, et `clearSlip` comme le retrait de la dernière jambe qui retirent la clé. `typecheck` propre, builds web et iOS.
- ⚠️ **Connu :** le coupon n'est pas rattaché à un compte — une déconnexion ne le vide pas. Sans conséquence de sécurité (rien de sensible dans une jambe), mais deux comptes sur le même navigateur se partagent le brouillon.

### ✅ CORRIGÉ · [HIGH] Aucun timeout de requête, aucun bouton « Réessayer »
**Fichiers :** `client/src/app/services/http.ts` (nouveau), `components/ErrorState.tsx` (nouveau), + les 4 helpers `request()` et 5 écrans.

- **Problème :** `grep AbortController|AbortSignal` sur tout `client/` → **0 résultat**. `grep -i retry|réessayer` → **0 résultat**.
- **Impact :** c'est exactement le scénario « mauvaise connexion » que tu redoutes. Sur un réseau mobile dégradé, un `fetch` peut rester en attente une minute sans que l'écran change ; et quand il échouait, le seul recours de l'utilisateur était de tuer l'app. Le serveur, lui, a bien des timeouts partout.
- **Solution appliquée :** un seul `fetchWithTimeout` (`http.ts`), appelé par `authedFetch`, `nhlApiService.get`, `predictionApiService.request`, `oddsApiService`, `pushService` et les 3 `fetch` bruts de `MLPredictionCard`/`BestBetsSection`. Il ne reste **aucun** `fetch` sans délai dans `client/src`, hors `shareImage.ts` qui lit une `data:` URL.
- **`AbortController` + `setTimeout`, PAS `AbortSignal.timeout()`** comme l'audit le suggérait : celui-ci n'existe qu'à partir d'iOS **16**, et `AbortSignal.any()` — nécessaire pour fusionner le délai avec un `signal` de l'appelant — qu'à partir d'**iOS 17.4**. La version iOS minimale n'étant pas arrêtée, la version manuelle marche partout.
- **15 s par défaut, 45 s pour `/llm`.** Le défaut est **au-dessus** de tous les délais serveur (NHL 8 s, ML 5 s) plus la marge d'un démarrage à froid Railway : le client n'abandonne jamais une requête que le serveur allait servir. L'IA est la seule exception — `LLM_FETCH_TIMEOUT_MS` laisse **30 s** à l'amont, donc 15 s côté client auraient coupé des réponses valides. ⚠️ Garder `LLM_TIMEOUT_MS` au-dessus si la variable serveur change.
- **Un délai dépassé n'est pas une coupure réseau :** `RequestTimeoutError` est un type à part, sinon les deux arrivent en `AbortError` indistinguable d'un abandon volontaire (démontage d'un composant), et quitter une page ferait clignoter une erreur.
- **Aucun réessai automatique.** L'échec remonte tel quel et c'est l'utilisateur qui rejoue. Un réessai automatique transformerait une panne d'amont en troupeau — précisément ce que le tir S1 a coûté sur l'API de cotes facturée à l'appel.
- **Le bouton, sur 5 écrans** via `ErrorState` (message + `AppButton variant="ghost"` + `.tap-44`) : Accueil, Calendrier, Stats, Ligue/classement, Mes coupons. Il ne connaît pas l'erreur — il reçoit un `onRetry`, et chaque écran sait ce que « recharger » veut dire chez lui.
- **Trois états vides mensongers corrigés au passage**, parce qu'un bouton n'a nulle part où s'accrocher sans ça : l'accueil rendait un réseau coupé en « aucun match ce soir », le classement en classement vide (`.catch(() => [])`), et « Mes coupons » affichait la ligne rouge **et** l'état vide « aucun coupon » l'un sous l'autre.
- **Vérifié au banc jetable** (esbuild + Node 22, doublure de `fetch` qui honore le signal ; pas de Playwright, `http.ts` ne touche ni au DOM ni au stockage) : **16 assertions vertes** — abandon **au** délai mesuré, budget porté par l'erreur, `timeoutMs` qui ne fuit pas dans le `RequestInit`, minuteur désarmé après succès, abandon de l'appelant qui reste un `AbortError`, signal déjà abandonné, `timeoutMs: 0`, erreur réseau non déguisée, écouteur retiré. ⚠️ **Banc supprimé le 2026-09-08 ; la liste ci-dessus est la seule trace de son passage au vert.** Il vivait dans `.claude-tmp/banc-http/` et rien ne le lançait. `typecheck` propre, builds web et `VITE_TARGET=ios` verts.
- ⚠️ **Connu :** le délai couvre l'attente des **en-têtes**, pas la lecture du corps — le minuteur est désarmé dès que `fetch` rend la main. Couvrir le corps demanderait de reconstruire la `Response` autour d'un flux surveillé, ce qui perd `url`/`redirected` et lève sur un 204. Les corps servis ici sont du JSON court, lu immédiatement.
- ⚠️ **Non traité :** le socket du chat (socket.io a ses propres délais) et le « Réessayer » des écrans secondaires (graphiques, feuilles de prédiction, modération). Rien n'est déployé ni essayé sur un vrai téléphone.

### ✅ CORRIGÉ · [MEDIUM] `autoComplete` absent des champs de connexion
**Fichier :** `client/src/app/pages/LoginPage.tsx`

Seuls les champs de code OTP avaient `autoComplete="one-time-code"`. L'e-mail, le nom d'utilisateur et les mots de passe n'avaient rien → **le Trousseau iOS ne proposait ni de remplir ni d'enregistrer**, donc créer un compte dans l'app laissait l'utilisateur sans mot de passe enregistré nulle part.

- Les 9 champs sont annotés, plus `autoCapitalize="none"` / `autoCorrect="off"` / `spellCheck={false}` sur e-mail et pseudo — iOS met une majuscule au premier caractère d'un e-mail et « corrige » un pseudo.
- **Le mot de passe est conditionnel** : `current-password` en connexion, `new-password` en inscription. C'est ce couple qui décide si iOS propose le mot de passe existant ou en propose un fort à enregistrer ; une valeur fixe se tromperait dans un des deux cas.

### ✅ CORRIGÉ · [MEDIUM] Boîtes de dialogue système
**Fichiers :** `RoomChat.tsx`, `MembersModal.tsx`, `ProfilePage.tsx`, `i18n/index.tsx`

4 `confirm()` + 1 `alert()` — alors que `ConfirmDialog` existe et sert déjà au blocage. En WKWebView ces dialogues affichent **le nom de domaine en titre** et gèlent le fil JavaScript.

- **Solution appliquée (2026-09-08) :** les 3 `confirm()` de `RoomChat` passent par **un seul état générique** `confirmAction {title, description, cta, run}` plutôt qu'un booléen par geste. Les trois posent la même question, seuls le texte et l'action changent — et trois états auraient permis d'en ouvrir deux à la fois, ce que `window.confirm()` interdisait par construction.
- ⚠️ **`run` est appelée APRÈS la fermeture** : quitter ou supprimer un salon démonte `RoomChat`, et l'ordre inverse laissait un `setState` sur un composant démonté.
- `MembersModal` a son propre `kickTarget` (le dialogue y est indépendant du reste), et l'`alert()` de `ProfilePage` — **le seul de l'app** — devient un `toast.error`, comme tous les autres échecs.
- **Effet de bord réparé au passage :** ces cinq textes étaient **en anglais en dur**, jamais traduits. 12 clés i18n ajoutées.

### 🟡 [MEDIUM] `AppShell` : `w-screen h-screen overflow-hidden` + défilement imbriqué
**Fichier :** `client/src/app/App.tsx`

`100vh` sur iOS Safari inclut la zone sous la barre d'outils → le bas de l'app est coupé, et `overflow-hidden` empêche la barre d'URL de se replier. Le défilement dans un `<div>` imbriqué plutôt que sur le document casse la restauration de position et surtout le **repositionnement automatique du curseur quand le clavier s'ouvre**. Préférer `100dvh` (avec repli `100vh`) et laisser le document défiler.

### ✅ CORRIGÉ · [MEDIUM] Le partage d'image échoue en silence
**Fichiers :** `client/src/app/services/shareImage.ts`, `MySlipsTab.tsx`

- `toPng` avec `cacheBust: true` sur une carte contenant des logos NHL cross-origin → **canvas contaminé** → `SecurityError`, avalée par un `console.warn` : **l'utilisateur tapait « Partager » et il ne se passait rien** — indiscernable d'un bouton mort.
- **Solution appliquée (2026-09-08), en quatre points dont aucun ne suffit seul :**
  1. `crossOrigin="anonymous"` sur le logo de la carte — **avec un `onError` qui retire l'attribut et recharge**. Si le CDN de la NHL ne renvoie pas d'en-tête CORS, la demande anonyme fait échouer le **chargement** : le logo disparaîtrait de l'écran pour sauver une capture. Le repli garde le logo visible et laisse le partage échouer proprement.
  2. `cacheBust` retiré : il ajoutait `?t=…` à chaque URL, forçant un aller-retour réseau neuf et perdant le bénéfice d'une image déjà chargée correctement.
  3. `pixelRatio` passe de `2` en dur à `Math.min(2, devicePixelRatio)` — `2` allouait 4× la surface de la carte quel que soit l'écran.
  4. **L'échec remonte à l'appelant**, qui l'affiche en `toast`. Un `console.warn` n'est pas une gestion d'erreur.
- ⚠️ **`a.download` ne fait rien en WKWebView** : sur le build iOS, arriver au repli lève désormais `ShareUnavailableError` et l'écran propose une capture d'écran, au lieu de simuler un clic sans effet.

### ✅ CORRIGÉ · [MEDIUM] Réglages tactiles iOS absents
**Fichier :** `client/src/styles/theme.css` (aucun composant touché)

Les trois — flash gris à chaque tap, appui long qui sélectionne le texte du chrome, rebond qui décolle toute la page — sont posés le 2026-09-08, tactile uniquement.

- ⚠️⚠️ **Dans `@layer base`, PAS hors couche — l'inverse du bloc des 16 px juste au-dessus, et c'est délibéré.** Là-bas il fallait *battre* `text-xs` ; ici on pose des **défauts** qu'une classe Tailwind (`select-text`, `active:opacity-100`) doit pouvoir reprendre au cas par cas. Une règle hors couche gagnerait contre elles et rendrait ces classes inopérantes sans que personne ne comprenne pourquoi. **Vérifié dans le CSS bâti** : les trois sortent à `@layer base > @media`, la règle des 16 px à `@media` seul.
- ⚠️ **Supprimer le flash sans rien mettre à la place retire le seul retour tactile** des boutons sans classe `active:` — l'app en a 66, donc loin de tous. D'où le repli `button:not(:disabled):active { opacity: .75 }`, qui s'ajoute proprement à `active:scale-[0.98]` et `active:bg-*`.
- ⚠️ **`user-select: none` est volontairement ÉTROIT** (`button, [role=button], nav, label`). Global, il aurait empêché de **copier un message de chat** — geste légitime et attendu. Les messages ne sont pas des boutons : ils gardent la sélection sans qu'on ait à la réactiver.
- ⚠️ `overscroll-behavior-y` seulement : `-x` toucherait au geste de retour par balayage. **À revérifier à l'écran le jour où `AppShell` passera en `100dvh`** — c'est cette règle qui décidera s'il reste un rebond.

### 🟡 [MEDIUM] Aucune gestion du clavier
`grep visualViewport` → 0 résultat. Combiné à la barre de navigation `fixed` et au défilement imbriqué, l'input du chat peut se retrouver **sous** le clavier.

### 🟢 [LOW]
- `::-webkit-scrollbar { width: 0 }` global : aucune indication de défilement sur desktop.
- Le manifest déclare `orientation: portrait`, mais aucune mise en page paysage n'est prévue — à confirmer dans Xcode (l'iPad exige les 4 orientations si tu vises l'universel).

---

## 3. Fonctionnalités / bugs

### ✅ CORRIGÉ · [HIGH] Décodage JWT en `atob` — déconnexions aléatoires
**Fichiers :** `AuthContext.tsx`, `AuthCallback.tsx` → nouveau `client/src/app/services/jwt.ts`

- **Problème :** `JSON.parse(atob(token.split('.')[1]))`. Un JWT encode en **base64url**, pas en base64 : `-` et `_` au lieu de `+` et `/`, sans remplissage. `atob` **lève** `InvalidCharacterError` dès que la charge utile produit l'un de ces caractères.
- **Impact :** intermittent et invisible en test. Dans `AuthContext`, le `catch` appelait `tokenStore.clear()` → **l'utilisateur était déconnecté au démarrage, au hasard**. Dans `AuthCallback`, redirection vers `/login` → **connexion Google qui échoue sans message**.
- **Solution appliquée :** module `jwt.ts` avec conversion base64url → base64, remplissage, et décodage UTF-8 (les prénoms accentués étaient aussi mal décodés). Les deux appelants l'utilisent.
- **Bonus corrigé :** `AuthCallback` lisait `payload.username`, `payload.first_name`, `payload.last_name`, `payload.avatar_url` — **aucun de ces champs n'est dans le jeton** (`signAccessToken` ne met que `sub`, `email`, `role`). Les valeurs retombaient toujours sur le défaut. C'est désormais explicite.

### ✅ CORRIGÉ · [HIGH] La liste de blocage fuit entre comptes
**Fichier :** `client/src/app/context/BlockContext.tsx`

- **Problème :** `requested` est un `useRef` jamais remis à zéro. Après déconnexion et connexion d'un **autre compte sur le même appareil**, `ensureLoaded()` sortait immédiatement.
- **Impact :** le nouvel utilisateur héritait de la liste de blocage du précédent — messages masqués pour la mauvaise personne dans le chat, et **la liste de blocage de quelqu'un d'autre affichée dans ses Paramètres**. Fuite de données entre comptes.
- **Solution appliquée :** un effet suit `user?.id` et réinitialise `requested` + la liste au changement de compte.

### ✅ CORRIGÉ · [HIGH] Quatre sources de données du modèle sont mortes en production
**Fichiers :** `injuryStore.ts`, `injuries.routes.ts`, `refereeStore.ts`, `scratches.ts`, `startingGoalies.ts`

- **Problème :** ces modules lisent des fichiers à l'exécution :
  - `join(__dirname, '..', 'data', 'injuries.json')` → `dist/data/injuries.json`
  - `join(__dirname, '..', 'data', 'referees.json')` et `ref_assignments.json`
  - `path.resolve(process.cwd(), '..', 'ml', 'data', 'scratches.json')` et `starting_goalies.json`

  Or `npm run build` = **`tsc`**, et **tsc ne copie pas les fichiers non-TypeScript**. Vérifié : `server/dist/data/` ne contient que `arenas.js`, `mock.js`, `mockNhl.js` — **ni `injuries.json`, ni `referees.json`**. Et le Dockerfile ne copie que `dist/`, donc `../ml/data/` n'existe pas non plus dans le conteneur.
- **Impact :**
  - `getManualFactors()` renvoie **toujours** neutre → le facteur blessures et le facteur alignement sont **désactivés en production**, en silence (`try/catch` → repli neutre).
  - Idem pour les arbitres, les joueurs en réserve et les gardiens partants.
  - **`PUT /api/injuries/:key` lève ENOENT** (`writeFileSync` dans un dossier inexistant) → 500. La carte d'admin des blessures ne fonctionne pas en production.
  - Même si le fichier était copié : le système de fichiers d'un conteneur est **éphémère**, donc toute saisie manuelle disparaîtrait au prochain déploiement, et ne serait pas partagée entre instances.
- **Solution appliquée (2026-09-04) :** les quatre tables passent en base — migration `034_manual_data.sql`, table `manual_data (kind, entry_key, payload JSONB, updated_at, updated_by)`, service unique `manualData.service.ts` avec cache TTL 30 s (les absences aussi sont mises en cache : la plupart des matchs n'ont aucune saisie) et **pannes journalisées** au lieu d'un `catch {}` muet. Les quatre stores lisent la base, `PUT /api/manual/*` écrit dedans, et l'onglet « Compos du soir » de la carte admin rend enfin faisable la saisie gardiens/absents depuis un téléphone 1-2 h avant le match. Les anciens `.json` sont supprimés du dépôt. Migration validée contre un vrai Postgres 16 (application, idempotence, purge datée) ; 25 tests de régression ajoutés (`manualData.service.test.ts`, `manual.routes.test.ts`).
- **⚠️ Ce que la correction ne fait PAS, et qu'il faut lire avant de cocher cet item.** Le code est réparé ; **les quatre facteurs ne sont pas pour autant vivants**. `034` crée une table **vide** — seule la moyenne ligue (`ref_config` = 6,2 pp/match) est semée. Tant que rien n'y est saisi, les quatre entrées rendent exactement la même valeur neutre qu'avant. Ce qui a changé, c'est que **la saisie est enfin possible et persistante**, et que l'échec est **journalisé** (`logger.warn '[manualData] lecture impossible'`) au lieu d'être muet. Le mode de panne d'origine — quatre entrées mortes sans symptôme — n'est pas éliminé, il est devenu visible.

  | Source | `kind` | Après la migration seule | Ce qu'il faut pour l'activer |
  |---|---|---|---|
  | Blessures / alignement | `injuries` | table vide → facteur neutre | saisie **par match**, carte admin |
  | Gardiens partants | `starting_goalies` | vide → zéro gardien | saisie **par jour**, 1-2 h avant la mise au jeu |
  | Absents (*scratches*) | `scratches` | vide → zéro absent | saisie **par jour** |
  | Tendance d'arbitre | `ref_tendency` + `ref_tendency_auto` | ✅ **se remplit tout seul** depuis le 2026-09-04 | rien — voir le bloc suivant |
  | Assignation d'arbitre | `ref_assignment` | **scrapée en direct** (wp-json STR) ; la saisie n'est qu'un secours | ✅ parseur réécrit et testé sur un vrai billet |

- **Reste à faire de ton côté :**
  1. **Appliquer la migration en production** (`npm run db:migrate:all` avec le `DATABASE_URL` de prod) **avant** de déployer le serveur qui la suppose. Un déploiement dans l'autre ordre ne casse rien de visible — `manualData.service` retombe sur neutre — mais rejoue exactement la panne d'origine, avec une trace cette fois.
  2. **Vérifier que la table existe**, connecté en admin : `GET /api/manual/injuries` doit rendre **200 `[]`**. Un 500 = migration non appliquée.
  3. **Décider si la saisie sera réellement tenue** pour les trois jeux qui la demandent (blessures, gardiens, absents). C'est la vraie question ouverte de cet item : sans routine quotidienne, ces trois tables restent vides et le modèle porte trois entrées inertes. `GET /api/manual/coverage` (ci-dessous) est là pour que ça ne puisse plus passer inaperçu.

### ✅ CORRIGÉ · [HIGH] Le scrape d'arbitres ne se contentait pas d'échouer — il inventait des noms
**Fichiers :** `server/src/services/refereeStore.ts`, `services/__fixtures__/str-2025-11-18.html` *(nouveau)*, `services/refereeStore.test.ts` *(nouveau)*

Trouvé le 2026-09-04 en allant lire un vrai billet Scouting the Refs, ce que
personne n'avait fait — le commentaire du fichier disait « à valider une fois
sur un vrai jour de match ».

- **Problème :** `extractAssignments()` cherchait une ligne `Referees: A, B`. Ce format n'existe pas : STR met `REFEREES` seul dans un `<h3>` et les noms plus loin, dans une cellule de tableau. Passée sur le billet du 18/11/2025 (8 matchs), la fonction ne rendait pas zéro arbitre — elle en rendait **deux, tous deux inventés** :

  ```
  [ { abbrs: ['DAL','NYI'], refs: ['Linesmen TBD'] },
    { abbrs: ['SJS','UTA'], refs: ["'s rank among active officials."] } ]
  ```

  Le premier vient de « Referees and Linesmen TBD » (le match dont les officiels ne sont pas encore annoncés), le second de la légende du tableau. Ces chaînes seraient sorties **à l'écran** dans `RefFactor.note` : « arbitres Linesmen TBD — tendance inconnue ».
- **Deux défauts trouvés en même temps :** `posts.find(...) ?? posts[0]` appliquait **les arbitres d'un autre jour** quand le billet du jour n'était pas dans les cinq derniers, en silence ; et l'alias `'hockey club': 'UTA'` matchait n'importe quelle phrase contenant ces deux mots.
- **Solution appliquée :** parsing par l'ancre `<h1 id="#AWAYvsHOME">` (les abréviations sont dedans, plus besoin d'interpréter les noms d'équipes) puis la section `REFEREES` du `table.TOTable`, en s'arrêtant avant `LINESPERSONS`. Un match sans section arbitres est **ignoré, pas deviné**. Le repli `posts[0]` est supprimé — un facteur neutre vaut infiniment mieux qu'un facteur faux. Le `catch {}` muet est journalisé.
- **Et le facteur s'auto-alimente désormais.** Le même tableau porte `PP Opp/Gm` par arbitre — `5.7 (10) | 5.6 (37)` = saison passée | **carrière** — c'est-à-dire exactement la tendance que `ref_tendency` attendait qu'on saisisse à la main. Elle est lue et mémorisée dans un `kind` **séparé**, `ref_tendency_auto`, pour qu'un relevé automatique n'écrase jamais une saisie humaine (`loadTendencies` lit l'auto puis le manuel, qui gagne). **Le facteur arbitre est donc le seul des quatre à vivre sans routine quotidienne.**
- **⚠️ Le piège de mesure, qui décidait si ce facteur aide ou nuit :** `multiplier = moyenne(arbitres du match) / league`. Les valeurs STR de la colonne saison vont de 5,1 à 6,2 — **toutes sous le 6,2 semé dans `ref_config`**. Diviser par 6,2 aurait donné ≈ 0,90 à tout le monde, tous les soirs : pas un signal, une remise constante déguisée. Le dénominateur est donc maintenant **la moyenne des tendances connues**, la même mesure que le numérateur ; `ref_config` ne sert plus que de repli sous 10 arbitres connus. (Rassurant au passage : la moyenne de la colonne carrière tombe autour de 6,2 — le 6,2 était juste pour la carrière, faux pour la saison.)
- **Preuve :** `refereeStore.test.ts`, 10 tests contre un **extrait verbatim** du billet du 18/11/2025 gardé en fixture — les deux matchs avec officiels, le match « TBD », et la légende. Quatre tests sont des assertions **négatives** : aucun nom ne contient « TBD » / « rank » / « official », les juges de ligne du même tableau ne sont jamais pris pour des arbitres, et un billet d'une autre date ne s'applique pas.

### ✅ CORRIGÉ · [HIGH] Une table de saisie VIDE est aussi muette qu'un fichier introuvable
**Fichiers :** `server/src/services/manualData.service.ts`, `services/cleanup.service.ts`, `routes/manual.routes.ts`

- **Problème :** la migration `034` répare le chemin de lecture et journalise les échecs, mais **une table vide rend exactement les mêmes probabilités qu'un fichier introuvable** — facteur neutre, sans un mot. Le mode de panne d'origine (quatre entrées mortes des mois durant, sans symptôme) ne demandait qu'à revenir, cette fois par simple absence de saisie.
- **Solution appliquée :** `coverage()` compte les entrées par jeu de données. Le job de nettoyage quotidien en journalise une ligne — **les quatre jeux énumérés même à zéro**, parce que « injuries=0 » est l'information et qu'une ligne absente n'en est pas une. Et `GET /api/manual/coverage?date=` (admin) répond à la question utile : sur les matchs de **ce soir**, combien sont renseignés — `{ saisi, attendu, actif }` par jeu, `matchs` pris du calendrier NHL du jour. Un jour sans match rend 0/0, pas une erreur.

### ✅ CORRIGÉ · [MEDIUM] Un message de chat qui échoue reste affiché comme envoyé
**Fichier :** `RoomChat.tsx` (`sendMessage`)

Le `catch` ne faisait que `setErrorMsg` : la bulle optimiste **restait** à l'écran comme un message envoyé, et **le texte était perdu** (l'input avait été vidé au départ). `removeMessage(tempId)` existait déjà et n'était pas appelé ici.

- L'échec **défait** l'optimisme : `removeMessage(tempId)`, `setInput(text)`, et — ce que l'audit ne mentionnait pas — **restauration de `tag` et `replyTo`**, capturés avant que les champs ne soient vidés. Perdre la cible d'une réponse est le même bug.
- **Pas de file de renvoi**, contrairement au « proposer un renvoi » recommandé : le texte revient dans la zone de saisie avec sa réponse et son étiquette, donc renvoyer c'est appuyer sur Envoyer. Une file demanderait un état de persistance qui n'a pas sa place la veille d'un gel.

### ✅ CORRIGÉ · [MEDIUM] Course entre l'historique HTTP et le socket
**Fichiers :** `client/src/app/hooks/useChatSocket.ts`, `RoomChat.tsx`

`initMessages(msgs)` faisait `setMessages(msgs)` — un **remplacement**. Un message arrivé par le socket pendant que le `GET /messages` était en vol était écrasé. Court, mais **permanent** : ce message-là ne revenait jamais.

- **Solution appliquée (2026-09-08) :** `initMessages` est **supprimé**. `mergeMessages` (qui existait déjà pour la resynchro après coupure) devient le seul point d'entrée de l'historique HTTP, au montage comme après une reconnexion.
- ⚠️ **Ce qu'`initMessages` faisait d'AUTRE, et qu'il fallait remplacer : isoler les salons.** Le hook ne vidait jamais `messages` ; c'était le remplacement du premier `fetch` qui s'en chargeait, par effet de bord. Fusionner sans y toucher aurait **mêlé les messages de deux salons**. La remise à zéro vit maintenant dans l'effet `[roomId]` du hook — à l'endroit où le salon change.

### ✅ CORRIGÉ · [MEDIUM] Le 401 du LLM est confondu avec une expiration de session
**Fichiers :** `server/src/routes/llm.routes.ts`, `client/src/app/services/llmService.ts`

Le serveur relayait le **401** du fournisseur. Côté client, `authedFetch` interprète tout 401 comme « jeton expiré » : refresh, rotation du refresh token, rejeu inutile — et si ce refresh échouait au même instant, `tokenStore.clear()` **déconnectait l'utilisateur d'ArakIce parce que sa clé OpenAI était mauvaise**.

- **Le serveur rend désormais 502 quel que soit le code amont**, avec `code: 'invalid_api_key'` quand l'amont a répondu 401.
- **La règle qui en découle, et qui vaut au-delà de cette route :** un 401 rendu par cette API signifie « ta session ArakIce a expiré », et rien d'autre. L'échec d'un fournisseur amont est un 502.
- Côté client, la clé invalide est reconnue par son **code**, plus par un statut.

### ✅ CORRIGÉ · [MEDIUM] L'auto-scroll du chat ramène toujours en bas
**Fichier :** `client/src/app/pages/league/chat/RoomChat.tsx`

Les deux défauts sont traités le 2026-09-08 :

- **Remonter lire l'historique était impossible** dans un salon actif : chaque message arrivant renvoyait l'utilisateur en bas. On ne défile plus que si le conteneur était **déjà à moins de 80 px du bas** (marge pour qu'un pouce qui effleure ne désarme pas le suivi).
- `scrollIntoView` fait défiler **tous les conteneurs ancêtres** sur iOS — la page entière bougeait sous la barre de navigation. Remplacé par `scrollTo` sur le conteneur, qui ne touche que lui. `bottomRef` et son `<div>` sentinelle sont retirés.
- **`atBottom` est une `ref`, pas un `state`** : elle est écrite à chaque événement de défilement ; en faire un état re-rendrait toute la liste des messages à chaque pixel.
- Deux exceptions volontaires au « seulement si en bas » : **l'entrée dans le salon** (positionnement instantané, sans animer tout l'historique sous les yeux) et **l'envoi de son propre message** — envoyer, c'est vouloir se voir.

### 🟡 PARTIELLEMENT CORRIGÉ · [MEDIUM] Les erreurs se transforment en états vides
**✅ Trois écrans corrigés le 2026-09-06** avec le lot « Réessayer » : l'accueil (un réseau coupé s'affichait en « aucun match ce soir »), le classement de `LeaguePage` (le `.catch(() => [])` du classement ; celui des **salons** garde son repli à dessein — l'onglet Chat a sa propre gestion et le badge de non-lus ne doit pas bloquer le classement), et « Mes coupons » (qui affichait la ligne rouge **et** l'état vide l'un sous l'autre).

**⬜ Reste `NHLPredictionsPage`** (`catch { /* use defaults */ }`) — non traité.

### ✅ CORRIGÉ · [MEDIUM] Nom d'utilisateur vide après rechargement
**Fichier :** `client/src/app/context/AuthContext.tsx`

`AuthContext` réhydratait avec `username: ''` et sans `avatar_url` (le jeton ne les porte pas), et rien ne rechargeait le profil. **L'avatar disparaissait de la barre de navigation à chaque rechargement**, remplacé par l'icône générique — et ça se réparait tout seul dès qu'on ouvrait la page Profil, ce qui rendait le défaut d'autant plus déroutant.

- **Solution appliquée (2026-09-08) :** un effet qui complète l'utilisateur par `GET /users/me`.
- ⚠️ **Déclenché par `token`, PAS par `user`** — comme le recommandait l'audit. `setUser` à l'intérieur de l'effet relancerait un effet dépendant de `user` : boucle infinie. Le jeton ne change qu'à une vraie transition de session.
- ⚠️ **Un échec est ignoré volontairement.** `login()` et `setSession()` renseignent déjà l'utilisateur complet ; cet effet ne fait qu'enrichir. Un réseau coupé au démarrage ne doit ni déconnecter, ni afficher une erreur pour un avatar.

### ✅ CORRIGÉ · [MEDIUM] Pas de `maxLength` sur l'input du chat
**Fichier :** `client/src/app/pages/league/chat/RoomChat.tsx`

`maxLength={1000}` + un compteur qui n'apparaît qu'à partir de 900 caractères et passe au rouge sur la limite — sans lui, `maxLength` ferait simplement **cesser de répondre** la frappe, sans explication.

⚠️ `MAX_MESSAGE_CHARS` doit rester égal à `MAX_TEXT_LENGTH` de `chat.service.ts` **et** à `chatSendMessageSchema` (posé le même jour). Trois endroits, une seule valeur.

### 🟢 [LOW]
- `tempId = optimistic_${Date.now()}` : collision si deux messages partent dans la même milliseconde. `crypto.randomUUID()`.
- `GET /api/predict/markets/game/:id` **ignore complètement `:id`** et renvoie une constante — paramètre trompeur.
- `ruleWeightsService.ts:64,71` : `localStorage.setItem` **sans try/catch**, alors que `tokenStore` protège soigneusement les siens. Lève en navigation privée Safari.
- ✅ **CORRIGÉ le 2026-09-08** — `RoomChat` testait `!e.shiftKey` sur un `<input>` d'une seule ligne, où Maj+Entrée n'insère rien. La condition ne faisait qu'**avaler un envoi** quand Maj traînait sous le doigt — exactement ce que fait un clavier tactile qui vient d'écrire une majuscule. Condition retirée (pas de passage en `<textarea>` : ce serait un changement de mise en page avant le gel).
- ✅ **CORRIGÉ le 2026-09-08** — `llmService.ts` déclarait `const BASE = env.nhlServerUrl`, jamais utilisé (les appels passent par `authedFetch`, qui a sa propre base). Parti avec le lot `taskType`, l'import `env` avec.

---

## 4. Architecture / code

### 🟡 PARTIELLEMENT CORRIGÉ · [MEDIUM] Aucun test ni typecheck côté client dans la CI

> **Où sont passés les bancs d'essai.** Trois vérifications de ce document
> (19 assertions sur la reprise du socket de chat, 16 sur les délais de requête,
> 13 sur le coupon persisté) ont été faites à des bancs jetables montés hors du
> dépôt. **Tous supprimés le 2026-09-08**, à la demande du propriétaire et pour
> une bonne raison : rien ne les lançait, et un banc qu'aucune CI n'exécute finit
> par se lire comme un garde-fou alors qu'il n'en est pas un. Ce qu'ils ont
> prouvé, et quand, est écrit dans les items correspondants — c'est la trace, et
> elle vaut ce que vaut ce document. Le jour où `client/` aura un runner, ces
> assertions sont la liste de ce qu'il faut y remettre.

**✅ Le typecheck y est (2026-09-08)** — `npm run typecheck` placé AVANT `npm run build` dans le job client, pour échouer vite. `vite build` passe par esbuild, qui jette les annotations de type sans les contrôler : le build ne prouvait donc rien, et `typecheck`, seul garde-fou automatique du client, ne tournait que quand on y pensait.
**⬜ Il n'y a toujours aucun test client** — `client/` n'a aucun runner, décision reportée après le gel.

`.github/workflows/ci.yml` : le job `client` fait `npm ci`, `npm run build`, `npm run check:env:dist`. Il **ne lance pas `npm run typecheck`** (qui existe pourtant), et il n'existe **aucun test client** — 0 fichier `.test.tsx`. Le serveur, lui, a 14 fichiers de test et un vrai job. Ajouter `npm run typecheck` au job client est gratuit.

### 🟡 [MEDIUM] Le serveur démarre même sans base de données
`server.ts` : `catch (err) { logger.warn('PostgreSQL unavailable - DB features disabled') }` puis il écoute quand même. Un déploiement avec un mauvais `DATABASE_URL` **réussit** ; l'app démarre et toutes les routes auth/profil rendent des 500. La sonde `/health/ready` renvoie bien 503, ce qui limite les dégâts si l'hébergeur la lit — à vérifier sur Railway.

### 🟡 [MEDIUM] Reliquats de scaffolding
- `client/package.json` s'appelle toujours **`@figma/my-make-file`**, contient un bloc `pnpm.overrides` inutile (tu utilises npm), et déclare **`react` et `react-dom` en `peerDependencies` optionnelles** au lieu de `dependencies`. Ça marche aujourd'hui (le lockfile les contient bien en 18.3.1, non-dev), mais une régénération du lockfile ou un passage à pnpm peut les faire disparaître et casser le build de façon incompréhensible.
- `server/dist/` contient encore `app.controller.js`, `app.module.js`, `app.service.js` — des restes d'un squelette NestJS, exclus par `tsconfig.json` mais jamais nettoyés du `dist/` local. (Le Dockerfile repart de zéro, donc ils ne partent pas en prod.)
- `client/public/jerseys/` est un dossier **vide**.

### ✅ CORRIGÉ · [MEDIUM] Un ancien `chat.service.ts` est versionné sous un nom d'artefact FUSE
**Sorti de l'arborescence le 2026-09-08** (déplacé dans `_to_delete/` — le bridge ne peut pas effacer ; `git` voit la suppression).

Le texte d'origine :

`server/src/services/.fuse_hidden0000000e00000001` — 450 lignes, une **copie datée du 1er juillet de `chat.service.ts`**, committée (commit `22e61fe`). Elle part dans le contexte de build Docker (`COPY src ./src`). À supprimer.

### 🟢 [LOW] Prix codé en dur
`ProPage.tsx:21-22` : `PRICE_MONTHLY = "11,99 $"`, `CURRENCY = "CAD"`. Deux sources de vérité avec Stripe, et la chaîne n'est **pas localisée** (un utilisateur anglophone lit « 11,99 $ CAD » au lieu de « $11.99 CAD »). Lire le prix depuis `GET /subscription/me` ou formater avec `Intl.NumberFormat`.

---

## 5. Performance

### ✅ CORRIGÉ · [HIGH] Le logo était un PNG de 1,49 Mo
**Fichiers :** `client/src/app/components/brand/IceedgeLogo.tsx`, `client/public/sw.js`

- **Problème :** `<img src="/arakice-logo.png">` — le master **1024×1024, 1 489 844 octets** — affiché à 28–72 px sur 8 écrans (connexion, accueil, Pro, 404, Conditions, Confidentialité, Support, succès). Le service worker s'en servait aussi comme icône **et** badge de notification.
- **Impact :** ~1,5 Mo téléchargé au premier chargement pour peindre une vignette. Sur un forfait mobile, plusieurs secondes et autant de données. C'était de loin le plus gros poste de la page.
- **Solution appliquée :** trois variantes générées (`arakice-mark-96/192/288.png` — **8 / 24 / 49 ko**), `srcSet` + `sizes` pour que le navigateur ne prenne que ce qu'il affiche (8 ko dans la barre de navigation), `decoding="async"`. Le master reste dans `public/` comme source. **Gain : ~1,48 Mo au premier chargement.**

### ✅ CORRIGÉ · [MEDIUM] Un aller-retour réseau pour une multiplication
**Fichier :** `client/src/app/context/BetContext.tsx`

- **Problème :** `BetContext` appelait `POST /api/predict/parlay` **à chaque ajout ou retrait de jambe**. Le commentaire disait que multiplier côté client « supposerait l'indépendance des jambes » — or le serveur faisait exactement ça : `legs.reduce((acc, leg) => acc * (leg.probability/100), 1) * 100 * 0.95`. Le voyage réseau n'achetait donc rien : même formule, plus la latence, plus la batterie, plus un état de chargement à gérer.
- **Solution appliquée (2026-09-11) — la première des deux branches : calcul côté client.** `combineLegs()` reproduit la formule du serveur, **arrondi compris** : l'arrondi porte sur le produit non arrondi, comme dans `ml.routes.ts`, sinon certains coupons afficheraient un dixième de point d'écart avec le chiffre enregistré.
  - **`useMemo`, plus `useState` + `useEffect`.** Le chiffre est désormais dans le même rendu que la jambe qu'on vient d'ajouter : plus d'état de chargement, plus de « — » qui clignote, et surtout plus de chiffre qui arrive après le geste — ou jamais, en tunnel.
  - **Le cas à une jambe garde son comportement exact** : pas d'abattement, pas d'arrondi. Il court-circuitait déjà l'appel réseau ; le changer aurait été une modification visible déguisée en optimisation.
  - **`null` change de sens et le type ne bouge pas.** Il ne veut plus dire « le service n'a pas répondu » mais « au moins une jambe porte une probabilité inexploitable » — une jambe relue d'un vieux coupon, par exemple. Les écrans qui affichaient « — » et `pred.unavailableParlay` disent donc toujours quelque chose de vrai, et aucun appelant n'a été touché.
  - **La route `/api/predict/parlay` reste en place, inchangée.** Elle est validée et limitée, elle ne coûte rien, et c'est elle qu'il faudra reprendre le jour où l'autre branche — une vraie corrélation entre jambes — sera implémentée. Le commentaire du client le dit à l'endroit exact où quelqu'un serait tenté de recopier un coefficient.
  - **Ce que ça ne corrige pas :** le `0.95` reste un abattement forfaitaire, pas un modèle. Le déplacer côté client ne le rend ni plus ni moins juste — il le rend seulement gratuit.

### 🟡 [MEDIUM] Aucune déduplication ni cache des requêtes côté client
Pas de react-query / SWR : chaque page refait ses `fetch` au montage, et deux composants montés ensemble qui veulent la même donnée font deux appels. C'est partiellement absorbé par les en-têtes `Cache-Control` posés côté serveur (bien pensés), mais pas la déduplication en vol ni la revalidation en arrière-plan.

### ✅ CORRIGÉ · [MEDIUM] Le premier appel après 15 minutes coûte 3 allers-retours
**Fichiers :** `client/src/app/services/authService.ts`, `client/src/app/hooks/useChatSocket.ts`

- **Problème :** aucun rafraîchissement proactif du jeton. Le premier appel après expiration prenait un **401**, puis un refresh, puis un rejeu — trois allers-retours, à chaque retour dans l'application, c'est-à-dire au geste le plus fréquent d'une app consultée entre deux périodes d'arrière-plan.
- **Solution appliquée (2026-09-11) :** `getFreshAccessToken()` renouvelle le jeton **avant** l'envoi quand il expire dans moins de 60 s. Deux allers-retours au lieu de trois ; le 401 + refresh + rejeu reste en place, mais redevient un filet au lieu d'être le chemin normal.
  - **Vérification à l'envoi, et non un minuteur à `exp - 60 s`**, contrairement à ce que cette ligne recommandait. iOS suspend les minuteurs d'une WKWebView en arrière-plan : celui-ci ne se déclencherait pas pendant l'absence, puis d'un coup au retour, en même temps que les appels de remontage — soit exactement la tempête que la coalescence R3bis.1 existe pour éteindre. Un contrôle à l'envoi ne dépend d'aucun minuteur et donne la bonne réponse au réveil comme à chaud.
  - **Passe par `tryRefresh`**, donc par la coalescence R3bis.1 : le socket, une requête HTTP et le contrôle proactif ne peuvent pas lancer trois rotations concurrentes.
  - **Le handshake du socket profite du même jeton.** `useChatSocket` lisait `tokenStore.getAccess()` : au retour d'un écran verrouillé il partait avec un jeton mort, se faisait refuser, et n'attendait le refresh que par `connect_error`. Il passe maintenant par `getFreshAccessToken()`.
  - ⚠️ **Un garde d'horloge, parce que `exp` se lit avec l'horloge du téléphone.** Une horloge en avance de plus de 15 minutes rend *tout* jeton « bientôt expiré », y compris celui qui vient d'arriver : sans garde, chaque requête déclencherait une rotation — une tempête de refresh silencieuse chez le seul utilisateur concerné. Si le jeton tout neuf paraît encore expirer, le mécanisme se coupe pour ce chargement de page et on repasse au chemin 401, qui ne dépend d'aucune horloge locale.
  - 🔴 **Un changement de comportement dans la couche d'authentification, à relire en priorité.** Le `catch` de `doRefresh` **n'efface plus la session**. Il ne s'atteint que quand le serveur n'a *rien* répondu — réseau coupé, DNS, délai dépassé —, donc quand il n'a pas refusé le jeton de rafraîchissement. Tant qu'on n'y arrivait qu'après un vrai 401, c'était sans conséquence ; le rafraîchissement proactif l'a rendu atteignable par un simple passage sous un tunnel, et déconnecter quelqu'un dont le jeton est valide parce que son métro est entré en station n'est pas une défense. Un **refus** du serveur (`!res.ok`) ferme toujours la session : l'intention de R3.8 — ne pas rester à afficher des 401 avec une session morte — est intacte.
  - **Coût assumé :** quand le rafraîchissement proactif vient d'échouer et que la requête prend quand même un 401, un second refresh part. Deux appels au lieu d'un, sur un chemin déjà en train d'échouer.

### 🟢 [LOW]
- Les messages du chat s'accumulent sans borne dans `useChatSocket` — plafonner à ~200 en mémoire.
- `backdrop-filter: blur(18px)` sur la barre `fixed` : coûteux à repeindre à chaque défilement sur iPhone.

---

## 6. UX / UI / Accessibilité

### ✅ CORRIGÉ · [HIGH] 351 occurrences de texte de 8 à 10 px
**Fichiers :** 47 `.tsx` + `rink-theme.css` et `league-theme.css`.

Le décompte de 351 incluait les écrans internes. Hors ceux-là — `DevMLDashboard`, `DevIndexPage`, `ModerationQueuePage` sont derrière `devRoutes: isWeb`, donc absents du build iOS — le vrai chiffre était **283 occurrences sur 47 fichiers**, plus **6 règles CSS** à 9-10 px.

- **Plancher unique à 11 px**, pas l'échelle 11-12 / 13-14 suggérée : `text-[11px]` est **déjà employé 104 fois** dans le design, donc rien de nouveau n'entre dans la palette et le rendu ne part pas en refonte à trois jours du gel. 8, 9 et 10 px deviennent 11 ; ce qui était déjà à 11 ne bouge pas.
- **Les 3 écrans internes ne sont PAS touchés** : tableaux denses d'outil interne, invisibles pour Apple, et personne ne relirait leur grille.
- **Prouvé dans le CSS bâti**, pas dans les sources : `cat dist/assets/*.css | grep -o "font-size:[0-9.]*px"` ne rend plus que `.text-[9px]` et `.text-[10px]` — deux utilitaires que Tailwind génère parce que les écrans internes s'en servent encore, et qu'**aucun écran atteignable sur iOS ne porte**. C'est la seule vérification qui vaut : une classe Tailwind ne se prouve pas en grepant le TSX.
- ⚠️ **Non touché :** les graduations d'axe des graphiques (`fontSize: 10` passé à Recharts, 4 occurrences dans `ChartVisuals.tsx`). Ce n'est pas du texte d'interface, l'audit ne les comptait pas, et les monter chevaucherait sur un axe dense.
- ⚠️ **À vérifier à l'œil** : la barre de navigation, les badges de rôle et les libellés à fort interlettrage (`.rink-signboard-kicker` à 0.22em, `.jersey-choice`) sont ceux qui peuvent déborder. Rien n'est déployé.

### ✅ CORRIGÉ · [MEDIUM] Formulaires : aucun `<label>`, erreurs non annoncées
`LoginPage` n'utilisait que des `placeholder` — qui disparaissent dès la première frappe et ne sont pas lus comme des étiquettes. Les blocs `{error}` et `{notice}` n'avaient ni `role` ni `aria-live`.

- **`aria-label` sur chaque champ, pas des `<label>` visibles.** Poser de vraies étiquettes change le dessin de l'écran, ce qui n'est pas une décision à prendre la veille d'un gel ; l'`aria-label` règle la partie lecteur d'écran sans toucher au rendu. À reconsidérer après le gel si la refonte est souhaitée.
- **4 blocs d'erreur en `role="alert"`, 3 blocs de confirmation en `role="status"` + `aria-live="polite"`** — la distinction compte : une confirmation ne doit pas interrompre la lecture en cours, une erreur si.

### ✅ CORRIGÉ · [MEDIUM] La langue n'est jamais reflétée dans le document
**Fichier :** `client/src/app/i18n/index.tsx`

- **`document.documentElement.lang = lang`** dans un effet — volontairement pas au rendu : muter le document pendant le rendu est un effet de bord que React se réserve le droit de rejouer. Sans ça, un lecteur d'écran lisait du français avec une voix anglaise et le correcteur du navigateur se trompait de dictionnaire.
- **Détection initiale** via `navigator.languages` (l'ordre de préférence réel) avant `navigator.language`, tout ce qui commence par `fr` comptant. **Le choix explicite reste prioritaire** : quelqu'un qui a mis l'anglais sur un téléphone français le garde.

### ✅ CORRIGÉ · [MEDIUM] Le chat public est figé pour les visiteurs non connectés
**Fichiers :** `server/src/socket.ts`, `server/src/services/chat.service.ts`

- **Problème :** le middleware socket exigeait un JWT (`if (!token) return next(new Error(...))`), alors que l'historique des salons publics est lisible sans compte via HTTP (`getPublicRoomMessages`). Un invité voyait donc les messages **mais jamais les nouveaux**, avec « 0 en ligne » et un point gris — l'app avait l'air cassée. Et comme le refus de handshake dit « Authentication required », le client y lisait « auth », tentait un refresh, échouait, et affichait **« session expirée » à quelqu'un qui n'avait jamais eu de session**. C'est aussi le premier écran d'un relecteur Apple, qui n'est pas connecté.
- **Solution appliquée (2026-09-11) — la première des deux branches : socket en lecture seule pour les invités.** Un handshake sans jeton passe, `userId` reste `null`, et `join_room` demande alors `chatService.isPublicRoom()` au lieu de `canRead()`.
  - ⚠️ **Jeton ABSENT ≠ jeton INVALIDE, et c'est tout le correctif.** Un jeton absent, c'est un visiteur : il entre en invité. Un jeton présent mais refusé, c'est une session expirée : il est refusé, et le `connect_error` du client déclenche son refresh exactement comme avant. Confondre les deux ferait retomber un utilisateur connecté en invité au bout de 15 minutes — il perdrait ses salons privés sans un mot, et le chemin de refresh du socket (R3bis) deviendrait mort.
  - **`isPublicRoom` suit la même règle que `getPublicRoomMessages`**, délibérément : si l'un s'ouvrait sans l'autre, un invité verrait soit un historique qui ne bouge pas, soit des messages en direct dont il ne peut pas lire l'histoire.
  - **Aucun changement côté client n'a été nécessaire.** `RoomChat` montait déjà le socket pour tout le monde, l'envoi est déjà derrière `requireAuth`, et le compte « N en ligne » devient enfin vrai puisque les invités y comptent.
  - **Ce que ça ouvre :** un socket sans compte peut exister, donc consommer une connexion — il n'y a pas de plafond par IP ici, c'est à l'hébergeur de le poser. **Ce que ça n'ouvre pas :** ce socket n'a aucun chemin d'écriture (les messages partent en POST HTTP, qui exige toujours un compte), il ne peut rejoindre qu'un salon public, et il n'y reçoit que ce que `GET /messages` sert déjà sans compte. Pas une donnée de plus ne sort.
  - ⬜ **Reste à faire :** un test du handshake invité. Il n'en existe aucun pour `socket.ts` (il faudrait monter un serveur socket.io de test), et en écrire un sans pouvoir le lancer n'aurait rien prouvé — voir l'avertissement du § 9.

### 🟢 [LOW]
- Français : mélange de tutoiement et de vouvoiement dans le dictionnaire (7 vs 6 occurrences). Choisir le tutoiement — il colle mieux au ton du reste.
- `BottomNav` : `opacity: 0.45` sur `#92A08A` par-dessus un fond translucide → contraste très en dessous de 4.5:1. Pas d'`aria-current="page"` sur l'onglet actif, pas de `type="button"`.
- Copie du code d'invitation (`navigator.clipboard.writeText`) : aucun retour visuel alors que `sonner` est déjà en place.

---

## 7. Production readiness

### ✅ CORRIGÉ · [CRITICAL] « Mode démo : le paiement Stripe n'est pas encore branché » était affiché en production
**Fichiers :** `client/src/app/pages/ProPage.tsx`, `client/src/app/i18n/index.tsx`

- **Problème :** la clé `pro.devNote` — *« Demo mode: Stripe payment isn't wired yet — the subscription activates immediately so you can test. »* — était rendue **sans condition**, sous le bouton d'abonnement, pour **tous les visiteurs**.
- **Impact :** en production Stripe **est** configuré (sinon `/checkout` rend un 501), donc le message était **faux**. Et faux ou vrai, annoncer à quelqu'un que le paiement n'est pas branché sur la page où on lui demande de payer est exactement ce qui détruit la confiance dans un produit payant. C'était le signal « prototype » le plus visible de l'app.
- **Solution appliquée :** rendu supprimé, clé retirée du dictionnaire.

### ✅ CORRIGÉ · [HIGH] `/share/:id` est une page « bientôt disponible » en production
**Fichiers :** `routes.tsx`, `i18n/index.tsx` ; `pages/SharePage.tsx` supprimée.

- **Problème :** la page affichait `t("share.soon")` = « Les coupons partagés arrivent bientôt. » Route enregistrée et publiquement atteignable, alors que **rien dans l'app n'y renvoyait** — le partage passe par une image, ce qui reste le bon choix. Du code mort avec du texte de remplacement, rejeté par Apple (Guideline 2.1 / 4.2).
- **Solution appliquée :** page supprimée (déplacée dans `_to_delete/`, le bridge ne peut pas effacer), route retirée, et **la liaison `lazy()` avec elle** — c'est le piège qui a déjà attrapé `AuthCallback` et `DevMLDashboard` : `lazy()` s'exécute au niveau du module, retirer la ligne de route n'aurait pas tué le chunk.
- **Clés `share.title` / `heading` / `slipId` / `soon` retirées** du dictionnaire. `share.goHome` **reste** : `NotFoundPage` s'en sert, c'est son seul autre appelant.
- **Vérifié dans `dist/` :** aucun `SharePage-*.js` dans le build web ni dans le build iOS. Une ancienne URL partagée tombe désormais sur `NotFoundPage`, qui est faite pour ça.

### ✅ CORRIGÉ · [HIGH] Sur iOS, la page Pro est une impasse
**Fichier :** `client/src/app/pages/ProPage.tsx`

Avec `features.stripeCheckout === false` :
- le prix est masqué (bien pensé : « un prix sans moyen d'acheter est pire que pas de prix »)
- si l'essai est disponible → bouton « Essai gratuit »
- **si l'essai est déjà consommé → `: null`, donc aucun bouton d'action**
- le champ **code promo reste affiché**

Un utilisateur iOS voit donc la liste complète des avantages Pro, sans aucun moyen d'y accéder — sauf un code promo. Deux problèmes :
1. **Parcours en impasse** : c'est le genre d'écran qui fait dire « c'est incomplet ».
2. **Risque de rejet 3.1.1** : déverrouiller du contenu payant sur iOS par un code hors App Store est précisément ce que la règle interdit, et le testeur d'Apple doit pouvoir exercer les fonctions payantes. À ce jour il n'y a **aucun chemin IAP** dans le code.
- **Décision prise le 2026-09-06 : build v1 sans Pro sur iOS.** L'IAP est reporté ; la page entière disparaît du build iOS, champ promo compris.
- **Solution appliquée :** un drapeau `features.proUpgrade` (`platform.ts`) — « ce build a-t-il **un** chemin vers Pro », distinct de `stripeCheckout` qui ne dit que **comment** on paie. Les deux valent `isWeb` aujourd'hui, ce qui a l'air redondant ; ça cesse de l'être le jour où l'IAP arrive en phase 3 et où `proUpgrade` passe à vrai sur iOS pendant que `stripeCheckout` reste faux. Les séparer maintenant fait de ce jour-là un changement d'une ligne au lieu d'un audit de tous les écrans Pro.
- **Ce qui disparaît du build iOS :** `/pro` et `/pro/success` (routes **et** liaisons `lazy()` — vérifié : aucun `ProPage-*.js` ni `ProSuccessPage-*.js` dans `dist/` en `VITE_TARGET=ios`, les deux sont bien là dans le build web), le prix, le champ code promo, et le bouton « Passe Pro » de la carte Abonnement des Paramètres.
- **Ce qui reste :** les sections Pro restent **verrouillées** (`ProLock` garde son flou et son titre) mais **sans appel à l'action** — sur un build sans `/pro`, le bouton pointerait vers une route inexistante, soit un cul-de-sac pire que celui qu'on corrige. Et il ne fallait **pas** le remplacer par « disponible sur le web » : renvoyer vers un achat hors App Store est précisément ce que 3.1.1 interdit. La carte Abonnement reste visible pour un **abonné** (souscrit sur le web, même compte) afin qu'il lise son échéance et puisse résilier — résilier n'est pas un achat.
- ⚠️ **Tension assumée :** un testeur d'Apple verra du contenu flouté sans aucun moyen d'y accéder. C'est permis (3.1.1 interdit de pointer vers un achat externe, pas de verrouiller du contenu) mais ça peut se lire comme incomplet. L'alternative — retirer les sections Pro du build iOS — change le produit, pas seulement l'écran. À trancher avant de **soumettre**, pas avant de taguer.

### ✅ CORRIGÉ · [MEDIUM] Des cotes fictives sont servies publiquement
**Supprimé le 2026-09-08.** `GET /api/odds/live` et `GET /api/odds/game/:gameId` servaient `MOCK_ODDS` — deux cotes écrites en dur sur un match « g1 » — à n'importe qui, sans authentification et sans le dire. Aucun appelant : le client passe par `/bet365/:sportKey`, qui relaie The Odds API. `services/odds.service.ts` et `data/mock.ts` sont partis avec elles, faute d'appelant. Sur une app de paris, une cote inventée qui a l'air vraie est le pire mode d'échec possible — même arbitrage que `PredictionUnavailableError` côté prédictions.

Le texte d'origine :

`GET /api/odds/live` et `GET /api/odds/game/:gameId` renvoient `MOCK_ODDS` — deux entrées codées en dur (`BOS 1.85`, `NYR 2.05`) depuis `server/src/data/mock.ts`. Aucun écran client ne les appelle (le client passe par `/odds/bet365/...`), donc ce sont **des endpoints publics morts qui servent des cotes inventées** sous ton nom de domaine. À supprimer.

### 🟡 [MEDIUM] Journalisation
Rien de grave : les `console.*` restants sont légitimes (scripts de migration, `instrument.ts` avant que le logger n'existe, `ErrorBoundary`). Côté client, ~24 `console.error/warn` de diagnostic — acceptables, mais plusieurs marquent des échecs **que l'utilisateur ne voit pas** (partage, `TeamCarousel`, `oddsApi`). Un `console.warn` n'est pas une gestion d'erreur.

### 🟢 Ce qui est déjà bien configuré
`.gitignore` complet, gitleaks sur `master` **et** les PR (avec le commentaire qui explique pourquoi `master` doit y rester), CSP stricte + HSTS + `X-Frame-Options` + `Permissions-Policy`, aucun secret côté client, `SECRET_ROTATION.md` et `BACKUP_DR.md` présents, Sentry armé des deux côtés avec un taux d'échantillonnage raisonné, `check:env` en deux filets (commande de build Vercel + scan du `dist/` en CI).

---

## 8. Regard d'utilisateur, pas de développeur

**Ce qui semble bizarre ou inutile**
- La mention « mode démo » sous le bouton d'abonnement (corrigée) : c'était le premier truc qui faisait douter.
- Une page « bientôt disponible » atteignable (supprimée).
- Sur iPhone, la page zoome à chaque tap dans un champ et ne dézoome pas.
- L'avatar disparaît de la barre du bas après un rechargement.

**Fonctionnalité présente à plusieurs endroits au lieu d'être centralisée**
- Le motif `res.status(...).json({ error: err.message })` est recopié dans ~40 handlers, ce qui contourne le handler global soigneusement écrit. **Un seul helper**, et la règle redevient vraie partout.
- Les confirmations : `ConfirmDialog` d'un côté, `window.confirm` de l'autre.
- Les `fetch` : quatre helpers `request()` quasi identiques (`authService`, `nhlApiService`, `predictionApiService`, `injuriesAdminService`), chacun avec sa gestion d'erreur et **aucun** avec de timeout. Une base commune donnerait timeout + retry + abort à tout le monde d'un coup.

**Où l'utilisateur peut se perdre**
- Chat : après un verrouillage d'écran, la conversation reprend avec un trou et sans indication.
- Ligue : quand le réseau tombe, « vide » et « cassé » sont indistinguables, et il n'y a rien à réessayer (corrigé).
- Pro sur iOS : liste d'avantages, aucun bouton (la page entière est retirée du build iOS).

**Étapes inutiles**
- Un aller-retour réseau à chaque modification du coupon, pour une multiplication.
- Un 401 + un refresh + un rejeu à chaque retour dans l'app après 15 minutes.

**Ce qui fait « prototype » plutôt que produit fini**
Par ordre d'impact : la mention mode démo (corrigée) · les textes à 8-9 px · le zoom iOS sur les champs · les `confirm()` système · la page « bientôt disponible » · les échecs silencieux (partage, blessures).

**Risques App Store**
| Guideline | Risque | État |
|---|---|---|
| 2.1 / 4.2 — App Completeness | ~~Page `/share/:id` « coming soon »~~ supprimée 2026-09-06 | 🟢 traité |
| 3.1.1 — In-App Purchase | ~~Pro déverrouillable par code promo~~ → build v1 sans Pro sur iOS (`features.proUpgrade`) ; ⚠️ contenu verrouillé sans CTA, à relire avant de soumettre | 🟢 traité |
| 4.0 — Design | ✅ cibles 44 pt, safe areas, et plancher de 11 px posé 2026-09-06 (283 + 6 règles) | 🟢 traité |
| 5.3 — Gambling | Liens sortants coupés par `features.bookmakerLinks`, double barrière dans `openUrl` | 🟢 bien traité |
| 4.8 — Sign in with Apple | Google retiré du build iOS (`features.googleLogin`) | 🟢 bien traité |
| 1.2 — Safety / UGC | Signalement, blocage réversible, file de modération, règles accessibles depuis le chat, adresse de support publiée | 🟢 bien traité |

---

## 9. Correctifs appliqués

Travail fait directement sur `master` dans `~/dev/ICEEDGE`, relu et committé
par le user : lots 1-9 (`357a458`, `816e547`), lot 10 (`a204a20`), lot 11
(`3194c1b`).

| # | Fichier(s) | Changement |
|---|---|---|
| 1 | `server/src/cors.ts` | Regex des previews Vercel restreinte au slug d'équipe (**faille de prise de contrôle de compte**) |
| 2 | `client/index.html` | `viewport-fit=cover` — rend enfin actifs les 14 `env(safe-area-inset-*)` du code |
| 3 | `server/src/routes/push.routes.ts`, `server/src/services/push.service.ts` | `removeSubscription` scopé au propriétaire (IDOR) |
| 4 | `client/src/app/pages/ProPage.tsx`, `client/src/app/i18n/index.tsx` | Suppression de la mention « Mode démo — Stripe pas branché » |
| 5 | `client/src/app/services/jwt.ts` *(nouveau)*, `AuthContext.tsx`, `AuthCallback.tsx` | Décodage base64url + UTF-8 (déconnexions aléatoires, échecs Google intermittents) ; champs JWT inexistants rendus explicites |
| 6 | `client/src/app/context/BlockContext.tsx` | Réinitialisation au changement de compte (fuite de la liste de blocage) |
| 7 | `client/src/app/components/brand/IceedgeLogo.tsx`, `client/public/sw.js`, 3 PNG générés | Logo 1,49 Mo → 8/24/49 ko avec `srcSet` |
| 8 | `034_manual_data.sql`, `manualData.service.ts`, `manual.routes.ts`, `injuryStore/refereeStore/scratches/startingGoalies`, `nhlPredictions`, `featureEngineering`, `cleanup.service`, `app.ts`, `schemas.ts` + carte admin et service côté client | Saisie manuelle en base — les quatre facteurs morts en production revivent, et la saisie devient faisable depuis le téléphone |
| 9 | `httpError.ts` *(nouveau)* + 12 fichiers, 93 handlers | Une seule règle de mise en forme des erreurs ; plus aucun message interne dans une réponse, et les 5xx enfin journalisés |
| 10 | `profile.service.ts`, `SettingsTab.tsx`, `types/user.tsx`, `userService.ts`, `i18n` | Clé OpenAI en écriture seule — elle ne sort plus de la base, et elle ne s'efface plus par accident |
| 11 | `validation/schemas.ts`, `middleware/rateLimit.middleware.ts`, `routes/ml.routes.ts`, `routes/ml.routes.test.ts` *(nouveau)*, `validation/schemas.test.ts` | `/api/predict/*` borné : six schémas zod et `predictLimiter` (60/min) sur les deux routes qui appellent le service Python |
| 12 | `services/refereeStore.ts`, `services/refereeStore.test.ts` + `__fixtures__/str-2025-11-18.html` *(nouveaux)*, `manualData.service.ts`, `cleanup.service.ts`, `routes/manual.routes.ts`, `routes/manual.routes.test.ts` | Facteur arbitre : parseur réécrit (il **inventait** des noms), tendances auto-alimentées depuis STR, dénominateur mesuré au lieu du 6,2 en dur — et un relevé de couverture pour que quatre tables vides ne repassent plus inaperçues |

| 13 | `services/llmPrompts.ts` *(nouveau)*, `routes/llm.routes.ts`, `routes/llm.routes.test.ts` *(nouveau)*, `routes/odds.routes.ts`, `routes/chat.routes.ts`, `routes/push.routes.ts`, `routes/subscription.routes.ts`, `validation/schemas.ts` + `.test.ts`, `services/nhlApiClient.ts`, `server.ts`, `client/.../llmService.ts`, `client/.../PredictionSheet.tsx` | **Lot sécurité serveur du 2026-09-08.** Invite système construite par le serveur depuis un `taskType` fermé (le chemin Pro n'est plus un proxy LLM généraliste) · zod complété sur le chat, `/push/subscribe` et `/subscription/redeem` · timeout de 8 s sur le proxy odds, le dernier `fetch` sortant sans borne · `NHL_USE_MOCK` ignoré en production sans second interrupteur |

`npx tsc --noEmit` passe sur le client **et** sur le serveur après ces changements, et la suite de tests serveur est verte : **348 tests, 29 fichiers** (dont 8 pour le câblage de `/api/predict/*`, 30 pour ses schémas, 10 pour le facteur arbitre contre un vrai billet, 4 pour la couverture, et 5 qui lisent le corps réellement envoyé au fournisseur LLM).

| 14 | `styles/theme.css`, `pages/league/chat/RoomChat.tsx`, `MembersModal.tsx`, `hooks/useChatSocket.ts`, `context/AuthContext.tsx`, `services/shareImage.ts`, `pages/bet/MySlipsTab.tsx`, `pages/profile/ProfilePage.tsx`, `i18n/index.tsx` | **Lot « ce que le doigt touche » du 2026-09-08.** Dialogues système → `ConfirmDialog`/`toast` (+ 14 clés i18n) · réglages tactiles iOS · `maxLength` + compteur sur le chat · partage d'image qui échoue visiblement · auto-scroll qui respecte la lecture · fusion de l'historique au montage · avatar rechargé au démarrage |

| 15 | `context/BetContext.tsx`, `services/authService.ts`, `hooks/useChatSocket.ts` | **Lot performance du 2026-09-11.** Probabilité du coupon calculée côté client (`useMemo`), la formule du serveur recopiée à l'identique, route `/predict/parlay` laissée en place pour la corrélation future · jeton d'accès renouvelé à `exp - 60 s`, **vérifié à l'envoi** et partagé avec le handshake du socket · le `catch` de `doRefresh` n'efface plus la session quand le serveur n'a rien répondu |

| 16 | `server/src/socket.ts`, `server/src/services/chat.service.ts` | **Lot invités du 2026-09-11.** Handshake socket sans jeton accepté comme invité (lecture seule, salons publics via `isPublicRoom`) ; un jeton présent mais invalide reste refusé, donc le refresh du socket est intact. Aucun changement client |

⚠️ **Ni le 15ᵉ ni le 16ᵉ lot n'ont été vérifiés à la compilation** : la passerelle vers le
poste Windows ne monte plus les fichiers depuis la mise à jour du 2026-09-08,
donc ni `tsc --noEmit`, ni `vitest`, ni `vite build` n'ont pu tourner sur le
code réellement écrit. Les cinq fichiers ont été relus isolément (syntaxe,
imports, variables inutilisées) et rien d'autre. **À faire avant de committer :
`npm run typecheck` dans `client/` et dans `server/`, `npm test` côté serveur,
puis `npm run build`.**

**Vérifié dans le conteneur cloud le 2026-09-08**, sur une installation Linux fraîche du lockfile — `tsc --noEmit` serveur et client, `vitest run` (348/348), `vite build` web **et** `VITE_TARGET=ios`. Les empreintes `md5sum` des 9 fichiers serveur modifiés ont été comparées des deux côtés avant de lancer quoi que ce soit, donc c'est bien le code du disque qui a tourné.

---

## 10. Résumé

### 🔴 À corriger absolument avant le freeze iOS

**10 faits sur 11 au 2026-09-06.** Le seul non fait est le `tokenStore` natif,
que l'audit range lui-même en phase 3. Le vrai verrou avant le tag n'est pas
dans cette table : **c'est l'adresse de support, qui rebondit encore** (voir
l'en-tête).

| | Sujet | État |
|---|---|---|
| 1 | CORS previews Vercel → prise de contrôle de compte | ✅ CORRIGÉ |
| 2 | `viewport-fit=cover` manquant → safe areas inertes | ✅ CORRIGÉ |
| 3 | Mention « mode démo Stripe » en production | ✅ CORRIGÉ |
| 4 | `BottomNav` sans `safe-area-inset-bottom` | ✅ CORRIGÉ |
| 5 | Champs < 16 px → zoom iOS irréversible | ✅ CORRIGÉ |
| 6 | Cibles tactiles 28-32 px (envoi chat en premier) | ✅ CORRIGÉ |
| 7 | Page `/share/:id` « bientôt disponible » (Guideline 2.1) | ✅ CORRIGÉ — page et route supprimées |
| 8 | Décision Pro sur iOS : IAP ou retrait complet (Guideline 3.1.1) | ✅ TRANCHÉ 2026-09-06 — build v1 sans Pro sur iOS (`features.proUpgrade`) ; IAP reporté en phase 3 |
| 9 | Chat : resync au retour au premier plan + `connect_error` | ✅ CORRIGÉ |
| 10 | Fichiers de données jamais copiés dans `dist/` (blessures, arbitres, gardiens) | ✅ CORRIGÉ — passés en base |
| 11 | `tokenStore` natif absent → session perdue toutes les 15 min en WKWebView | phase 3, à planifier |

### 🟠 Importants, peuvent attendre un peu

~~Coupon non persisté~~ ✅ · ~~aucun timeout de requête ni bouton « Réessayer »~~ ✅ · ~~`autoComplete` pour le Trousseau iOS~~ ✅ · ~~message de chat échoué qui reste affiché~~ ✅ · ~~`email_verified` Google~~ ✅ · ~~jeton d'accès dans l'URL + Sentry sans `beforeSend`~~ ✅ · ~~erreurs transformées en états vides (Ligue)~~ ✅ (accueil, classement et « Mes coupons ») · ~~401 LLM confondu avec 401 de session~~ ✅ · ~~`/api/odds/live` qui sert des cotes fictives~~ ✅ · ~~`typecheck` client absent de la CI~~ ✅.

**Le groupe 🟠 est vide.** Ce qui reste est 🟡 ou 🟢, plus le `tokenStore` natif de phase 3 — et l'adresse de support, qui n'est pas du code.

### 🟡 Améliorations recommandées

~~Texte 8-10 px (351 occurrences)~~ ✅ plancher de 11 px, 283 classes + 6 règles CSS · ~~`systemPrompt` piloté par le client~~ ✅ · ~~validation zod partielle~~ ✅ · ~~timeout du proxy odds~~ ✅ · ~~`NHL_USE_MOCK` non bridé en production~~ ✅ · ~~aller-retour réseau pour le parlay~~ ✅ · ~~rafraîchissement proactif du jeton~~ ✅ · `confirm()`/`alert()` système · `<label>` + `role="alert"` sur les formulaires · `<html lang>` et détection de langue · ~~chat figé pour les invités~~ ✅ · partage d'image qui échoue en silence · réglages tactiles iOS (`tap-highlight`, `user-select`, `overscroll`) · `.fuse_hidden…` versionné · `@figma/my-make-file` et react en peerDependency optionnelle · prix codé en dur · tu/vous · cache client des requêtes.

**Après le 3ᵉ passage du 2026-09-08**, sept 🟡 de plus sont tombés :
~~`confirm()`/`alert()` système~~ ✅ · ~~réglages tactiles iOS~~ ✅ ·
~~`maxLength` du chat~~ ✅ · ~~partage d'image muet~~ ✅ · ~~auto-scroll~~ ✅ ·
~~course historique/socket~~ ✅ · ~~pseudo et avatar vides~~ ✅.

**Après les deux lots du 2026-09-11**, trois 🟡 de plus sont tombés :
~~aller-retour réseau pour le parlay~~ ✅ · ~~rafraîchissement proactif du
jeton~~ ✅ · ~~chat figé pour les invités~~ ✅.

**Ce qui reste ouvert tient en trois lignes**, et rien n'y est de la sécurité :
`AppShell`/clavier (mis de côté, voir ci-dessous) · cache client des requêtes ·
`NHLPredictionsPage` qui transforme encore une erreur en état vide · les
reliquats de scaffolding (`@figma/my-make-file`, react en peerDependency) · prix
codé en dur · tu/vous · et le 🟢 « Divers » du § 1 (deux routeurs sur
`/api/users`, `EMAIL_VERIFICATION_DISABLED` écarté sur décision du user).

⚠️ **`AppShell` (`w-screen h-screen overflow-hidden` → `100dvh`) et la gestion
du clavier (`visualViewport`) sont mis de côté volontairement** (décision du
2026-09-08) : c'est le seul changement encore *architectural*, il touche toutes
les pages et peut déplacer les trois blocs calés sur la safe area du bas. À
faire à part, avec une vérification à l'écran sur un vrai iPhone. **Le clavier
reste non géré en v1.**

### 🟢 Ce qui est déjà très bien fait

Il faut le dire, parce que c'est loin d'être la norme :

- **L'authentification est sérieuse.** Rotation atomique des refresh tokens en un seul `UPDATE … RETURNING` avec fenêtre de grâce et coalescence côté client **et** serveur ; jetons stockés hachés ; bcrypt natif hors event loop ; codes OTP salés avec plafond de tentatives ; réponses neutres anti-énumération ; `logout-all`. Le raisonnement derrière chaque choix est écrit dans le code.
- **Le rate limiting** à cinq niveaux, avec une clé compte-ou-IP qui tient compte du NAT mobile, et une justification honnête de ce que ça ne protège pas.
- **La discipline sur les caches** : plafonds partout, avec la leçon de l'OOM documentée à l'endroit exact où elle a été apprise.
- **`env.ts` et `platform.ts`** sont deux très bonnes pièces d'ingénierie. Le déploiement en deux temps de la validation d'environnement, l'écran d'erreur en DOM brut, et la vérification que `lazy()` conditionnel supprime réellement les chunks du bundle iOS — c'est du travail de niveau professionnel.
- **La suppression des prédictions mockées** (`PredictionUnavailableError`, « un chiffre faux qui a l'air juste est pire que pas de chiffre ») est exactement le bon arbitrage pour une app de paris.
- **Le nécessaire Guideline 1.2 est là et bien fait** : signalement, blocage réversible et expliqué, file de modération, règles accessibles depuis le chat, adresse de support publiée.
- **L'infra** : Dockerfile non-root avec tini et healthcheck, arrêt gracieux, liveness/readiness séparés avec un raisonnement sur le coût Neon, gitleaks sur toutes les entrées de `master`, CSP stricte.
- **Quasi zéro dette visible** : 0 `TODO`/`FIXME`, 0 `@ts-ignore`, 0 `dangerouslySetInnerHTML`, tous les `<img>` ont un `alt`, presque aucun fichier orphelin, `tsc --noEmit` propre des deux côtés.

Le niveau de commentaire explicatif — pas « ce que fait le code » mais « pourquoi, et ce qui a cassé avant » — est le meilleur atout de ce dépôt. Les défauts trouvés sont majoritairement **des choses invisibles depuis le web et qui ne se manifestent que sur iPhone**, ce qui est cohérent : c'est le premier audit vraiment orienté iOS.

---

## 11. Checklist finale pré-freeze iOS

**Bloquant**
- [x] ~~`BottomNav` : `bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px))`~~ → fait, avec `LockSlipCTA` et les marges basses des 11 pages. **Reste :** le voir sur un iPhone à encoche
- [ ] Vérifier visuellement toutes les pages sur iPhone à encoche maintenant que `viewport-fit=cover` est actif
- [x] ~~`input, textarea, select { font-size: 16px }` global~~ → posé dans `theme.css`, hors `@layer`, sous `@media (pointer: coarse)`. **Reste :** vérifier la rangée du chat sur téléphone
- [x] ~~Élargir à 44×44 pt : envoi du chat, retour, `⋯`, onglets de la nav~~ → 43 boutons, `.tap-44` ou vrais `min-w`/`min-h`. **Les onglets de la nav étaient déjà à 52×47**, mesurés — rien à y faire. **Reste :** l'essayer au doigt
- [x] ~~Supprimer la route et la page `/share/:id`~~ → faite le 2026-09-06, liaison `lazy()` comprise
- [x] ~~Trancher Pro sur iOS~~ → tranché le 2026-09-06 : build v1 sans Pro sur iOS (`features.proUpgrade`), bouton, prix **et** code promo retirés
- [x] ~~Socket : resync de l'historique sur `connect`, écouteur `connect_error` avec refresh, affichage de `room_error`~~ → `resyncKey` + fusion, un refresh par cycle via `refreshSession()`, bandeau. **Reste :** l'essayer sur un vrai téléphone (verrouiller l'écran deux minutes)
- [x] ~~Copier `src/data/*.json` dans `dist/`~~ → migré en base (034). **Reste :** appliquer la migration en prod avant de déployer le serveur
- [ ] Vérifier `CORS_ORIGIN` en production et tester une preview Vercel après le déploiement du correctif CORS
- [ ] Vérifier après déploiement que la carte admin (Profil → Paramètres → Saisie manuelle) affiche bien « une clé est enregistrée » et que modifier sa bio ne l'efface pas
- [ ] Planifier `nativeStore` (`@capacitor/preferences`) pour la phase 3

**Important**
- [x] ~~Helper `sendError()` unique ; retirer `detail`, `raw` et le message `psql …` des réponses~~ → `httpError.ts`, 93 handlers
- [x] ~~`GET /users/me` : renvoyer `hasOpenaiKey` au lieu de la clé~~ (sans `last4` : le calculer imposerait de déchiffrer à chaque lecture)
- [x] ~~Persister le coupon (`BetContext`) dans le stockage local~~ → `iceedge_slip`, TTL 12 h depuis la jambe la plus récente, relecture défensive. 13 assertions vertes
- [x] ~~`AbortSignal.timeout(15000)` dans les helpers `request()` + boutons « Réessayer »~~ → `http.ts` (`AbortController`, pas `AbortSignal.timeout` : iOS 16+) à 15 s / 45 s pour `/llm`, `ErrorState` sur 5 écrans. 16 assertions vertes
- [x] ~~Supprimer `/share/:id`~~ → page dans `_to_delete/`, route **et** liaison `lazy()` retirées, 4 clés i18n supprimées. Aucun `SharePage-*.js` dans les deux builds
- [x] ~~Décision Pro sur iOS~~ → `features.proUpgrade` ; `/pro` et `/pro/success` absentes du build iOS (chunks vérifiés), champ promo et prix avec. ⚠️ contenu Pro verrouillé sans CTA — à relire avant de soumettre
- [x] ~~Plancher de 11 px sur le texte~~ → 283 classes Tailwind + 6 règles CSS ; les 3 écrans internes non touchés (hors build iOS). Prouvé en grepant `dist/assets/*.css`. ⚠️ à vérifier à l'œil (nav, badges, libellés à fort interlettrage)
- [x] ~~`autoComplete` sur tous les champs de `LoginPage`~~ → 9 champs, mot de passe conditionnel `current-`/`new-`, + `aria-label`, `role="alert"`/`role="status"`, `<html lang>` et détection de `navigator.language`
- [x] ~~Chat : retirer la bulle optimiste en cas d'échec et restaurer le texte~~ → + `tag` et `replyTo` restaurés ; pas de file de renvoi (le texte revient, renvoyer = ré-appuyer)
- [x] ~~Vérifier `email_verified` dans `loginWithGoogle`~~ → refus **par défaut** (`!== true`), garde avant `pool.connect()`, code `google_unverified` visible à l'écran, 4 tests
- [x] ~~Schémas zod sur `/api/predict/*`~~ → six schémas + `predictLimiter` (60/min) sur `/ml` et `/factors`
- [x] ~~`beforeSend` Sentry qui masque `access_token` ; jeton dans le fragment~~ → fragment + `history.replaceState` + `beforeSend` **et** `beforeBreadcrumb`. ⚠️ repli `?access_token=` gardé pour la fenêtre de déploiement, à retirer ensuite
- [x] ~~`LeaguePage` : distinguer « vide » de « en erreur »~~ → fait avec le lot « Réessayer » (accueil et « Mes coupons » aussi)
- [x] ~~Supprimer `/api/odds/live` et `/api/odds/game/:gameId` (cotes fictives)~~ → routes, `odds.service.ts` et `data/mock.ts` retirés
- [x] ~~Ajouter `npm run typecheck` au job client de la CI~~ → avant `npm run build`, pour échouer vite
- [x] ~~`git rm server/src/services/.fuse_hidden0000000e00000001`~~ → déplacé dans `_to_delete/`
- [ ] 401 LLM : ~~confondu avec un 401 de session~~ ✅ corrigé — le serveur rend 502 + `code: invalid_api_key`

**Ordre de déploiement de ce qui est déjà fait**
1. `npm run db:migrate:all` avec le `DATABASE_URL` de **production** (migration 034).
2. Déployer le serveur. Avant l'étape 1, toutes les lectures de saisie manuelle retombent en neutre — avec un `warn` dans les journaux, plus en silence.
3. Déployer le client. Aucun ordre imposé avec le serveur : un ancien bundle resté en cache affichera un champ de clé vide au lieu de la clé, et son `openaiApiKey: null` est désormais ignoré côté serveur — il ne peut plus rien effacer.

**Avant de soumettre**
- [ ] `npm audit` sur `client/` et `server/` (n'a pas pu tourner ici — le réseau du poste bloquait le registre)
- [ ] Vérifier sur Railway : `NHL_USE_MOCK`, `EMAIL_VERIFICATION_DISABLED`, `API_RATE_LIMIT`, `DORMANT` — toutes absentes ou à `false`
- [ ] Vérifier que `ENABLE_DEV_ROUTES` n'est **pas** à `true` en production
- [ ] Confirmer que Railway lit bien `/health/ready`
- [ ] Ouvrir la file de modération et la vider — Apple demande le processus, pas seulement le bouton
- [ ] Vérifier l'adresse de support publiée (`support.arakice@gmail.com`) : boîte accessible, réponse testée
- [ ] Tester le parcours complet sur un vrai iPhone : inscription → code e-mail → coupon → chat → verrouillage d'écran 5 min → retour
- [ ] Tester en mode Avion et en réseau très lent (Network Link Conditioner)
