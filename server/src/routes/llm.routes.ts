/**
 * llm.routes.ts
 * POST /api/llm  — proxies a prompt to a chat model.
 *
 * Two billing paths, chosen by subscription tier:
 *   • PRO  users  → the app's own GitHub Models token (GITHUB_MODELS_TOKEN).
 *                   Costs/rate-limits are billed to the app operator's GitHub
 *                   account. Model defaults to `openai/gpt-5-mini`.
 *   • FREE users  → their own OpenAI key stored in user_profiles.openai_api_key.
 *                   Costs are billed to the user's OpenAI account.
 *
 * ── PLAFOND DE COÛT (P1-6) ──────────────────────────────────────────────────
 *
 * Le chemin Pro est le seul qui coûte de l'argent à l'opérateur. Le nombre de
 * requêtes qu'un abonné peut y envoyer est PLAFONNÉ MENSUELLEMENT, et ce plafond
 * est dérivé de ce qu'il paie (voir `services/llmQuota.service.ts`) : la dépense
 * IA d'un utilisateur ne peut pas dépasser la part prévue de son abonnement.
 *
 * Une fois le plafond atteint, le chemin Pro se ferme mais la fonctionnalité ne
 * disparaît pas : si l'utilisateur a renseigné sa propre clé OpenAI, la requête
 * repart par le chemin Free, à ses frais. Ce n'est pas seulement plus aimable
 * qu'un blocage — cela retire la seule raison qu'aurait un abonné d'exiger un
 * plafond plus haut, donc cela rend le plafond tenable.
 */

import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authenticate } from '../middleware/auth.middleware';
import { llmLimiter } from '../middleware/rateLimit.middleware';
import { isPro } from '../services/subscription.service';
import { decryptSecret } from '../services/crypto.util';
import { TtlCache } from '../services/ttlCache';
import { recordUpstream } from '../metrics';
import { logger } from '../logger';
import {
  consumeProRequest, refundProRequest, getUsage, MONTHLY_QUOTA, MAX_OUTPUT_TOKENS,
} from '../services/llmQuota.service';
import {
  LLM_TASK_TYPES, isLlmTaskType, resolveLocale, systemPromptFor,
} from '../services/llmPrompts';

const router = Router();

// ── Abuse controls ────────────────────────────────────────────────────────────
// Caps keep a single user (or a leaked token) from running up token-cost on the
// operator's GitHub Models account or tying up connections indefinitely.
const MAX_PROMPT_CHARS  = Number(process.env.LLM_MAX_PROMPT_CHARS)  || 8_000;   // ~2k tokens
// `LLM_MAX_SYSTEM_CHARS` a disparu avec le `systemPrompt` du corps de requête :
// l'invite système est maintenant écrite dans `services/llmPrompts.ts`, donc sa
// taille est connue à la compilation et n'a plus à être bornée à l'exécution.
const FETCH_TIMEOUT_MS  = Number(process.env.LLM_FETCH_TIMEOUT_MS)  || 30_000;
/**
 * Quota journalier par utilisateur, en mémoire.
 *
 * Ne s'applique plus qu'aux utilisateurs **Free**, et son rôle a changé : ils
 * paient leurs propres tokens, donc il ne protège pas un budget — il protège
 * nos ressources serveur (connexions sortantes, event loop) d'un usage
 * anormal. Approximatif et par instance : c'est acceptable pour cet usage-là.
 *
 * Le budget des utilisateurs **Pro**, lui, est protégé par le plafond mensuel
 * en base (`llmQuota.service`), qui survit aux redéploiements et au
 * multi-instance — ce que ce compteur-ci ne fait pas.
 */
const DAILY_QUOTA       = Number(process.env.LLM_DAILY_QUOTA)       || 200;

interface QuotaEntry { count: number; day: string; }

// Une entrée par utilisateur, jamais supprimée : la `Map` d'origine gardait
// pour toujours le compteur de chaque personne ayant utilisé l'IA une fois.
// Le compteur lui-même est minuscule, mais la croissance est monotone — c'est
// la même fuite que les caches d'API, en plus lent.
//
// Plafond volontairement très large : l'éviction FIFO REMET À ZÉRO le quota de
// l'utilisateur évincé (fail-open). C'est le bon sens de l'échec — une éviction
// ne peut jamais bloquer quelqu'un à tort — mais il ne faut pas qu'elle serve
// de contournement, d'où un plafond bien au-dessus du nombre d'utilisateurs
// actifs quotidiens attendu. Le vrai plafond de coût reste `llmLimiter`
// (10 requêtes/min/utilisateur), que rien ici ne peut contourner.
const QUOTA_MAX_USERS = Number(process.env.LLM_QUOTA_MAX_USERS) || 20_000;

// TTL > 24 h : c'est le champ `day` qui gère le passage à minuit, le TTL n'est
// qu'un filet pour qu'un utilisateur inactif finisse par libérer sa place.
const quota = new TtlCache<QuotaEntry>(36 * 60 * 60_000, QUOTA_MAX_USERS);

function todayKey(): string { return new Date().toISOString().slice(0, 10); }

/** Returns true if the user is within quota (and increments), false if over.
 *  `quota.get` rend la référence stockée : incrémenter `entry.count` met bien à
 *  jour l'entrée en cache, sans la réinsérer (donc sans toucher à son rang
 *  d'éviction ni à son expiration). */
function underDailyQuota(userId: string): boolean {
  const day = todayKey();
  const entry = quota.get(userId);
  if (!entry || entry.day !== day) {
    quota.set(userId, { count: 1, day });
    return true;
  }
  if (entry.count >= DAILY_QUOTA) return false;
  entry.count += 1;
  return true;
}

/** POST to a provider with a hard timeout and one retry on transient failure
 *  (network error or 5xx). Returns the fetch Response; throws only on a
 *  network-level error after the retry is exhausted. */
async function fetchWithTimeoutRetry(
  endpoint: string,
  init: Record<string, any>,
  attempts = 2,
): Promise<any> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetch(endpoint, { ...init, signal: controller.signal }) as any;
      // Chaque tentative est comptée séparément : une réessayée coûte deux
      // appels au fournisseur, donc potentiellement deux facturations.
      recordUpstream('llm', Date.now() - started, res.status < 400);
      // Retry once on 5xx (transient upstream); return 4xx/2xx as-is.
      if (res.status >= 500 && i < attempts - 1) { lastErr = new Error(`upstream ${res.status}`); continue; }
      return res;
    } catch (err: any) {
      recordUpstream('llm', Date.now() - started, false);
      lastErr = err;
      // AbortError (timeout) and network errors fall through to a retry.
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// GitHub Models (personal inference endpoint). See:
// https://docs.github.com/en/rest/models/inference
const GITHUB_MODELS_URL = 'https://models.github.ai/inference/chat/completions';
const GITHUB_API_VERSION = '2026-03-10';
// GitHub Models require a publisher-prefixed id, e.g. "openai/gpt-4.1-mini".
// NB: the gpt-5 family is gated (rate_limit_tier "custom") and returns
// 400 unavailable_model on the free GitHub Models tier. Switch this to
// "openai/gpt-5-mini" only once that model is enabled for the account.
const DEFAULT_PRO_MODEL = 'openai/gpt-4.1-mini';
const DEFAULT_FREE_MODEL = 'gpt-4o-mini';

/**
 * Récupère la clé OpenAI personnelle de l'utilisateur, déchiffrée.
 *
 * Extraite parce que DEUX chemins en ont besoin : l'utilisateur Free, et
 * l'abonné Pro qui a épuisé son plafond mensuel et bascule à ses frais.
 */
async function personalOpenAiKey(userId: string): Promise<string | null> {
  let rows: any[];
  try {
    const result = await pool.query(
      `SELECT openai_api_key AS "openaiApiKey" FROM user_profiles WHERE user_id = $1`,
      [userId],
    );
    rows = result.rows;
  } catch (err: any) {
    if (err.code === '42703') {
      throw Object.assign(new Error('Database migration 005 not applied.'), { status: 500, code: 'db_schema' });
    }
    throw err;
  }
  // Keys are stored encrypted at rest (AES-256-GCM); decrypt for use.
  // Legacy plaintext rows pass through unchanged until the migration runs.
  return rows[0]?.openaiApiKey ? decryptSecret(rows[0].openaiApiKey) : null;
}

/** Message affiché à l'abonné qui vient d'atteindre son maximum du mois. */
function quotaMessage(resetsAt: string, hasOwnKey: boolean): string {
  const date = new Date(resetsAt).toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  const base = `Tu as atteint ton maximum de ${MONTHLY_QUOTA} requêtes IA pour ce mois-ci. Ton compteur repart le ${date}.`;
  return hasOwnKey
    ? `${base} En attendant, tes requêtes utilisent ta propre clé OpenAI (facturée sur ton compte OpenAI).`
    : `${base} Pour continuer dès maintenant, ajoute ta clé OpenAI dans Paramètres → IA : tes requêtes passeront alors par ton compte OpenAI.`;
}

// All LLM routes require a valid JWT, then a dedicated per-user rate limit.
router.use(authenticate);
router.use(llmLimiter);

/**
 * GET /api/llm/usage — consommation du mois, pour que le client puisse afficher
 * un compteur AVANT que l'utilisateur ne se heurte au plafond. Un plafond dont
 * on ne découvre l'existence qu'en le heurtant est vécu comme une panne.
 */
router.get('/usage', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const userIsPro = await isPro(userId);
  // Un utilisateur Free n'a pas de plafond de notre part : il paie ses tokens.
  if (!userIsPro) return res.json({ pro: false, unlimited: true });

  return res.json({ pro: true, ...(await getUsage(userId)) });
});

router.post('/', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { prompt, model, taskType, locale } = req.body as {
    prompt?: string;
    model?: string;
    taskType?: string;
    locale?: string;
  };

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  // Size caps — reject oversized payloads before spending any provider tokens.
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(413).json({ error: `prompt too long (max ${MAX_PROMPT_CHARS} characters)` });
  }
  if (model != null && (typeof model !== 'string' || model.length > 100)) {
    return res.status(400).json({ error: 'invalid model' });
  }

  /**
   * ── L'invite système ne vient plus du client ──────────────────────────────
   *
   * Le corps portait un `systemPrompt` libre, relayé tel quel au fournisseur.
   * Sur le chemin Pro, facturé à l'opérateur, cela faisait de cette route un
   * proxy LLM généraliste : n'importe quel abonné pouvait y poser sa propre
   * invite système et s'en servir à toute autre fin, dans la limite du quota.
   *
   * `taskType` est désormais pris dans une énumération FERMÉE et le texte vit
   * dans `services/llmPrompts.ts`. Un `systemPrompt` encore présent dans le
   * corps — ancien bundle client — est ignoré en silence : le refuser par un
   * 400 casserait la fonctionnalité pendant la fenêtre de déploiement, alors
   * que l'ignorer la dégrade au pire d'un choix de langue.
   *
   * `taskType` absent retombe sur la seule tâche existante, pour la même
   * raison. Le jour où il y en aura deux, ce défaut devra devenir un 400 —
   * deviner la tâche demandée n'aurait alors plus de sens.
   */
  if (taskType != null && !isLlmTaskType(taskType)) {
    return res.status(400).json({
      error: `unknown taskType (expected one of: ${LLM_TASK_TYPES.join(', ')})`,
    });
  }
  const resolvedTask = isLlmTaskType(taskType) ? taskType : 'explain_bet';
  const resolvedLocale = resolveLocale(locale, req.headers['accept-language']);

  // Build the shared message array once.
  const messages: { role: string; content: string }[] = [
    { role: 'system', content: systemPromptFor(resolvedTask, resolvedLocale) },
    { role: 'user', content: prompt },
  ];

  // ── Decide which path to use ──────────────────────────────────────────────
  const userIsPro = await isPro(userId);

  /** Tout ce qu'il faut pour appeler un fournisseur, choisi en un seul endroit. */
  interface ProviderCall {
    endpoint: string;
    apiKey: string;
    requestModel: string;
    extraHeaders: Record<string, string>;
    /**
     * Qui paie — et donc DE QUI parle un message d'erreur du fournisseur.
     *
     * C'est la distinction qui décide si l'on a le droit de relayer ce message.
     * Sur `user`, l'erreur porte sur la clé OpenAI de l'appelant : « Incorrect
     * API key provided: sk-…4f2a » est exactement ce qu'il doit lire pour
     * corriger. Sur `operator`, elle porte sur le compte GitHub Models du
     * projet — modèle retiré, organisation suspendue, quota dépassé — et
     * n'apprend rien à l'utilisateur qu'il puisse corriger, tout en décrivant
     * notre infrastructure.
     */
    billedTo: 'user' | 'operator';
  }

  let call: ProviderCall;
  /** Vrai si une requête a été décomptée du quota Pro — donc à rembourser en cas d'échec. */
  let quotaConsumed = false;
  /** Renseigné quand le plafond mensuel est atteint : sert à informer le client. */
  let quotaNotice: { limit: number; resetsAt: string; message: string; billedTo: 'user' } | null = null;

  /** Appel facturé à l'utilisateur, sur sa propre clé OpenAI. */
  const ownKeyCall = (key: string): ProviderCall => ({
    endpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: key,
    requestModel: model ?? DEFAULT_FREE_MODEL,
    extraHeaders: {},
    billedTo: 'user',
  });

  if (userIsPro) {
    const token = process.env.GITHUB_MODELS_TOKEN;
    if (!token) {
      return res.status(500).json({
        error: 'config',
        message: 'GITHUB_MODELS_TOKEN is not configured on the server.',
      });
    }

    // Plafond mensuel — décompté AVANT l'appel au fournisseur, et remboursé
    // plus bas si celui-ci n'a finalement rien facturé.
    const verdict = await consumeProRequest(userId);

    if (verdict.allowed) {
      quotaConsumed = true;
      call = {
        endpoint: GITHUB_MODELS_URL,
        apiKey: token,
        // Accept a caller-supplied model only if it's already publisher-prefixed;
        // otherwise fall back to the Pro default so we don't send an OpenAI-style id.
        requestModel: model?.includes('/') ? model : DEFAULT_PRO_MODEL,
        extraHeaders: {
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          Accept: 'application/vnd.github+json',
        },
        billedTo: 'operator',
      };
    } else if (verdict.reason === 'db') {
      // Fail-closed : ne pas pouvoir compter, c'est ne pas pouvoir garantir. On
      // préfère une erreur franche et temporaire à une dépense non mesurée.
      return res.status(503).json({
        error: 'quota_unavailable',
        message: 'Impossible de vérifier ton quota IA pour le moment. Réessaie dans un instant.',
      });
    } else {
      // Plafond atteint (personnel ou disjoncteur global). On tente la bascule
      // sur la clé personnelle plutôt que de couper la fonctionnalité.
      let ownKey: string | null = null;
      try { ownKey = await personalOpenAiKey(userId); }
      catch (err: any) { logger.warn({ err: err?.message, userId }, '[LLM] lecture de la clé perso échouée'); }

      const message = quotaMessage(verdict.resetsAt, Boolean(ownKey));

      if (!ownKey) {
        return res.status(429).json({
          error: 'monthly_quota_reached',
          message,
          limit: verdict.limit,
          used: verdict.used,
          resetsAt: verdict.resetsAt,
        });
      }

      logger.info({ userId, reason: verdict.reason }, '[LLM] plafond mensuel atteint — bascule sur la clé de l’utilisateur');
      quotaNotice = { limit: verdict.limit, resetsAt: verdict.resetsAt, message, billedTo: 'user' };
      call = ownKeyCall(ownKey);
    }
  } else {
    // FREE → user's own OpenAI key. Quota journalier en mémoire : ne protège
    // pas un budget (l'utilisateur paie ses tokens) mais nos ressources.
    if (!underDailyQuota(userId)) {
      return res.status(429).json({ error: 'Daily AI request limit reached. Try again tomorrow.' });
    }

    let userKey: string | null;
    try { userKey = await personalOpenAiKey(userId); }
    catch (err: any) {
      if (err?.code === 'db_schema') {
        // Le message rendait publics le nom de la base ET l'arborescence du
        // dépôt : « Run: psql -d IceedgeDB -f src/db/migrations/005_openai_key.sql ».
        // C'était une consigne d'exploitation adressée à l'opérateur, envoyée à
        // l'utilisateur. Elle part maintenant dans les journaux, où l'opérateur
        // la lira ; l'utilisateur reçoit ce qui le concerne — le service est
        // indisponible, il n'y peut rien.
        logger.error(
          { err: err?.message },
          '[LLM] colonne openai_api_key absente — appliquer la migration 005 (npm run db:migrate:all)',
        );
        // `error` porte le texte lisible et non le code : le client
        // (`llmService.askLLMDetailed`) ne teste explicitement que
        // `monthly_quota_reached` et `no_api_key` ; pour tout le reste il
        // affiche `body.error` tel quel. Y mettre « unavailable » aurait mis le
        // mot « unavailable » sous les yeux de l'utilisateur.
        return res.status(503).json({
          error: 'La fonction IA est momentanément indisponible. Réessaie plus tard.',
          code: 'unavailable',
        });
      }
      throw err;
    }

    if (!userKey) {
      return res.status(422).json({
        error: 'no_api_key',
        message: 'Add your OpenAI API key in Settings → AI Settings, or upgrade to Pro to use the built-in model.',
      });
    }
    call = ownKeyCall(userKey);
  }

  // ── Forward the request ───────────────────────────────────────────────────
  // Reasoning models (gpt-5*, o1/o3/o4*) differ from chat models: they reject
  // `max_tokens` (need `max_completion_tokens`) and only accept the default
  // temperature. They also spend output tokens on hidden reasoning, so the
  // budget must be generous or `content` comes back empty.
  const isReasoning = /(^|\/)(gpt-5|o1|o3|o4)/.test(call.requestModel);

  const body: Record<string, any> = { model: call.requestModel, messages };
  if (isReasoning) {
    body.max_completion_tokens = 2048;
    // no temperature — reasoning models only allow the default (1)
  } else {
    // Doit rester aligné sur LLM_MAX_OUTPUT_TOKENS dans llmQuota.service, qui
    // s'en sert pour majorer le coût d'une requête. Les désynchroniser ferait
    // sous-estimer la dépense pire-cas, donc surestimer le plafond.
    body.max_tokens = MAX_OUTPUT_TOKENS;
    body.temperature = 0.7;
  }

  // Node 18+ global fetch returns a Response-like object typed loosely as `any`.
  // Bounded by a hard timeout with one retry on transient failure, so a hung
  // provider can't tie up the request/connection indefinitely.
  let providerRes: any;
  try {
    providerRes = await fetchWithTimeoutRetry(call.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${call.apiKey}`,
        ...call.extraHeaders,
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    // Le fournisseur n'a jamais été atteint : rien n'a été facturé, donc le
    // quota du mois ne doit pas être amputé. Sans ce remboursement, une panne
    // réseau consommerait le quota de l'utilisateur sans rien lui rendre.
    if (quotaConsumed) await refundProRequest(userId);
    const timedOut = err?.name === 'AbortError';
    // `detail: err?.message` retiré : sur un échec réseau, `err.message` est du
    // type « fetch failed for https://models.inference.ai.azure.com/… », donc
    // l'adresse exacte du fournisseur et le chemin appelé. Le client n'en
    // faisait rien (il affiche « openai_error »), et le message complet est déjà
    // journalisé par `fetchWithTimeoutRetry` en amont.
    logger.warn(
      { err: err?.message, timedOut, model: call.requestModel },
      '[LLM] fournisseur injoignable',
    );
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'The model provider timed out' : 'Failed to reach the model provider',
    });
  }

  if (!providerRes.ok) {
    const raw = await (providerRes as any).text().catch(() => '');
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* non-JSON error page */ }
    const status = (providerRes as any).status ?? 502;

    // Remboursé sur 4xx uniquement : la requête a été REJETÉE avant inférence
    // (modèle inconnu, entrée invalide, authentification), donc rien n'a été
    // facturé. Sur 5xx, le modèle a pu tourner avant d'échouer — on ne rembourse
    // pas, par prudence : la garantie doit pencher du côté du plafond.
    if (quotaConsumed && status >= 400 && status < 500) await refundProRequest(userId);

    // Log the FULL upstream error to the server console for debugging.
    logger.error(
      { status, pro: userIsPro, model: call.requestModel, body: raw || '(empty body)' },
      '[LLM] provider error'
    );
    // Ce qui remonte au client dépend de QUI paie l'appel.
    //
    // Avant : `body?.error?.message ?? body?.error ?? raw` — donc, en dernier
    // recours, le corps BRUT de la réponse amont. Ce `raw` est le pire des trois :
    // quand le fournisseur ou un proxy répond une page HTML d'erreur, elle part
    // entière au client, avec les noms d'hôtes internes qu'elle contient. Et sur
    // le chemin Pro, même un message JSON propre parle du compte GitHub Models
    // du projet, pas de l'utilisateur.
    //
    // Sur la clé de l'utilisateur, en revanche, le message EST l'information
    // utile : « Incorrect API key provided » lui dit quoi corriger dans les
    // Paramètres. On le relaie donc, mais seulement s'il est une chaîne (jamais
    // `raw`, jamais un objet) et borné.
    const upstreamMessage =
      typeof body?.error?.message === 'string' ? body.error.message.slice(0, 300) : null;

    const clientMessage =
      call.billedTo === 'user' && upstreamMessage
        ? upstreamMessage
        : 'Le fournisseur de modèle a refusé la requête.';

    /**
     * ⚠️ **502 même quand l'amont répond 401.** Jusqu'au 2026-09-08 ce 401 était
     * relayé tel quel, et c'était une déconnexion déguisée : côté client,
     * `authedFetch` traite TOUT 401 comme « jeton d'accès expiré ». Une clé
     * OpenAI invalide déclenchait donc un refresh, une rotation du refresh
     * token et un rejeu inutile de la requête — et si ce refresh échouait au
     * même instant, `tokenStore.clear()` **déconnectait l'utilisateur
     * d'ArakIce parce que sa clé OpenAI était mauvaise**.
     *
     * La règle qui en découle, et qui vaut au-delà de cette route : un 401 rendu
     * par cette API signifie « ta session ArakIce a expiré », et rien d'autre.
     * L'échec d'un fournisseur amont est un 502, quel que soit son propre code.
     *
     * `invalid_api_key` porte l'information à la place du statut : le client
     * s'appuie dessus pour dire « vérifie ta clé dans les Paramètres ».
     */
    const clientCode =
      status === 401
        ? 'invalid_api_key'
        : (typeof body?.error?.code === 'string' ? body.error.code : 'provider_error');

    return res.status(502).json({
      error: clientMessage,
      code:  clientCode,
      upstreamStatus: status,
    });
  }

  const data = await (providerRes as any).json();
  const text: string = data?.choices?.[0]?.message?.content ?? '';

  // `quotaNotice` n'est présent que le mois où le plafond est atteint : le
  // client affiche alors le message pendant que la réponse arrive quand même.
  return res.json(quotaNotice ? { text, quota: quotaNotice } : { text });
});

export default router;
