/**
 * newsSources.ts — comptes Bluesky lus par `newsSync.service.ts`.
 *
 * `team` : abréviation LNH (celle du spine), ou `null` pour une source de
 * ligue (insider, Daily Faceoff…). Pour une source de ligue, les équipes sont
 * retrouvées dans le texte (`teamsInText`).
 *
 * ── ÉTAT AU 2026-10-23 : RIEN N'EST VÉRIFIÉ ─────────────────────────────────
 * Ces handles viennent d'un pack de démarrage public (« NHL journalists,
 * analysts, and other media on Bluesky ») et n'ont pas pu être testés depuis la
 * session qui les a écrits. Avant d'activer le job :
 *
 *   npm run news:check
 *
 * Le script résout chaque handle, compte ses publications des 7 derniers jours
 * et dit lesquels retirer. Ajouter des journalistes par équipe ici (2 à 4 par
 * équipe) : c'est la couverture des sources qui fait la valeur du fil.
 */

export interface NewsSource {
  handle: string;
  team: string | null;
  label: string;
}

export const NEWS_SOURCES: NewsSource[] = [
  // ── Ligue ────────────────────────────────────────────────────────────────
  { handle: 'dailyfaceoff.bsky.social', team: null,  label: 'Daily Faceoff' },
  { handle: 'stevenpellis.ca',          team: null,  label: 'Steven Ellis' },
  { handle: 'seanshapiro.bsky.social',  team: null,  label: 'Sean Shapiro' },
  { handle: 'joeyerdon.bsky.social',    team: null,  label: 'Joe Yerdon' },
  // ── Équipes ──────────────────────────────────────────────────────────────
  { handle: 'jmarshpgh.bsky.social',    team: 'PIT', label: 'Jesse Marshall' },
];
