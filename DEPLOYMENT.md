# ARAKICE — Guide de déploiement

Architecture : **Vercel** (frontend) + **Railway** (Node.js + Python) + **Neon** (PostgreSQL) + **Cloudflare R2** (avatars)

> **Note.** Ce guide a longtemps décrit Supabase. La base de production est
> **Neon** (§1 ci-dessous) : c'est son *scale-to-zero* qui rend le job de
> règlement événementiel rentable — la base s'endort hors des heures de match.
> Un seul hébergeur Postgres est nécessaire ; si un projet Supabase traîne
> encore, le supprimer **après** avoir vérifié que le `DATABASE_URL` de Railway
> pointe bien sur Neon.

---

## 1. Neon — Base de données

### Créer le projet
1. https://neon.tech → New project
2. Nom : `iceedge` · Région : **AWS US East (Ohio)** ou la plus proche de Railway
3. Postgres 16 · le projet est prêt en quelques secondes

### Importer le schéma
Depuis `server/`, avec le `DATABASE_URL` de l'étape suivante dans l'environnement :
```bash
npm run db:migrate:all
```
Cette commande applique `schema.sql` puis chaque migration `src/db/migrations/*.sql`
dans l'ordre, en les enregistrant dans la table `schema_migrations` (donc
ré-exécutable sans risque). L'éditeur SQL du dashboard fonctionne aussi, mais il
ne tient pas le registre des migrations.

### Récupérer l'URL de connexion — prendre l'endpoint **pooled**
Dashboard → **Connection Details** → cocher **Connection pooling**, puis copier :
```
postgresql://[USER]:[PASSWORD]@ep-xxxx-xxxx-pooler.us-east-2.aws.neon.tech/iceedge?sslmode=require
```

⚠️ **Le `-pooler` dans le nom d'hôte n'est pas optionnel.** Neon expose deux
endpoints :

| Endpoint | Limite de connexions | Usage |
|----------|---------------------|-------|
| direct (`ep-xxxx.…`) | quelques dizaines | migrations, psql ponctuel |
| pooled (`ep-xxxx-pooler.…`) | ~10 000 (PgBouncer) | **l'application** |

Avec une seule instance Railway et `DB_POOL_MAX=10`, l'endpoint direct passe.
Dès deux instances, ou quand le job de règlement et les requêtes web se
disputent le pool, il sature. Le serveur émet un avertissement au démarrage si
l'URL ne contient pas `-pooler`.

### Taille du pool
`DB_POOL_MAX` vaut **10 par instance** et doit y rester. À ~200 req/s, 10
connexions supposent que chaque requête tienne sous 50 ms : augmenter le pool
sans avoir d'abord corrigé les requêtes lentes ne fait que déplacer la
saturation du process vers Neon. Ne le monter (10 → 20) qu'avec une mesure du
temps d'attente d'acquisition d'une connexion à l'appui.

### Budget compute — le scale-to-zero protège désormais la facture, plus la disponibilité

> ⚠️ **Réécrit le 2026-08-30.** Ce paragraphe raisonnait sur le **plan gratuit**
> de Neon. Le projet est en réalité sur **Launch** (« Free limits are removed »,
> relevé dans la console le 2026-08-29), et le sens du risque **s'inverse**.

| | Plan gratuit (ce que disait ce §) | **Launch — la réalité** |
|---|---|---|
| Compute | 100 CU-h/mois inclus | **aucune allocation incluse — 0,106 $/CU-heure** |
| Stockage | 0,5 Go inclus | **aucune allocation incluse — 0,35 $/Go-mois** |
| Transfert réseau public | — | 500 Go/projet inclus, puis 0,10 $/Go |
| Au dépassement | **compute suspendu** jusqu'au mois suivant | **rien ne s'arrête — la facture monte** |
| Scale-to-zero | 5 min, non désactivable | 5 min, **désactivable** — ne pas y toucher |

**Ce que ça change.** « Ce n'est pas un sujet de coût, c'est une panne » était
vrai sur le plan gratuit et est **faux ici** : sur Launch, Neon ne suspend rien.
Une base qui ne dort jamais ne se fait pas couper vers le 20 du mois, elle
facture — à 0,25 CU en continu, 730 h × 0,25 = **182,5 CU-h ≈ 19,35 $/mois**,
indéfiniment. Le scale-to-zero reste donc obligatoire, mais pour une autre
raison : il ne protège plus la disponibilité, il protège la facture.

**Et il n'y a aucun plafond dur à poser.** Neon n'offre sur Launch que des
*spending notifications* (alerte à 80 % puis 100 % d'un seuil en dollars qu'on
choisit soi-même). Le seuil est armé à **6 $** depuis le 2026-08-29. Ce n'est
pas un garde-fou, c'est un e-mail : avec le stockage, Neon est la seule ligne de
la stack qui ne peut pas se couper toute seule. Voir `MONITORING.md`.

**Le seuil de 6 $ sonnera en fonctionnement normal, pas en incident.** Le rythme
événementiel décrit ci-dessous (~61 CU-h/mois) vaut **≈ 6,5 $/mois** — 6 $
correspondent à ~57 CU-h. À relever d'un cran dès que la saison aura donné une
consommation réelle, sinon l'alerte devient du bruit qu'on apprend à ignorer.

**Le 0,55 CU-h relevé depuis le 1er août ne vaut plus rien** : il a été mesuré
avec `DORMANT=true`, donc sans un seul job de fond. `DORMANT=false` depuis le
2026-08-29.

**Le stockage n'est plus gratuit non plus** — 0,35 $/Go-mois dès le premier
octet. Les data-URI d'avatars restées en base (ligne E de l'audit) sont
désormais une dépense directe, et pas seulement une inélégance.

Ce qui réveille la base quand personne n'utilise le site :

| Source | Cadence au repos | Réveille la DB ? |
|--------|------------------|------------------|
| Job de règlement (`SETTLEMENT_IDLE_POLL_MIN`) | 15 min | oui — c'est le rythme de référence |
| Filet de sécurité règlement (`SETTLEMENT_FALLBACK_MIN`) | 60 min | oui |
| `startCleanupJob` | 24 h | oui |
| `startValueBetScan` (`PUSH_SCAN_INTERVAL_MIN`) | 30 min | seulement si un value bet est détecté |
| `startOddsLogger` | 6 passes/jour **en saison** (11 h et 17 h ET, plus quatre passes `spreads` en soirée) | **oui** — il écrit dans `odds_log` et `odds_snapshots` depuis la migration 027. L'ancienne mention « non (écrit un CSV) » était périmée |
| Sonde `/health/ready` | 1-5 min côté monitoring | **non** — résultat mis en cache (`READINESS_DB_TTL_MS`, 10 min par défaut) |

Sans le cache de la sonde, une sonde toutes les 1-5 min suffit à elle seule à
maintenir le compute allumé 24/7 et à annuler tout le travail événementiel du
job de règlement. Avec le cache, le rythme est dicté par le règlement : réveil
toutes les 15 min, ~5 min d'activité ensuite, soit un cycle de service d'environ
33 % → **~61 CU-h/mois**, soit **≈ 6,5 $/mois** sur Launch. (Ce calcul ne
compte pas encore les six réveils quotidiens du log des cotes : négligeables en
cadence, mais ils s'ajoutent en saison.)

Règle à retenir avant d'ajouter un job périodique : **toute tâche qui interroge
Postgres plus souvent que toutes les 5 minutes supprime le scale-to-zero.**
Voir `MONITORING.md` pour l'intervalle des sondes.

### Mode veille hors-saison (`DORMANT`)
Entre la fin des séries et la reprise d'octobre, les jobs de fond réveillent la
base toutes les 15 minutes pour ne rien trouver. `DORMANT=true` sur Railway
démarre l'API sans aucun d'entre eux (règlement, value bets, nettoyage, log des
cotes) : plus aucun réveil programmé.

Ce que ça implique :

- **Ce n'est pas zéro compute.** Une visite du site, ou une sonde de readiness
  dont le cache a expiré, réveille la base pour au moins 5 min. Pour un vrai
  zéro, il faut retirer le déploiement Railway (menu « … » du déploiement actif
  → *Remove*, puis *Redeploy* pour le rallumer) et mettre les sondes uptime en
  pause. Le service, ses variables et les données Neon sont conservés.
- **Les paris placés pendant la veille ne sont pas réglés.** Ils restent en
  attente ; au retour à `DORMANT=false`, la passe de rattrapage du job de
  règlement (30 s après le démarrage) les traite tous.
- **Le nettoyage des tokens ne tourne pas.** Sans conséquence de sécurité : un
  refresh token expiré ou révoqué est refusé à la vérification
  (`auth.service.ts` filtre sur `revoked=FALSE AND expires_at>NOW()`) ; seule
  la table grossit, ce que la reprise du job résorbe.
- **Ne pas oublier de repasser à `false`** avant le premier match de la saison.

### Rétention / PITR
Dashboard → **Settings → History retention** : porter la fenêtre à **≥ 7 jours**
(voir `BACKUP_DR.md`). C'est ce qui permet de restaurer à un instant précis.

---

## 2. Railway — Backend Node.js

### Créer le service
1. https://railway.app → New Project → **Deploy from GitHub repo**
2. Sélectionner `ICEEDGE` → choisir le dossier **`server/`** comme root (ou configurer le Dockerfile)
3. Railway détecte le `Dockerfile` dans `server/` automatiquement

### Variables d'environnement
Settings → Variables → ajouter :

| Variable | Valeur |
|----------|--------|
| `NODE_ENV` | `production` |
| `PORT` | `3001` |
| `DATABASE_URL` | URL Neon **pooled** (étape 1) — le nom d'hôte doit contenir `-pooler` |
| `DB_SSL` | `true` (Neon exige TLS) |
| `DB_POOL_MAX` | `10` — par instance ; ne pas augmenter sans mesure (voir étape 1) |
| `READINESS_DB_TTL_MS` | `600000` (défaut) — durée de mise en cache du `SELECT 1` de `/health/ready` |
| `DORMANT` | `false` en saison · `true` hors saison pour couper les jobs de fond (voir étape 1) |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `JWT_REFRESH_SECRET` | (même commande, valeur différente) |
| `GOOGLE_CLIENT_ID` | Depuis Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Depuis Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `https://[TON-SERVICE].railway.app/api/auth/google/callback` |
| `CLIENT_URL` | `https://iceedge.vercel.app` (à confirmer après Vercel) |
| `CORS_ORIGIN` | `https://iceedge.vercel.app` |
| `ML_SERVICE_URL` | **Réseau privé** : `http://<nom-du-service-ml>.railway.internal:8000` (étape 3 — pas de domaine public) |
| `ML_API_TOKEN` | Secret partagé avec le service ML : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

### Domaine
Settings → Networking → **Generate Domain** → noter l'URL (ex: `iceedge-backend.railway.app`)

---

## 2 bis. Cloudflare R2 — Stockage des avatars

**Optionnel mais recommandé.** Sans R2, les avatars restent stockés en data-URI
base64 dans Postgres : ~27 ko par utilisateur dans la base *et* dans chaque
payload de chat et de leaderboard. R2 offre 10 Go gratuits et **aucun frais
d'egress**, contrairement au stockage Neon qui est le plus cher de la stack.

> **Compte de production (2026-09-16) :** le compte Cloudflare d'origine, géré depuis
> `ireinahedad24@gmail.com` — identifiant `2216e2d9…`, le même qui porte la zone
> `arakice.com` et l'enregistrement du domaine. Le compte `Ireinahedad@icloud.com's
> Account` a été abandonné : ne rien y recréer.

### Créer le bucket
1. https://dash.cloudflare.com → **R2** → *Create bucket* → nom : `arakice-avatars`
2. Bucket → **Settings → Public access** : activer le sous-domaine `r2.dev`
   (URL du type `https://pub-xxxxxxxx.r2.dev`), ou brancher un domaine perso
   (ex. `cdn.arakice.com`). C'est cette URL que les navigateurs appelleront.
3. R2 → **Manage API tokens → Create API token**
   - Permission : **Object Read & Write**
   - Portée : **ce bucket uniquement** (pas « all buckets »)
   - Noter `Access Key ID` et `Secret Access Key` — le secret n'est affiché qu'une fois.
4. `Account ID` : visible en haut à droite du dashboard R2.

### Variables Railway (backend)

| Variable | Valeur |
|----------|--------|
| `R2_ACCOUNT_ID` | Account ID Cloudflare |
| `R2_ACCESS_KEY_ID` | Access Key ID du token |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key du token |
| `R2_BUCKET` | `arakice-avatars` |
| `R2_PUBLIC_URL` | `https://pub-xxxxxxxx.r2.dev` (sans slash final) |

Les cinq doivent être présentes : s'il en manque une, le serveur retombe
silencieusement sur le stockage base64 (aucune erreur, mais aucun bénéfice).

### Vérifier
Changer d'avatar depuis l'app, puis `GET /api/users/me` : `avatarUrl` doit être
une URL `https://…/avatars/<userId>/<hash>.webp` et non plus `data:image/…`.
L'ancien objet est supprimé automatiquement lors d'un remplacement.

### Notes
- Le bucket est public **en lecture seule** ; les écritures passent par le
  backend avec le token ci-dessus. Ne jamais exposer ces clés au client.
- Les avatars déjà en base (data-URI) continuent de fonctionner ; ils sont
  remplacés par une URL au prochain changement d'avatar de chaque utilisateur.
- Le CSP du client (`client/vercel.json`) autorise déjà `img-src … https:`,
  aucun changement à prévoir.

---

## 3. Railway — Service ML Python

### Créer un deuxième service dans le même projet
1. Railway → **même projet et même environnement** que le backend → **+ New Service → GitHub repo**
2. Même repo `ICEEDGE` → Settings → Build → **Root directory : `ml`** ← et non `ml/python`
3. Rien d'autre à configurer : le `Dockerfile` est à la racine de `ml/`, Railway
   le détecte seul (« Using detected Dockerfile » dans les logs). Ni build
   command, ni `RAILWAY_DOCKERFILE_PATH`.

> ⚠️ Le root directory **est** le contexte de build. Le Dockerfile fait
> `COPY models ./models`, or `ml/models/` est le frère de `ml/python/` : avec
> `ml/python` comme racine, les modèles sont hors contexte et le build échoue.
> Et si Railway répond *« Railpack could not determine how to build the app »*,
> c'est qu'il n'a pas vu de `Dockerfile` à la racine du contexte — vérifier le
> root directory, et que le fichier est bien poussé sur la branche déployée.

### Variables d'environnement

| Variable | Valeur |
|----------|--------|
| `ML_API_TOKEN` | Secret partagé, **identique** à celui du backend (étape 2). Générer : `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PORT` | `8000` (optionnel — Railway l'injecte) |
| `ML_CORS_ORIGINS` | Optionnel. Aucune origine autorisée par défaut : aucun navigateur n'appelle ce service, le backend fait proxy. |

> Le service **refuse de démarrer** en environnement déployé si `ML_API_TOKEN`
> est absent — plutôt que de servir des inférences ouvertes. Si tu tiens à t'en
> passer parce que le service n'a strictement aucun domaine public, pose
> explicitement `ML_AUTH_DISABLED=true`.

### Modèles XGBoost
`ml/models/*.json` **est suivi par Git** (cf. `.gitignore`) et embarqué dans
l'image : `game_model.json`, `score_model.json` + `score_report.json`,
`elo_ratings.json`, `inference_state.json`, `training_report.json`. Rien à
monter, rien à uploader.

Deux exceptions, exclues par `ml/.dockerignore` :

- `models/score_ensemble/` — 8.9 Mo de membres bootstrap dont σ n'est consommée
  par aucun code de mise (S1). Régénérable par `python train_score.py --ensemble 20`.
- `totals_model.json` — supprimé (S2). Les totaux sont pricés depuis la
  distribution du modèle de score, qui compte le but de prolongation
  correctement là où l'ancien repli ne le faisait pas.

Le corollaire : **les modèles déployés sont ceux du dernier commit.** Après un
ré-entraînement local, il faut committer et pousser, sinon Railway sert
l'ancien modèle sans le moindre avertissement.

```bash
cd ml/python && python train.py     # régénère ml/models/
git add ../models && git commit -m "chore(ml): retrain" && git push
```

Dans l'image, les modèles sont à `/app/models` et le Dockerfile pose
`ENV MODELS_DIR=/app/models` — le service les cherche là et non via le chemin
relatif valable seulement depuis `ml/python/`. Ne pas retirer cette variable.

Sans modèles chargés, le service démarre quand même — en mode règles. C'est
silencieux, donc à vérifier explicitement après déploiement :

```bash
curl -s $ML_SERVICE_URL/health   # trained_models_loaded doit être true/true
```

### Réseau — ⚠️ ne PAS générer de domaine public

Ce service n'a aucune notion d'utilisateur : quiconque connaît son URL peut
envoyer des inférences XGBoost illimitées. Sur Railway le compute est facturé à
l'usage → facture ouverte, et exfiltration du modèle par requêtes répétées.

**Le seul client légitime est le backend Node, dans le même projet Railway** :
il n'a donc besoin que du réseau privé.

1. Settings → Networking : **laisser la section Public Networking vide**
   (si un domaine a déjà été généré : *Remove Domain*).
2. Noter le nom interne du service (Settings → Service Name), ex. `iceedge-ml`.
3. Relever le **port réellement écouté** dans les logs de démarrage du service ML :
   `Uvicorn running on http://[::]:8080` → c'est `8080`. Railway injecte `$PORT`
   (souvent `8080`) ; le `8000` du Dockerfile n'est que le défaut hors plateforme.
   Le port de `ML_SERVICE_URL` doit correspondre à celui-là, sinon connexion refusée.
4. Dans le service **Node.js** (étape 2), poser :
   ```
   ML_SERVICE_URL=http://iceedge-ml.railway.internal:8080
   ```
   Réseau privé Railway : inclus, **0 €**, aucun egress facturé, latence moindre
   qu'un aller-retour par l'internet public.

> ⚠️ En interne on parle **http** et le port est celui du service (`8000`),
> pas `443`. Le trafic ne quitte pas le réseau privé du projet.

Trois conditions pour que `railway.internal` résolve :
- les deux services sont dans le **même projet** ET le **même environnement**
  (production ↔ production) — l'isolation est stricte entre projets ;
- le réseau privé n'existe **qu'au runtime**, jamais pendant le build ;
- le service ML écoute en **IPv6** : les environnements créés avant le
  2025-10-16 ne résolvent `*.railway.internal` qu'en IPv6, donc un bind sur
  `0.0.0.0` serait injoignable. Le Dockerfile utilise déjà `--host ::`.

Le token `X-ML-Token` reste la deuxième barrière : il protège le service si un
domaine public réapparaît un jour (redéploiement, manipulation dans le
dashboard). Les deux ensemble, pas l'un *ou* l'autre.

### Vérifier

Railway n'a pas de terminal dans le dashboard : le shell passe par la CLI.
`railway shell` ouvre un sous-shell **sur ta machine** (variables injectées) —
il ne voit donc pas le réseau privé. C'est `railway ssh` qu'il faut, qui ouvre
un shell **dans le conteneur déployé** :

```bash
npm i -g @railway/cli && railway login
railway ssh --project=<id> --environment=<id> --service=<id-du-service>
```

**1. Depuis le conteneur ML** — les modèles sont-ils chargés ?
(image `python:3.12-slim`, `curl` est installé)
```bash
curl -s localhost:8000/health     # trained_models_loaded → true/true
```

**2. Depuis le conteneur Node** — le réseau privé fonctionne-t-il ?
⚠️ L'image est `node:20-alpine` : **pas de `curl`**, utiliser le `wget` de busybox.
```bash
echo $ML_SERVICE_URL                       # doit finir par .railway.internal:8000
wget -qO- $ML_SERVICE_URL/health           # 200 + JSON
wget -qO- --post-data='{}' --header='Content-Type: application/json' \
  $ML_SERVICE_URL/predict/game             # "ERROR 401" attendu : le token protège bien
```

Et depuis l'extérieur, l'URL publique ne doit **pas** exister.

---

## 4. Vercel — Frontend

### Déployer
1. https://vercel.com → New Project → Importer `ICEEDGE`
2. **Root directory : `client`**
3. Framework : **Vite** (détecté automatiquement)
4. Build command : `npm run check:env && npm run build` · Output : `dist`

> `check:env` (PRE_IOS_PLAN.md R7) valide les quatre URLs **avant** de
> construire : présence, `https://` obligatoire. C'est le seul endroit du
> pipeline où les vraies variables existent, donc le seul endroit où cette
> vérification a du sens. Un build qui échoue ici laisse la version précédente
> en ligne — préférable à déployer un bundle qui pointe vers le vide.
> La CI GitHub ne vérifie que le bundle construit (`check:env:dist`).

### Variables d'environnement
Project Settings → Environment Variables → Production :

| Variable | Valeur |
|----------|--------|
| `VITE_NHL_API_URL` | `https://[TON-BACKEND].railway.app/api/nhl` |
| `VITE_PROFILE_API_URL` | `https://[TON-BACKEND].railway.app/api` |
| `VITE_PREDICTION_API_URL` | `https://[TON-BACKEND].railway.app/api` |
| `VITE_SOCKET_URL` | `https://[TON-BACKEND].railway.app` |
| `VITE_ODDS_API_KEY` | `<placeholder>` — **ne jamais commiter la vraie valeur** |
| `VITE_BET365_AFFILIATE_CODE` | Code affilié Bet365 — optionnel |
| `VITE_STAKE_AFFILIATE_CODE` | Code affilié Stake — optionnel |
| `VITE_SENTRY_DSN` | DSN frontend Sentry — optionnel, vide = monitoring désactivé |

> Les quatre premières sont **obligatoires** depuis R7 : il n'y a plus de repli
> sur `localhost`. Une variable manquante fait échouer le build Vercel (étape 2
> de R7 : elle affichera un écran « Configuration error » au lieu d'une page
> blanche). Les trois dernières sont optionnelles par construction.

> ⚠️ **`VITE_*` est exposé au navigateur par construction.** La clé Odds servie au
> client est publique de fait ; c'est précisément pourquoi le proxy serveur
> (`odds.routes.ts`) existe et garde la vraie clé sous `ODDS_API_KEY`, côté
> Railway. Si une valeur littérale a circulé dans le dépôt, la considérer comme
> compromise : révoquer et régénérer.

### Domaine — hôte canonique `arakice.com` (apex, sans `www`)

**Décision (2026-07-30) : l'hôte canonique est `https://arakice.com`.** Tout le
code l'assume déjà — `SITE` dans `client/scripts/seo-gen.mjs` et
`client/scripts/route-shells.mjs`, les `<link rel="canonical">` / `og:url` /
`@id` JSON-LD de `client/index.html`, `robots.txt`, `sitemap.xml` et les ~900
pages générées dans `client/public/`. **Ne pas changer un seul de ces hôtes sans
changer les autres** : un canonical qui pointe vers un hôte qui redirige envoie
des signaux contradictoires à Google et empêche les sitelinks d'apparaître.

Vercel recommande `www` comme domaine principal (le CDN a plus de contrôle sur
un `www`, qui peut être un CNAME, que sur un apex qui exige un A/ALIAS). On
choisit quand même l'apex ici parce que la totalité du code et des pages
générées le référencent déjà, et que basculer coûterait une régénération
complète. Compromis assumé, pas un oubli.

Ce qui doit rester aligné sur `https://arakice.com` :

| Endroit | Valeur attendue |
|---|---|
| Vercel → Settings → Domains | `arakice.com` **primary**, `www.arakice.com` en **redirect** vers lui |
| DNS apex | A / ALIAS vers Vercel (l'apex ne peut pas être un CNAME) |
| Railway `CORS_ORIGIN` | doit **contenir** `https://arakice.com` (liste séparée par des virgules — garder `https://www.arakice.com` le temps de la transition ne coûte rien) |
| Railway `CLIENT_URL` | `https://arakice.com` — sert aux redirections post-OAuth et aux retours Stripe |
| Google Cloud Console → OAuth | `https://arakice.com` dans « Authorized JavaScript origins ». `GOOGLE_REDIRECT_URI` pointe sur le **backend**, donc l'hôte du frontend ne l'affecte pas. |
| Search Console | inspecter et soumettre les URLs **sans** `www` |

Effet de bord attendu au moment de la bascule : le cookie de refresh est lié à
l'hôte, donc les sessions ouvertes sur `www.arakice.com` sont perdues une fois.
Les utilisateurs se reconnectent, rien n'est corrompu.

Vérification après bascule — les deux commandes doivent donner ceci :

```bash
curl -sI https://www.arakice.com/ | head -3   # 301/308 + Location: https://arakice.com/
curl -sI https://arakice.com/     | head -3   # 200, aucun Location
```

---

## 5. Google OAuth — Mettre à jour les redirections

1. https://console.cloud.google.com → APIs & Services → Credentials
2. Sélectionner le client OAuth existant
3. **Authorized redirect URIs** → ajouter :
   ```
   https://[TON-BACKEND].railway.app/api/auth/google/callback
   ```
4. **Authorized JavaScript origins** → ajouter :
   ```
   https://iceedge.vercel.app
   ```
5. Sauvegarder

---

## 6. Checklist post-déploiement

### Vérifier les health checks
```bash
# Backend Node.js — liveness (aucune dépendance) puis readiness (SELECT 1 sur la DB)
curl https://[TON-BACKEND].railway.app/health
curl https://[TON-BACKEND].railway.app/health/ready   # 200 si DB ok, 503 sinon

# Service ML Python — pas de domaine public (cf. §3) : se tester depuis le
# Shell Railway du service Node, via le réseau privé.
curl $ML_SERVICE_URL/health
```

### Vérifier la chaîne complète
```bash
# Test prédiction ML via le backend
curl -X POST https://[TON-BACKEND].railway.app/api/predict/ml \
  -H "Content-Type: application/json" \
  -d '{"type":"game","homeTeam":"TOR","awayTeam":"MTL","propType":"moneyline"}'
```

### Checklist finale
- [ ] Neon : schéma + migrations appliqués (`npm run db:migrate:all`), connexion vérifiée
- [ ] `DATABASE_URL` pointe sur l'endpoint **pooled** (`-pooler` dans le nom d'hôte) — vérifier l'absence d'avertissement au démarrage
- [ ] Neon : rétention d'historique ≥ 7 jours
- [ ] Neon : après quelques heures sans trafic, le dashboard montre le compute **suspendu** (sinon un job réveille la base trop souvent — voir « Budget compute »)
- [ ] Monitoring : sondes `/health/ready` à **5 min**, pas 1 min (`MONITORING.md`)
- [ ] Cloudflare R2 : les 5 variables `R2_*` définies, un changement d'avatar renvoie bien une URL et non une data-URI
- [ ] Railway Node.js : deploy réussi, `/health` répond 200 et `/health/ready` répond 200
- [ ] Railway Python : deploy réussi, `/health` répond 200
- [ ] Railway Python : **aucun domaine public** (Public Networking vide), `ML_SERVICE_URL` en `*.railway.internal:8000`
- [ ] `ML_API_TOKEN` identique sur les deux services ; `POST /predict/game` sans le header renvoie 401
- [ ] Vercel : build réussi, app accessible
- [ ] Google OAuth : URIs de redirection mises à jour
- [ ] Variables d'env croisées mises à jour (ML_SERVICE_URL, ML_API_TOKEN, CLIENT_URL, CORS_ORIGIN)
- [ ] Modèles XGBoost déployés (ou fallback accepté)
- [ ] Test de connexion end-to-end (login → prédiction)
- [ ] `JWT_SECRET` / `JWT_REFRESH_SECRET` forts et **différents** de ceux de dev
- [ ] `CORS_ORIGIN` restreint au domaine de prod (jamais `*`)
- [ ] Le seed **n'est pas** lancé en prod (`/dev/seed` non monté si `NODE_ENV=production`)
- [ ] Parcours complet à la main : inscription → login → construire un coupon → chat → best bets

---

## 7. Mise en service des coupons publics (page joueur)

Fonctionnalité livrée le 2026-08-09 et **inerte tant que `PUBLIC_SLIPS_SINCE`
n'est pas renseignée**. Cette section est la procédure d'allumage.

### Ce que ça fait

Un abonné Pro peut ouvrir `/player/:userId` et consulter les coupons d'un autre
joueur, pari par pari, avec sa forme sur 30 jours glissants. Aucun paiement entre
utilisateurs n'est impliqué.

> Le marketplace payant entre utilisateurs a été **abandonné** : Stripe classe le
> « sports forecasting or odds making » avec contrepartie monétaire dans ses
> commerces prohibés, et avec Connect chaque compte créateur hérite de la
> restriction. Le repli (PSP high-risk à ~5 % + réserve glissante) imposait une
> commission plateforme d'environ 30 %. **À rouvrir seulement si** Stripe donne un
> accord écrit, ou si un PSP alternatif est retenu en connaissance des coûts —
> auquel cas les sujets à reprendre sont : ROSCA et lois d'auto-renouvellement des
> États · LPC Québec (contrat à exécution successive) · Loi 96 · substantiation des
> allégations de ROI (Loi sur la concurrence, FTC Endorsement Guides) · règles AGCO
> sur les affiliés · TPS/TVQ et *marketplace facilitator laws* · 1099-K et Partie XX
> de la LIR · EFVP Loi 25 · **jamais de portefeuille interne**, sous peine de
> basculer dans le régime des entreprises de services monétaires (FINTRAC).

### Les règles à ne pas casser

Ce sont les invariants du dispositif. Toute évolution doit s'y mesurer — les
enfreindre ne produit pas un bug visible, mais un problème de confiance ou de
conformité qu'on découvre trop tard.

**Rien de rétroactif.** Seuls les coupons déposés après `PUBLIC_SLIPS_SINCE` sont
montrés à un tiers. L'historique antérieur a été saisi quand le produit promettait
l'inverse ; il reste privé pour toujours. C'est ce qui rend l'`UPDATE` de masse de
la migration 030 acceptable.

**Échec fermé.** `PUBLIC_SLIPS_SINCE` absente ou illisible → aucun coupon visible,
plus un warn. Une variable oubliée doit casser le feature, jamais la vie privée.
Même parti pris que `PRO_PROMO_CODES`.

**Le retrait reste gratuit.** L'opt-out (`show_slips`) est **découplé de
`is_public`**, qui commande la recherche et le classement. Les lier ferait payer
la discrétion d'un rang, et un « choix » de ce genre n'en est pas un. Ne jamais
supprimer l'opt-out : forcer la publication d'un renseignement personnel sans
porte de sortie n'est pas défendable (Loi 25).

**Masquage global, jamais par coupon.** Autoriser à cacher un coupon précis, c'est
autoriser à cacher ses perdants — et le taux affiché ne veut plus rien dire.

**Le verrou temporel n'est pas un privilège.** Avant `locks_at`, les jambes ne
sortent pas du service — ni pour un Pro, ni pour un admin. `locks_at` est résolu
au serveur, jamais accepté du client. `NULL` = masqué tant que `pending` : une
panne de résolution d'horaire doit rendre un coupon trop discret, jamais le
divulguer trop tôt. L'erreur inverse est irréversible.

**Redaction dans le service, pas dans le composant.** Envoyer les jambes au client
« pour les flouter en CSS », c'est les publier.

**Aucun chiffre invérifiable à l'écran.** Les stats de l'en-tête se calculent sur
les coupons **visibles**, pas sur `user_bets` — sinon on affiche « 64 % sur 128 »
au-dessus d'une liste de 12. Plancher de 10 paris tranchés : en dessous, le
serveur renvoie `hitRate: null`. Fenêtre glissante de 30 jours, jamais calendaire
(un mois calendaire afficherait « 100 % sur 1 pari » chaque 1er du mois).

**Une jambe non évaluée n'est pas une jambe perdue.** `unknown` et les coupons
antérieurs à la persistance par jambe s'affichent `—`.

**La divulgation vit au point de collecte.** La ligne sous le bouton de soumission
(`BetBuilderPage`) est ce qui rend le consentement éclairé — pas les CGU, que
personne n'ouvre.

### Deux verrous, à ouvrir dans cet ordre

| Verrou | Effet fermé | Comment on l'ouvre |
|---|---|---|
| `show_slips` (colonne) | Le joueur n'apparaît pas | Migration **030** — passe le défaut à TRUE |
| `PUBLIC_SLIPS_SINCE` (env) | **Aucun** coupon visible à un tiers, quel que soit `show_slips` | Variable d'environnement sur Railway |

La migration 030 peut être appliquée **des semaines avant** l'allumage : sans la
variable, elle n'expose rien. C'est voulu — ça décorrèle le déploiement du schéma
du choix de la date, et ça rend la bascule réversible en une variable.

### Procédure

1. **Vérifier que le code est déployé** (client + serveur) et que
   `PUBLIC_SLIPS_SINCE` est absente. Au démarrage du serveur, la première lecture
   d'une page joueur doit produire :
   `[profile] PUBLIC_SLIPS_SINCE absente ou invalide — aucun coupon n'est visible`.
2. **Appliquer les migrations** : `npm run db:migrate:all` (029 + 030).
3. **Prévenir les joueurs** — `npm run notify:slips -- --date 2026-10-07`
   (simulation), puis `--send`. Contenu minimal : ce qui devient visible, à partir
   de quand, que rien d'antérieur ne le sera, et où se retirer (Paramètres →
   Confidentialité). À envoyer **avant** l'étape 4.

   > **Décidé le 2026-08-09 : pas de bandeau in-app.** L'avis passe uniquement par
   > le courriel. Conséquence assumée — les comptes qui ne lisent pas leurs
   > courriels découvriront le changement en ouvrant les Paramètres. La divulgation
   > au moment de la soumission du coupon (`BetBuilderPage`) reste le filet : elle
   > est vue par tous ceux qui déposent un coupon, donc par tous ceux qui sont
   > concernés.
4. **Poser la variable** sur Railway (service Node), au format ISO 8601 :
   `PUBLIC_SLIPS_SINCE=2026-10-07T00:00:00Z`
   Viser le **début de saison NHL** : allumer en septembre donnerait des pages
   vides pendant trois semaines.
5. **Redéployer** le service Node (Railway relance sur changement de variable).

### Vérifications après allumage

```bash
# Depuis un compte Pro, sur un joueur tiers
curl -H "Authorization: Bearer $PRO_TOKEN" \
     "$API/api/users/$OTHER_USER_ID/slips"      # → 200, uniquement des coupons post-coupure

# Depuis un compte non-Pro
curl -H "Authorization: Bearer $FREE_TOKEN" \
     "$API/api/users/$OTHER_USER_ID/slips"      # → 402 PRO_REQUIRED, aucun coupon dans le corps

# Sur un joueur qui s'est retiré
# → 403 SLIPS_HIDDEN (code distinct : l'abonnement n'est pas en cause)
```

À contrôler à l'œil, une fois :

- [ ] Un coupon dont le match n'a pas commencé revient avec `legs: null` et `locked: true`
- [ ] Aucun coupon antérieur à `PUBLIC_SLIPS_SINCE` n'apparaît pour un tiers
- [ ] Le propriétaire voit bien tout son historique, verrous compris
- [ ] Le taux de réussite de l'en-tête est cohérent avec la liste affichée
      (calculé sur les coupons visibles, pas sur `user_bets`)
- [ ] Sous 10 paris tranchés, aucun pourcentage n'est affiché

### Retour arrière

**Supprimer `PUBLIC_SLIPS_SINCE` et redéployer.** Tout se referme immédiatement,
sans migration inverse. C'est la raison pour laquelle la date vit dans une
variable d'environnement plutôt qu'en base.

Un retour arrière plus profond (revenir à l'opt-in) demanderait
`ALTER TABLE user_profiles ALTER COLUMN show_slips SET DEFAULT FALSE` — mais pas
d'`UPDATE` de masse en sens inverse : il écraserait les choix de ceux qui ont
délibérément gardé la visibilité.

---

## Coûts estimés

| Service | Plan gratuit | Limite |
|---------|-------------|--------|
| Neon | **Launch — payant, aucun plan gratuit** | aucune allocation incluse : **0,106 $/CU-h**, **0,35 $/Go-mois**, 500 Go de transfert public inclus puis 0,10 $/Go. **Aucun plafond dur** — seulement une alerte de dépense, armée à 6 $. Scale-to-zero à 5 min, désactivable : ne pas y toucher |
| Cloudflare R2 | Free tier | 10 Go, **egress gratuit** |
| Railway | Hobby ($5/mo) | 512 MB RAM × 2 services |
| Vercel | Hobby (gratuit) | 100 GB bandwidth |

> **Railway** : le plan Hobby est nécessaire pour les services persistants (Hobby = $5/mois crédits inclus).

---

## Commandes utiles en local

```bash
# Lancer tout en local (3 terminaux)
cd server && npm run dev          # :3001
cd ml/python && python ml_service.py   # :8000
cd client && npm run dev          # :5173

# Entraîner les modèles ML
cd ml/python
python fetch_data.py --seasons 3 --output ../data/nhl_games.csv
python train.py

# Générer des secrets JWT
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```
