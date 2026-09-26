# QA dynamique — stack locale

Ce que `QA_TEST_PLAN.md` appelle F1, F2, F3, F6, S1 (IDOR 2 comptes), S2 (JWT, refresh),
I3 (webhook Stripe), I5 (socket.io), P3 (rate limit), P5 (pool), les deux cas de modération
jamais vus à l'écran, et R5 (SIGTERM sous trafic) — joué contre une stack **locale** en
`NODE_ENV=production`. Première exécution : 2026-09-26, 90/90 après correctifs (voir
`QA_TEST_PLAN.md` § « Exécution du 2026-09-26 »).

**Jamais contre la production.** Le script écrit en base, forge des JWT avec le secret de
l'API et signe des webhooks Stripe avec son secret : il lit tout ça dans le fichier d'env de
la stack locale. Il refuse de partir si `QA_API` ressemble à arakice.com / Railway ou si
`DATABASE_URL` pointe sur Neon.

## Monter la stack (conteneur Linux, pas le pont Windows)

```bash
# Postgres 16 jetable
initdb -D /tmp/pgdata -A trust -U postgres && pg_ctl -D /tmp/pgdata -l /tmp/pg.log start
createdb -h 127.0.0.1 -U postgres iceqa
cd server && npm ci && npm run build
DB_SSL=false DATABASE_URL=postgresql://postgres@127.0.0.1:5432/iceqa npm run db:migrate:all

# Fichier d'env de la stack (secrets aléatoires, JAMAIS ceux de prod)
cat > /tmp/qa/api.env <<EOF
NODE_ENV=production
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/iceqa
DB_SSL=false
CORS_ORIGIN=https://arakice.com
CLIENT_URL=https://arakice.com
JWT_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
ML_SERVICE_URL=http://127.0.0.1:8000
ML_API_TOKEN=<même valeur que côté ML>
EMAIL_VERIFICATION_DISABLED=true
STRIPE_SECRET_KEY=sk_test_dummy
STRIPE_WEBHOOK_SECRET=whsec_$(openssl rand -hex 8)
SENTRY_DSN=http://qapublickey@127.0.0.1:9999/1
ENABLE_DEV_ROUTES=true
DORMANT=true
NHL_USE_MOCK=true
ALLOW_MOCK_IN_PRODUCTION=true
EOF
```

Le conteneur n'atteint pas `api-web.nhle.com`, d'où le mock NHL (les deux variables).
Ne pas avoir de `server/.env` dans la copie : `dotenv` compléterait avec les vraies clés.

Puis : service ML (`uvicorn ml_service:app --port 8000` avec `MODELS_DIR` et `ML_API_TOKEN`),
`node sentry-catcher.js &`, l'API (`set -a; . /tmp/qa/api.env; node dist/server.js`), et :

```bash
node qa.mjs            # tout
node qa.mjs S1 S2      # une partie
node r5.mjs            # SIGTERM pendant 20 clients : 0 réponse 5xx attendue, puis « Clean shutdown »
```

## Pièges rencontrés

- `pkill -f <motif>` tue aussi le shell dont la ligne de commande contient le motif.
  Mettre les commandes dans un script.
- Chaque « client » du script a sa propre `X-Forwarded-For` (l'API fait confiance à un
  proxy en production) — sinon `authLimiter` (15 échecs / 15 min / IP) fait échouer les
  sections suivantes.
- Les prédictions ML sont en cache 5 min : pour tester « ML coupé », varier les équipes.
