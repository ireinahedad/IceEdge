# Audit pré-freeze iOS — ArakIce / IceEdge

**Date :** 2026-09-04 · **Périmètre :** `client/` (52 k lignes TS/TSX), `server/` (TS/Express), `.github/`, config de build
**Méthode :** lecture intégrale des routes, services, contextes et middlewares ; `tsc --noEmit` client + serveur (0 erreur) ; inspection de `dist/`, `public/`, CI, Dockerfile, CSP.

> **Correctifs déjà appliqués** (7, non commités — voir § 9). Chaque finding corrigé porte la mention ✅ **CORRIGÉ**.

---

## 1. Sécurité

### 🔴 [CRITICAL] La regex des previews Vercel autorisait n'importe quel compte Vercel ✅ CORRIGÉ
**Fichier :** `server/src/cors.ts`

- **Problème :** `vercelPreview = /^https:\/\/ice-edge[a-z0-9-]*\.vercel\.app$/i` accepte `https://ice-edge-nimportequoi.vercel.app`. Or un sous-domaine `<projet>.vercel.app` est attribué **au premier arrivé, sur n'importe quel compte Vercel**. Il suffisait de créer un projet nommé `ice-edge-x` pour obtenir une origine autorisée par ton API.
- **Impact :** avec `cors({ credentials: true })` et le cookie de refresh en `SameSite=None`, une page hébergée sur cette origine pouvait faire `fetch('https://api.arakice.com/api/auth/refresh', {credentials:'include'})` **et lire la réponse** — donc repartir avec un `access_token` valide et un refresh token tourné. **Prise de contrôle de compte complète, sans XSS**, pour tout visiteur connecté qui ouvre le lien.
- **Solution appliquée :** la regex exige désormais le slug d'équipe (`-ireina-hedad-s-projects`), qui n'est pas attribuable à un tiers. Surchargeable par `VERCEL_TEAM_SLUG`. Le domaine de production reste déclaré explicitement dans `CORS_ORIGIN`.
- **À faire de ton côté :** vérifier que `CORS_ORIGIN` contient bien `https://arakice.com` (+ `https://www.arakice.com` si utilisé) et tester une preview après déploiement.

### 🟠 [HIGH] Fuite d'informations internes dans les réponses d'erreur
**Fichiers :** `ml.routes.ts`, `llm.routes.ts`, `odds.routes.ts`, `app.ts` (leaderboard), `auth.routes.ts`, `profile.routes.ts`, `chat.routes.ts`, `slip.routes.ts`

- **Problème :** le handler d'erreur global d'`app.ts` masque correctement les 5xx en production (`'Internal server error'`). Mais **presque toutes les routes répondent elles-mêmes** avec `res.status(err.status ?? 500).json({ error: err.message })` — elles court-circuitent donc cette protection. Cas les plus parlants :
  - `POST /api/predict/ml` → `{ error: 'ML service unavailable', detail: err.message }` (expose l'URL/hôte du service ML)
  - `POST /api/llm` → `message: 'Database migration 005 not applied. Run: psql -d IceedgeDB -f src/db/migrations/005_openai_key.sql'` (nom de base + arborescence)
  - `POST /api/llm` → relaie le corps d'erreur **brut** du fournisseur (`raw`), qui peut contenir des identifiants d'organisation
- **Impact :** cartographie gratuite de ton infrastructure pour un attaquant. Aucune de ces chaînes n'aide un utilisateur.
- **Solution recommandée :** un helper unique `sendError(res, err)` qui applique la même règle que le handler global (message réel pour 4xx, générique pour 5xx en prod) et l'utiliser partout. Supprimer `detail`, `raw` et le message de migration des réponses.

### 🟠 [HIGH] `GET /api/users/me` renvoie la clé OpenAI en clair
**Fichier :** `server/src/services/profile.service.ts:112`

- **Problème :** `openaiApiKey: profile.openaiApiKey ? decryptSecret(...) : null`. La clé est chiffrée au repos (bien), puis **déchiffrée et renvoyée intégralement au client à chaque chargement de profil**.
- **Impact :** la clé traverse le réseau à chaque montage du profil, vit dans la mémoire JS de l'onglet, et devient capturable par n'importe quelle extension, outil de débogage ou intégration analytique. Le chiffrement au repos ne protège plus grand-chose si le secret ressort à la demande.
- **Solution recommandée :** renvoyer `hasOpenaiKey: boolean` + `openaiKeyLast4: string`. L'écran Paramètres affiche `sk-…a1b2` et un bouton « Remplacer » ; pour changer la clé on la ressaisit. `SettingsTab.tsx:109` (`useState(profile.openaiApiKey ?? "")`) devient `useState("")`.

### 🟡 [MEDIUM] Google : `email_verified` n'est pas vérifié avant le rattachement de compte
**Fichier :** `server/src/services/auth.service.ts` (`loginWithGoogle`)

- **Problème :** l'interface `GoogleUserInfo` ne lit pas `email_verified`, et `loginWithGoogle` rattache un compte Google à un compte mot-de-passe existant **sur la seule égalité d'adresse e-mail**.
- **Impact :** si Google renvoie une adresse non vérifiée (cas résiduel, notamment sur certains comptes Workspace), le rattachement donne accès à un compte existant.
- **Solution recommandée :** ajouter `email_verified?: boolean` à `GoogleUserInfo` et refuser (`403`) quand il vaut `false`.

### 🟡 [MEDIUM] `POST /api/push/unsubscribe` — IDOR ✅ CORRIGÉ
**Fichiers :** `server/src/routes/push.routes.ts`, `server/src/services/push.service.ts`

- **Problème :** `removeSubscription(endpoint)` supprimait par endpoint seul. N'importe quel compte authentifié pouvait désabonner un **autre** utilisateur.
- **Impact :** notifications coupées pour la victime, sans qu'elle sache pourquoi. Difficulté d'exploitation faible (l'endpoint est opaque) mais la faille d'autorisation est réelle.
- **Solution appliquée :** `DELETE … WHERE endpoint = $1 AND user_id = $2`.

### 🟡 [MEDIUM] `/api/predict/*` : public, sans validation, et coûteux
**Fichier :** `server/src/routes/ml.routes.ts` (aucun `router.use`)

- **Problème :** `POST /single`, `/parlay`, `/factors`, `/player-prop`, `/futures`, `/ml` et `GET /best-bets` sont ouverts à tous, sans schéma zod. Ils déclenchent des appels vers l'API NHL, `buildRealFactors`, `buildGameFeatures` et le service ML Python.
- **Impact :** amplification — une requête entrante gratuite génère plusieurs requêtes sortantes coûteuses. Seul `apiLimiter` (300/min/IP) freine. `/parlay` accepte des `probability` non validées (`NaN` → `combinedProbability: NaN` renvoyé au client).
- **Solution recommandée :** schémas zod sur les six routes (bornes sur `line`, `limit`, `days`, `legs.length ≤ 20`, `probability ∈ [0,100]`), et envisager `optionalAuthenticate` + limiteur dédié plus strict sur `/ml` et `/factors`.

### 🟡 [MEDIUM] `systemPrompt` piloté par le client sur le chemin Pro
**Fichier :** `server/src/routes/llm.routes.ts`

- **Problème :** `prompt` **et** `systemPrompt` viennent du corps de requête, et le chemin Pro utilise `GITHUB_MODELS_TOKEN`, **facturé à toi**.
- **Impact :** tout compte Pro (y compris via essai gratuit ou code promo) dispose d'un proxy LLM généraliste à tes frais, dans la limite du quota mensuel. Le quota borne la dépense, pas l'usage détourné.
- **Solution recommandée :** construire le `systemPrompt` côté serveur à partir d'un `taskType` fermé (`'explain_bet' | 'summarize_game' | …`) envoyé par le client.

### 🟡 [MEDIUM] Jeton d'accès dans l'URL + Sentry sans `beforeSend`
**Fichiers :** `server/src/routes/auth.routes.ts` (callback Google), `client/src/main.tsx`

- **Problème :** le serveur redirige vers `/auth/callback?access_token=eyJ…`. Côté client, `Sentry.init` n'a **pas** de `beforeSend`, et Sentry attache l'URL de la page à chaque événement et fil d'Ariane.
- **Impact :** un jeton d'accès valide 15 min peut se retrouver dans Sentry, dans l'historique du navigateur, et dans l'en-tête `Referer` de toute sous-ressource chargée par cette page.
- **Solution recommandée :** passer le jeton dans le **fragment** (`#access_token=`, jamais envoyé au serveur ni loggé) ; appeler `history.replaceState` dès le premier effet ; ajouter un `beforeSend` qui remplace `access_token=…` par `access_token=[redacted]` dans `event.request.url` et les breadcrumbs.

### 🟡 [MEDIUM] Validation zod partielle
`validateBody` n'est posé que sur auth, slips, avatar et profil. Absent sur : chat (`/rooms`, `/messages`, `/reactions`, `/report`), `PUT /api/injuries/:key`, `/api/push/subscribe`, `/api/subscription/redeem`, et tout `/api/predict/*`. Le chat compense par une sanitisation serveur solide (`chat.service.ts` : `stripControlChars`, `MAX_TEXT_LENGTH`, `slice`) ; les autres non.

### 🟢 [LOW] Divers
- **Deux routeurs montés sur `/api/users`** (`profileRoutes` puis `userRoutes`) : une route ajoutée dans le second peut être silencieusement masquée par le premier, et `authenticate` s'exécute deux fois sur `/me/*`. Fusionner ou préfixer.
- **`NHL_USE_MOCK` et `EMAIL_VERIFICATION_DISABLED` ne sont pas bridés en production.** Une variable posée par erreur sur Railway sert des données NHL fictives ou désactive la vérification e-mail. La bannière de démarrage les affiche (bien) mais rien ne les empêche. Forcer `false` quand `NODE_ENV === 'production'`.
- **Aucun timeout sur les `fetch` du proxy odds** (`odds.routes.ts`), alors que `nhlApiClient`, `mlApiClient` et `llm.routes` en ont un. Un upstream lent bloque une connexion.

---

## 2. iOS / Mobile

### 🔴 [CRITICAL] `viewport-fit=cover` manquant — toutes les safe areas valaient 0 ✅ CORRIGÉ
**Fichier :** `client/index.html`

- **Problème :** `<meta name="viewport" content="width=device-width, initial-scale=1.0">`. **Sans `viewport-fit=cover`, `env(safe-area-inset-*)` vaut 0 px sur iPhone.** Les 14 endroits du code qui font `paddingTop: "env(safe-area-inset-top, 0px)"` étaient donc **entièrement inopérants**.
- **Impact :** aggravé par `apple-mobile-web-app-status-bar-style: black-translucent`, déjà présent : en PWA installée, le contenu passe **déjà aujourd'hui** sous la barre d'état. Dans le WKWebView Capacitor, il passera sous l'encoche **et** sous l'indicateur d'accueil.
- **Solution appliquée :** `viewport-fit=cover` ajouté. **À vérifier visuellement sur un iPhone à encoche** : maintenant que les insets sont réels, les en-têtes vont descendre — c'est le comportement voulu, mais l'espacement mérite un coup d'œil.

### 🔴 [CRITICAL] La barre de navigation ignore la safe area du bas
**Fichier :** `client/src/app/components/BottomNav.tsx`

- **Problème :** `className="fixed bottom-3 …"` — 12 px du bas, sans `env(safe-area-inset-bottom)`. Sur iPhone l'indicateur d'accueil occupe 34 pt.
- **Impact :** la barre chevauche l'indicateur d'accueil ; les onglets du bas deviennent difficiles à toucher et le geste de retour à l'accueil se déclenche à leur place. C'est **le** défaut que les testeurs remarquent en premier.
- **Solution recommandée :** `style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))" }}`. Vérifier aussi les `pb-24` des pages qui réservent la place de la barre.

### 🟠 [HIGH] Champs de saisie sous 16 px → zoom automatique iOS
**Fichiers :** `LoginPage.tsx` (`text-sm` = 14 px), `RoomChat.tsx` (`text-xs` = 12 px), et la plupart des 38 `<input>`

- **Problème :** Safari/WKWebView **zoome la page** quand on met le focus sur un champ dont la `font-size` est < 16 px, et ne dézoome pas ensuite.
- **Impact :** à chaque tap sur « e-mail », « mot de passe » ou l'input du chat, la page saute et reste zoomée. C'est le comportement qui dit le plus clairement « ceci est un site web dans une coquille ».
- **Solution recommandée :** `input, textarea, select { font-size: 16px; }` dans le CSS global (le rendu visuel change peu, la taille perçue reste proche). Ne **pas** utiliser `maximum-scale=1` pour le contourner : ça casse le zoom d'accessibilité et Apple le relève.

### 🟠 [HIGH] Cibles tactiles sous 44 pt
- Bouton d'envoi du chat : `w-7 h-7` = **28 px**
- Retour, icône du salon, menu `⋯` : `w-8 h-8` = **32 px**
- 41 occurrences de `w-6/7/8 h-6/7/8` sur des éléments cliquables
- **Impact :** taux d'erreur de tap élevé, en particulier pour l'envoi de message. Le minimum HIG est 44×44 pt.
- **Solution recommandée :** garder l'icône visuellement petite mais élargir la zone : `p-2 -m-2` ou une classe utilitaire `min-w-[44px] min-h-[44px] flex items-center justify-center`.

### 🟠 [HIGH] Le stockage natif des jetons n'existe pas encore
**Fichier :** `client/src/app/services/tokenStore.ts`

- **Problème :** le serveur a déjà tout le chemin natif (`X-Client: native`, `isNativeClient`, refresh dans le corps — R3.1/R3.2, propre et bien gardé). Côté client, `tokenStore` n'a **qu'une implémentation web**, et `@capacitor/preferences` n'est pas dans `package.json`.
- **Impact :** en l'état, le build iOS perd la session **toutes les 15 minutes** (WKWebView jette le cookie `SameSite=None`) sans aucun moyen de récupérer.
- **Solution recommandée :** c'est du travail de phase 3, mais il doit être **dans le plan de freeze**, pas après. La couture est déjà prête (`TokenStore` est une interface, toutes les méthodes sont `async`) — il ne manque que `nativeStore`.

### 🟠 [HIGH] Le chat ne survit pas au retour au premier plan
**Fichiers :** `client/src/app/hooks/useChatSocket.ts`, `RoomChat.tsx`

Trois défauts qui se cumulent, tous visibles dès le premier verrouillage d'écran :
1. **Aucune resynchronisation après reconnexion.** Le handler `connect` fait `socket.emit('join_room')` et rien d'autre. Les messages arrivés pendant que l'app était en arrière-plan sont **perdus définitivement** — trou silencieux dans la conversation.
2. **Aucun écouteur `connect_error`.** Le jeton d'accès expire au bout de 15 min ; le serveur refuse alors le handshake (`Invalid or expired token`) et **rien ne déclenche de refresh**. Socket.io réessaie en boucle, le chat est mort, l'utilisateur ne voit qu'un point gris.
3. **`room_error` est émis par le serveur mais jamais écouté côté client.** Un accès refusé laisse l'utilisateur dans un salon qui ne reçoit rien, sans message.
- **Solution recommandée :** sur `connect`, refaire l'appel HTTP d'historique et le fusionner (au lieu de `initMessages` qui écrase) ; sur `connect_error` contenant « token », appeler le refresh puis `socket.connect()` ; afficher `room_error`.

### 🟠 [HIGH] Le coupon est perdu à chaque mise en arrière-plan
**Fichier :** `client/src/app/context/BetContext.tsx`

- **Problème :** `useState<BetLeg[]>([])`, aucune persistance.
- **Impact :** iOS purge régulièrement les WKWebView en arrière-plan. Un utilisateur qui construit un coupon à 5 jambes, reçoit un appel et revient **repart de zéro**. Sur le web, un simple rechargement suffit aussi.
- **Solution recommandée :** persister `legs` dans `localStorage` (et `@capacitor/preferences` en natif) avec un TTL court, dans un `useEffect`. ~15 lignes.

### 🟠 [HIGH] Aucun timeout de requête, aucun bouton « Réessayer »
- **Problème :** `grep AbortController|AbortSignal` sur tout `client/` → **0 résultat**. `grep -i retry|réessayer` → **0 résultat**.
- **Impact :** c'est exactement le scénario « mauvaise connexion » que tu redoutes. Sur un réseau mobile dégradé, un `fetch` peut rester en attente une minute sans que l'écran change ; et quand il échoue, le seul recours de l'utilisateur est de tuer l'app. Le serveur, lui, a bien des timeouts partout.
- **Solution recommandée :** ajouter `signal: AbortSignal.timeout(15000)` dans les helpers `request()` de `nhlApiService`, `predictionApiService` et `authedFetch` ; ajouter un bouton « Réessayer » aux états d'erreur des pages principales.

### 🟡 [MEDIUM] `autoComplete` absent des champs de connexion
**Fichier :** `client/src/app/pages/LoginPage.tsx`

Seuls les champs de code OTP ont `autoComplete="one-time-code"` (bien vu). L'e-mail, le nom d'utilisateur et les mots de passe n'ont rien → **le Trousseau iOS ne propose ni de remplir ni d'enregistrer**. Ajouter `autoComplete="email"` / `"username"` / `"current-password"` / `"new-password"`, plus `autoCapitalize="none"` et `autoCorrect="off"` sur e-mail et nom d'utilisateur.

### 🟡 [MEDIUM] Boîtes de dialogue système
4 `confirm()` + 1 `alert()` (`RoomChat.tsx:143,191,202`, `MembersModal.tsx:33`, `ProfilePage.tsx:99`) — alors que `ConfirmDialog` existe et est utilisé pour le blocage. En WKWebView ces dialogues affichent un titre technique et bloquent le fil. Incohérent, et immédiatement repérable en revue.

### 🟡 [MEDIUM] `AppShell` : `w-screen h-screen overflow-hidden` + défilement imbriqué
**Fichier :** `client/src/app/App.tsx`

`100vh` sur iOS Safari inclut la zone sous la barre d'outils → le bas de l'app est coupé, et `overflow-hidden` empêche la barre d'URL de se replier. Le défilement dans un `<div>` imbriqué plutôt que sur le document casse la restauration de position et surtout le **repositionnement automatique du curseur quand le clavier s'ouvre**. Préférer `100dvh` (avec repli `100vh`) et laisser le document défiler.

### 🟡 [MEDIUM] Le partage d'image échoue en silence
**Fichiers :** `client/src/app/services/shareImage.ts`, `MySlipsTab.tsx:30`

- `toPng` avec `cacheBust: true` sur une carte contenant des logos NHL cross-origin → **canvas contaminé** → `SecurityError`. L'erreur n'est que `console.warn` : **l'utilisateur tape « Partager » et il ne se passe rien**.
- Le repli `a.download` **ne fonctionne pas** en WKWebView.
- `pixelRatio: 2` sur une grande carte : allocation mémoire notable sur iPhone ancien.
- **Solution :** `crossOrigin="anonymous"` sur les images de la carte (ou les proxifier), et un `toast.error()` en cas d'échec.

### 🟡 [MEDIUM] Réglages tactiles iOS absents
Aucun `-webkit-tap-highlight-color` (flash gris sur chaque tap), aucun `user-select: none` sur les éléments de chrome (l'appui long sélectionne le texte et ouvre le menu contextuel), aucun `overscroll-behavior` (le rebond fait bouger toute la page). Trois lignes de CSS global qui changent énormément la sensation.

### 🟡 [MEDIUM] Aucune gestion du clavier
`grep visualViewport` → 0 résultat. Combiné à la barre de navigation `fixed` et au défilement imbriqué, l'input du chat peut se retrouver **sous** le clavier.

### 🟢 [LOW]
- `::-webkit-scrollbar { width: 0 }` global : aucune indication de défilement sur desktop.
- Le manifest déclare `orientation: portrait`, mais aucune mise en page paysage n'est prévue — à confirmer dans Xcode (l'iPad exige les 4 orientations si tu vises l'universel).

---

## 3. Fonctionnalités / bugs

### 🟠 [HIGH] Décodage JWT en `atob` — déconnexions aléatoires ✅ CORRIGÉ
**Fichiers :** `AuthContext.tsx`, `AuthCallback.tsx` → nouveau `client/src/app/services/jwt.ts`

- **Problème :** `JSON.parse(atob(token.split('.')[1]))`. Un JWT encode en **base64url**, pas en base64 : `-` et `_` au lieu de `+` et `/`, sans remplissage. `atob` **lève** `InvalidCharacterError` dès que la charge utile produit l'un de ces caractères.
- **Impact :** intermittent et invisible en test. Dans `AuthContext`, le `catch` appelait `tokenStore.clear()` → **l'utilisateur était déconnecté au démarrage, au hasard**. Dans `AuthCallback`, redirection vers `/login` → **connexion Google qui échoue sans message**.
- **Solution appliquée :** module `jwt.ts` avec conversion base64url → base64, remplissage, et décodage UTF-8 (les prénoms accentués étaient aussi mal décodés). Les deux appelants l'utilisent.
- **Bonus corrigé :** `AuthCallback` lisait `payload.username`, `payload.first_name`, `payload.last_name`, `payload.avatar_url` — **aucun de ces champs n'est dans le jeton** (`signAccessToken` ne met que `sub`, `email`, `role`). Les valeurs retombaient toujours sur le défaut. C'est désormais explicite.

### 🟠 [HIGH] La liste de blocage fuit entre comptes ✅ CORRIGÉ
**Fichier :** `client/src/app/context/BlockContext.tsx`

- **Problème :** `requested` est un `useRef` jamais remis à zéro. Après déconnexion et connexion d'un **autre compte sur le même appareil**, `ensureLoaded()` sortait immédiatement.
- **Impact :** le nouvel utilisateur héritait de la liste de blocage du précédent — messages masqués pour la mauvaise personne dans le chat, et **la liste de blocage de quelqu'un d'autre affichée dans ses Paramètres**. Fuite de données entre comptes.
- **Solution appliquée :** un effet suit `user?.id` et réinitialise `requested` + la liste au changement de compte.

### 🟠 [HIGH] Quatre sources de données du modèle sont mortes en production ✅ CORRIGÉ
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
- **Reste à faire de ton côté :** appliquer la migration en production (`npm run db:migrate:all` avec le `DATABASE_URL` de prod) **avant** de déployer le serveur.

### 🟡 [MEDIUM] Un message de chat qui échoue reste affiché comme envoyé
**Fichier :** `RoomChat.tsx` (`sendMessage`)

`setInput("")` puis `appendOptimistic(...)` ; en cas d'échec, le `catch` ne fait que `setErrorMsg`. La bulle optimiste **reste**, donc l'utilisateur croit son message envoyé, et **son texte est perdu** (l'input a été vidé). `removeMessage(tempId)` existe déjà et n'est pas appelé ici. Correctif : retirer la bulle, restaurer `setInput(text)`, et proposer un renvoi.

### 🟡 [MEDIUM] Course entre l'historique HTTP et le socket
`initMessages(msgs)` fait `setMessages(msgs)` — un **remplacement**. Si un message arrive par le socket avant que le `GET /messages` ne réponde, il est écrasé. Fusionner par id plutôt que remplacer.

### 🟡 [MEDIUM] Le 401 du LLM est confondu avec une expiration de session
`llmService.askLLMDetailed` passe par `authedFetch`. Quand la clé OpenAI de l'utilisateur est invalide, le serveur relaie un **401**, et `authedFetch` interprète tout 401 comme « jeton expiré » : il déclenche un refresh, fait tourner le refresh token, puis rejoue la requête (deuxième appel inutile). Si ce refresh échoue au même moment, `tokenStore.clear()` → **l'utilisateur est déconnecté d'ArakIce parce que sa clé OpenAI était mauvaise**. Le serveur devrait répondre `502` avec `code: 'invalid_api_key'`.

### 🟡 [MEDIUM] L'auto-scroll du chat ramène toujours en bas
`useEffect(() => bottomRef.current?.scrollIntoView({behavior:"smooth"}), [visibleMessages.length])` : si l'utilisateur remonte lire l'historique, chaque nouveau message le **renvoie en bas**. De plus `scrollIntoView` fait défiler **tous** les conteneurs ancêtres sur iOS. Ne défiler que si l'utilisateur était déjà près du bas.

### 🟡 [MEDIUM] Les erreurs se transforment en états vides
`LeaguePage.tsx:27-28` : `.catch(() => [])` sur le classement **et** sur les salons. Une panne réseau s'affiche donc comme « il n'y a rien ici ». L'utilisateur ne peut pas distinguer « vide » de « cassé », et il n'a rien à réessayer. Même motif dans `NHLPredictionsPage` (`catch { /* use defaults */ }`).

### 🟡 [MEDIUM] Nom d'utilisateur vide après rechargement
`AuthContext` réhydrate avec `username: ''` et `avatar_url` absent (le jeton ne les contient pas), et rien ne recharge le profil complet au démarrage. Conséquence visible : **l'avatar disparaît de la barre de navigation après chaque rechargement**, remplacé par l'icône générique. Charger le profil dans un effet quand `user` existe.

### 🟡 [MEDIUM] Pas de `maxLength` sur l'input du chat
Le serveur refuse au-delà de 1000 caractères (`MAX_TEXT_LENGTH`) ; le client ne le dit pas. On peut taper 3000 caractères et découvrir l'erreur à l'envoi. Ajouter `maxLength={1000}` + un compteur au-delà de 900.

### 🟢 [LOW]
- `tempId = optimistic_${Date.now()}` : collision si deux messages partent dans la même milliseconde. `crypto.randomUUID()`.
- `GET /api/predict/markets/game/:id` **ignore complètement `:id`** et renvoie une constante — paramètre trompeur.
- `ruleWeightsService.ts:64,71` : `localStorage.setItem` **sans try/catch**, alors que `tokenStore` protège soigneusement les siens. Lève en navigation privée Safari.
- `RoomChat` teste `!e.shiftKey` sur un `<input>` simple ligne : Shift+Entrée n'y fait rien. Soit passer en `<textarea>`, soit retirer la condition.
- `llmService.ts` déclare `const BASE = env.nhlServerUrl` qui **n'est jamais utilisé** (les appels passent par `authedFetch`, qui a sa propre base). Variable morte et trompeuse.

---

## 4. Architecture / code

### 🟡 [MEDIUM] Aucun test ni typecheck côté client dans la CI
`.github/workflows/ci.yml` : le job `client` fait `npm ci`, `npm run build`, `npm run check:env:dist`. Il **ne lance pas `npm run typecheck`** (qui existe pourtant), et il n'existe **aucun test client** — 0 fichier `.test.tsx`. Le serveur, lui, a 14 fichiers de test et un vrai job. Ajouter `npm run typecheck` au job client est gratuit.

### 🟡 [MEDIUM] Le serveur démarre même sans base de données
`server.ts` : `catch (err) { logger.warn('PostgreSQL unavailable - DB features disabled') }` puis il écoute quand même. Un déploiement avec un mauvais `DATABASE_URL` **réussit** ; l'app démarre et toutes les routes auth/profil rendent des 500. La sonde `/health/ready` renvoie bien 503, ce qui limite les dégâts si l'hébergeur la lit — à vérifier sur Railway.

### 🟡 [MEDIUM] Reliquats de scaffolding
- `client/package.json` s'appelle toujours **`@figma/my-make-file`**, contient un bloc `pnpm.overrides` inutile (tu utilises npm), et déclare **`react` et `react-dom` en `peerDependencies` optionnelles** au lieu de `dependencies`. Ça marche aujourd'hui (le lockfile les contient bien en 18.3.1, non-dev), mais une régénération du lockfile ou un passage à pnpm peut les faire disparaître et casser le build de façon incompréhensible.
- `server/dist/` contient encore `app.controller.js`, `app.module.js`, `app.service.js` — des restes d'un squelette NestJS, exclus par `tsconfig.json` mais jamais nettoyés du `dist/` local. (Le Dockerfile repart de zéro, donc ils ne partent pas en prod.)
- `client/public/jerseys/` est un dossier **vide**.

### 🟡 [MEDIUM] Un ancien `chat.service.ts` est versionné sous un nom d'artefact FUSE
`server/src/services/.fuse_hidden0000000e00000001` — 450 lignes, une **copie datée du 1er juillet de `chat.service.ts`**, committée (commit `22e61fe`). Elle part dans le contexte de build Docker (`COPY src ./src`). À supprimer.

### 🟢 [LOW] Prix codé en dur
`ProPage.tsx:21-22` : `PRICE_MONTHLY = "11,99 $"`, `CURRENCY = "CAD"`. Deux sources de vérité avec Stripe, et la chaîne n'est **pas localisée** (un utilisateur anglophone lit « 11,99 $ CAD » au lieu de « $11.99 CAD »). Lire le prix depuis `GET /subscription/me` ou formater avec `Intl.NumberFormat`.

---

## 5. Performance

### 🟠 [HIGH] Le logo était un PNG de 1,49 Mo ✅ CORRIGÉ
**Fichiers :** `client/src/app/components/brand/IceedgeLogo.tsx`, `client/public/sw.js`

- **Problème :** `<img src="/arakice-logo.png">` — le master **1024×1024, 1 489 844 octets** — affiché à 28–72 px sur 8 écrans (connexion, accueil, Pro, 404, Conditions, Confidentialité, Support, succès). Le service worker s'en servait aussi comme icône **et** badge de notification.
- **Impact :** ~1,5 Mo téléchargé au premier chargement pour peindre une vignette. Sur un forfait mobile, plusieurs secondes et autant de données. C'était de loin le plus gros poste de la page.
- **Solution appliquée :** trois variantes générées (`arakice-mark-96/192/288.png` — **8 / 24 / 49 ko**), `srcSet` + `sizes` pour que le navigateur ne prenne que ce qu'il affiche (8 ko dans la barre de navigation), `decoding="async"`. Le master reste dans `public/` comme source. **Gain : ~1,48 Mo au premier chargement.**

### 🟡 [MEDIUM] Un aller-retour réseau pour une multiplication
`BetContext` appelle `POST /api/predict/parlay` **à chaque ajout ou retrait de jambe**. Le commentaire dit que multiplier côté client « supposerait l'indépendance des jambes » — or le serveur fait exactement ça : `legs.reduce((acc, leg) => acc * (leg.probability/100), 1) * 100 * 0.95`. Le voyage réseau n'achète donc rien : même formule, plus la latence, plus la batterie, plus un état de chargement à gérer. Soit calculer côté client, soit implémenter côté serveur une vraie corrélation qui justifie l'appel.

### 🟡 [MEDIUM] Aucune déduplication ni cache des requêtes côté client
Pas de react-query / SWR : chaque page refait ses `fetch` au montage, et deux composants montés ensemble qui veulent la même donnée font deux appels. C'est partiellement absorbé par les en-têtes `Cache-Control` posés côté serveur (bien pensés), mais pas la déduplication en vol ni la revalidation en arrière-plan.

### 🟡 [MEDIUM] Le premier appel après 15 minutes coûte 3 allers-retours
Aucun rafraîchissement proactif du jeton : le premier appel après expiration prend un **401**, puis un refresh, puis un rejeu. Sur un réseau mobile, c'est un délai perceptible à chaque retour dans l'app. Rafraîchir en avance (à `exp - 60 s`) supprime le 401.

### 🟢 [LOW]
- Les messages du chat s'accumulent sans borne dans `useChatSocket` — plafonner à ~200 en mémoire.
- `backdrop-filter: blur(18px)` sur la barre `fixed` : coûteux à repeindre à chaque défilement sur iPhone.

---

## 6. UX / UI / Accessibilité

### 🟠 [HIGH] 351 occurrences de texte de 8 à 10 px
Réparties sur 30 fichiers, y compris les libellés de la barre de navigation (`text-[9px]`), les badges de rôle (`text-[8px]`) et le compteur « en ligne ». Le minimum HIG est 11 pt, et rien ne réagit à la taille de texte système. **C'est le facteur numéro un qui fait « page web dense » plutôt qu'« app iOS ».** Passer un plancher à 11-12 px sur les libellés et 13-14 px sur le texte secondaire.

### 🟡 [MEDIUM] Formulaires : aucun `<label>`, erreurs non annoncées
`LoginPage` n'utilise que des `placeholder` — qui disparaissent dès qu'on tape et ne sont pas lus comme des étiquettes. Les blocs `{error}` et `{notice}` n'ont ni `role="alert"` ni `aria-live`, donc un lecteur d'écran ne les annonce jamais.

### 🟡 [MEDIUM] La langue n'est jamais reflétée dans le document
`LanguageProvider` bascule le dictionnaire mais `<html lang="en">` reste figé, et il n'y a **aucune détection de `navigator.language`** — un iPhone configuré en français démarre en anglais. Ajouter `document.documentElement.lang = lang` et une détection initiale.

### 🟡 [MEDIUM] Le chat public est figé pour les visiteurs non connectés
Le middleware socket exige un JWT (`if (!token) return next(new Error(...))`), alors que l'historique des salons publics est lisible sans compte via HTTP. Un invité voit donc les messages **mais jamais les nouveaux**, avec « 0 en ligne » et un point gris — l'app a l'air cassée. Soit autoriser le socket en lecture seule pour les invités, soit afficher explicitement « Connecte-toi pour suivre en direct ».

### 🟢 [LOW]
- Français : mélange de tutoiement et de vouvoiement dans le dictionnaire (7 vs 6 occurrences). Choisir le tutoiement — il colle mieux au ton du reste.
- `BottomNav` : `opacity: 0.45` sur `#92A08A` par-dessus un fond translucide → contraste très en dessous de 4.5:1. Pas d'`aria-current="page"` sur l'onglet actif, pas de `type="button"`.
- Copie du code d'invitation (`navigator.clipboard.writeText`) : aucun retour visuel alors que `sonner` est déjà en place.

---

## 7. Production readiness

### 🔴 [CRITICAL] « Mode démo : le paiement Stripe n'est pas encore branché » était affiché en production ✅ CORRIGÉ
**Fichiers :** `client/src/app/pages/ProPage.tsx`, `client/src/app/i18n/index.tsx`

- **Problème :** la clé `pro.devNote` — *« Demo mode: Stripe payment isn't wired yet — the subscription activates immediately so you can test. »* — était rendue **sans condition**, sous le bouton d'abonnement, pour **tous les visiteurs**.
- **Impact :** en production Stripe **est** configuré (sinon `/checkout` rend un 501), donc le message était **faux**. Et faux ou vrai, annoncer à quelqu'un que le paiement n'est pas branché sur la page où on lui demande de payer est exactement ce qui détruit la confiance dans un produit payant. C'était le signal « prototype » le plus visible de l'app.
- **Solution appliquée :** rendu supprimé, clé retirée du dictionnaire.

### 🟠 [HIGH] `/share/:id` est une page « bientôt disponible » en production
**Fichier :** `client/src/app/pages/SharePage.tsx` — affiche `t("share.soon")` = « Les coupons partagés arrivent bientôt. »

La route est enregistrée et publiquement atteignable. Rien dans l'app n'y renvoie (le partage passe par une image, ce qui est le bon choix), donc c'est du code mort **avec du texte de remplacement**. Apple rejette explicitement le contenu « coming soon » (Guideline 2.1 / 4.2 — App Completeness). **Supprimer la route et la page**, ou l'implémenter.

### 🟠 [HIGH] Sur iOS, la page Pro est une impasse
**Fichier :** `client/src/app/pages/ProPage.tsx`

Avec `features.stripeCheckout === false` :
- le prix est masqué (bien pensé : « un prix sans moyen d'acheter est pire que pas de prix »)
- si l'essai est disponible → bouton « Essai gratuit »
- **si l'essai est déjà consommé → `: null`, donc aucun bouton d'action**
- le champ **code promo reste affiché**

Un utilisateur iOS voit donc la liste complète des avantages Pro, sans aucun moyen d'y accéder — sauf un code promo. Deux problèmes :
1. **Parcours en impasse** : c'est le genre d'écran qui fait dire « c'est incomplet ».
2. **Risque de rejet 3.1.1** : déverrouiller du contenu payant sur iOS par un code hors App Store est précisément ce que la règle interdit, et le testeur d'Apple doit pouvoir exercer les fonctions payantes. À ce jour il n'y a **aucun chemin IAP** dans le code.
- **Solution :** c'est la décision structurante de ta phase iOS. Soit tu livres l'IAP avant le freeze, soit tu assumes un build v1 « lecture seule » où Pro n'existe pas du tout sur iOS (masquer la page entière, pas seulement le bouton) — mais alors le champ promo doit disparaître aussi.

### 🟡 [MEDIUM] Des cotes fictives sont servies publiquement
`GET /api/odds/live` et `GET /api/odds/game/:gameId` renvoient `MOCK_ODDS` — deux entrées codées en dur (`BOS 1.85`, `NYR 2.05`) depuis `server/src/data/mock.ts`. Aucun écran client ne les appelle (le client passe par `/odds/bet365/...`), donc ce sont **des endpoints publics morts qui servent des cotes inventées** sous ton nom de domaine. À supprimer.

### 🟡 [MEDIUM] Journalisation
Rien de grave : les `console.*` restants sont légitimes (scripts de migration, `instrument.ts` avant que le logger n'existe, `ErrorBoundary`). Côté client, ~24 `console.error/warn` de diagnostic — acceptables, mais plusieurs marquent des échecs **que l'utilisateur ne voit pas** (partage, `TeamCarousel`, `oddsApi`). Un `console.warn` n'est pas une gestion d'erreur.

### 🟢 Ce qui est déjà bien configuré
`.gitignore` complet, gitleaks sur `master` **et** les PR (avec le commentaire qui explique pourquoi `master` doit y rester), CSP stricte + HSTS + `X-Frame-Options` + `Permissions-Policy`, aucun secret côté client, `SECRET_ROTATION.md` et `BACKUP_DR.md` présents, Sentry armé des deux côtés avec un taux d'échantillonnage raisonné, `check:env` en deux filets (commande de build Vercel + scan du `dist/` en CI).

---

## 8. Regard d'utilisateur, pas de développeur

**Ce qui semble bizarre ou inutile**
- La mention « mode démo » sous le bouton d'abonnement (corrigée) : c'était le premier truc qui faisait douter.
- Une page « bientôt disponible » atteignable.
- Sur iPhone, la page zoome à chaque tap dans un champ et ne dézoome pas.
- L'avatar disparaît de la barre du bas après un rechargement.

**Fonctionnalité présente à plusieurs endroits au lieu d'être centralisée**
- Le motif `res.status(...).json({ error: err.message })` est recopié dans ~40 handlers, ce qui contourne le handler global soigneusement écrit. **Un seul helper**, et la règle redevient vraie partout.
- Les confirmations : `ConfirmDialog` d'un côté, `window.confirm` de l'autre.
- Les `fetch` : quatre helpers `request()` quasi identiques (`authService`, `nhlApiService`, `predictionApiService`, `injuriesAdminService`), chacun avec sa gestion d'erreur et **aucun** avec de timeout. Une base commune donnerait timeout + retry + abort à tout le monde d'un coup.

**Où l'utilisateur peut se perdre**
- Chat : après un verrouillage d'écran, la conversation reprend avec un trou et sans indication.
- Ligue : quand le réseau tombe, « vide » et « cassé » sont indistinguables, et il n'y a rien à réessayer.
- Pro sur iOS : liste d'avantages, aucun bouton.

**Étapes inutiles**
- Un aller-retour réseau à chaque modification du coupon, pour une multiplication.
- Un 401 + un refresh + un rejeu à chaque retour dans l'app après 15 minutes.

**Ce qui fait « prototype » plutôt que produit fini**
Par ordre d'impact : la mention mode démo (corrigée) · les textes à 8-9 px · le zoom iOS sur les champs · les `confirm()` système · la page « bientôt disponible » · les échecs silencieux (partage, blessures).

**Risques App Store**
| Guideline | Risque | État |
|---|---|---|
| 2.1 / 4.2 — App Completeness | Page `/share/:id` « coming soon » | 🔴 à traiter |
| 3.1.1 — In-App Purchase | Pro déverrouillable par code promo, aucun IAP | 🔴 décision à prendre |
| 4.0 — Design | Cibles < 44 pt, texte 8-9 px, safe areas | 🟠 à traiter |
| 5.3 — Gambling | Liens sortants coupés par `features.bookmakerLinks`, double barrière dans `openUrl` | 🟢 bien traité |
| 4.8 — Sign in with Apple | Google retiré du build iOS (`features.googleLogin`) | 🟢 bien traité |
| 1.2 — Safety / UGC | Signalement, blocage réversible, file de modération, règles accessibles depuis le chat, adresse de support publiée | 🟢 bien traité |

---

## 9. Correctifs appliqués (non commités)

Travail fait directement sur `master` dans `~/dev/ICEEDGE`, sans commit — à toi de relire et de committer.

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

`npx tsc --noEmit` passe sur le client **et** sur le serveur après ces changements, et la suite de tests serveur est verte : **265 tests, 23 fichiers** (dont 26 nouveaux — 25 pour la saisie manuelle, 1 pour la faille CORS).

---

## 10. Résumé

### 🔴 À corriger absolument avant le freeze iOS

| | Sujet | État |
|---|---|---|
| 1 | CORS previews Vercel → prise de contrôle de compte | ✅ corrigé |
| 2 | `viewport-fit=cover` manquant → safe areas inertes | ✅ corrigé |
| 3 | Mention « mode démo Stripe » en production | ✅ corrigé |
| 4 | `BottomNav` sans `safe-area-inset-bottom` | à faire |
| 5 | Champs < 16 px → zoom iOS irréversible | à faire |
| 6 | Cibles tactiles 28-32 px (envoi chat en premier) | à faire |
| 7 | Page `/share/:id` « bientôt disponible » (Guideline 2.1) | à faire |
| 8 | Décision Pro sur iOS : IAP ou retrait complet (Guideline 3.1.1) | à trancher |
| 9 | Chat : resync au retour au premier plan + `connect_error` | à faire |
| 10 | Fichiers de données jamais copiés dans `dist/` (blessures, arbitres, gardiens) | ✅ corrigé — passés en base |
| 11 | `tokenStore` natif absent → session perdue toutes les 15 min en WKWebView | phase 3, à planifier |

### 🟠 Importants, peuvent attendre un peu

Fuite d'infos dans les erreurs (helper unique) · clé OpenAI renvoyée en clair · coupon non persisté · aucun timeout de requête ni bouton « Réessayer » · `autoComplete` pour le Trousseau iOS · message de chat échoué qui reste affiché · `email_verified` Google · `/api/predict/*` sans validation ni auth · jeton d'accès dans l'URL + Sentry sans `beforeSend` · erreurs transformées en états vides (Ligue) · 401 LLM confondu avec 401 de session · `/api/odds/live` qui sert des cotes fictives · `typecheck` client absent de la CI.

### 🟡 Améliorations recommandées

Texte 8-10 px (351 occurrences) · `confirm()`/`alert()` système · `<label>` + `role="alert"` sur les formulaires · `<html lang>` et détection de langue · chat figé pour les invités · partage d'image qui échoue en silence · réglages tactiles iOS (`tap-highlight`, `user-select`, `overscroll`) · aller-retour réseau pour le parlay · rafraîchissement proactif du jeton · `.fuse_hidden…` versionné · `@figma/my-make-file` et react en peerDependency optionnelle · prix codé en dur · tu/vous · cache client des requêtes.

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
- [ ] `BottomNav` : `bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px))`
- [ ] Vérifier visuellement toutes les pages sur iPhone à encoche maintenant que `viewport-fit=cover` est actif
- [ ] `input, textarea, select { font-size: 16px }` global
- [ ] Élargir à 44×44 pt : envoi du chat, retour, `⋯`, onglets de la nav
- [ ] Supprimer la route et la page `/share/:id`
- [ ] Trancher Pro sur iOS : IAP livré, **ou** page Pro entièrement masquée (bouton, prix **et** code promo)
- [ ] Socket : resync de l'historique sur `connect`, écouteur `connect_error` avec refresh, affichage de `room_error`
- [x] ~~Copier `src/data/*.json` dans `dist/`~~ → migré en base (034). **Reste :** appliquer la migration en prod avant de déployer le serveur
- [ ] Vérifier `CORS_ORIGIN` en production et tester une preview Vercel après le déploiement du correctif CORS
- [ ] Planifier `nativeStore` (`@capacitor/preferences`) pour la phase 3

**Important**
- [ ] Helper `sendError()` unique ; retirer `detail`, `raw` et le message `psql …` des réponses
- [ ] `GET /users/me` : renvoyer `hasOpenaiKey` + `last4` au lieu de la clé
- [ ] Persister le coupon (`BetContext`) dans le stockage local
- [ ] `AbortSignal.timeout(15000)` dans les helpers `request()` + boutons « Réessayer »
- [ ] `autoComplete` sur tous les champs de `LoginPage`
- [ ] Chat : retirer la bulle optimiste en cas d'échec et restaurer le texte
- [ ] Vérifier `email_verified` dans `loginWithGoogle`
- [ ] Schémas zod sur `/api/predict/*`
- [ ] `beforeSend` Sentry qui masque `access_token` ; jeton dans le fragment
- [ ] `LeaguePage` : distinguer « vide » de « en erreur »
- [ ] Supprimer `/api/odds/live` et `/api/odds/game/:gameId` (cotes fictives)
- [ ] Ajouter `npm run typecheck` au job client de la CI
- [ ] `git rm server/src/services/.fuse_hidden0000000e00000001`

**Avant de soumettre**
- [ ] `npm audit` sur `client/` et `server/` (n'a pas pu tourner ici — le réseau du poste bloquait le registre)
- [ ] Vérifier sur Railway : `NHL_USE_MOCK`, `EMAIL_VERIFICATION_DISABLED`, `API_RATE_LIMIT`, `DORMANT` — toutes absentes ou à `false`
- [ ] Vérifier que `ENABLE_DEV_ROUTES` n'est **pas** à `true` en production
- [ ] Confirmer que Railway lit bien `/health/ready`
- [ ] Ouvrir la file de modération et la vider — Apple demande le processus, pas seulement le bouton
- [ ] Vérifier l'adresse de support publiée (`support.arakice@gmail.com`) : boîte accessible, réponse testée
- [ ] Tester le parcours complet sur un vrai iPhone : inscription → code e-mail → coupon → chat → verrouillage d'écran 5 min → retour
- [ ] Tester en mode Avion et en réseau très lent (Network Link Conditioner)
