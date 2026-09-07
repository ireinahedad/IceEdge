/**
 * http.ts — le seul `fetch` du client qui abandonne.
 *
 * Avant ce fichier, `grep -c "AbortController\|AbortSignal" client/src` donnait
 * **0** : une requête partie sur un réseau mobile dégradé pouvait rester en
 * attente jusqu'au plafond de la plateforme (undici : 300 s ; WKWebView :
 * indéfini tant que la socket n'est pas coupée), sans que l'écran change et
 * sans autre recours que de tuer l'application. Le serveur, lui, a des délais
 * partout (`NHL_TIMEOUT_MS` 8 s, `mlApiClient` 5 s, `LLM_FETCH_TIMEOUT_MS`
 * 30 s) : c'est le client qui manquait.
 *
 * ── Pourquoi `AbortController` et pas `AbortSignal.timeout()` ────────────────
 * `AbortSignal.timeout()` n'existe qu'à partir de Safari/iOS **16**, et
 * `AbortSignal.any()` — qui aurait servi à fusionner le délai avec le `signal`
 * de l'appelant — qu'à partir d'**iOS 17.4**. La cible iOS de la phase 3 n'est
 * pas encore arrêtée ; `AbortController` + `setTimeout` marche partout et ne
 * coûte rien. À ne PAS « moderniser » sans avoir fixé la version minimale.
 *
 * ── Ce que le délai couvre, et ce qu'il ne couvre pas ────────────────────────
 * Il court de l'envoi de la requête jusqu'à la réception des **en-têtes**, ce
 * qui est la phase où une mauvaise connexion bloque en pratique. Le minuteur
 * est désarmé dès que `fetch` rend la main : la lecture du corps (`res.json()`)
 * n'est donc pas plafonnée. C'est assumé — couvrir le corps demanderait de
 * reconstruire la `Response` autour d'un flux surveillé, et une `Response`
 * reconstruite perd `url`/`redirected` et lève sur un 204. Les corps servis
 * ici sont du JSON court, lu immédiatement après l'appel.
 *
 * ── Pas de réessai automatique ───────────────────────────────────────────────
 * Un échec remonte tel quel : c'est l'utilisateur qui réessaie, par le bouton
 * des écrans principaux. Un réessai automatique transformerait une panne
 * d'amont en troupeau — exactement ce que le tir S1 a coûté sur l'API de cotes
 * facturée à l'appel (AUDIT_SCALABILITE_COUTS.md).
 */

/**
 * 15 s. Choisi au-dessus de tous les délais serveur (8 s NHL, 5 s ML) plus la
 * marge d'un démarrage à froid Railway, pour que le client n'abandonne jamais
 * une requête que le serveur était sur le point de servir. La seule exception
 * est l'IA, qui laisse 30 s à son amont : voir `LLM_TIMEOUT_MS` dans
 * `llmService.ts`.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Délai dépassé — distinct d'une coupure réseau.
 *
 * Sans ce type, les deux arrivent comme un `AbortError` et l'interface ne peut
 * pas les distinguer d'un abandon volontaire (démontage d'un composant), ce qui
 * ferait clignoter un message d'erreur en quittant une page.
 */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number, url: string) {
    super(`Request timed out after ${timeoutMs} ms: ${url}`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function isRequestTimeout(e: unknown): e is RequestTimeoutError {
  return e instanceof RequestTimeoutError;
}

export interface TimedRequestInit extends RequestInit {
  /** Millisecondes avant abandon. `0` désarme le délai (à ne pas faire sans raison). */
  timeoutMs?: number;
}

/**
 * `fetch` + abandon au bout de `timeoutMs`.
 *
 * Un `signal` déjà fourni par l'appelant est **relayé**, pas remplacé : les deux
 * causes d'abandon restent vivantes, et l'abandon de l'appelant remonte comme
 * son `AbortError` habituel, pas comme un délai dépassé.
 */
export async function fetchWithTimeout(url: string, init: TimedRequestInit = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, ...rest } = init;

  if (!(timeoutMs > 0)) return fetch(url, { ...rest, signal: callerSignal });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const relay = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', relay, { once: true });
  }

  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (cause) {
    // L'ordre compte : un abandon de l'appelant arrivé pendant que le minuteur
    // courait doit rester un abandon de l'appelant.
    if (callerSignal?.aborted) throw cause;
    if (timedOut) throw new RequestTimeoutError(timeoutMs, url);
    throw cause;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', relay);
  }
}
