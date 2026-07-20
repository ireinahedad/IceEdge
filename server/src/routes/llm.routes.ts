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
 */

import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authenticate } from '../middleware/auth.middleware';
import { llmLimiter } from '../middleware/rateLimit.middleware';
import { isPro } from '../services/subscription.service';
import { decryptSecret } from '../services/crypto.util';

const router = Router();

// ── Abuse controls ────────────────────────────────────────────────────────────
// Caps keep a single user (or a leaked token) from running up token-cost on the
// operator's GitHub Models account or tying up connections indefinitely.
const MAX_PROMPT_CHARS  = Number(process.env.LLM_MAX_PROMPT_CHARS)  || 8_000;   // ~2k tokens
const MAX_SYSTEM_CHARS  = Number(process.env.LLM_MAX_SYSTEM_CHARS)  || 2_000;
const FETCH_TIMEOUT_MS  = Number(process.env.LLM_FETCH_TIMEOUT_MS)  || 30_000;
// Per-user daily request quota. In-memory (per instance) — good enough as a
// cost backstop pre-scale; move to Redis/DB if you run multiple instances.
const DAILY_QUOTA       = Number(process.env.LLM_DAILY_QUOTA)       || 200;

interface QuotaEntry { count: number; day: string; }
const quota = new Map<string, QuotaEntry>();

function todayKey(): string { return new Date().toISOString().slice(0, 10); }

/** Returns true if the user is within quota (and increments), false if over. */
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
    try {
      const res = await fetch(endpoint, { ...init, signal: controller.signal }) as any;
      // Retry once on 5xx (transient upstream); return 4xx/2xx as-is.
      if (res.status >= 500 && i < attempts - 1) { lastErr = new Error(`upstream ${res.status}`); continue; }
      return res;
    } catch (err: any) {
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

// All LLM routes require a valid JWT, then a dedicated per-user rate limit.
router.use(authenticate);
router.use(llmLimiter);

router.post('/', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { prompt, model, systemPrompt } = req.body as {
    prompt?: string;
    model?: string;
    systemPrompt?: string;
  };

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required' });
  }
  // Size caps — reject oversized payloads before spending any provider tokens.
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(413).json({ error: `prompt too long (max ${MAX_PROMPT_CHARS} characters)` });
  }
  if (systemPrompt != null && (typeof systemPrompt !== 'string' || systemPrompt.length > MAX_SYSTEM_CHARS)) {
    return res.status(413).json({ error: `systemPrompt too long (max ${MAX_SYSTEM_CHARS} characters)` });
  }
  if (model != null && (typeof model !== 'string' || model.length > 100)) {
    return res.status(400).json({ error: 'invalid model' });
  }

  // Per-user daily quota — a hard cost backstop on top of the rate limiter.
  if (!underDailyQuota(userId)) {
    return res.status(429).json({ error: 'Daily AI request limit reached. Try again tomorrow.' });
  }

  // Build the shared message array once.
  const messages: { role: string; content: string }[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  // ── Decide which path to use ──────────────────────────────────────────────
  const userIsPro = await isPro(userId);

  let endpoint: string;
  let apiKey: string;
  let requestModel: string;
  const extraHeaders: Record<string, string> = {};

  if (userIsPro) {
    // PRO → app's GitHub Models token
    const token = process.env.GITHUB_MODELS_TOKEN;
    if (!token) {
      return res.status(500).json({
        error: 'config',
        message: 'GITHUB_MODELS_TOKEN is not configured on the server.',
      });
    }
    endpoint = GITHUB_MODELS_URL;
    apiKey = token;
    // Accept a caller-supplied model only if it's already publisher-prefixed;
    // otherwise fall back to the Pro default so we don't send an OpenAI-style id.
    requestModel = model?.includes('/') ? model : DEFAULT_PRO_MODEL;
    extraHeaders['X-GitHub-Api-Version'] = GITHUB_API_VERSION;
    extraHeaders['Accept'] = 'application/vnd.github+json';
  } else {
    // FREE → user's own OpenAI key
    let rows: any[];
    try {
      const result = await pool.query(
        `SELECT openai_api_key AS "openaiApiKey" FROM user_profiles WHERE user_id = $1`,
        [userId]
      );
      rows = result.rows;
    } catch (err: any) {
      if (err.code === '42703') {
        return res.status(500).json({
          error: 'db_schema',
          message: 'Database migration 005 not applied. Run: psql -d IceedgeDB -f src/db/migrations/005_openai_key.sql',
        });
      }
      throw err;
    }

    // Keys are stored encrypted at rest (AES-256-GCM); decrypt for use.
    // Legacy plaintext rows pass through unchanged until the migration runs.
    const userKey: string | null = rows[0]?.openaiApiKey ? decryptSecret(rows[0].openaiApiKey) : null;
    if (!userKey) {
      return res.status(422).json({
        error: 'no_api_key',
        message: 'Add your OpenAI API key in Settings → AI Settings, or upgrade to Pro to use the built-in model.',
      });
    }
    endpoint = 'https://api.openai.com/v1/chat/completions';
    apiKey = userKey;
    requestModel = model ?? DEFAULT_FREE_MODEL;
  }

  // ── Forward the request ───────────────────────────────────────────────────
  // Reasoning models (gpt-5*, o1/o3/o4*) differ from chat models: they reject
  // `max_tokens` (need `max_completion_tokens`) and only accept the default
  // temperature. They also spend output tokens on hidden reasoning, so the
  // budget must be generous or `content` comes back empty.
  const isReasoning = /(^|\/)(gpt-5|o1|o3|o4)/.test(requestModel);

  const body: Record<string, any> = { model: requestModel, messages };
  if (isReasoning) {
    body.max_completion_tokens = 2048;
    // no temperature — reasoning models only allow the default (1)
  } else {
    body.max_tokens = 512;
    body.temperature = 0.7;
  }

  // Node 18+ global fetch returns a Response-like object typed loosely as `any`.
  // Bounded by a hard timeout with one retry on transient failure, so a hung
  // provider can't tie up the request/connection indefinitely.
  let providerRes: any;
  try {
    providerRes = await fetchWithTimeoutRetry(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    const timedOut = err?.name === 'AbortError';
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'The model provider timed out' : 'Failed to reach the model provider',
      detail: err?.message,
    });
  }

  if (!providerRes.ok) {
    const raw = await (providerRes as any).text().catch(() => '');
    let body: any = {};
    try { body = JSON.parse(raw); } catch { /* non-JSON error page */ }
    const status = (providerRes as any).status ?? 502;
    // Log the FULL upstream error to the server console for debugging.
    console.error(
      `[LLM] provider error ${status} (pro=${userIsPro}, model=${requestModel}):`,
      raw || '(empty body)'
    );
    return res.status(status === 401 ? 401 : 502).json({
      error: body?.error?.message ?? body?.error ?? raw ?? 'Model provider error',
      code:  body?.error?.code  ?? 'provider_error',
      upstreamStatus: status,
    });
  }

  const data = await (providerRes as any).json();
  const text: string = data?.choices?.[0]?.message?.content ?? '';

  return res.json({ text });
});

export default router;
