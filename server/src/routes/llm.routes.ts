/**
 * llm.routes.ts
 * POST /api/llm  — proxies a prompt to a chat model.
 *
 * Deux chemins de facturation, choisis par le niveau d'abonnement. Les deux
 * appellent le MÊME endpoint OpenAI ; seule la clé change, et donc qui paie :
 *   • PRO  → la clé de l'opérateur (`OPENAI_API_KEY`), modèle imposé
 *            (`LLM_PRO_MODEL`, défaut gpt-5.6-luna) et plafond mensuel.
 *   • FREE → la clé OpenAI de l'utilisateur, rangée chiffrée dans
 *            `user_profiles.openai_api_key`. Il choisit son modèle, il paie.
 *
 * (Le chemin Pro passait par GitHub Models jusqu'au 2026-09-08 ; ce service a
 *  été retiré le 30 juillet 2026. Voir le bloc au-dessus de `OPENAI_CHAT_URL`.)
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
 *
 * ── TÂCHE `parse_bet_command` (2026-09-28, SLIP_COMMANDE_PLAN.md § 5) ────────
 *
 * Le « Bet builder IA » (à ne pas confondre avec l'« Analyse LLM » d'un pari,
 * `explain_bet`) : le client n'appelle cette tâche que quand
 * son analyseur local n'a pas compris la phrase. Trois différences :
 *   • l'invite embarque les matchs et joueurs du moment, construits ICI
 *     (`buildServerSlipContext`) — le serveur ne croit rien du client ;
 *   • la réponse est imposée par un schéma JSON, puis CHAQUE intention repasse
 *     par `validateIntent` (`readParseResponse`) avant d'être renvoyée ;
 *   • un compte GRATUIT sans clé perso a droit à `FREE_PARSE_DAILY` appels par
 *     jour sur la clé de l'opérateur (compteur en base, migration 039, et
 *     disjoncteur mensuel PROPRE au gratuit — celui de Pro n'est pas touché).
 *     Avec sa clé perso, il passe par elle.
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
import { sendError } from '../httpError';
import {
  consumeProRequest, refundProRequest, getUsage, MONTHLY_QUOTA, MAX_OUTPUT_TOKENS,
  consumeFreeParse, refundFreeParse, getFreeParseUsage, PROMPT_BUDGET_CHARS,
  type QuotaVerdict,
} from '../services/llmQuota.service';
import {
  LLM_TASK_TYPES, isLlmTaskType, resolveLocale, systemPromptFor,
} from '../services/llmPrompts';
import { SLIP_COMMAND_MAX_LENGTH, type SlipContext } from '../services/slipCommand';
import {
  buildParsePrompt, readParseResponse, PARSE_RESPONSE_FORMAT, PARSE_MAX_SYSTEM_CHARS,
} from '../services/slipCommandLlm';
import { buildServerSlipContext } from '../services/slipCommandContext';

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

/**
 * ── 2026-09-08 : GitHub Models est MORT, le chemin Pro passe par OpenAI ──────
 *
 * GitHub Models a été **définitivement retiré le 30 juillet 2026** (playground,
 * catalogue, API d'inférence et endpoints BYOK). L'endpoint répondait depuis
 * `{"error":{"code":"github_models_retirement_brownout"}}`, ce qui se traduisait
 * en 502 côté client : l'analyse IA des abonnés était donc hors service depuis
 * six semaines, sans que rien ne le dise.
 *
 * Le chemin Pro appelle désormais OpenAI directement — c'est-à-dire le MÊME
 * endpoint que le chemin Free, à une différence près : la clé. Free utilise
 * celle de l'utilisateur, Pro celle de l'opérateur (`OPENAI_API_KEY`). Ce
 * n'est pas un raccourci : le calcul de plafond de `llmQuota.service` était
 * déjà calibré sur les tarifs OpenAI de gpt-4.1-mini, donc la garantie de coût
 * — jusqu'ici théorique, puisque GitHub Models ne facturait pas au token —
 * devient enfin celle qu'on mesure réellement.
 *
 * ⚠️ Ne pas ressusciter `GITHUB_MODELS_TOKEN` : le service n'existe plus.
 */
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Modèle du chemin Pro. Surchargeable par `LLM_PRO_MODEL`.
 *
 * ⚠️⚠️ **Doit rester cohérent avec `LLM_PRICE_INPUT_PER_MTOK` /
 * `LLM_PRICE_OUTPUT_PER_MTOK`** dans `llmQuota.service`. Ces deux variables
 * chiffrent le coût pire-cas d'une requête, donc le plafond mensuel : changer
 * de modèle ici sans changer les tarifs là-bas fait mentir la garantie en
 * silence, et dans le sens coûteux.
 */
const DEFAULT_PRO_MODEL = process.env.LLM_PRO_MODEL || 'gpt-5.6-luna';

/**
 * Modèle par défaut du chemin Free (clé de l'utilisateur, donc son argent).
 *
 * ⚠️ C'était `gpt-4o-mini`, qui ne figure plus au catalogue OpenAI — comme
 * `gpt-4.1-mini` côté Pro. Deux identifiants morts, sur les deux chemins : la
 * fonction IA n'aurait pas redémarré même avec la clé opérateur en place.
 */
const DEFAULT_FREE_MODEL = process.env.LLM_FREE_MODEL || 'gpt-5.6-luna';

/**
 * Effort de raisonnement demandé aux modèles qui en acceptent un.
 *
 * `none` par défaut, et c'est la décision de coût la plus importante de ce
 * fichier : la gamme gpt-5.6 raisonne à l'effort `medium` par défaut, et les
 * tokens de réflexion — invisibles pour l'utilisateur — sont facturés comme des
 * tokens de SORTIE. Or « explique-moi ce pari » part de données déjà calculées
 * et d'une invite système fixe : il n'y a rien à raisonner, seulement à
 * rédiger. Laisser l'effort par défaut ferait payer une réflexion dont la
 * réponse ne porte aucune trace.
 *
 * Surchargeable par `LLM_REASONING_EFFORT` (none | low | medium | high) si la
 * qualité des explications se révèle insuffisante à l'usage — mais alors le
 * budget de sortie ci-dessous doit être revu en même temps, puisque la
 * réflexion s'y impute.
 */
const REASONING_EFFORT = process.env.LLM_REASONING_EFFORT || 'none';

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
// `try` obligatoire ici aussi : `isPro()` et `getUsage()` touchent la base, et
// un gestionnaire `async` qui laisse fuir un rejet ne produit PAS une réponse
// d'erreur sous Express 4 — voir le long commentaire du POST ci-dessous.
router.get('/usage', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.sub;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const userIsPro = await isPro(userId);
    /**
     * ⚠️ Renvoyait `{ pro: false, unlimited: true }`. C'était faux sur les deux
     * mots : un compte Free a bien un plafond — `DAILY_QUOTA` requêtes par jour,
     * qui protège nos ressources et non un budget — et il lui faut sa propre clé
     * OpenAI pour que la fonction marche. Le champ n'était affiché nulle part,
     * donc le mensonge n'atteignait personne ; il n'attendait qu'un écran.
     * Corrigé le 2026-09-09, en même temps que le compteur des Réglages.
     */
    if (!userIsPro) {
      // `freeParse` : les appels offerts du jour pour le Bet builder IA
      // (2026-09-28). `ownKey` : avec sa clé, ces appels passent par
      // elle et ce compteur ne s'applique pas — l'écran le dit.
      let ownKey = false;
      try { ownKey = Boolean(await personalOpenAiKey(userId)); } catch { /* colonne ou clé illisible : pas de clé */ }
      return res.json({ pro: false, dailyLimit: DAILY_QUOTA, ownKey, freeParse: await getFreeParseUsage(userId) });
    }

    return res.json({ pro: true, ...(await getUsage(userId)) });
  } catch (err: any) {
    return sendError(res, err, { context: '[LLM/usage]' });
  }
});

/**
 * Filet de sécurité posé le 2026-09-08, après un « No 'Access-Control-Allow-Origin' »
 * suivi d'un 502 sur cette route en production.
 *
 * ── Pourquoi une route peut répondre SANS en-tête CORS ──────────────────────
 *
 * `app.ts` monte `cors()` en tête de chaîne (ligne 47), donc TOUTE réponse que
 * cette application produit porte l'en-tête. Une réponse qui n'en a pas ne vient
 * donc pas d'ici : elle vient du bord (Railway), qui répond 502 quand l'instance
 * n'a rien répondu du tout. Le message CORS du navigateur est le symptôme ; la
 * cause est que le processus n'a pas rendu la main.
 *
 * ── Ce que ce fichier avait de particulier ─────────────────────────────────
 *
 * Le corps du gestionnaire était `async` et une bonne partie de ses `await` —
 * `isPro()` en tête — n'étaient dans AUCUN `try`. Express 4 ne rattrape pas le
 * rejet d'un gestionnaire asynchrone : la promesse part en `unhandledRejection`,
 * et selon la configuration Node/Sentry cela fait soit tomber le processus, soit
 * traîner la requête jusqu'au délai du bord. Dans les deux cas : 502 sans CORS,
 * et pour tout le monde, pas seulement pour l'appelant.
 *
 * Le corps est donc extrait dans `handleLlmRequest` et le gestionnaire ne fait
 * plus que l'attendre sous `try`. Une panne inattendue devient une réponse 500
 * propre — avec en-tête CORS, donc lisible par le client — et une ligne de
 * journal corrélée au `request-id`, au lieu d'une panne d'infrastructure muette.
 *
 * ⚠️ Ne pas « simplifier » en remettant le corps directement dans `router.post`.
 * C'est l'absence de ce `try` qui était le défaut.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    await handleLlmRequest(req, res);
  } catch (err: any) {
    // Le remboursement de quota des chemins CONNUS est déjà fait au plus près de
    // l'échec (voir `refundProRequest` plus bas). Ici on est par définition dans
    // l'inattendu : on journalise et on rend une erreur propre.
    sendError(res, err, { context: '[LLM]' });
  }
});

async function handleLlmRequest(req: Request, res: Response): Promise<unknown> {
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
   * ⚠️ `taskType` est OBLIGATOIRE depuis le 2026-09-28. Il retombait sur
   * `explain_bet` pendant la fenêtre de déploiement du 2026-09-08 ; il y a
   * maintenant DEUX tâches, et deviner laquelle est demandée n'a plus de sens.
   * Vérifié avant : le client en production (commit bb71c6f) l'envoie
   * toujours — `askLLM` l'exige depuis le 2026-09-08.
   */
  if (!isLlmTaskType(taskType)) {
    return res.status(400).json({
      error: `taskType is required (expected one of: ${LLM_TASK_TYPES.join(', ')})`,
    });
  }
  const isParse = taskType === 'parse_bet_command';
  if (isParse && prompt.length > SLIP_COMMAND_MAX_LENGTH) {
    return res.status(413).json({ error: `prompt too long (max ${SLIP_COMMAND_MAX_LENGTH} characters)` });
  }
  const resolvedLocale = resolveLocale(locale, req.headers['accept-language']);

  // Build the shared message array once.
  // `parse_bet_command` : l'invite porte le contexte du moment, construit ici
  // AVANT tout décompte de quota — un calendrier injoignable ne coûte rien.
  let parseCtx: SlipContext | null = null;
  let messages: { role: string; content: string }[];
  if (isParse) {
    try {
      parseCtx = await buildServerSlipContext();
    } catch (err: any) {
      logger.warn({ err: err?.message }, '[LLM] contexte de la commande indisponible (calendrier LNH)');
      return res.status(503).json({
        error: 'Le calendrier LNH est momentanément indisponible. Réessaie plus tard.',
        code: 'schedule_unavailable',
      });
    }
    // Bornée pour que le coût pire-cas reste celui sur lequel le plafond est
    // calculé (voir PARSE_MAX_SYSTEM_CHARS).
    const maxSystem = Math.min(PARSE_MAX_SYSTEM_CHARS, PROMPT_BUDGET_CHARS - SLIP_COMMAND_MAX_LENGTH);
    const p = buildParsePrompt(prompt, parseCtx, resolvedLocale, maxSystem);
    messages = [{ role: 'system', content: p.system }, { role: 'user', content: p.user }];
  } else {
    messages = [
      { role: 'system', content: systemPromptFor('explain_bet', resolvedLocale) },
      { role: 'user', content: prompt },
    ];
  }

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
  /** Verdict du quota Pro décompté — sert au compteur renvoyé par `parse_bet_command`. */
  let proVerdict: QuotaVerdict | null = null;
  /** Renseigné quand un appel GRATUIT (`parse_bet_command`, clé opérateur) a été décompté. */
  let freeVerdict: QuotaVerdict | null = null;
  /** Rend ce qui a été décompté, quand le fournisseur n'a rien facturé. */
  const refund = async () => {
    if (quotaConsumed) await refundProRequest(userId);
    if (freeVerdict) await refundFreeParse(userId);
  };
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
    const token = process.env.OPENAI_API_KEY?.trim();
    if (!token) {
      // Message générique : le client n'y peut rien, et nommer la variable
      // décrirait la configuration du serveur. Le détail part dans les logs.
      logger.error('[LLM] OPENAI_API_KEY (clé opérateur) absente — le chemin Pro est hors service');
      return res.status(503).json({
        error: 'La fonction IA est momentanément indisponible. Réessaie plus tard.',
        code: 'unavailable',
      });
    }

    // Plafond mensuel — décompté AVANT l'appel au fournisseur, et remboursé
    // plus bas si celui-ci n'a finalement rien facturé.
    const verdict = await consumeProRequest(userId);

    if (verdict.allowed) {
      quotaConsumed = true;
      proVerdict = verdict;
      call = {
        endpoint: OPENAI_CHAT_URL,
        apiKey: token,
        /**
         * ⚠️⚠️ Le `model` envoyé par le client est IGNORÉ sur ce chemin, et
         * c'est délibéré.
         *
         * Avant : `model?.includes('/') ? model : DEFAULT_PRO_MODEL` — un
         * abonné pouvait donc choisir le modèle facturé à l'OPÉRATEUR. C'était
         * déjà discutable sur GitHub Models ; sur une facturation OpenAI au
         * token, c'est un trou de coût direct : demander `gpt-4o` ou `o1` au
         * lieu de `gpt-4.1-mini` multiplie le prix d'une requête par un facteur
         * à deux chiffres, et le plafond mensuel — calculé sur le tarif de
         * gpt-4.1-mini — ne protège alors plus rien.
         *
         * Qui paie choisit le modèle : sur le chemin Free (`ownKeyCall`) le
         * client garde ce choix, parce que c'est sa clé et son argent.
         */
        requestModel: DEFAULT_PRO_MODEL,
        extraHeaders: {},
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

    if (userKey) {
      call = ownKeyCall(userKey);
    } else if (!isParse) {
      return res.status(422).json({
        error: 'no_api_key',
        message: 'Add your OpenAI API key in Settings → AI Settings, or upgrade to Pro to use the built-in model.',
      });
    } else {
      // `parse_bet_command` sans clé perso : la clé de l'OPÉRATEUR, dans la
      // limite des appels offerts du jour (décision du user, D4 du plan).
      const token = process.env.OPENAI_API_KEY?.trim();
      if (!token) {
        logger.error('[LLM] OPENAI_API_KEY (clé opérateur) absente — appels gratuits de la commande hors service');
        return res.status(503).json({
          error: 'La fonction IA est momentanément indisponible. Réessaie plus tard.',
          code: 'unavailable',
        });
      }
      const verdict = await consumeFreeParse(userId);
      if (!verdict.allowed) {
        if (verdict.reason === 'user') {
          // L'écran propose alors Pro (via `features.proUpgrade`) ; l'analyseur
          // local, lui, continue de marcher.
          return res.status(429).json({ error: 'free_parse_quota', limit: verdict.limit, resetsAt: verdict.resetsAt });
        }
        // 'db' (fail-closed) ou 'global' (disjoncteur) : rien que l'utilisateur
        // puisse corriger, et rien à lui vendre.
        return res.status(503).json({
          error: 'La fonction IA est momentanément indisponible. Réessaie plus tard.',
          code: verdict.reason === 'db' ? 'quota_unavailable' : 'unavailable',
        });
      }
      freeVerdict = verdict;
      // Clé de l'opérateur, donc modèle de l'opérateur : le plafond de coût
      // est calculé sur ses tarifs (voir la note sur DEFAULT_PRO_MODEL).
      call = { endpoint: OPENAI_CHAT_URL, apiKey: token, requestModel: DEFAULT_PRO_MODEL, extraHeaders: {}, billedTo: 'operator' };
    }
  }

  // ── Forward the request ───────────────────────────────────────────────────
  // Les modèles à raisonnement (gpt-5*, gpt-6*, o1/o3/o4*) diffèrent des modèles
  // de chat : ils refusent `max_tokens` (il leur faut `max_completion_tokens`)
  // et n'acceptent que la température par défaut.
  const isReasoning = /(^|\/)(gpt-5|gpt-6|o1|o3|o4)/.test(call.requestModel);

  const body: Record<string, any> = { model: call.requestModel, messages };
  if (isReasoning) {
    /**
     * ⚠️⚠️ **Le budget de sortie est le MÊME que sur l'autre branche**, et ce
     * n'est pas une simplification : c'est la correction d'une incohérence.
     *
     * Cette branche donnait 2048 en dur, quand `llmQuota.service` majore le coût
     * d'une requête sur `MAX_OUTPUT_TOKENS` (512). Le plafond mensuel était donc
     * calculé sur un quart du budget réellement accordé — la garantie « ne
     * jamais payer plus que ce que l'utilisateur paie » ne tenait plus dès que le
     * modèle Pro appartenait à la gamme gpt-5, ce qui est désormais le cas.
     *
     * Les 2048 se justifiaient par la réflexion cachée, qui s'impute sur ce
     * budget. Avec `REASONING_EFFORT = 'none'` il n'y a plus de réflexion à
     * loger, donc plus de raison de sur-provisionner. Si l'effort est remonté,
     * `LLM_MAX_OUTPUT_TOKENS` doit l'être aussi — dans les DEUX endroits, ce qui
     * est justement automatique puisqu'il n'y a plus qu'une constante.
     */
    body.max_completion_tokens = MAX_OUTPUT_TOKENS;
    body.reasoning_effort = REASONING_EFFORT;
    // pas de `temperature` — ces modèles n'acceptent que la valeur par défaut
  } else {
    // Doit rester aligné sur LLM_MAX_OUTPUT_TOKENS dans llmQuota.service, qui
    // s'en sert pour majorer le coût d'une requête. Les désynchroniser ferait
    // sous-estimer la dépense pire-cas, donc surestimer le plafond.
    body.max_tokens = MAX_OUTPUT_TOKENS;
    // De l'extraction pour `parse_bet_command` : aucune créativité voulue.
    body.temperature = isParse ? 0 : 0.7;
  }
  // `parse_bet_command` : réponse imposée par un schéma (structured outputs).
  if (isParse) body.response_format = PARSE_RESPONSE_FORMAT;

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
    await refund();
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
    if (status >= 400 && status < 500) await refund();

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

  // `.json()` peut LEVER : un amont qui répond 200 avec une page HTML (proxy,
  // portail captif, page d'erreur d'un CDN) passe le test `providerRes.ok` puis
  // casse ici. C'était l'un des `await` qui pouvaient s'échapper du gestionnaire.
  let data: any;
  try {
    data = await (providerRes as any).json();
  } catch (err: any) {
    logger.error(
      { err: err?.message, model: call.requestModel, pro: userIsPro },
      '[LLM] réponse amont illisible (200 mais pas du JSON)',
    );
    return res.status(502).json({
      error: 'Le fournisseur de modèle a renvoyé une réponse illisible.',
      code: 'provider_error',
    });
  }

  const text: string = data?.choices?.[0]?.message?.content ?? '';

  if (isParse && parseCtx) {
    // Chaque intention repasse par `validateIntent` ; une seule invalide et la
    // réponse entière est rejetée (`{ ok: false }` sans question : l'écran
    // affiche alors son propre message). L'appel reste décompté : le modèle
    // a tourné, et le rembourser ferait d'une phrase absurde un appel gratuit.
    const outcome = readParseResponse(text, parseCtx);
    const usage =
      freeVerdict ? { kind: 'free' as const, used: freeVerdict.used, limit: freeVerdict.limit, resetsAt: freeVerdict.resetsAt }
      : proVerdict ? { kind: 'pro' as const, used: proVerdict.used, limit: proVerdict.limit, resetsAt: proVerdict.resetsAt }
      : { kind: 'own_key' as const };
    return res.json(quotaNotice ? { ...outcome, usage, quota: quotaNotice } : { ...outcome, usage });
  }

  // `quotaNotice` n'est présent que le mois où le plafond est atteint : le
  // client affiche alors le message pendant que la réponse arrive quand même.
  return res.json(quotaNotice ? { text, quota: quotaNotice } : { text });
}

export default router;
