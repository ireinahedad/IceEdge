# ICEEDGE — Guide de déploiement

Architecture : **Vercel** (frontend) + **Railway** (Node.js + Python) + **Supabase** (PostgreSQL)

---

## 1. Supabase — Base de données

### Créer le projet
1. https://supabase.com → New project
2. Nom : `iceedge` · Région : **US East (N. Virginia)** · Mot de passe DB : générer un fort
3. Attendre ~2 min que le projet s'initialise

### Importer le schéma
1. Dashboard → **SQL Editor** → New query
2. Copier-coller le contenu de `server/src/db/schema.sql`
3. Exécuter (▶)

### Récupérer l'URL de connexion
Dashboard → **Settings → Database → URI** → copier la connection string :
```
postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
```
→ Garder cette URL pour les étapes Railway et variables d'env.

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
| `DATABASE_URL` | URL Supabase (étape 1) |
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `JWT_REFRESH_SECRET` | (même commande, valeur différente) |
| `GOOGLE_CLIENT_ID` | Depuis Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | Depuis Google Cloud Console |
| `GOOGLE_REDIRECT_URI` | `https://[TON-SERVICE].railway.app/api/auth/google/callback` |
| `CLIENT_URL` | `https://iceedge.vercel.app` (à confirmer après Vercel) |
| `CORS_ORIGIN` | `https://iceedge.vercel.app` |
| `ML_SERVICE_URL` | URL du service Python Railway (étape 3) |

### Domaine
Settings → Networking → **Generate Domain** → noter l'URL (ex: `iceedge-backend.railway.app`)

---

## 3. Railway — Service ML Python

### Créer un deuxième service dans le même projet
1. Railway → même projet → **+ New Service → GitHub repo**
2. Même repo `ICEEDGE` → **Root directory : `ml/python`**
3. Railway détecte le `Dockerfile` dans `ml/python/`

### Variables d'environnement
Aucune variable requise par défaut. Optionnel :

| Variable | Valeur |
|----------|--------|
| `PORT` | `8000` |

### Modèles XGBoost
Les modèles (`game_model.json`, `totals_model.json`) ne sont **pas** dans le repo Git.
Deux options :

**Option A — Entraîner en local et committer les modèles :**
```bash
cd ml/python
python fetch_data.py --seasons 3 --output ../data/nhl_games.csv
python train.py
# Modèles générés dans ml/models/
git add ../models/
git commit -m "feat: add trained XGBoost models"
git push
```

**Option B — Railway Volume (après déploiement) :**
Si les modèles sont trop lourds pour Git, utiliser un Railway Volume monté sur `/app/models`.

> Sans modèles, le service démarre en mode fallback (règle-based seulement).

### Domaine
Settings → Networking → **Generate Domain** → noter l'URL (ex: `iceedge-ml.railway.app`)
→ Mettre à jour `ML_SERVICE_URL` dans le service Node.js (étape 2)

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
# Backend Node.js
curl https://[TON-BACKEND].railway.app/api/health

# Service ML Python
curl https://[TON-ML].railway.app/health
```

### Vérifier la chaîne complète
```bash
# Test prédiction ML via le backend
curl -X POST https://[TON-BACKEND].railway.app/api/predict/ml \
  -H "Content-Type: application/json" \
  -d '{"type":"game","homeTeam":"TOR","awayTeam":"MTL","propType":"moneyline"}'
```

### Checklist finale
- [ ] Supabase : schéma importé, connexion vérifiée
- [ ] Railway Node.js : deploy réussi, `/api/health` répond 200
- [ ] Railway Python : deploy réussi, `/health` répond 200
- [ ] Vercel : build réussi, app accessible
- [ ] Google OAuth : URIs de redirection mises à jour
- [ ] Variables d'env croisées mises à jour (ML_SERVICE_URL, CLIENT_URL, CORS_ORIGIN)
- [ ] Modèles XGBoost déployés (ou fallback accepté)
- [ ] Test de connexion end-to-end (login → prédiction)

---

## Coûts estimés

| Service | Plan gratuit | Limite |
|---------|-------------|--------|
| Supabase | Free tier | 500 MB DB, 2 GB transfer |
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
