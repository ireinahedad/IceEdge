/**
 * compliance.ts — le vocabulaire interdit, en un seul endroit
 * ============================================================
 * Liste partagée par `check-posts.ts` (pipeline quotidien, textes rédigés) et
 * `build-recap.ts` (récaps d'après-match, textes générés).
 *
 * POURQUOI ELLE EST SORTIE DE check-posts. C'est la vérification qui compte le
 * plus de tout le système : une seule occurrence suffit à faire classer le
 * compte comme promotion de jeu d'argent, et la portée perdue ne revient pas.
 * Deux copies de cette liste, c'est la certitude qu'un mot ajouté un jour dans
 * l'une manquera dans l'autre — et le trou sera exactement du côté qu'on ne
 * relit jamais. Elle vit donc ici, et nulle part ailleurs.
 *
 * Voir content/STYLE-GUIDE.md §5.
 */

export const BANNED = [
  'bet', 'bets', 'betting', 'bettor', 'bettors', 'spread', 'parlay',
  'wager', 'wagers', 'lock', 'locks', 'guaranteed', 'edge', 'pick', 'picks',
  'tip', 'tips', 'prediction', 'predictions', 'sportsbook', 'bookmaker',
];

/**
 * Les mots interdits présents dans un texte, sans doublon.
 *
 * Frontières de mots des deux côtés : « locks » est interdit, « Blackhawks »
 * ne l'est pas, et « edge » ne doit pas se déclencher sur « Sledge ».
 */
export function findBanned(text: string): string[] {
  const haystack = String(text ?? '').toLowerCase();
  return BANNED.filter((word) => new RegExp(`\\b${word}\\b`).test(haystack));
}
