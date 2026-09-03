/**
 * env.ts — the single, validated entry point for every VITE_* variable.
 *
 * PRE_IOS_PLAN.md R7. Before this module existed, each service read
 * `import.meta.env.VITE_*` directly with a `|| 'http://localhost:3001'`
 * fallback: a variable missing from a Vercel deploy made the *deployed* app
 * quietly call the visitor's own machine. In a browser that is a console full
 * of errors and an empty page; under iOS ATS it is a blank screen with no clue
 * why. One module, validated once, with no localhost fallback.
 *
 * ── Two-stage rollout (deliberate) ──────────────────────────────────────────
 * `client/.env.production` is gitignored, so Vercel builds from the variables
 * set in its dashboard — which this repo cannot inspect. Throwing on day one
 * would turn an unverified assumption into a white screen for every visitor.
 *
 *   Stage 1 (done, 2026-09-03)  ENFORCEMENT = 'warn'
 *       Deployed alone. The four production variables were confirmed present in
 *       the Vercel dashboard, and Sentry recorded no `[env]` event afterwards.
 *   Stage 2 (current)           ENFORCEMENT = 'throw'
 *       `assertEnv()` throws and main.tsx renders a readable "Configuration
 *       error" screen instead of a white page.
 *
 * Two nets now, in this order: the Vercel build command runs
 * `npm run check:env && npm run build`, so a missing variable fails the deploy
 * and leaves the previous version live — the user never reaches the throw. The
 * throw is what catches the case the build cannot see.
 *
 * Only production is strict about https. In dev, `import.meta.env.PROD` is
 * false, so `http://localhost:3001` in your `.env` keeps working.
 */

/** Back to 'warn' only to debug a live configuration problem — not by default. */
const ENFORCEMENT: 'warn' | 'throw' = 'throw';

export interface EnvProblem {
  /** The variable at fault, e.g. 'VITE_SOCKET_URL'. */
  name: string;
  message: string;
}

/**
 * Problems found while this module was evaluated. Empty on a correctly
 * configured build. main.tsx forwards them to Sentry once it is initialised —
 * this module deliberately knows nothing about Sentry, so importing it stays
 * free of side effects beyond a console.error.
 */
export const envProblems: EnvProblem[] = [];

function record(name: string, message: string): void {
  envProblems.push({ name, message });
  console.error(`[env] ${message}`);
}

/**
 * A URL that the app cannot work without: present, https:// in production,
 * no trailing slash. Returns '' when missing, so that in stage 1 the app falls
 * back to a same-origin relative URL rather than to the visitor's machine.
 */
function requiredUrl(name: string, value: string | undefined): string {
  if (!value) {
    record(name, `${name} is not set. Check client/.env locally, or the Vercel project's environment variables.`);
    return '';
  }
  if (import.meta.env.PROD && !value.startsWith('https://')) {
    record(name, `${name} must be https:// in production, got: ${value}`);
  }
  return value.replace(/\/+$/, '');
}

/** Optional: absent is a supported configuration, not a problem. */
function optional(value: unknown): string | undefined {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.length > 0 ? v : undefined;
}

/** Server origin: strips a trailing `/api` or `/api/<segment>` from a base URL. */
function serverOrigin(url: string): string {
  return url.replace(/\/api(\/.*)?$/, '');
}

const nhlApiUrl        = requiredUrl('VITE_NHL_API_URL',        import.meta.env.VITE_NHL_API_URL);
const predictionApiUrl = requiredUrl('VITE_PREDICTION_API_URL', import.meta.env.VITE_PREDICTION_API_URL);
const profileApiUrl    = requiredUrl('VITE_PROFILE_API_URL',    import.meta.env.VITE_PROFILE_API_URL);
const socketUrl        = requiredUrl('VITE_SOCKET_URL',         import.meta.env.VITE_SOCKET_URL);

export const env = {
  /** NHL data proxy, e.g. https://api.example.com/api/nhl */
  nhlApiUrl,
  /** Prediction / ML API, e.g. https://api.example.com/api */
  predictionApiUrl,
  /** Profile + auth API, e.g. https://api.example.com/api */
  profileApiUrl,
  /** Socket.io origin, e.g. https://api.example.com */
  socketUrl,

  /** Origin behind VITE_NHL_API_URL (its `/api/nhl` suffix removed) — /api/llm, /api/predict. */
  nhlServerUrl: serverOrigin(nhlApiUrl),
  /** Origin behind VITE_PROFILE_API_URL (its `/api` suffix removed) — the Google OAuth entry point. */
  profileServerUrl: serverOrigin(profileApiUrl),
  /**
   * Backend API base for services that used to write
   * `VITE_PROFILE_API_URL || VITE_PREDICTION_API_URL || localhost`.
   * Same chain, minus the localhost leg.
   */
  apiBase: profileApiUrl || predictionApiUrl,

  /** Optional — a missing analytics DSN must never become an outage. */
  sentryDsn: optional(import.meta.env.VITE_SENTRY_DSN),
  /** Optional public affiliate codes; the links work untracked without them. */
  bet365AffiliateCode: optional(import.meta.env.VITE_BET365_AFFILIATE_CODE),
  stakeAffiliateCode: optional(import.meta.env.VITE_STAKE_AFFILIATE_CODE),
} as const;

/**
 * Called by main.tsx inside a try/catch, before the first render.
 *
 * Stage 1: no-op. Stage 2: throws, and main.tsx shows the configuration screen.
 *
 * The throw lives here rather than at import time on purpose — a module that
 * throws while being evaluated cannot be caught by the module importing it,
 * and the user would get the white page this whole item exists to remove.
 */
export function assertEnv(): void {
  if (ENFORCEMENT !== 'throw' || envProblems.length === 0) return;
  throw new Error(envProblems.map((p) => p.message).join('\n'));
}
