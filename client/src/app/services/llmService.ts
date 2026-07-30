/**
 * llmService.ts
 * Client helper for the /api/llm proxy endpoint.
 * The server uses the authenticated user's stored OpenAI key — no key needed here.
 */

import { authedFetch } from './authService';

const BASE = (import.meta.env.VITE_NHL_API_URL as string | undefined)
  ?.replace('/api/nhl', '') ?? 'http://localhost:3001';

export interface LLMError {
  type: 'no_api_key' | 'openai_error' | 'network' | 'unknown' | 'monthly_quota';
  message: string;
  /** Renseignés pour type 'monthly_quota' : plafond et date de remise à zéro. */
  limit?: number;
  resetsAt?: string;
}

/**
 * Avis de plafond mensuel.
 *
 * Présent dans DEUX situations, volontairement distinctes :
 *  • en `quota` d'une réponse réussie — l'abonné a dépassé son maximum du mois
 *    mais la requête est passée par SA clé OpenAI, donc il a sa réponse ;
 *  • en erreur `monthly_quota` (429) — plafond atteint et aucune clé perso.
 */
export interface LLMQuotaNotice {
  limit: number;
  resetsAt: string;
  message: string;
  billedTo: 'user';
}

export interface LLMAnswer {
  text: string;
  /** Non nul le mois où le plafond a été atteint : à afficher à côté de la réponse. */
  quota?: LLMQuotaNotice;
}

/** Consommation IA du mois, pour afficher un compteur AVANT d'atteindre la limite. */
export interface LLMUsage {
  pro: boolean;
  /** Vrai pour un utilisateur Free : il paie ses propres tokens, on ne le plafonne pas. */
  unlimited?: boolean;
  used?: number;
  limit?: number;
  remaining?: number;
  resetsAt?: string;
}

export async function getLLMUsage(): Promise<LLMUsage | null> {
  try {
    const res = await authedFetch('/llm/usage');
    if (!res.ok) return null;
    return await res.json() as LLMUsage;
  } catch {
    return null;   // un compteur indisponible ne doit jamais casser la page
  }
}

/**
 * Variante renvoyant la réponse complète, avis de quota compris.
 * `askLLM` reste la porte d'entrée simple pour les appelants qui n'en ont pas
 * besoin.
 */
export async function askLLMDetailed(
  prompt: string,
  opts?: { systemPrompt?: string; model?: string }
): Promise<LLMAnswer> {
  const res = await authedFetch('/llm', {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      systemPrompt: opts?.systemPrompt,
      model: opts?.model ?? 'gpt-4o-mini',
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as {
      error?: string; message?: string; code?: string; limit?: number; resetsAt?: string;
    };

    // Plafond mensuel atteint ET pas de clé personnelle pour prendre le relais.
    // Message distinct des autres 429 : ici, réessayer plus tard dans la minute
    // ne sert à rien — c'est un compteur mensuel.
    if (res.status === 429 && body.error === 'monthly_quota_reached') {
      const err: LLMError = {
        type: 'monthly_quota',
        message: body.message ?? 'Tu as atteint ton maximum de requêtes IA pour ce mois-ci.',
        limit: body.limit,
        resetsAt: body.resetsAt,
      };
      throw Object.assign(new Error(err.message), err);
    }
    if (res.status === 422 && body.error === 'no_api_key') {
      const err: LLMError = { type: 'no_api_key', message: body.message ?? 'Add your OpenAI API key in Settings.' };
      throw Object.assign(new Error(err.message), err);
    }
    if (res.status === 401) {
      const err: LLMError = { type: 'openai_error', message: 'Invalid OpenAI API key. Check your key in Settings → AI Settings.' };
      throw Object.assign(new Error(err.message), err);
    }
    const err: LLMError = { type: 'openai_error', message: body.error ?? `LLM error ${res.status}` };
    throw Object.assign(new Error(err.message), err);
  }

  return await res.json() as LLMAnswer;
}

export async function askLLM(
  prompt: string,
  opts?: { systemPrompt?: string; model?: string }
): Promise<string> {
  return (await askLLMDetailed(prompt, opts)).text;
}
