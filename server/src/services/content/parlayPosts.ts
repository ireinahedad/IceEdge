/**
 * parlayPosts.ts — les deux vidéos quotidiennes des combinés (MARKETING_PLAN Phase C)
 * ------------------------------------------------------------------
 * Fonctions PURES : combinés gelés (`parlay_log`) + bilan → un post au format
 * de `posts.json` (plans, légendes, titre YouTube). Le script
 * `scripts/build-parlays.ts` s'occupe des appels réseau et des fichiers ;
 * `render-slides.ts` et `build-video.ts` traitent ensuite le post comme
 * n'importe quel autre.
 *
 *   • mode `pick`   — avant les matchs : ouverture, un plan par combiné
 *                     (jambes + probabilité), carte de fin.
 *   • mode `result` — le lendemain : ouverture, un plan par combiné
 *                     (✓/✗ par jambe, WON / LOST), bilan cumulé, carte de fin.
 *
 * POURQUOI PAS `lib/compliance.ts`. Ce vocabulaire interdit (« parlay », « pick »,
 * « prediction »…) protège le contenu « insight » sur TikTok / Instagram, qui ne
 * doit JAMAIS ressembler à du pari. Ces vidéos-ci sont des combinés, par
 * décision (MARKETING_PLAN §0, 2026-10-21) : leurs garde-fous sont autres —
 * mention 18+ partout, aucun bookmaker nommé, aucune promesse de gain
 * (`parlayComplianceProblems`).
 */

import type { LoggedParlay, ParlayRecord } from '../parlayLog.service';
import type { BestBet } from '../bestBets.service';

export type ParlayMode = 'pick' | 'result';

/** Mention obligatoire : chaque plan (pied de page) et chaque légende. */
export const DISCLAIMER = '18+ (21+ US). Not betting advice. Gamble responsibly.';

const SITE = 'https://arakice.com';

/** Durées, en secondes. */
const D = {
  intro:     2.2,
  cardBase:  1.6,   // en-tête du combiné + probabilité…
  cardLeg:   0.6,   // … plus une jambe, lue d'un coup d'œil
  cardMax:   5.0,
  record:    2.8,
  cta:       2.4,
};
const round1 = (n: number) => Math.round(n * 10) / 10;

// ─── Formats ─────────────────────────────────────────────────────────────────

/** « Thursday » / « October 23, 2026 » d'une date ISO (midi UTC : jamais la veille). */
export function dayParts(date: string): { weekday: string; long: string; short: string } {
  const d = new Date(`${date}T12:00:00Z`);
  return {
    weekday: d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    long:    d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
    short:   d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  };
}

/** « 7:00 PM ET », ou '' sans heure. */
export function etTime(iso: string | null | undefined): string {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  return `${new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`;
}

/** Probabilité affichée : entier au-delà de 10 %, sinon un décimale. */
export function pct(p: number): string {
  if (!Number.isFinite(p)) return '';
  return `${p >= 10 ? Math.round(p) : Math.round(p * 10) / 10}%`;
}

/** « 12-9 (57%) since Oct 23 », ou null avant le premier combiné décidé. */
export function recordLine(r: ParlayRecord | null): string | null {
  if (!r || r.won + r.lost === 0 || r.winPct == null) return null;
  const since = r.since ? ` since ${dayParts(r.since).short}` : '';
  return `${r.won}-${r.lost} (${Math.round(r.winPct)}%)${since}`;
}

/**
 * « Last night: 1 of 2 hit », ou null si la veille n'a rien eu de gelé ou si un
 * combiné n'est pas encore réglé. Depuis le 2026-10-26, la vidéo « résultat »
 * n'est plus publiée : c'est cette ligne, sur la vidéo du jour, qui garde le
 * bilan public honnête (pertes comprises). Un combiné annulé (void) ne compte
 * ni comme gagné ni comme joué.
 */
export function lastNightLine(yesterday: LoggedParlay[] | null | undefined): string | null {
  if (!yesterday || yesterday.length === 0) return null;
  if (yesterday.some((p) => p.status === 'pending')) return null;
  const decided = yesterday.filter((p) => p.status === 'won' || p.status === 'lost');
  if (decided.length === 0) return null;
  const won = decided.filter((p) => p.status === 'won').length;
  return `Last night: ${won} of ${decided.length} hit`;
}

/** Le Short « pick » sort 2 h avant le 1er match… */
export const YOUTUBE_LEAD_MS = 2 * 3_600_000;
/** …si cette heure est encore à au moins 15 min ; sinon il sort tout de suite. */
export const YOUTUBE_MIN_DELAY_MS = 15 * 60_000;

/**
 * Heure de sortie programmée du Short (ISO), ou null = publier tout de suite.
 * Gel à 14 h à Bali depuis le 2026-10-26 (2 h du matin à New York) : sans
 * programmation, le Short sortirait en pleine nuit nord-américaine.
 */
export function youtubePublishAt(firstStarts: Array<string | null | undefined>, now: number): string | null {
  const times = firstStarts.map((s) => Date.parse(s ?? '')).filter(Number.isFinite);
  if (!times.length) return null;
  const at = Math.min(...times) - YOUTUBE_LEAD_MS;
  return at - now >= YOUTUBE_MIN_DELAY_MS ? new Date(at).toISOString() : null;
}

/** Ce qu'une jambe montre à l'écran — rien d'autre que ce que l'API a gelé. */
export interface SlideLeg {
  label:   string;          // « BOS to win », « Connor McDavid over 2.5 shots »
  market:  string;          // « Moneyline », « Shots O/U »
  logo:    string | null;   // abréviation du club concerné
  logos:   string[];        // les deux clubs, pour un total de match
  context: string;          // « NYR @ BOS · 7:00 PM ET »
  pct:     string;          // probabilité de la jambe
  result?: 'win' | 'loss' | 'void' | 'unknown';
}

function slideLeg(l: BestBet, result?: SlideLeg['result']): SlideLeg {
  const g = l.game;
  const matchup = g ? `${g.away} @ ${g.home}` : l.subjectName;
  const time = etTime(g?.startTimeUTC);
  const isTotal = l.subjectType === 'game' && !l.teamAbbr;
  return {
    label:   l.label,
    market:  l.marketLabel,
    logo:    isTotal ? null : (l.teamAbbr ? l.teamAbbr.toUpperCase() : null),
    logos:   isTotal && g ? [g.away, g.home] : [],
    context: time ? `${matchup} · ${time}` : matchup,
    pct:     pct(l.score),
    ...(result ? { result } : {}),
  };
}

// ─── Plans ───────────────────────────────────────────────────────────────────

export interface ParlayPost {
  candidate_id:        string;
  variant:             'short';
  duration_target:     [number, number];
  subject:             string;
  slides:              any[];
  caption_tiktok:      string;
  caption_instagram:   string;
  hashtags:            string[];
  youtube_title:       string;
  youtube_description: string;
  numbers_used:        string[];
}

const KIND_LABEL = { moneyline: 'Moneyline', mixed: 'Mixed markets' } as const;
const STATUS_LABEL = { won: 'WON', lost: 'LOST', void: 'VOID', pending: 'PENDING' } as const;

function cardSeconds(legs: number): number {
  return round1(Math.min(D.cardMax, D.cardBase + D.cardLeg * legs));
}

export function buildParlayPost(
  mode: ParlayMode, date: string, parlays: LoggedParlay[], record: ParlayRecord | null,
  yesterday: LoggedParlay[] | null = null,
): ParlayPost {
  if (parlays.length === 0) throw new Error(`aucun combiné gelé pour ${date}`);
  const day = dayParts(date);
  const rec = recordLine(record);
  const last = mode === 'pick' ? lastNightLine(yesterday) : null;
  const slides: any[] = [];
  let n = 1;

  if (mode === 'pick') {
    slides.push({
      n: n++, template: 'parlay_pick', kind: 'intro', duration: D.intro, text: '',
      intro: {
        title: "Tonight's NHL parlays", weekday: day.weekday, date: day.long,
        line: `${parlays.length} parlay${parlays.length > 1 ? 's' : ''} · arakiceML model`,
        record: rec ? `Record ${rec}` : null,
        last,
      },
    });
  } else {
    const won = parlays.filter((p) => p.status === 'won').length;
    slides.push({
      n: n++, template: 'parlay_result', kind: 'intro', duration: D.intro, text: '',
      intro: {
        title: "Last night's parlays", weekday: day.weekday, date: day.long,
        line: `${won} of ${parlays.length} hit`,
        record: null,
      },
    });
  }

  for (const p of parlays) {
    const legs = p.legs.map((l, i) => slideLeg(l, mode === 'result' ? (p.legResults?.[i] ?? 'unknown') : undefined));
    slides.push({
      n: n++, template: mode === 'pick' ? 'parlay_pick' : 'parlay_result', kind: 'card',
      duration: cardSeconds(legs.length), text: '',
      parlay: {
        title: `Parlay ${p.rank}`,
        kind: KIND_LABEL[p.kind] ?? p.kind,
        legs,
        probability: pct(p.probability),
        ...(mode === 'result' ? { status: STATUS_LABEL[p.status] } : {}),
      },
    });
  }

  if (mode === 'result' && rec) {
    slides.push({
      n: n++, template: 'parlay_result', kind: 'record', duration: D.record, text: '',
      record: {
        pct: `${Math.round(record!.winPct!)}%`,
        line: `${record!.won}-${record!.lost}`,
        since: record!.since ? `since ${dayParts(record!.since).short}` : '',
        note: 'Every published parlay counts, losses included.',
      },
    });
  }

  slides.push({ n: n++, template: mode === 'pick' ? 'parlay_pick' : 'parlay_result', kind: 'cta', duration: D.cta, text: '' });

  const caps = captions(mode, date, parlays, rec, last);
  return {
    candidate_id: `${date}-parlays-${mode}`,
    variant: 'short',
    duration_target: [10, 20],
    subject: mode === 'pick' ? `NHL parlays · ${day.short}` : `Results · ${day.short}`,
    slides,
    ...caps,
    numbers_used: ['probability', 'legs', ...(mode === 'result' ? ['status', 'leg_results', 'record'] : [])],
  };
}

// ─── Légendes ────────────────────────────────────────────────────────────────

const HASHTAGS = ['#NHL', '#hockey', '#NHLPicks', '#Parlay'];

function utm(source: 'youtube' | 'tiktok', date: string): string {
  return `${SITE}/match/${date}?utm_source=${source}&utm_medium=social&utm_campaign=parlays`;
}

const ICON = { win: '✅', loss: '❌', void: '➖', unknown: '⏳' } as const;

function parlayLines(mode: ParlayMode, parlays: LoggedParlay[]): string[] {
  return parlays.map((p) => {
    const legs = p.legs.map((l, i) => (mode === 'result' ? `${ICON[p.legResults?.[i] ?? 'unknown']} ` : '') + l.label);
    const head = mode === 'result'
      ? `Parlay ${p.rank} — ${STATUS_LABEL[p.status]}`
      : `Parlay ${p.rank} (${pct(p.probability)})`;
    return `${head}: ${legs.join(' · ')}`;
  });
}

function captions(mode: ParlayMode, date: string, parlays: LoggedParlay[], rec: string | null, last: string | null = null) {
  const day = dayParts(date);
  const lines = parlayLines(mode, parlays);
  const recordTxt = [last ? `${last}.` : '', rec ? `Record: ${rec}.` : ''].filter(Boolean).join(' ');
  const tags = HASHTAGS.join(' ');

  if (mode === 'pick') {
    const lead = `Tonight's ${parlays.length} free NHL parlays from the arakiceML model, ${day.short}.`;
    return {
      youtube_title: `Tonight's NHL Parlays — ${day.short} #Shorts`,
      youtube_description: [lead, '', ...lines, '', recordTxt,
        `Every leg, matchup and model probability: ${utm('youtube', date)}`, '', DISCLAIMER, '', `#Shorts ${tags}`]
        .filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim(),
      caption_tiktok: [lead, recordTxt, 'Full breakdown at arakice.com', DISCLAIMER].filter(Boolean).join(' '),
      caption_instagram: [lead, '', ...lines, '', 'Full breakdown at arakice.com', DISCLAIMER].join('\n'),
      hashtags: HASHTAGS,
    };
  }
  const won = parlays.filter((p) => p.status === 'won').length;
  const lead = `Last night's NHL parlays (${day.short}): ${won} of ${parlays.length} hit.`;
  return {
    youtube_title: `NHL Parlay Results — ${day.short} #Shorts`,
    youtube_description: [lead, '', ...lines, '', recordTxt, 'Every published parlay stays on the record, losses included.',
      `Tonight's parlays: ${utm('youtube', date)}`, '', DISCLAIMER, '', `#Shorts ${tags}`]
      .filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim(),
    caption_tiktok: [lead, recordTxt, "Tonight's parlays at arakice.com", DISCLAIMER].filter(Boolean).join(' '),
    caption_instagram: [lead, '', ...lines, '', recordTxt, "Tonight's parlays at arakice.com", DISCLAIMER].join('\n'),
    hashtags: HASHTAGS,
  };
}

// ─── Garde-fous ──────────────────────────────────────────────────────────────

/** Promesses de gain : interdites partout (et trompeuses). */
const PROMISES = ['guaranteed', 'guarantee', 'lock', 'locks', 'sure thing', 'free money', "can't lose", 'risk-free', 'risk free'];
/** Aucun bookmaker nommé : pas d'accord d'affiliation (MARKETING_PLAN §2). */
const BOOKS = ['draftkings', 'fanduel', 'bet365', 'betmgm', 'betrivers', 'caesars', 'bet99', 'pointsbet', 'espn bet', 'fanatics'];

/**
 * Problèmes bloquants d'un post : liste vide = publiable. Le texte des jambes
 * vient de l'API (noms de joueurs) : il est contrôlé comme le reste.
 */
export function parlayComplianceProblems(post: ParlayPost): string[] {
  const problems: string[] = [];
  const texts: Record<string, string> = {
    caption_tiktok: post.caption_tiktok,
    caption_instagram: post.caption_instagram,
    youtube_title: post.youtube_title,
    youtube_description: post.youtube_description,
    slides: JSON.stringify(post.slides),
  };
  for (const [where, text] of Object.entries(texts)) {
    const low = text.toLowerCase();
    for (const w of [...PROMISES, ...BOOKS]) {
      const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}([^a-z0-9]|$)`);
      if (re.test(low)) problems.push(`${where} : « ${w} »`);
    }
  }
  for (const k of ['caption_tiktok', 'caption_instagram', 'youtube_description'] as const) {
    if (!post[k].includes(DISCLAIMER)) problems.push(`${k} : mention 18+ absente`);
  }
  if (post.youtube_title.length > 100) problems.push('youtube_title : plus de 100 caractères');
  if (post.youtube_description.length > 5000) problems.push('youtube_description : plus de 5 000 caractères');
  if (/https?:\/\/(?!arakice\.com)/i.test(post.youtube_description)) problems.push('youtube_description : lien hors arakice.com');
  return problems;
}
