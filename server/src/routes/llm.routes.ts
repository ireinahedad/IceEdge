/**
 * llm.routes.ts
 * POST /api/llm  — proxies a prompt to OpenAI using the authenticated user's
 * own API key (stored in their user_profiles row).  Costs are billed to the
 * user's OpenAI account, not the app operator.
 */

import { Router, Request, Response } from 'express';
import { pool } from '../db/connection';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// All LLM routes require a valid JWT
router.use(authenticate);

router.post('/', async (req: Request, res: Response) => {
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  const { prompt, model = 'gpt-4o-mini', systemPrompt } = req.body as {
    prompt?: string;
    model?: string;
    systemPrompt?: string;
  };

  if (!prompt?.trim()) return res.status(400).json({ error: 'prompt is required' });

  // Fetch the user's stored OpenAI API key
  let rows: any[];
  try {
    const result = await pool.query(
      `SELECT openai_api_key AS "openaiApiKey" FROM user_profiles WHERE user_id = $1`,
      [userId]
    );
    rows = result.rows;
  } catch (err: any) {
    // Column missing = migration 005 not yet applied
    if (err.code === '42703') {
      return res.status(500).json({
        error: 'db_schema',
        message: 'Database migration 005 not applied. Run: psql -d IceedgeDB -f src/db/migrations/005_openai_key.sql',
      });
    }
    throw err;
  }

  const apiKey: string | null = rows[0]?.openaiApiKey ?? null;

  if (!apiKey) {
    return res.status(422).json({
      error: 'no_api_key',
      message: 'Add your OpenAI API key in Settings → AI Settings to use Ask LLM.',
    });
  }

  // Forward to OpenAI
  const messages: { role: string; content: string }[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  let openAiRes: Response;
  try {
    openAiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: 512, temperature: 0.7 }),
    }) as unknown as Response;
  } catch (err: any) {
    return res.status(502).json({ error: 'Failed to reach OpenAI', detail: err.message });
  }

  if (!openAiRes.ok) {
    const body = await (openAiRes as any).json().catch(() => ({}));
    const status = (openAiRes as any).status ?? 502;
    // Forward useful OpenAI error messages (e.g. invalid key, quota exceeded)
    return res.status(status === 401 ? 401 : 502).json({
      error: body?.error?.message ?? 'OpenAI error',
      code:  body?.error?.code  ?? 'openai_error',
    });
  }

  const data = await (openAiRes as any).json();
  const text: string = data?.choices?.[0]?.message?.content ?? '';

  return res.json({ text });
});

export default router;
