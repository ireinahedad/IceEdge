/**
 * authService.ts
 * Wraps /api/auth/* endpoints. Where the session is *kept* is tokenStore.ts.
 *
 * Web: access token in localStorage, refresh token in an httpOnly cookie the
 * server sets — so every /auth call uses `credentials: 'include'` and the
 * cookie flows between the client origin and the API origin.
 *
 * Native (Phase 3): WKWebView drops that cookie, so the refresh token is held
 * by the store and travels in the request body behind `X-Client: native`
 * (PRE_IOS_PLAN.md R3). Only one function below branches on it — `tryRefresh`
 * — and it branches on whether the *store* has a refresh token, not on the
 * platform. On web the store returns null forever, so the browser path is the
 * code that always ran.
 */

import { env } from '../env';
import { tokenStore } from './tokenStore';
import { decodeJwtPayload } from './jwt';
import { fetchWithTimeout, type TimedRequestInit } from './http';
import { isIOS } from '../platform';

const BASE = env.profileApiUrl;

/** Marks a request as coming from the native shell (see tokenStore.ts). */
const NATIVE_CLIENT_HEADER = { 'X-Client': 'native' } as const;

/**
 * APPLE_PLAN 3.5 — headers for the /auth calls that open a session (register,
 * verify-email, login…). On iOS they carry `X-Client: native` so the server
 * answers with the refresh token in the body instead of a cookie WKWebView would
 * drop. The server ignores the header on routes that issue no tokens.
 */
const AUTH_JSON_HEADERS: Record<string, string> = isIOS
  ? { 'Content-Type': 'application/json', ...NATIVE_CLIENT_HEADER }
  : { 'Content-Type': 'application/json' };

// --- Authed fetch helper ----------------------------------------------------

/**
 * Tout passe par `fetchWithTimeout` : sans délai, une requête partie sur un
 * réseau mobile dégradé n'échouait jamais et l'écran restait figé (voir
 * `http.ts`). `init.timeoutMs` permet de sortir du défaut de 15 s — un seul
 * appelant le fait, `llmService`, dont l'amont a droit à 30 s côté serveur.
 *
 * Le rejeu après un 401 rearme son propre délai : deux allers-retours peuvent
 * donc prendre jusqu'à 2 × le budget, ce qui est voulu — le refresh est court
 * et l'utilisateur préfère une session rafraîchie à un abandon.
 *
 * Le jeton vient de `getFreshAccessToken()` et non plus de `tokenStore` : le
 * 401 + refresh + rejeu ci-dessous reste le filet, il n'est plus le chemin
 * normal du retour dans l'application.
 *
 * Conséquence assumée : quand le rafraîchissement proactif vient d'échouer et
 * que la requête prend quand même un 401, un second refresh part. C'est deux
 * appels au lieu d'un, sur un chemin déjà en train d'échouer — un refus du
 * serveur a de toute façon fermé la session et l'écran part vers /login, et
 * hors ligne les deux échouent immédiatement. Ça ne valait pas un drapeau de
 * plus à porter à travers la fonction.
 */
export async function authedFetch(path: string, init: TimedRequestInit = {}): Promise<Response> {
  const token = await getFreshAccessToken();
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> ?? {}),
    },
  });

  // If 401, try a cookie-based refresh once, then replay the request
  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const newToken = await tokenStore.getAccess();
      return fetchWithTimeout(`${BASE}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${newToken}`,
          ...(init.headers as Record<string, string> ?? {}),
        },
      });
    }
  }
  return res;
}

/**
 * Exchange the refresh credential for a new access token. R3.5.
 *
 * One branch, keyed on what the store holds rather than on the platform:
 *   web    → getRefresh() is null → `credentials: 'include'`, no body. The
 *            httpOnly cookie *is* the credential, exactly as before.
 *   native → the token is in hand → it travels in the body behind
 *            `X-Client: native`, because no cookie survives WKWebView.
 *
 * A failure clears the session, which now notifies the auth context (R3.8):
 * before that, the tokens were dropped but the UI kept rendering 401s.
 */
async function doRefresh(): Promise<boolean> {
  try {
    const refresh = await tokenStore.getRefresh();

    const res = await fetchWithTimeout(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: refresh ? 'omit' : 'include',
      headers: refresh
        ? { 'Content-Type': 'application/json', ...NATIVE_CLIENT_HEADER }
        : { 'Content-Type': 'application/json' },
      body: refresh ? JSON.stringify({ refresh_token: refresh }) : undefined,
    });
    if (!res.ok) { await tokenStore.clear(); return false; }

    const data = await res.json();
    // `refresh_token` is present only in a native response; the store drops it
    // on web. Rotation means the old one is already revoked server-side.
    await tokenStore.setTokens(data.access_token, data.refresh_token);
    return true;
  } catch {
    // Réseau coupé, DNS, délai dépassé : le serveur n'a RIEN répondu, donc il
    // n'a pas refusé le jeton de rafraîchissement — on ne sait simplement pas.
    //
    // ⚠️ Ce `catch` effaçait la session jusqu'au 2026-09-11. C'était tenable
    // tant qu'on n'arrivait ici qu'après un vrai 401 ; le rafraîchissement
    // proactif ci-dessous l'a rendu atteignable par un simple passage sous un
    // tunnel, et déconnecter quelqu'un dont le jeton est parfaitement valide
    // parce que son métro est entré en station n'est pas une défense, c'est un
    // bogue. On rend `false` : l'appel en cours échoue comme n'importe quel
    // appel hors ligne, l'écran affiche son erreur réseau et son bouton
    // « Réessayer », et le prochain essai repart avec la même session.
    //
    // Seul un REFUS du serveur (`!res.ok` ci-dessus) met fin à la session —
    // c'est ce que R3.8 voulait dire par « ne pas rester à afficher des 401 ».
    return false;
  }
}

// --- Rafraîchissement proactif (audit pré-freeze, § 5) -----------------------

/**
 * Marge avant expiration. 60 s : largement au-dessus d'un aller-retour même
 * sur un réseau mobile lent, largement en dessous des 15 min de durée de vie du
 * jeton — donc au plus un refresh supplémentaire par quart d'heure d'usage.
 */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Coupe-circuit d'horloge. Voir `getFreshAccessToken`.
 *
 * Volontairement à la portée du chargement de page : un téléphone dont
 * l'horloge est remise à l'heure recharge de toute façon l'application.
 */
let skewGuardTripped = false;

/** `true` si le jeton expire dans moins de `marginMs` — ou est déjà expiré. */
function expiresWithin(token: string, marginMs: number): boolean {
  const exp = decodeJwtPayload(token)?.exp;
  // `exp` illisible : on ne devine pas, on laisse le 401 trancher comme avant.
  if (typeof exp !== 'number') return false;
  return Date.now() >= exp * 1000 - marginMs;
}

/**
 * Le jeton d'accès, rafraîchi AVANT de partir s'il est sur le point d'expirer.
 *
 * ── Ce que ça supprime ──────────────────────────────────────────────────────
 * Le premier appel après 15 minutes coûtait trois allers-retours : un 401, un
 * refresh, un rejeu. Sur un réseau mobile c'est un délai visible à chaque
 * retour dans l'application — et c'est le geste le plus fréquent d'une app
 * consultée entre deux périodes d'arrière-plan. Ici le refresh part à la place
 * du 401, pas après lui : deux allers-retours au lieu de trois, et le rejeu du
 * chemin 401 ne sert plus que de filet.
 *
 * ── Pourquoi pas un minuteur à `exp - 60 s` ─────────────────────────────────
 * Parce que iOS suspend les minuteurs d'une WKWebView en arrière-plan : il ne
 * se déclencherait pas pendant l'absence, puis d'un coup au retour, en même
 * temps que les appels de remontage — soit exactement la tempête que la
 * coalescence R3bis.1 existe pour éteindre. Vérifier à l'envoi ne dépend
 * d'aucun minuteur et donne la bonne réponse au réveil comme à chaud.
 *
 * ── Le garde d'horloge ──────────────────────────────────────────────────────
 * `exp` est lu avec l'horloge du téléphone. Une horloge en avance de plus de
 * 15 minutes rend TOUT jeton « bientôt expiré », y compris celui qui vient
 * d'arriver : sans garde, chaque requête déclencherait une rotation, soit une
 * tempête de refresh silencieuse chez le seul utilisateur concerné. Si le
 * jeton tout neuf paraît encore expirer, on arrête les frais pour ce
 * chargement et on repasse au chemin 401, qui ne dépend d'aucune horloge
 * locale.
 *
 * Passe par `tryRefresh` (et non `doRefresh`) pour partager la coalescence
 * R3bis.1 avec le chemin 401 et le socket.
 */
export async function getFreshAccessToken(): Promise<string | null> {
  const token = await tokenStore.getAccess();
  if (!token || skewGuardTripped) return token;
  if (!expiresWithin(token, REFRESH_MARGIN_MS)) return token;

  // Un échec ne se traite pas ici : soit le serveur a refusé et `doRefresh` a
  // déjà fermé la session, soit le réseau est tombé et le jeton actuel reste
  // le meilleur qu'on ait — dans les deux cas on rend ce que le magasin a.
  await tryRefresh();

  const renewed = await tokenStore.getAccess();
  if (renewed && expiresWithin(renewed, REFRESH_MARGIN_MS)) skewGuardTripped = true;
  return renewed;
}

/**
 * R3bis.1 — one refresh at a time, however many callers ask.
 *
 * `authedFetch` is called concurrently (a page load fires `/users/me` and
 * `/subscription/me` together). With an expired access token each of them takes
 * a 401 and each used to call the refresh independently: one 401 produced three
 * `POST /auth/refresh`, observed in production on 2026-09-03.
 *
 * That matters more than the wasted requests. The server rotates on every
 * refresh, and its rotation is a SELECT followed by an UPDATE rather than one
 * atomic statement (`auth.service.ts`), so the concurrent callers all pass the
 * `revoked=FALSE` check and one refresh token becomes three — each valid for
 * 7 to 30 days, two of them orphaned but live. Coalescing here is also what
 * makes the server side safe to fix later: the day that rotation becomes
 * atomic, the extra callers would get a 401, and `doRefresh` answers a 401 by
 * clearing the session. Without this, hardening the server would sign users out
 * on every silent refresh. See PRE_IOS_PLAN.md R3bis.
 *
 * Not covered, deliberately: two browser tabs each coalesce their own callers
 * but not each other, and a caller whose 401 lands just after a refresh settled
 * starts a second one instead of retrying with the token it could now read.
 * Both need the server-side grace window (R3bis.2), not more client state.
 */
let inFlightRefresh: Promise<boolean> | null = null;

function tryRefresh(): Promise<boolean> {
  // `doRefresh` is async, so it cannot settle before this assignment lands —
  // the `.finally()` that clears the slot always runs on a later tick.
  if (!inFlightRefresh) {
    inFlightRefresh = doRefresh().finally(() => { inFlightRefresh = null; });
  }
  return inFlightRefresh;
}

/**
 * Le rafraîchissement partagé, pour le seul appelant qui ne passe pas par
 * `authedFetch` : le socket du chat.
 *
 * Son handshake porte le jeton d'accès ; passé 15 minutes le serveur le refuse
 * (`socket.ts`, « Invalid or expired token ») et **rien** ne déclenchait alors
 * de refresh — socket.io réessayait en boucle avec le même jeton mort.
 *
 * ⚠️ Passe par `tryRefresh` et NON par `doRefresh` : c'est la coalescence
 * R3bis.1 qui empêche le socket et une requête HTTP simultanée de lancer deux
 * rotations concurrentes — exactement la panne du 2026-09-03. Un second chemin
 * de refresh la ferait revenir.
 */
export function refreshSession(): Promise<boolean> {
  return tryRefresh();
}

// --- Auth API calls ---------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  first_name: string | null;
  last_name:  string | null;
  role: string;
  avatar_url?: string | null;
}

export interface AuthResult {
  user: AuthUser;
  /**
   * R3.3 — `sendTokens()` returns two shapes. A browser gets the access token
   * only; the refresh credential is in the httpOnly cookie and must stay
   * unreachable from JavaScript. A native client gets the refresh pair in the
   * body, because no cookie survives WKWebView. Optional, therefore, rather
   * than absent: `setSession()` forwards `refresh_token` to the store, which
   * drops it on web.
   */
  tokens: {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    refresh_expires_in?: number;
  };
}

/** /register no longer logs in immediately — it returns a pending state. */
export interface PendingVerification {
  pending: true;
  email: string;
}

/** Error thrown when login is blocked because the email isn't verified yet. */
export class EmailNotVerifiedError extends Error {
  email: string;
  constructor(email: string) {
    super('Email not verified');
    this.name = 'EmailNotVerifiedError';
    this.email = email;
  }
}

// Register returns a pending state normally, OR a full session when email
// verification is disabled on the server (dev bypass).
export async function apiRegister(
  email: string,
  username: string,
  password: string,
  first_name?: string
): Promise<PendingVerification | AuthResult> {
  const res = await fetchWithTimeout(`${BASE}/auth/register`, {
    method: 'POST',
    credentials: 'include',
    headers: AUTH_JSON_HEADERS,
    body: JSON.stringify({ email, username, password, first_name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Registration failed');
  }
  return res.json();
}

/** Confirms the 6-digit code; on success the user is logged in. */
export async function apiVerifyEmail(email: string, code: string): Promise<AuthResult> {
  const res = await fetchWithTimeout(`${BASE}/auth/verify-email`, {
    method: 'POST',
    credentials: 'include', // receive the refresh cookie
    headers: AUTH_JSON_HEADERS,
    body: JSON.stringify({ email, code }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Verification failed');
  }
  return res.json();
}

export async function apiResendVerification(email: string): Promise<void> {
  await fetchWithTimeout(`${BASE}/auth/resend-verification`, {
    method: 'POST',
    credentials: 'include',
    headers: AUTH_JSON_HEADERS,
    body: JSON.stringify({ email }),
  }).catch(() => {});
}

/** Requests a password-reset code by email. Always resolves (no enumeration). */
export async function apiForgotPassword(email: string): Promise<void> {
  await fetchWithTimeout(`${BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: AUTH_JSON_HEADERS,
    body: JSON.stringify({ email }),
  }).catch(() => {});
}

/** Sets a new password using the emailed reset code. */
export async function apiResetPassword(email: string, code: string, newPassword: string): Promise<void> {
  const res = await fetchWithTimeout(`${BASE}/auth/reset-password`, {
    method: 'POST',
    headers: AUTH_JSON_HEADERS,
    body: JSON.stringify({ email, code, new_password: newPassword }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? 'Reset failed');
  }
}

export async function apiLogin(email: string, password: string, remember = false): Promise<AuthResult> {
  const res = await fetchWithTimeout(`${BASE}/auth/login`, {
    method: 'POST',
    credentials: 'include', // receive the refresh cookie
    headers: AUTH_JSON_HEADERS,
    body: JSON.stringify({ email, password, remember }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    if (res.status === 403 && err.code === 'EMAIL_NOT_VERIFIED') {
      throw new EmailNotVerifiedError(err.email ?? email);
    }
    throw new Error(err.error ?? 'Login failed');
  }
  return res.json();
}

export async function apiLogout(): Promise<void> {
  const token   = await tokenStore.getAccess();
  const refresh = await tokenStore.getRefresh(); // native only — null on web

  await fetchWithTimeout(`${BASE}/auth/logout`, {
    method: 'POST',
    credentials: refresh ? 'omit' : 'include', // web: server reads + revokes the cookie
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(refresh ? NATIVE_CLIENT_HEADER : {}),
    },
    // The route already accepted a body token before R3; native needs it,
    // otherwise the server has nothing to revoke.
    body: refresh ? JSON.stringify({ refresh_token: refresh }) : undefined,
  }).catch(() => {});

  await tokenStore.clear();
}

/** Sign out from every device by revoking all of the user's refresh tokens. */
export async function apiLogoutAll(): Promise<void> {
  const token = await tokenStore.getAccess();
  await fetchWithTimeout(`${BASE}/auth/logout-all`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).catch(() => {});
  await tokenStore.clear();
}

export function getGoogleLoginUrl(): string {
  const serverBase = env.profileServerUrl;
  return `${serverBase}/api/auth/google`;
}
