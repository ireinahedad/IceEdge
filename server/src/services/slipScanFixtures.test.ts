import { describe, it, expect } from 'vitest';
import { fixtureNames, loadFixture, validateExpected } from './__fixtures__/slipScan/fixture';

/**
 * SCAN_TICKET_PLAN § 7 (S0) — le jeu de fixtures lui-même est bien formé.
 *
 * Les tests du parseur (S2) s'appuieront sur ces fichiers ; une vérité mal
 * écrite fausserait la mesure d'efficacité sans que personne ne le voie.
 */
describe('fixtures slipScan', () => {
  const names = fixtureNames();

  it('le dossier expected/ contient au moins une fixture', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('%s : vérité attendue valide', (name) => {
    const { expected } = loadFixture(name);
    expect(validateExpected(expected)).toEqual([]);
  });

  it.each(names)('%s : sorties OCR bien formées', (name) => {
    const { ocr, expected } = loadFixture(name);
    for (const [engine, res] of Object.entries(ocr)) {
      expect(res.engine).toBe(engine);
      expect(res.width).toBeGreaterThan(0);
      expect(res.height).toBeGreaterThan(0);
      for (const l of res.lines) {
        expect(typeof l.text).toBe('string');
        expect(l.confidence).toBeGreaterThanOrEqual(0);
        expect(l.confidence).toBeLessThanOrEqual(1);
        expect(l.box.x + l.box.w).toBeLessThanOrEqual(res.width + 2);
        expect(l.box.y + l.box.h).toBeLessThanOrEqual(res.height + 2);
      }
    }
    // Les données personnelles ne sont jamais dans la vérité attendue des jambes.
    const legsText = expected.groups.flatMap((g) => g.legs.flatMap((l) => l.ticketText)).join('\n');
    for (const p of expected.personal) expect(legsText).not.toContain(p);
  });
});
