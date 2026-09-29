/**
 * injurySync.ts — la partie PURE de `npm run injuries:sync`.
 *
 * Le script (server/scripts/sync-injuries.ts) lit la liste des blessés de
 * PoolExpert, décide pour chaque joueur « absent ou non, et jusqu'à quand »,
 * lui donne une importance tirée de ses statistiques LNH, puis range le tout
 * dans `long_injuries` en entrées `source: 'auto'` (voir `longInjuries.ts`).
 * Tout ce qui se teste sans réseau vit ici ; le script ne fait que les appels.
 *
 * ── Ce qu'on garde de la source, et ce qu'on n'en garde pas ────────────────
 * On ne stocke AUCUN texte de la source : ni la note, ni le type de blessure.
 * La note sert uniquement à décider, ici, si le joueur est absent et jusqu'à
 * quand ; seuls le nom (orthographe LNH), l'importance et deux dates partent en
 * base. Choix du user du 2026-09-29.
 *
 * ── Pourquoi la note ne peut pas être prise au pied de la lettre ────────────
 * La liste n'est pas « les absents du jour » : c'est la DERNIÈRE note de chaque
 * joueur, et elle remonte à un an (mesuré le 2026-09-29 : ~575 lignes, la plus
 * vieille du 2025-09-29). « Saison terminée » d'avril parle de la saison
 * dernière ; « S'est entraîné normalement » dit qu'il joue. D'où `classifyNote`
 * : chaque note reçoit une date de fin, et une date de fin passée = ignorée.
 *
 * Les règles sont volontairement simples et lisibles. Ce qui ne rentre dans
 * aucune règle sort en « non classé » dans le rapport du script, pas en base.
 */

// ── Lignes brutes ────────────────────────────────────────────────────────────

export interface RawInjury {
  player: string;
  /** Code PoolExpert : C, AG, AD, D, G. */
  position: string;
  /** Abréviation PoolExpert (LA, NJ, SJ, TB, WIN…) — voir `toNhlAbbr`. */
  team: string;
  /** Date de la note, YYYY-MM-DD. */
  date: string;
  note: string;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç',
  ocirc: 'ô', icirc: 'î', ucirc: 'û', uuml: 'ü', ouml: 'ö', auml: 'ä', euml: 'ë',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => {
      const ch = ENTITIES[name.toLowerCase()];
      if (!ch) return m;
      // &Eacute; → É : la majuscule de l'entité est celle de la lettre.
      return name[0] === name[0].toUpperCase() && name.length > 3 ? ch.toUpperCase() : ch;
    });
}

const cellText = (html: string) =>
  decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/[ \t]+/g, ' ').trim();

/**
 * Une page `ginjuries.aspx` → ses lignes, et le nombre de pages annoncé.
 *
 * Structure relevée le 2026-09-29 : des `div.resRow` (pas de <table>, et des
 * attributs entre apostrophes dans le HTML brut : `class='resRow r1'`), sept
 * cellules — joueur, position, équipe, date, note, type, lien « détails ». La
 * ligne d'en-tête porte des `resTHead` et est écartée. Une ligne dont la date
 * ne ressemble pas à une date est écartée aussi : si la mise en page change,
 * on veut ZÉRO ligne (le script s'arrête) plutôt que des colonnes décalées.
 */
export function parseInjuryPage(html: string): { rows: RawInjury[]; pageCount: number } {
  const rows: RawInjury[] = [];
  const chunks = html.split(/<div class=['"]resRow\b/).slice(1);
  for (const chunk of chunks) {
    if (chunk.includes('resTHead')) continue;
    const cells = [...chunk.matchAll(/<div class=['"]resCell[^'"]*['"][^>]*>([\s\S]*?)<\/div>/g)].map((m) => cellText(m[1]));
    if (cells.length < 5) continue;
    const [player, position, team, date, note] = cells;
    if (!player || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    rows.push({ player, position, team: team.toUpperCase(), date, note });
  }
  const pages = [...html.matchAll(/ginjuries\.aspx\?g=(\d+)/g)].map((m) => Number(m[1]));
  return { rows, pageCount: Math.max(1, ...pages) };
}

// ── Équipes ──────────────────────────────────────────────────────────────────

/** PoolExpert → LNH, pour les seules abréviations qui diffèrent. */
const TEAM_ALIASES: Record<string, string> = { LA: 'LAK', NJ: 'NJD', SJ: 'SJS', TB: 'TBL', WIN: 'WPG', MON: 'MTL', CLB: 'CBJ', NAS: 'NSH', WAS: 'WSH' };

export function toNhlAbbr(team: string, known: Set<string>): string | null {
  const t = team.trim().toUpperCase();
  const abbr = TEAM_ALIASES[t] ?? t;
  return known.has(abbr) ? abbr : null;
}

// ── Dates ────────────────────────────────────────────────────────────────────

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const pad = (n: number) => String(n).padStart(2, '0');
function lastDayOfMonth(year: number, month0: number): string {
  const d = new Date(Date.UTC(year, month0 + 1, 0, 12));
  return d.toISOString().slice(0, 10);
}

// ── Classement d'une note ────────────────────────────────────────────────────

export type NoteVerdict =
  /** Absent jusqu'à `until` inclus (null = pas de date, voir `LONG_DAYS`). */
  | { kind: 'out'; until: string; rule: string }
  /** Au jeu, ou sur le point d'y revenir : rien à écrire. */
  | { kind: 'available'; rule: string }
  /** Au jour le jour, décision avant le match… : on laisse l'humain trancher. */
  | { kind: 'doubtful'; rule: string }
  /** Une note d'absence dont la date de fin est passée. */
  | { kind: 'stale'; until: string; rule: string }
  /** Aucune règle ne s'applique. */
  | { kind: 'unknown'; rule: string };

export interface SeasonContext {
  /** Aujourd'hui, heure de l'Est. */
  today: string;
  /**
   * Premier match de saison régulière DE L'ÉQUIPE du joueur quand on le
   * connaît (« manquera le match d'ouverture » parle du sien), sinon celui de
   * la ligue (`regularSeasonStartDate`).
   */
  opener: string;
  /** Fin de saison (`playoffEndDate`, à défaut fin de saison régulière). */
  seasonEnd: string;
}

/** Durées retenues quand la note n'en donne pas. Une seule place pour les régler. */
export const HORIZONS = {
  /** « Blessé », « Ne jouera pas »… sans durée : la source publie une nouvelle note sous peu. */
  generic: 5,
  /** Note liée à UN match (« contre Boston », « jeudi »). */
  singleGame: 2,
  /** Liste des blessés (IR) : 7 jours minimum en LNH. */
  injuredReserve: 14,
  /** « Évalué sur une base hebdomadaire ». */
  weekly: 14,
  /** Opération, fracture, durée indéterminée, liste des blessés à long terme. */
  long: 60,
  /** « Rate le début de saison » : la première semaine. */
  seasonStart: 7,
};

/** Minuscules, sans accents, sans les préfixes de traduction de la source. */
export function normalizeNote(note: string): string {
  let t = note;
  // « [Trad. auto.] … [Original en] … » : l'original anglais est plus sûr.
  const orig = t.match(/\[original en\]([\s\S]*)$/i);
  if (orig) t = orig[1];
  t = t.replace(/\[(en|trad\. auto\.)\]/gi, ' ');
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
}

const NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, un: 1, une: 1, another: 1,
  two: 2, deux: 2, three: 3, trois: 3, four: 4, quatre: 4, five: 5, cinq: 5, six: 6, seven: 7, sept: 7, eight: 8, huit: 8,
};
const UNIT_DAYS: Record<string, number> = {
  day: 1, days: 1, jour: 1, jours: 1,
  week: 7, weeks: 7, semaine: 7, semaines: 7,
  month: 30, months: 30, mois: 30,
};
const MONTHS: Record<string, number> = {
  january: 0, janvier: 0, february: 1, fevrier: 1, march: 2, mars: 2, april: 3, avril: 3, may: 4, mai: 4,
  june: 5, juin: 5, july: 6, juillet: 6, august: 7, aout: 7, september: 8, septembre: 8,
  october: 9, octobre: 9, november: 10, novembre: 10, december: 11, decembre: 11,
};
const MONTH_RE = Object.keys(MONTHS).join('|');

/** La durée explicite d'une note, en jours (la borne HAUTE d'une fourchette). */
export function durationDays(t: string): number | null {
  const unit = '(days?|jours?|weeks?|semaines?|months?|mois)';
  const range = t.match(new RegExp(`(\\d+)\\s*(?:-|–|a|to|à)\\s*(\\d+)\\s*(?:more |autres |de plus )?${unit}`));
  if (range) return Number(range[2]) * UNIT_DAYS[range[3]];
  const digits = t.match(new RegExp(`(\\d+)[- ]?(?:more |autres )?${unit}`));
  if (digits) return Number(digits[1]) * UNIT_DAYS[digits[2]];
  const words = t.match(new RegExp(`\\b(${Object.keys(NUM).join('|')})[- ](?:more )?${unit}`));
  if (words) {
    // « another week or two » → deux semaines.
    const orTwo = /or two|ou deux/.test(t) ? 2 : 1;
    return NUM[words[1]] * UNIT_DAYS[words[2]] * orTwo;
  }
  const games = t.match(/\b(\d+|two|deux|three|trois|four|quatre)\s+(?:(?:prochains|next|first|premiers)\s+)?(?:\S+\s+)?(?:matchs|games|parties)\b/);
  if (games) return (Number(games[1]) || NUM[games[1]] || 2) * 2;
  return null;
}

/** Une date de fin tirée d'un nom de mois : « until December », « back in November »… */
function monthUntil(t: string, noteDate: string): string | null {
  const m = t.match(new RegExp(`\\b(until|jusqu'en|jusqu'a|back in|return in|retour en|revenir en|late|fin|miss|manquer|manquera|through|out for|in)\\s+(?:early |late |mid-|debut |fin )?(${MONTH_RE})\\b`));
  if (!m) return null;
  const month0 = MONTHS[m[2]];
  const [y, mo] = noteDate.split('-').map(Number);
  const year = month0 >= mo - 1 ? y : y + 1;
  const first = `${year}-${pad(month0 + 1)}-01`;
  switch (m[1]) {
    case 'until': case "jusqu'en": case "jusqu'a":
      return addDays(first, -1);
    case 'back in': case 'return in': case 'retour en': case 'revenir en':
      return /late|fin/.test(t) ? `${year}-${pad(month0 + 1)}-25` : `${year}-${pad(month0 + 1)}-15`;
    case 'late': case 'fin':
      return `${year}-${pad(month0 + 1)}-25`;
    default:
      return lastDayOfMonth(year, month0);
  }
}

const RE = {
  notReady: /(pas (encore )?pret|not (yet )?ready|won't be ready|ne sera pas pret|n'est pas pret|not yet close)/,
  available: /(est pret|pret pour un retour|pret a jouer|feu vert|cleared|entraine normalement|devrait jouer|should play|should be ready|on track to be ready|ready for|a recupere|recovered|\bavailable for|wearing regular jersey|back from assignment|de retour au jeu|sera en uniforme|will play|va jouer|retour imminent|back in (the )?lineup)/,
  mightMiss: /((could|might|pourrait|may) (miss|manquer)|probablement pas|likely (to miss|out))/,
  doubtful: /(jour le jour|jour-le-jour|day-to-day|game-time|\bgtd\b|decision|incertain|uncertain|questionable|doubtful|in doubt|probable|pourrait|could|might|status for|statut sera|maintenance day|day off|taking \w+ off|absent de la pratique|manque la pratique|ne sera pas a l'entrainement|pas present a l'entrainement|pres d'un retour|close to (a )?return|nearing (a )?return|devrait revenir|should return)/,
  seasonOver: /(saison terminee|saison reguliere terminee|remainder of (the )?season|reste de la saison|pour la saison|for the season|this season|ruled out for playoffs|won't be ready for playoffs|out until postseason|dernier match de la saison|probablement tenu a l'ecart pour la saison)/,
  opener: /(opener|opening night|match d'ouverture|match inaugural|premier match)/,
  seasonStart: /(start of (the )?(regular )?season|start of \d{4}-\d{2} season|debut de (la )?saison|early in (the )?season|beginning of (the )?season|regular-season games)/,
  christmas: /(christmas|noel)/,
  preseason: /(preseason|pre-saison|training camp|\bcamp\b|exhibition|rookie|showcase|preparatoire)/,
  /** Un incident (« blessé pendant un match préparatoire ») n'est pas « absent du camp ». */
  incident: /(hurt|injured|leaves|exits|quitte|blesse|slashed|gets)/,
  olympics: /olympi/,
  weekly: /(hebdomadaire|week-to-week|week to week|quelque temps|some time)/,
  long: /(indefini|indetermine|long terme|long-term|longue periode|ltir|non-roster|hors effectif|surgery|chirurgie|opere|operation|fracture|broken|extended time|des semaines|weeks away|no timeline|pas de date|timeline for return unclear|not close|setback|rechute)/,
  injuredReserve: /(injured reserve|liste des blesses)/,
  singleGame: /(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday|against|versus|contre|\bvs\b|tonight|ce soir|game \d|la rencontre|clash|contest|matchup)/,
  out: /(\bmiss(es)?\b|miss time|ne jouera pas|won't play|won't suit|won't return|ruled out|out for|out against|\bout\b|not available|non disponible|indisponible|ne sera pas|n'est pas de l'alignement|sur la touche|shelved|sidelined|held out|missing|manquera|misses|absent|a l'ecart|toujours blesse|encore blesse|reste|remains|still|officiellement|blesse|injur|hurt|blessure|commotion|concussion|malade|illness|sick|leaves|exits|quitte|a quitte|not suiting|not playing|not an option|empire|evalu|examen|testing|diagnostic|souffre|aux prises|dealing with|managing|contending|sustains|suffers|scratched|laisse de cote|ne se sent pas bien|rater|quelques matchs|probablement pas)/,
  recovering: /(patin|skat|voyage|travel|accompan|recovery|recupere|progres|tracking|practic|pratique|entrainement|contacts|sans contact|non-contact|reprendre)/,
};

/**
 * La note d'un joueur → absent (et jusqu'à quand), disponible, incertain,
 * périmé ou non classé.
 *
 * L'ORDRE des règles est la règle : « Could miss more than one week » doit
 * tomber dans la durée, pas dans l'incertain ; « Practices Wednesday, won't
 * play » dans l'absent, pas dans l'entraînement.
 */
export function classifyNote(note: string, noteDate: string, ctx: SeasonContext): NoteVerdict {
  const t = normalizeNote(note);
  if (!t) return { kind: 'unknown', rule: 'note vide' };

  const notReady = RE.notReady.test(t);
  if (!notReady && RE.available.test(t)) return { kind: 'available', rule: 'de retour / prêt' };

  const done = (until: string, rule: string): NoteVerdict =>
    (until < ctx.today ? { kind: 'stale', until, rule } : { kind: 'out', until, rule });

  // « Début de saison » ne vaut que si le premier match suit la note de moins
  // de 200 jours : une note de l'an dernier parlait de l'AUTRE début de saison.
  const openerNear = ctx.opener >= noteDate && ctx.opener <= addDays(noteDate, 200);
  const aboutSeasonStart = RE.opener.test(t) || RE.seasonStart.test(t);

  // 1. Une durée ou une date explicite gagne sur tout le reste. « Les deux
  // premiers matchs de la saison » se comptent à partir du premier match.
  const days = durationDays(t);
  if (days != null && !(RE.doubtful.test(t) && !RE.mightMiss.test(t) && !/(miss|manqu|out|absent)/.test(t))) {
    const from = aboutSeasonStart && openerNear ? addDays(ctx.opener, -1) : noteDate;
    let until = addDays(from, days);
    // « Les deux derniers matchs préparatoires » : la présaison finit à la
    // veille du premier match, quelle que soit la durée comptée.
    if (RE.preseason.test(t) && !aboutSeasonStart && openerNear && until >= ctx.opener) until = addDays(ctx.opener, -1);
    return done(until, `durée explicite (${days} j)`);
  }
  const byMonth = monthUntil(t, noteDate);
  if (byMonth) return done(byMonth, 'mois nommé');
  if (RE.christmas.test(t)) {
    const y = Number(noteDate.slice(0, 4));
    return done(/post|apres/.test(t) ? `${y}-12-28` : `${y}-12-25`, 'Noël');
  }

  // 2. Saison : ne vaut que pour la saison de la note.
  const seasonBoundary = addDays(ctx.opener, -60);
  if (RE.seasonOver.test(t)) {
    return noteDate < seasonBoundary
      ? { kind: 'stale', until: noteDate, rule: 'fin de saison (saison passée)' }
      : done(ctx.seasonEnd, 'fin de saison');
  }
  if (aboutSeasonStart) {
    if (RE.doubtful.test(t) && !RE.mightMiss.test(t) && !/(miss|manqu)/.test(t)) {
      return { kind: 'doubtful', rule: 'incertain pour le début de saison' };
    }
    if (openerNear) {
      return done(RE.opener.test(t) && !RE.seasonStart.test(t) ? ctx.opener : addDays(ctx.opener, HORIZONS.seasonStart), 'début de saison');
    }
    return done(addDays(noteDate, HORIZONS.generic), 'début de saison (date incohérente)');
  }

  // 3. Incertain.
  if (RE.doubtful.test(t) && !RE.mightMiss.test(t)) return { kind: 'doubtful', rule: 'incertain' };

  // 4. Préparatoires / camp : absent jusqu'à la veille du premier match.
  if (RE.preseason.test(t) && !RE.long.test(t) && !RE.incident.test(t)) {
    return openerNear ? done(addDays(ctx.opener, -1), 'camp / préparatoire') : done(addDays(noteDate, HORIZONS.generic), 'camp (hors saison)');
  }
  if (RE.olympics.test(t)) return done(addDays(noteDate, 21), 'Jeux olympiques');

  // 5. Durées implicites.
  if (RE.weekly.test(t)) return done(addDays(noteDate, HORIZONS.weekly), 'réévalué chaque semaine');
  if (RE.long.test(t) || notReady) return done(addDays(noteDate, HORIZONS.long), 'longue durée sans date');
  if (RE.injuredReserve.test(t)) return done(addDays(noteDate, HORIZONS.injuredReserve), 'liste des blessés');
  if (RE.out.test(t)) {
    return RE.singleGame.test(t)
      ? done(addDays(noteDate, HORIZONS.singleGame), 'absent pour un match')
      : done(addDays(noteDate, HORIZONS.generic), 'absent, sans durée');
  }
  if (RE.recovering.test(t)) return done(addDays(noteDate, HORIZONS.generic), 'en réadaptation');

  return { kind: 'unknown', rule: 'aucune règle' };
}

// ── Noms ─────────────────────────────────────────────────────────────────────

/** « Juraj Slafkovský » et « juraj slafkovsky » → la même clé. */
export function nameKey(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\b(jr|sr|ii|iii)\b\.?/g, '').replace(/[.'’]/g, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Le nom tel qu'il est RANGÉ : l'orthographe LNH sans accents. Le service ML
 * apparie les absents par nom exact (casse ignorée) contre les noms MoneyPuck,
 * qui sont en ASCII (« Isac Lundestrom », pas « Lundeström » comme la
 * recherche LNH le rend).
 */
export function storedName(name: string): string {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

/** Diminutifs courants entre la source et l'API LNH (les deux sens). */
const NICKNAMES: string[][] = [
  ['alex', 'alexander', 'alexandre', 'aleksander', 'alexandr'], ['mitch', 'mitchell'], ['matt', 'matthew', 'mathew'],
  ['mike', 'michael'], ['nick', 'nicholas', 'nicolas', 'nikolai'], ['josh', 'joshua'], ['zach', 'zachary', 'zack'],
  ['will', 'william', 'billy'], ['jake', 'jacob'], ['sam', 'samuel'], ['tony', 'anthony'], ['chris', 'christopher'],
  ['dan', 'daniel', 'danny'], ['tim', 'timothy'], ['tom', 'thomas'], ['jon', 'jonathan'], ['max', 'maxim', 'maxime', 'maximilian'],
  ['cam', 'cameron'], ['ben', 'benjamin'], ['ed', 'edward'], ['vince', 'vincent'], ['pat', 'patrick'], ['joe', 'joseph'],
  ['nate', 'nathan'], ['greg', 'gregory'], ['jt', 'j t'], ['tj', 't j'], ['pj', 'p j'], ['cal', 'calvin'], ['jj', 'j j'],
];
function sameFirstName(a: string, b: string): boolean {
  if (a === b) return true;
  return NICKNAMES.some((g) => g.includes(a) && g.includes(b));
}

export interface RosterPlayer {
  id: string;
  /** Orthographe LNH, telle que l'écran d'admin la propose. */
  name: string;
  firstName: string;
  lastName: string;
  team: string;
  /** C, L, R, D, G. */
  position: string;
}

/**
 * Le joueur LNH correspondant à une ligne de la source.
 *
 * Ordre : nom complet dans l'équipe annoncée → même nom de famille ET prénom
 * compatible (diminutif) dans l'équipe → nom complet ailleurs dans la ligue
 * (échange que la source n'a pas encore suivi) → même chose avec diminutif.
 * Un nom de famille seul ne suffit JAMAIS : deux frères dans la même équipe
 * (Hughes, Tkachuk) seraient confondus.
 */
export function matchPlayer(name: string, team: string | null, roster: RosterPlayer[]): { player: RosterPlayer; how: string } | null {
  const k = nameKey(name);
  const [first, ...rest] = k.split(' ');
  const last = rest.join(' ');
  const inTeam = roster.filter((p) => p.team === team);
  const exact = (list: RosterPlayer[]) => list.filter((p) => nameKey(p.name) === k);
  const loose = (list: RosterPlayer[]) => list.filter((p) =>
    nameKey(p.lastName) === last && sameFirstName(nameKey(p.firstName), first));

  for (const [list, how] of [
    [exact(inTeam), 'nom'], [loose(inTeam), 'diminutif'],
    [exact(roster), 'autre équipe'], [loose(roster), 'autre équipe, diminutif'],
  ] as const) {
    if (list.length === 1) return { player: list[0], how };
    if (list.length > 1) return null; // ambigu : on ne devine pas
  }
  return null;
}

/**
 * Résultats de la recherche de joueurs LNH (search.d3.nhle.com) → candidats.
 *
 * Nécessaire parce que `v1/roster/:équipe/current` n'inclut PAS les blessés
 * (mesuré le 2026-09-29 : Domi, Joshua, Merzlikins absents de l'effectif de
 * TOR ; 18 absents sur 53 introuvables par les seuls effectifs). La recherche,
 * elle, les rend avec leur équipe. Seuls les joueurs actifs sont gardés.
 */
export function searchResultsToRoster(results: any[]): RosterPlayer[] {
  return (Array.isArray(results) ? results : [])
    .filter((p) => p && p.active !== false && p.playerId && p.name && p.teamAbbrev)
    .map((p) => {
      const name = String(p.name).trim();
      const [firstName, ...rest] = name.split(' ');
      return {
        id: String(p.playerId),
        name,
        firstName,
        lastName: rest.join(' '),
        team: String(p.teamAbbrev).toUpperCase(),
        position: p.positionCode ?? 'C',
      };
    });
}

// ── Importance ───────────────────────────────────────────────────────────────

/** Une saison LNH (saison régulière) d'un joueur, déjà repliée s'il a été échangé. */
export interface SeasonLine {
  season: string;
  gamesPlayed: number;
  points: number;
  /** Minutes par match (patineurs). */
  avgToi: number;
  /** Départs (gardiens). */
  gamesStarted: number;
}

/**
 * `seasonTotals` de `v1/player/:id/landing` → une ligne par saison régulière
 * LNH, les lignes d'un joueur échangé en cours de saison additionnées (le
 * temps de glace est pondéré par les matchs). La plus récente d'abord.
 */
export function foldSeasons(seasonTotals: any[]): SeasonLine[] {
  const by = new Map<string, SeasonLine & { _toi: number }>();
  for (const s of seasonTotals ?? []) {
    if (s?.leagueAbbrev !== 'NHL' || s?.gameTypeId !== 2) continue;
    const season = String(s.season ?? s.seasonId);
    const gp = Number(s.gamesPlayed) || 0;
    const cur = by.get(season) ?? { season, gamesPlayed: 0, points: 0, avgToi: 0, gamesStarted: 0, _toi: 0 };
    cur.gamesPlayed += gp;
    cur.points += Number(s.points) || 0;
    cur.gamesStarted += Number(s.gamesStarted) || 0;
    cur._toi += toiMinutes(s.avgToi) * gp;
    by.set(season, cur);
  }
  return [...by.values()]
    .map(({ _toi, ...l }) => ({ ...l, avgToi: l.gamesPlayed ? Math.round((_toi / l.gamesPlayed) * 10) / 10 : 0 }))
    .sort((a, b) => b.season.localeCompare(a.season));
}

function toiMinutes(s: unknown): number {
  if (typeof s !== 'string' || !s.includes(':')) return 0;
  const [m, sec] = s.split(':').map(Number);
  return Number.isFinite(m) && Number.isFinite(sec) ? m + sec / 60 : 0;
}

/** Échantillon minimal pour qu'une moyenne veuille dire quelque chose. */
export const MIN_GAMES = 10;

/**
 * La saison qui sert de base : la saison en cours dès 10 matchs joués, sinon
 * la plus récente qui en compte 10. `null` = recrue ou trop peu de matchs LNH.
 */
export function pickBaseSeason(lines: SeasonLine[], currentSeason: string): SeasonLine | null {
  const cur = lines.find((l) => l.season === currentSeason);
  if (cur && cur.gamesPlayed >= MIN_GAMES) return cur;
  return lines.find((l) => l.season !== currentSeason && l.gamesPlayed >= MIN_GAMES) ?? null;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/** L'importance par défaut quand on n'a pas de base statistique. */
export const DEFAULT_IMPACT = 0.03;

/**
 * L'importance d'un absent, sur le barème de `injuries` (0.03 soutien,
 * 0.06 joueur clé, 0.12 gardien n° 1). Décision du user du 2026-09-29 : les
 * points pour les attaquants, une statistique propre au rôle pour les autres.
 *
 *   • Attaquant : 0.02 + 0.05 × points par match, borné à [0.02, 0.08].
 *     0.2 pt/m → 0.03 ; 0.8 → 0.06 ; 1.2 et plus → 0.08.
 *   • Défenseur : le temps de glace, qui dit la place dans l'alignement bien
 *     mieux que les points (un défenseur défensif de 1re paire marque peu).
 *     0.03 + 0.005 × (minutes − 16), borné à [0.02, 0.08].
 *     16 min (3e paire) → 0.03 ; 22 min (1re paire) → 0.06 ; 26 min et plus → 0.08.
 *   • Gardien : la part des matchs de l'équipe qu'il a commencés — c'est la
 *     définition même du « gardien n° 1 ». 0.12 × part / 0.6, borné à
 *     [0.03, 0.12]. 60 % des départs et plus → 0.12 ; 45 % → 0.09 ; 25 % → 0.05.
 */
export function computeImpact(
  position: string,
  base: SeasonLine | null,
  teamGames: number,
): { impact: number; basis: string } {
  if (!base) return { impact: DEFAULT_IMPACT, basis: 'moins de 10 matchs LNH' };
  const s = `${base.season.slice(2, 4)}-${base.season.slice(6, 8)}`;
  if (position === 'G') {
    const share = teamGames > 0 ? base.gamesStarted / teamGames : 0;
    return {
      impact: round2(clamp(0.12 * (share / 0.6), 0.03, 0.12)),
      basis: `${Math.round(share * 100)} % des départs (${s})`,
    };
  }
  if (position === 'D') {
    return {
      impact: round2(clamp(0.03 + 0.005 * (base.avgToi - 16), 0.02, 0.08)),
      basis: `${base.avgToi.toFixed(1)} min/match (${s})`,
    };
  }
  const ppg = base.points / base.gamesPlayed;
  return {
    impact: round2(clamp(0.02 + 0.05 * ppg, 0.02, 0.08)),
    basis: `${ppg.toFixed(2)} pt/match (${s})`,
  };
}
