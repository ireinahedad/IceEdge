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
 *
 * ── 2026-10-24 ──────────────────────────────────────────────────────────────
 * +9 comptes trouvés par `npm run news:discover` : ANA, BOS, CAR, COL, NYI, NYR,
 * VGK, WPG couverts. Restent sans source dédiée (15) : CBJ, DAL, DET, FLA, LAK,
 * NSH, NJD, OTT, PIT, SJS, SEA, STL, TBL, UTA, WSH.
 *
 * ── 2026-10-26 ──────────────────────────────────────────────────────────────
 * 2e passage (médias locaux + mots-clics) : +3 comptes (DAL, STL, WSH), 20
 * refusés. Puis tranchés par le user : mike-fink et alexcthw (NJD) gardés ;
 * alexisb82, calbluechel, 101espn.com refusés. Restent sans source dédiée
 * (11) : CBJ, DET, FLA, LAK, NSH, OTT, PIT, SJS, SEA, TBL, UTA.
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
  // Trouvés par `npm run news:discover`, triés à la main le 2026-10-24 —
  // journalistes attitrés et médias d'équipe seulement. À confirmer par news:check.
  { handle: 'zachcavsports.bsky.social',    team: 'ANA', label: 'Zach Cavanagh' },
  { handle: 'ty-anderson.bsky.social',      team: 'BOS', label: 'Ty Anderson' },
  { handle: 'adamlichtenstein.bsky.social', team: 'CAR', label: 'Adam Lichtenstein' },
  { handle: 'evanrawal.bsky.social',        team: 'COL', label: 'Evan Rawal' },
  { handle: 'dnvr-avalanche.bsky.social',   team: 'COL', label: 'DNVR Avalanche' },
  { handle: 'stefenrosner.bsky.social',     team: 'NYI', label: 'Stefen Rosner' },
  { handle: 'mollieewalkerr.bsky.social',   team: 'NYR', label: 'Mollie Walker' },
  { handle: 'dannywebster21.bsky.social',   team: 'VGK', label: 'Danny Webster' },
  { handle: 'wiebesworld.bsky.social',      team: 'WPG', label: 'Ken Wiebe' },
  // 2e passage de `npm run news:discover`, triés le 2026-10-26 — journalistes
  // attitrés seulement. À confirmer par news:check.
  { handle: 'jeremyrutherford.bsky.social', team: 'STL', label: 'Jeremy Rutherford' },
  { handle: 'vogscaps.bsky.social',         team: 'WSH', label: 'Mike Vogel' },
  { handle: 'owennewkirk.bsky.social',      team: 'DAL', label: 'Owen Newkirk' },
  // Tranchés par le user le 2026-10-26 (étaient « pas encore tranchés »).
  { handle: 'mike-fink.bsky.social',        team: 'NJD', label: 'Mike Fink' },
  { handle: 'alexcthw.bsky.social',         team: 'NJD', label: 'Alex Chauvancy' },
  // Handles devinés et inexistants (400), ne pas réessayer : dfomontreal,
  // dfoottawa, dfowinnipeg, dfoseattle, dfomtl, dfohabs, dfosens, dfojets, dfokraken.
];

/**
 * Comptes proposés par `npm run news:discover` et REFUSÉS au tri (2026-10-24) :
 * le script ne les propose plus. Fans, histoire, balados d'opinion, parodies,
 * autre sport, politique — rien qui annonce un absent ou un gardien.
 */
export const REJECTED_HANDLES: string[] = [
  'bruinsbruinsbruins.bsky.social',    // BOS — compte de fan
  'lockedonavalanche.bsky.social',     // COL — balado d'opinion
  'dallasstarshistory.bsky.social',    // DAL — histoire du club
  'topher2.bsky.social',               // DET — compte personnel
  'detroithockey.net',                 // DET — site de fans
  'mikekayefootball.bsky.social',      // FLA — Carolina Panthers (NFL), pas Florida
  'notnjdevils.bsky.social',           // NJD — parodie
  'hockeynightny.bsky.social',         // NYI — agrégateur
  'jk4pghpa.bsky.social',              // PIT — compte de fan
  'usrepkathycastor.bsky.social',      // TBL — députée de Tampa
  'vegashockeygirls.bsky.social',      // VGK — compte de fan
  'antwanstaley.bsky.social',          // WPG — n'est plus attitré aux Jets
  'winnipeghockeytalk.bsky.social',    // WPG — blogue de fans
  // 2e passage (2026-10-26) — mots-clics surtout : fans, balados, bots, stats multi-équipes.
  'whalerjacket.bsky.social',          // CBJ — fan
  'gpwcbj.bsky.social',                // CBJ — fan
  'fiverumbeach.bsky.social',          // CBJ — fan
  'canucksgamebot.bsky.social',        // DET — bot, et des Canucks
  'hockeyalpha.bsky.social',           // DET — compte de stats général
  'hockeytownwpod.bsky.social',        // DET — balado
  'pucksleuth.bsky.social',            // LAK/PIT/UTA/WSH — plusieurs équipes, stats
  'hockeyalchemy.bsky.social',         // LAK/UTA — plusieurs équipes, stats
  'centralkingsbr.bsky.social',        // LAK — fan
  'thenvpshow.bsky.social',            // NJD — émission d'opinion
  'nhlgoals.bsky.social',              // OTT/UTA — buts de toute la ligue
  'hockeyfannibal.bsky.social',        // OTT — fan
  'senstennial.bsky.social',           // OTT — blogue de fans
  'davyjoneslr.bsky.social',           // SEA — blogue d'opinion
  'circlingseasports.bsky.social',     // SEA — multisport, opinion
  'sjsharks-news.bsky.social',         // SJS — agrégateur
  'gosharks.bsky.social',              // SJS — site de fans
  'tealtown-usa.bsky.social',          // SJS — balado
  'jts65.bsky.social',                 // STL — fan
  'glb.dogfishcr.us',                  // WSH — site de fans
  'alexisb82.bsky.social',             // TBL — refusé par le user (2026-10-26)
  'calbluechel.bsky.social',           // SEA — refusé par le user (2026-10-26)
  '101espn.com',                       // STL — radio multisport, refusé par le user (2026-10-26)
];
