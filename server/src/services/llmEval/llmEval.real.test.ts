import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildGameFacts } from '../llmFacts';
import { fallbackAnalysis } from '../llmAnalysis';
import { scoreAnalysis, sanityCheckFacts, FALLBACK_LIMITS } from './metrics';

/**
 * Rejoue les matchs RÉELS figés par `scripts/check-real-facts.ts --freeze`
 * (dossier `real/`). Sans fixtures, la suite est ignorée : elle s'active dès
 * qu'on fige un premier match.
 */
const dir = path.join(__dirname, 'real');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
const cases: any[] = files.flatMap(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

describe.skipIf(cases.length === 0)('FAITS sur matchs réels figés', () => {
  for (const c of cases) {
    it(c.id, () => {
      for (const locale of ['fr', 'en'] as const) {
        const facts = buildGameFacts({ ...c, locale });
        expect(sanityCheckFacts(facts, c.result)).toEqual([]);
        const a = fallbackAnalysis(facts, locale);
        expect(scoreAnalysis(a, facts, FALLBACK_LIMITS).failures).toEqual([]);
      }
    });
  }
});
