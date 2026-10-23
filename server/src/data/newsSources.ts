/**
 * newsSources.ts — comptes Bluesky lus par `newsSync.service.ts`.
 *
 * `team` : abréviation LNH (celle du spine), ou `null` pour une source de
 * ligue (insider, Daily Faceoff…). Pour une source de ligue, les équipes sont
 * retrouvées dans le texte (`teamsInText`).
 *
 * ── État au 2026-10-23 ──────────────────────────────────────────────────────
 * 19 comptes vérifiés par `npm run news:check` (actifs, bonne équipe).
 * Relancer le script après chaque ajout. Équipes avec une source dédiée :
 * CHI, BUF, MIN, PHI, MTL, VAN, TOR, EDM, CGY. Les 23 autres reposent sur les
 * sources de ligue (Daily Faceoff surtout).
 */

export interface NewsSource {
  handle: string;
  team: string | null;
  label: string;
}

export const NEWS_SOURCES: NewsSource[] = [
  // ── Ligue — vérifiées le 2026-10-23 (news:check) ──────────────────────────
  // Retirés ce jour : frank-seravalli (inactif), gmillertsn (aucune équipe citée).
  { handle: 'dailyfaceoff.bsky.social',     team: null,  label: 'Daily Faceoff' },
  { handle: 'stevenpellis.ca',              team: null,  label: 'Steven Ellis' },
  { handle: 'seanshapiro.bsky.social',      team: null,  label: 'Sean Shapiro' },
  { handle: 'joeyerdon.bsky.social',        team: null,  label: 'Joe Yerdon' },
  { handle: 'puckpedia.com',                team: null,  label: 'PuckPedia' },
  { handle: 'mirtle.bsky.social',           team: null,  label: 'James Mirtle' },
  { handle: 'arponbasu.bsky.social',        team: null,  label: 'Arpon Basu' },
  // ── Équipes — vérifiées le 2026-10-23 (la colonne « top » = l'équipe) ──────
  // Retirés ce jour (0 publication en 7 j) : edmontonjack, georgerichards,
  // jamesonolive, daviddwork, nhlcanucks, dhaliwalsports, thomasdrance.
  { handle: 'scottpowers.bsky.social',      team: 'CHI', label: 'Scott Powers' },
  { handle: 'marklazerus.bsky.social',      team: 'CHI', label: 'Mark Lazerus' },
  { handle: 'matthewfairburn.bsky.social',  team: 'BUF', label: 'Matthew Fairburn' },
  { handle: 'russohockey.bsky.social',      team: 'MIN', label: 'Michael Russo' },
  { handle: 'puckmyers.bsky.social',        team: 'MIN', label: 'Jess Myers' },
  { handle: 'kevinkurznhl.bsky.social',     team: 'PHI', label: 'Kevin Kurz' },
  { handle: 'bwildemtl.bsky.social',        team: 'MTL', label: 'Brian Wilde' },
  { handle: 'dfovancouver.bsky.social',     team: 'VAN', label: 'Daily Faceoff Vancouver' },
  { handle: 'risingaction.bsky.social',     team: 'VAN', label: 'Patrick Johnston' },
  // Daily Faceoff par ville — vérifiés le 2026-10-23.
  { handle: 'dfotoronto.bsky.social',       team: 'TOR', label: 'Daily Faceoff Toronto' },
  { handle: 'dfoedmonton.bsky.social',      team: 'EDM', label: 'Daily Faceoff Edmonton' },
  { handle: 'dfocalgary.bsky.social',       team: 'CGY', label: 'Daily Faceoff Calgary' },
  // Handles devinés et inexistants (400), ne pas réessayer : dfomontreal,
  // dfoottawa, dfowinnipeg, dfoseattle, dfomtl, dfohabs, dfosens, dfojets, dfokraken.
];
