import { describe, it, expect } from 'vitest';
import { inspect, containsProhibited } from './moderation.service';

/**
 * Le filtre a deux façons d'échouer, et la seconde est la plus coûteuse.
 *
 * Laisser passer une insulte est un incident. Bloquer « nice assist » est une
 * régression visible par tout le monde, tous les soirs de match. Les deux
 * premiers blocs verrouillent donc ce qui NE doit PAS sauter, avant ce qui doit.
 */

/**
 * `fold()` écrase les lettres répétées : `ass` devient `as`, un des mots les plus
 * courants de l'anglais et « as » en français. Ce bloc est le garde-fou qui
 * tombera si quelqu'un ajoute un terme court sans le replier mentalement.
 */
const MOTS_ORDINAIRES = [
  'as good as it gets',
  'he plays as a winger',
  'quel as ce gardien',
  'as soon as possible',
  'les as du patinage',
];

const HOCKEY = [
  'nice assist by McDavid',
  'great passing play',
  'world class goalie',
  'he shoots he scores',
  'the Canucks got hammered',
  'that hit was clean',
  'kill the penalty',
  'puck luck',
  'bass drum in the arena',
  'from Massachusetts',
  'glass broke behind the net',
  'embarrassing turnover',
  'belle passe de Suzuki',
  'les Habs ont gagne',
  'il a compte en prolongation',
];

const DOIT_BLOQUER = [
  'fuck you',
  'pussy',
  'You are a fucking idiot',
  'what a bitch',
  'f u c k you',
  'f.u.c.k you',
  'f-u-c-k',
  'FUUUUCK',
  'pu55y',
  'sh1t',
  'va te faire enculer',
  'enculez',
  'espece de connard',
  'quelle salope',
  'tabarnak',
  'câlisse de match',
];

describe('moderation — les mots ordinaires survivent au repliage', () => {
  for (const phrase of MOTS_ORDINAIRES) {
    it(`laisse passer : ${phrase}`, () => {
      expect(inspect(phrase).matches).toEqual([]);
    });
  }
});

describe('moderation — le vocabulaire hockey ne doit JAMAIS sauter', () => {
  for (const phrase of HOCKEY) {
    it(`laisse passer : ${phrase}`, () => {
      const v = inspect(phrase);
      expect(v.matches).toEqual([]);
      expect(v.blocked).toBe(false);
    });
  }
});

describe('moderation — ce qui doit être bloqué', () => {
  for (const phrase of DOIT_BLOQUER) {
    it(`bloque : ${phrase}`, () => {
      expect(containsProhibited(phrase)).toBe(true);
    });
  }
});

describe('moderation — les limites connues, écrites noir sur blanc', () => {
  // Documenté plutôt que caché : le filtre ne devine pas les substitutions de
  // voyelle. Le jour où ça compte, la réponse est un algorithme de distance,
  // pas une entrée de plus dans la liste.
  it('ne bloque PAS la substitution de voyelle (fvck) — limite assumée', () => {
    expect(containsProhibited('fvck')).toBe(false);
  });

  it('texte vide', () => {
    expect(containsProhibited('')).toBe(false);
  });

  it('des initiales ordinaires ne sont pas recollées', () => {
    expect(containsProhibited('J. M. Liles a marqué')).toBe(false);
  });

  it('rapporte QUEL terme a déclenché, pour le passage à blanc', () => {
    expect(inspect('fuck you pussy').matches.sort()).toEqual(['fuck', 'pusy']);
  });
});
