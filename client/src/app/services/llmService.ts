/**
 * llmService.ts
 * Client helper for the /api/llm proxy endpoint.
 * The server uses the authenticated user's stored OpenAI key — no key needed here.
 */

import { authedFetch } from './authService';

const BASE = (import.meta.env.VITE_NHL_API_URL as string | undefined)
  ?.replace('/api/nhl', '') ?? 'http://localhost:3001';

export interface LLMError {
  type: 'no_api_key' | 'openai_error' | 'network' | 'unknown';
  message: string;
}

export async function askLLM(
  prompt: string,
  opts?: { systemPrompt?: string; model?: string }
): Promise<string> {
  const res = await authedFetch('/llm', {
    method: 'POST',
    body: JSON.stringify({
      prompt,
      systemPrompt: opts?.systemPrompt,
      model: opts?.model ?? 'gpt-4o-mini',
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; message?: string; code?: string };

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

  const data = await res.json() as { text: string };
  return data.text;
}
