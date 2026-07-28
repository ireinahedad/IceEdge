# ARAKICE — Guide de déploiement

Architecture : **Vercel** (frontend) + **Railway** (Node.js + Python) + **Neon** (PostgreSQL) + **Cloudflare R2** (avatars)

> **Note.** Ce guide a longtemps décrit Supabase. La base de production est
> **Neon** (voir `DEPLOY_PLAN.md`) : c'est son *scale-to-zero* qui rend le job de
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
l'image : `game_model.json`, `totals_model.json`, `elo_ratings.json`,
`inference_state.json`, `training_report.json`. Rien à monter, rien à uploader.

Le corollaire : **les modèles déployés sont ceux du dernier commit.** Après un
ré-entraînement local, il faut committer et pousser, sinon Railway sert
l'ancien modèle sans le moindre avertissement.

```bash
cd ml/python && python train.py     # régénère ml/models/
git add ../models && git commit -m "chore(ml): retrain" && git push
```

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
3. Dans le service **Node.js** (étape 2), poser :
   ```
   ML_SERVICE_URL=http://iceedge-ml.railway.internal:8000
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
Depuis le service Node (Railway → Shell) :
```bash
curl -s $ML_SERVICE_URL/health                                    # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  $ML_SERVICE_URL/predict/game -H 'Content-Type: application/json' -d '{}'   # 401 sans token
```
Et depuis l'extérieur, l'URL publique ne doit **pas** exister.

---

## 4. Vercel — Frontend

### Déployer
1. https://vercel.com → New Project → Importer `ICEEDGE`
2. **Root directory : `client`**
3. Framework : **Vite** (détecté automatiquement)
4. Build command : `npm run build` · Output : `dist`

### Variables d'environnement
Project Settings → Environment Variables → Production :

| Variable | Valeur |
|----------|--------|
| `VITE_NHL_API_URL` | `https://[TON-BACKEND].railway.app/api/nhl` |
| `VITE_PROFILE_API_URL` | `https://[TON-BACKEND].railway.app/api` |
| `VITE_PREDICTION_API_URL` | `https://[TON-BACKEND].railway.app/api` |
| `VITE_SOCKET_URL` | `https://[TON-BACKEND].railway.app` |
| `VITE_ODDS_API_KEY` | `5333eb4e9ab762d0735120390351985b` |
| `VITE_BET365_AFFILIATE_CODE` | Code affilié Bet365 |

### Domaine
Vercel attribue automatiquement `iceedge.vercel.app` (ou le nom du projet).
→ Revenir à l'étape 2 pour mettre à jour `CLIENT_URL` et `CORS_ORIGIN` avec cette URL.

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

---

## Coûts estimés

| Service | Plan gratuit | Limite |
|---------|-------------|--------|
| Neon | Free tier | 0,5 Go de stockage, scale-to-zero |
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
