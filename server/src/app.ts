import express from 'express';
import * as Sentry from '@sentry/node';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import authRoutes          from './routes/auth.routes';
import userRoutes          from './routes/user.routes';
import profileRoutes       from './routes/profile.routes';
import nhlRoutes           from './routes/nhl.routes';
import oddsRoutes          from './routes/odds.routes';
import manualRoutes        from './routes/manual.routes';
import mlRoutes            from './routes/ml.routes';
import chatRoutes          from './routes/chat.routes';
import slipRoutes          from './routes/slip.routes';
import devRoutes           from './routes/dev.routes';
import llmRoutes           from './routes/llm.routes';
import subscriptionRoutes, { stripeWebhook } from './routes/subscription.routes';
import pushRoutes          from './routes/push.routes';
import { getLeaderboard }  from './services/profile.service';
import { pool }            from './db/connection';
import { httpLogger, logger } from './logger';
import { seedAll }         from './db/seed';
import { apiLimiter, authLimiter, writeLimiter } from './middleware/rateLimit.middleware';
import { noStore }            from './middleware/httpCache.middleware';
import { corsOriginCallback }  from './cors';
import { sendError, errorStatus, errorBody } from './httpError';

const app = express();

// Behind a proxy in prod (Railway/Render/Fly) → trust the first hop so
// express-rate-limit keys on the real client IP, not the proxy's.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(helmet());
// Structured per-request logging + request ids (before routes so every handler
// gets req.log and the x-request-id header is set on the response).
app.use(httpLogger);
// credentials:true is required so the httpOnly refresh-token cookie flows
// between the client (5173) and the API (3001). '*' is not allowed with
// credentials, hence the explicit default origin.
//
// La politique d'origine (liste CORS_ORIGIN + previews Vercel) vit dans
// ./cors, partagée avec socket.ts pour que HTTP et WebSocket ne puissent pas
// diverger — c'était le cas, et le WebSocket cassait dès qu'on configurait
// deux origines.
app.use(cors({ origin: corsOriginCallback, credentials: true }));
app.use(cookieParser());

// Stripe webhook — MUST receive the raw body to verify the signature, so it is
// mounted with express.raw BEFORE the JSON parser below. Registered early so it
// also bypasses the /api JSON rate limiter.
app.post('/api/subscription/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// Body limits. `express.json` parse la chaîne de façon SYNCHRONE : un body de
// plusieurs Mo bloque l'event loop pour toutes les requêtes en cours. Un plafond
// global de 5 Mo offrait cette surface à n'importe quelle route.
//
// L'avatar est la seule route qui a besoin de plus : elle reçoit une data-URI
// base64. Elle a donc son propre parser, monté AVANT le parser global — le
// premier body-parser à s'exécuter marque `req._body`, les suivants passent leur
// tour. Le client redimensionne désormais en 256×256 WebP (~20 ko, ~27 ko en
// base64) : 600 ko laissent une marge confortable, y compris pour un client dont
// le bundle n'est pas encore à jour.
app.use('/api/users/me/avatar', express.json({ limit: '600kb' }));

// 100 ko pour tout le reste : aucune route légitime n'envoie plus (paris,
// profil, messages de chat, prompts LLM).
app.use(express.json({ limit: '100kb' }));

// Broad rate-limit on the whole API (health check stays outside /api).
app.use('/api', apiLimiter);

// --- Cache HTTP : tout ce qui dépend de l'appelant part en `no-store` --------
//
// L'API va passer derrière Cloudflare pour que le CDN absorbe le trafic NHL et
// odds (voir AUDIT_SCALABILITE_COUTS.md, P1-9). Une réponse SANS `Cache-Control`
// n'est pas « non cachable » : elle est laissée à l'heuristique du cache, et
// cette heuristique varie d'un CDN, d'un proxy d'entreprise et d'un navigateur
// à l'autre. Le jour où quelqu'un ajoute une Cache Rule un peu large côté
// Cloudflare, l'absence d'en-tête devient une fuite de données entre comptes.
//
// La règle est donc explicite et posée AU MONTAGE, pas route par route : tout
// routeur servant une donnée dérivée de l'utilisateur est en `private,
// no-store`, sans exception à écrire dans chaque handler (donc sans oubli
// possible quand une route est ajoutée plus tard).
//
// `noStore` ne pose l'en-tête que si le handler n'en a pas déjà mis un, donc il
// n'écrase rien ; et il s'applique à l'envoi, donc les erreurs sont couvertes.

// Auth — strict limiter first (brute-force protection), then routes.
// Réponses contenant des jetons : jamais stockées, nulle part.
app.use('/api/auth',          authLimiter, noStore, authRoutes);

// Users: profile /me routes first (no auth), then admin CRUD (require JWT)
//
// ⚠️ DEUX routeurs sur le MÊME préfixe, et l'ordre est significatif (audit
// pré-freeze iOS, § 1 « Divers »). `profileRoutes` gagne sur tout ce qu'il
// déclare : `/search` et `/me` passent avant le `/:id` de `userRoutes`, ce qui
// est voulu — un utilisateur nommé « me » ne peut pas détourner son propre
// profil. Mais la conséquence l'est moins :
//
//   • une route ajoutée à `userRoutes` peut être **silencieusement masquée**
//     par un motif plus général de `profileRoutes` (tout `/:id` ou `/:userId`),
//     sans erreur au démarrage ni au build — seulement un 404 ou, pire, la
//     mauvaise réponse ;
//   • `authenticate` s'exécute **deux fois** sur `/me/blocks` : une fois par le
//     `router.use('/me', authenticate)` de `profileRoutes`, une fois par le
//     `router.use(authenticate)` de `userRoutes`. Sans conséquence (la
//     vérification du JWT ne touche pas la base), mais c'est le symptôme.
//
// La fusion des deux routeurs — ou un préfixe distinct — est **reportée après
// le freeze iOS** : elle déplace des URL publiques, donc elle demande de
// retoucher le client et de retester l'authentification, et ce n'est pas un
// risque à prendre pour un défaut qui ne se manifeste aujourd'hui dans aucun
// parcours. **En attendant : toute nouvelle route `/api/users/...` se déclare
// dans `profileRoutes`**, jamais dans `userRoutes`, pour ne pas dépendre de
// l'ordre ci-dessous.
app.use('/api/users',         noStore, profileRoutes);
app.use('/api/users',         noStore, userRoutes);

// NHL data (live from NHL API) — public et identique pour tous.
// Les en-têtes de cache sont posés par route dans nhl.routes.ts, alignés sur
// les TTL serveur de nhlApiClient.
app.use('/api/nhl',           nhlRoutes);

// Leaderboard — public, identique pour tous, caché 60 s côté service.
// Le même Cache-Control côté HTTP laisse navigateur et CDN absorber le reste.
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const leaderboard = await getLeaderboard();
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json(leaderboard);
  }
  catch (err: any) { sendError(res, err); }
});

// Chat (writes are limited to blunt spam)
// Les messages d'un salon privé et les avatars de ses membres n'ont rien à
// faire dans un cache partagé.
app.use('/api/chat',          writeLimiter, noStore, chatRoutes);

// Bet slips (auth-gated; writes limited)
app.use('/api/slips',         writeLimiter, noStore, slipRoutes);

// Odds
app.use('/api/odds',          oddsRoutes);

// Saisie manuelle (blessures, gardiens partants, absents, arbitres) — admin.
// Remplace `/api/injuries`, qui écrivait dans un `dist/data/` inexistant en
// production. `noStore` et `writeLimiter` comme les autres routeurs d'écriture ;
// `noStore` compte double ici, car la réponse contient la liste nominative des
// joueurs qu'on croit absents — elle n'a rien à faire dans un cache partagé.
app.use('/api/manual',        writeLimiter, noStore, manualRoutes);

// ML / prediction
app.use('/api/predict',       mlRoutes);


// LLM proxy (uses user's own OpenAI key)
app.use('/api/llm',           noStore, llmRoutes);

// Subscriptions (Free / Pro)
// Le webhook Stripe est monté plus haut, hors de ce routeur : il n'est pas
// concerné.
app.use('/api/subscription',  noStore, subscriptionRoutes);

// Web Push (value-bet notifications)
app.use('/api/push',          noStore, pushRoutes);

// Dev ML dashboard (admin-only). Defence in depth: even though every route is
// gated behind authenticate + requireRole('admin'), the router is not mounted
// at all in production unless explicitly opted in via ENABLE_DEV_ROUTES=true.
// This removes the attack surface entirely in a normal prod deployment.
// Exporté pour la bannière `[Server] Réglages effectifs` : le préflight des
// runbooks B4 (`QA_TEST_PLAN.md`) a besoin de la valeur EFFECTIVE, pas de la
// variable brute. Un routeur non monté répond 404, ce qui se lit à tort comme
// « la route est cassée » — une seule définition, deux lecteurs.
export const devRoutesEnabled =
  process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_ROUTES === 'true';
if (devRoutesEnabled) {
  app.use('/api/dev',         noStore, devRoutes);
}

// Dev-only seed endpoint
if (process.env.NODE_ENV !== 'production') {
  app.post('/dev/seed', async (_req, res) => {
    try { await seedAll(); res.json({ message: 'Seed complete' }); }
    catch (err: any) { sendError(res, err); }
  });
}

// Health checks — liveness vs readiness are deliberately separate.
//
// Liveness: is the process up and the event loop responsive? No dependencies.
// An orchestrator uses this to decide whether to RESTART the container, so it
// must NOT depend on Postgres — a DB blip should not trigger a restart loop.
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Readiness: can this instance actually serve requests right now? Checks the
// one hard dependency, Postgres. A load balancer uses this to decide whether to
// ROUTE traffic; returning 503 pulls the instance out of rotation while its DB
// is unreachable instead of sending users failing requests.
//
// The ML service is intentionally NOT checked here: predictions fall back to a
// rule-based path when it's down, so gating readiness on it would cause false
// outages and hammer the ML service with probe traffic.
//
// Le résultat du SELECT 1 est mis en cache : Neon suspend son compute après
// 5 min d'inactivité, donc une sonde qui interroge la base toutes les 1-5 min
// l'empêche à elle seule de dormir. Sur le plan Launch (celui du projet), ça ne
// suspend rien : ça facture 0,106 $/CU-heure sans plafond, soit ~19 $/mois pour
// une base allumée 24/7 à 0,25 CU.
// Un TTL supérieur à la fenêtre de suspension retire la sonde de l'équation.
// Contrepartie assumée : une panne DB pendant une période sans trafic peut
// mettre jusqu'à READINESS_DB_TTL_MS à apparaître sur le monitoring. Les
// requêtes réelles, elles, échouent immédiatement et remontent via Sentry.
const READINESS_DB_TTL_MS = Number(process.env.READINESS_DB_TTL_MS) || 600_000;

let dbOkUntil = 0;
let dbProbeInFlight: Promise<boolean> | null = null;

async function probeDb(): Promise<boolean> {
  const client = await pool.connect();
  try {
    // Bound the probe so a hung DB can't hang the health endpoint.
    await client.query('SET statement_timeout = 3000');
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

/**
 * Postgres reachable ? Les succès sont mis en cache READINESS_DB_TTL_MS ; les
 * échecs ne le sont jamais (le cache est invalidé), donc une panne comme un
 * rétablissement sont vus à la cadence réelle des sondes. Les appels
 * concurrents partagent la même requête : au réveil de Neon (démarrage à
 * froid de quelques secondes) plusieurs sondes ne monopolisent pas le pool.
 */
async function isDbReady(): Promise<boolean> {
  if (Date.now() < dbOkUntil) return true;
  if (!dbProbeInFlight) {
    dbProbeInFlight = probeDb()
      .then(() => {
        dbOkUntil = Date.now() + READINESS_DB_TTL_MS;
        return true;
      })
      .catch((err: any) => {
        dbOkUntil = 0;
        logger.error({ err: err?.message ?? err }, '[health] readiness DB check failed');
        return false;
      })
      .finally(() => { dbProbeInFlight = null; });
  }
  return dbProbeInFlight;
}

app.get('/health/ready', async (_req, res) => {
  const cached = Date.now() < dbOkUntil;
  const ready = await isDbReady();
  const checks: Record<string, 'ok' | 'down'> = { db: ready ? 'ok' : 'down' };
  res
    .status(ready ? 200 : 503)
    .json({ status: ready ? 'ok' : 'unavailable', checks, cached: ready && cached });
});

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Sentry error capture — no-op unless SENTRY_DSN is configured (see instrument.ts).
// Must be registered after routes and before our own error handler.
Sentry.setupExpressErrorHandler(app);

// Global error handler
//
// Le filet pour tout ce qui remonte par `next(err)` : erreurs non attrapées,
// corps JSON malformé, routeurs qui ne répondent pas eux-mêmes.
//
// La mise en forme vient de `httpError.ts`, comme celle des handlers qui
// répondent directement. C'était le vrai défaut de la version précédente : elle
// avait raison, mais elle était SEULE à avoir raison. Quatre-vingt-treize
// handlers répondaient sans passer par ici, donc sans sa protection. Une règle
// n'est une règle que s'il n'existe qu'un endroit où elle est écrite.
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Log with the request-scoped logger so the error is correlated to its
  // request id; fall back to console if the logger middleware didn't run.
  ((req as any).log?.error?.bind((req as any).log) ?? console.error)({ err }, 'request failed');
  res.status(errorStatus(err)).json(errorBody(err));
});

export default app;
