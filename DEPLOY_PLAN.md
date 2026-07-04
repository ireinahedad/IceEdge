# ICEEDGE — Plan de déploiement (économique, ~5-10 $/mois)

_Adapté à tes choix : petit serveur toujours allumé, données NHL en direct (pas stockées), ML reporté._

Dernière mise à jour : 2026-07-04

---

## La stack recommandée

| Composant | Hébergeur | Coût | Pourquoi |
|-----------|-----------|------|----------|
| **Frontend** (React/Vite) | **Vercel** | Gratuit | Parfait pour un SPA statique. Déploiement auto depuis Git. |
| **Backend** (Node + Express + Socket.io) | **Railway** | ~5 $/mo | Toujours allumé (pas de cold start → chat fluide). WebSocket natif. Simple. |
| **Base de données** (PostgreSQL) | **Neon** | Gratuit | Postgres serverless, scale-to-zero, tier gratuit généreux. Grandit avec tes users. |
| **Service ML** (Python) | — | 0 $ | **Non déployé pour l'instant.** L'app retombe sur les règles. |

**Total : ~5 $/mois.** (Vercel + Neon gratuits ; seul Railway est payant.)

> Pourquoi pas tout sur Vercel ? Vercel est serverless → il ne peut pas garder une connexion WebSocket ouverte pour Socket.io (le chat). Le backend doit tourner sur une instance persistante (Railway).

> Alternatives équivalentes : **Fly.io** ou **Render** (payant) au lieu de Railway ; **Supabase** au lieu de Neon (gratuit aussi, et te donne l'auth/le stockage en bonus si tu en veux plus tard).

---

## Pourquoi c'est efficace pour ton cas

- **Données NHL en direct + cache mémoire** : rien à stocker, pas de job de synchro, DB minuscule. Comme le backend est **une seule instance toujours allumée**, le cache mémoire fonctionne parfaitement — pas besoin de Redis.
- **DB qui grandit avec l'usage** : Neon ne facture qu'au stockage/compute réellement utilisé. Au lancement, ta base est quasi vide (juste les comptes qui s'inscrivent) → coût ≈ 0.
- **ML reporté** : un service de moins à héberger et à surveiller. Tu l'ajouteras quand le modèle aura un vrai edge.

---

## Étapes de déploiement (dans l'ordre)

### 1. Base de données — Neon
1. Créer un projet sur [neon.tech](https://neon.tech) → récupérer la `DATABASE_URL` (Connection string).
2. Créer les tables depuis ton poste, en pointant sur Neon :
   ```bash
   cd server
   # exécuter schema.sql + la migration slips contre Neon
   psql "postgresql://...neon..." -f src/db/schema.sql
   psql "postgresql://...neon..." -f - <<'SQL'
   -- ou lancer: DATABASE_URL="postgresql://...neon..." npm run db:migrate:slips
   SQL
   ```
   (La base démarre vide — elle se remplira quand les gens s'inscriront.)

### 2. Backend — Railway
1. Nouveau projet Railway → « Deploy from GitHub repo » → dossier `server/` (il y a déjà un `Dockerfile`).
2. Variables d'environnement à définir :
   ```
   DATABASE_URL=<la connection string Neon>
   JWT_SECRET=<générer: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
   JWT_REFRESH_SECRET=<idem, une autre>
   CORS_ORIGIN=https://<ton-app>.vercel.app
   NODE_ENV=production
   ML_DISABLED=true            # ← ML reporté : l'app utilise les règles
   RAPIDAPI_KEY=<ta clé tennis>   # optionnel
   GOOGLE_CLIENT_ID=<...>
   GOOGLE_CLIENT_SECRET=<...>
   GOOGLE_REDIRECT_URI=https://<ton-backend>.up.railway.app/api/auth/google/callback
   CLIENT_URL=https://<ton-app>.vercel.app
   ```
3. Railway te donne une URL publique (ex. `iceedge-server.up.railway.app`).

### 3. Frontend — Vercel
1. Importer le repo → « Root Directory » = `client/`.
2. Variables `VITE_*` (pointant sur le backend Railway) :
   ```
   VITE_NHL_API_URL=https://<ton-backend>.up.railway.app/api/nhl
   VITE_PROFILE_API_URL=https://<ton-backend>.up.railway.app/api
   VITE_PREDICTION_API_URL=https://<ton-backend>.up.railway.app/api
   VITE_SOCKET_URL=https://<ton-backend>.up.railway.app
   VITE_ODDS_API_KEY=<ta clé The Odds API>       # optionnel
   VITE_BET365_AFFILIATE_CODE=<ton code>          # optionnel
   ```
3. Deploy → tu obtiens `https://<ton-app>.vercel.app`.

### 4. Boucler les liens
- Mettre `CORS_ORIGIN` (Railway) = l'URL Vercel exacte.
- Dans **Google Cloud Console** → OAuth : ajouter l'URL de callback de prod (`.../api/auth/google/callback`) aux « Authorized redirect URIs ».
- Redéployer le backend si tu as changé une variable.

---

## Checklist avant d'ouvrir au public

- [ ] Secrets JWT forts et **différents** de ceux de dev.
- [ ] `CORS_ORIGIN` restreint au domaine Vercel (pas `*`).
- [ ] HTTPS partout (automatique sur Vercel/Railway).
- [ ] Tester : inscription → login → construire un slip → chat → best bets.
- [ ] Rate-limiting basique sur le backend (ex. `express-rate-limit`) — recommandé.
- [ ] Le seed **n'est pas** lancé en prod (route seed déjà désactivée si `NODE_ENV=production`).

---

## Plus tard : ajouter le ML

Quand le modèle aura un vrai edge :
1. Déployer `ml/python/` comme 2e service Railway (Dockerfile déjà présent) → URL publique.
2. Sur le backend : `ML_SERVICE_URL=https://<ml>.up.railway.app` et `ML_DISABLED=false`.
3. Redéployer. Aucune autre modif — le proxy et le fallback existent déjà.

Coût additionnel : ~5 $/mo pour le 2e service (ou scale-to-zero sur Render si usage faible).

---

## Estimation coût mensuel

| Scénario | Coût |
|----------|------|
| Lancement (front + back + DB, sans ML) | **~5 $/mo** |
| + service ML plus tard | ~10 $/mo |
| Si tu passes tout en tiers gratuits (avec cold starts) | 0 $ (moins bonne UX chat) |
