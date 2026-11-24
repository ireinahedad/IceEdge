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

/**
 * Crédit Uppbeat (plan gratuit) de la piste `content/assets/music/parlays.mp3`.
 * OBLIGATOIRE dans la description YouTube : c'est ce texte, avec le code de
 * licence, qui évite la réclamation Content ID. Changer de piste = changer ce
 * crédit en même temps (2026-11-24 : 'Soft & Beautiful', de 1:44 à la fin).
 */
export const MUSIC_CREDIT = [
  "Music: 'Soft & Beautiful' by Dope Cat on #Uppbeat https://uppbeat.io/c/dope-cat",
  'License code: 4YZOCUUGY6HLR6K1',
].join('\n');
/** Seuls domaines permis dans une description YouTube : le site, et le lien de crédit musical. */
const YT_LINK_OK = /https?:\/\/(?!arakice\.com|uppbeat\.io\/c\/)/i;

/** Durées, en secondes. */
// 2026-11-24 : allongées. À 9-12 s, 48 % des spectateurs balayaient avant
// d'avoir pu lire un combiné (YouTube Studio, 28 jours). Cible 15-20 s.
const D = {
  intro:     3.0,
  cardBase:  2.4,   // en-tête du combiné + probabilité…
  cardLeg:   0.9,   // … plus une jambe, le temps de la lire
  cardMax:   6.0,
  record:    2.6,
  cta:       2.6,
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

/** Le Short « pick » sort à midi (heure de l'Est), ou 2 h avant le 1er match si c'est plus tôt… */
export const YOUTUBE_LEAD_MS = 2 * 3_600_000;

/**
 * Midi à New York le jour (heure de l'Est) de l'instant `t`, en ms UTC.
 * 2026-11-24 : 69 % des vues viennent de la recherche (« nhl picks today »),
 * et on cherche les pronostics du jour avant les matchs, pas à la mise au jeu.
 */
export function noonET(t: number): number {
  const day = new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });   // AAAA-MM-JJ
  let guess = Date.parse(`${day}T17:00:00Z`);   // midi HNE ; corrigé ci-dessous pour l'heure d'été
  const h = Number(new Date(guess).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }));
  guess -= (h - 12) * 3_600_000;
  return guess;
}
/** …si cette heure est encore à au moins 15 min ; sinon il sort tout de suite. */
export const YOUTUBE_MIN_DELAY_MS = 15 * 60_000;

/**
 * Heure de sortie programmée du Short (ISO), ou null = publier tout de suite :
 * midi ET, ou 2 h avant le 1er match si celui-ci est avant 14 h ET.
 * Gel à 14 h à Bali depuis le 2026-10-26 (2 h du matin à New York) : sans
 * programmation, le Short sortirait en pleine nuit nord-américaine.
 */
export function youtubePublishAt(firstStarts: Array<string | null | undefined>, now: number): string | null {
  const times = firstStarts.map((s) => Date.parse(s ?? '')).filter(Number.isFinite);
  if (!times.length) return null;
  const first = Math.min(...times);
  const at = Math.min(first - YOUTUBE_LEAD_MS, noonET(first));
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
  /** Commentaire Reddit (fil quotidien NHL) : texte brut, AUCUN lien (règles des subreddits). */
  text_reddit:         string;
  /** Post X : jambes + lien UTM vers arakice.com. */
  text_x:              string;
  numbers_used:        string[];
}

const KIND_LABEL = { moneyline: 'Moneyline', mixed: 'Mixed markets' } as const;
const STATUS_LABEL = { won: 'WON', lost: 'LOST', void: 'VOID', pending: 'PENDING' } as const;

function cardSeconds(legs: number): number {
  return round1(Math.min(D.cardMax, D.cardBase + D.cardLeg * legs));
}

/** La jambe la plus probable du soir (pour l'accroche), ou null. */
export function topLeg(parlays: LoggedParlay[]): BestBet | null {
  let best: BestBet | null = null;
  for (const p of parlays) for (const l of p.legs) if (Number.isFinite(l.score) && (!best || l.score > best.score)) best = l;
  return best;
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
    // L'ouverture accroche : le pari le plus probable du soir, chiffré. Le
    // bilan (pertes comprises) n'est pas retiré, il passe sur son propre plan
    // juste avant la carte de fin : on reste honnête sans ouvrir dessus.
    const top = topLeg(parlays);
    slides.push({
      n: n++, template: 'parlay_pick', kind: 'intro', duration: D.intro, text: '',
      intro: {
        title: 'NHL picks today', weekday: day.weekday, date: day.long,
        line: top ? `Top pick: ${top.label} · ${pct(top.score)}` : `${parlays.length} parlay${parlays.length > 1 ? 's' : ''} · arakiceML model`,
        record: null,
        last: null,
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

  if (rec) {
    slides.push({
      n: n++, template: mode === 'pick' ? 'parlay_pick' : 'parlay_result', kind: 'record', duration: D.record, text: '',
      record: {
        pct: `${Math.round(record!.winPct!)}%`,
        line: `${record!.won}-${record!.lost}`,
        since: record!.since ? `since ${dayParts(record!.since).short}` : '',
        note: [last ? `${last}.` : '', 'Every published parlay counts, losses included.'].filter(Boolean).join(' '),
      },
    });
  }

  slides.push({ n: n++, template: mode === 'pick' ? 'parlay_pick' : 'parlay_result', kind: 'cta', duration: D.cta, text: '' });

  const caps = captions(mode, date, parlays, rec, last);
  return {
    candidate_id: `${date}-parlays-${mode}`,
    variant: 'short',
    duration_target: [12, 25],
    subject: mode === 'pick' ? `NHL parlays · ${day.short}` : `Results · ${day.short}`,
    slides,
    ...caps,
    numbers_used: ['probability', 'legs', ...(mode === 'result' ? ['status', 'leg_results', 'record'] : [])],
  };
}

// ─── Légendes ────────────────────────────────────────────────────────────────

const HASHTAGS = ['#NHL', '#hockey', '#NHLPicks', '#NHLPredictions', '#Parlay'];

function utm(source: 'youtube' | 'tiktok' | 'x', date: string): string {
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

/** Une jambe pour Reddit : match entre parenthèses (« Over 5.5 » seul ne dit rien) + % du modèle. */
function textLeg(l: BestBet, mode: ParlayMode, result?: keyof typeof ICON): string {
  const g = l.game;
  const where = g ? ` (${g.away} @ ${g.home})` : '';
  const icon = mode === 'result' ? `${ICON[result ?? 'unknown']} ` : '';
  return `- ${icon}${l.label}${where} — ${pct(l.score)}`;
}

const METHOD = 'How the % are made: an XGBoost model predicts each team\'s expected goals, which gives a full '
  + 'score distribution; every market is read from that one distribution. Trained on every NHL regular-season '
  + 'game since 2008. These are probabilities, nothing more.';

function redditText(mode: ParlayMode, date: string, parlays: LoggedParlay[], recordTxt: string): string {
  const day = dayParts(date);
  const blocks = parlays.map((p) => [
    mode === 'result' ? `**Parlay ${p.rank} — ${STATUS_LABEL[p.status]}**` : `**Parlay ${p.rank} — model ${pct(p.probability)}**`,
    ...p.legs.map((l, i) => textLeg(l, mode, p.legResults?.[i])),
  ].join('\n'));
  const head = mode === 'pick'
    ? `arakiceML (NHL score model), ${day.weekday} ${day.short}: the model's ${parlays.length} highest-probability parlays tonight.`
    : `arakiceML (NHL score model), results for ${day.weekday} ${day.short}.`;
  return [head, ...blocks,
    [recordTxt, 'Every posted parlay stays on the record, losses included.'].filter(Boolean).join(' '),
    ...(mode === 'pick' ? [METHOD] : []),
    DISCLAIMER].join('\n\n');
}

function captions(mode: ParlayMode, date: string, parlays: LoggedParlay[], rec: string | null, last: string | null = null) {
  const day = dayParts(date);
  const lines = parlayLines(mode, parlays);
  const recordTxt = [last ? `${last}.` : '', rec ? `Record: ${rec}.` : ''].filter(Boolean).join(' ');
  const tags = HASHTAGS.join(' ');

  if (mode === 'pick') {
    const lead = `Tonight's ${parlays.length} free NHL parlays from the arakiceML model, ${day.short}.`;
    // Titre et 1re ligne calqués sur ce que les gens tapent (YouTube Studio,
    // 2026-11-24) : « nhl picks today » 20 %, « pronostico nhl hoy » 5 %,
    // « nhl predictions today » 3 %. Le titre ne disait que « Parlays ».
    const ytLead = `NHL picks today, ${day.weekday} ${day.short}: the arakiceML model's ${parlays.length} best parlay${parlays.length > 1 ? 's' : ''} and predictions.`;
    const ytEs = `Pronóstico NHL hoy (${day.short}): ${parlays.length} parlay${parlays.length > 1 ? 's' : ''} del modelo arakiceML.`;
    return {
      youtube_title: `NHL Picks Today (${day.short}): Best Parlay${parlays.length > 1 ? 's' : ''} and Predictions #Shorts`,
      youtube_description: [ytLead, ytEs, '', ...lines, '', recordTxt,
        `Every leg, matchup and model probability: ${utm('youtube', date)}`, '', DISCLAIMER, '', MUSIC_CREDIT, '', `#Shorts ${tags}`]
        .filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim(),
      caption_tiktok: [lead, recordTxt, 'Full breakdown at arakice.com', DISCLAIMER].filter(Boolean).join(' '),
      caption_instagram: [lead, '', ...lines, '', 'Full breakdown at arakice.com', DISCLAIMER].join('\n'),
      text_reddit: redditText(mode, date, parlays, recordTxt),
      text_x: [lead, lines.join('\n'), recordTxt, utm('x', date), '#NHL #NHLPicks', DISCLAIMER].filter(Boolean).join('\n\n'),
      hashtags: HASHTAGS,
    };
  }
  const won = parlays.filter((p) => p.status === 'won').length;
  const lead = `Last night's NHL parlays (${day.short}): ${won} of ${parlays.length} hit.`;
  return {
    youtube_title: `NHL Parlay Results — ${day.short} #Shorts`,
    youtube_description: [lead, '', ...lines, '', recordTxt, 'Every published parlay stays on the record, losses included.',
      `Tonight's parlays: ${utm('youtube', date)}`, '', DISCLAIMER, '', MUSIC_CREDIT, '', `#Shorts ${tags}`]
      .filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n').trim(),
    caption_tiktok: [lead, recordTxt, "Tonight's parlays at arakice.com", DISCLAIMER].filter(Boolean).join(' '),
    caption_instagram: [lead, '', ...lines, '', recordTxt, "Tonight's parlays at arakice.com", DISCLAIMER].join('\n'),
    text_reddit: redditText(mode, date, parlays, recordTxt),
    text_x: [lead, lines.join('\n'), recordTxt, utm('x', date), '#NHL #NHLPicks', DISCLAIMER].filter(Boolean).join('\n\n'),
    hashtags: HASHTAGS,
  };
}

// ─── Garde-fous ──────────────────────────────────────────────────────────────

/** Promesses de gain : interdites partout (et trompeuses). */
export const PROMISES = ['guaranteed', 'guarantee', 'lock', 'locks', 'sure thing', 'free money', "can't lose", 'risk-free', 'risk free'];
/** Aucun bookmaker nommé : pas d'accord d'affiliation (MARKETING_PLAN §2). */
export const BOOKS = ['draftkings', 'fanduel', 'bet365', 'betmgm', 'betrivers', 'caesars', 'bet99', 'pointsbet', 'espn bet', 'fanatics'];

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
    text_reddit: post.text_reddit,
    text_x: post.text_x,
    slides: JSON.stringify(post.slides),
  };
  for (const [where, text] of Object.entries(texts)) {
    const low = text.toLowerCase();
    for (const w of [...PROMISES, ...BOOKS]) {
      const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}([^a-z0-9]|$)`);
      if (re.test(low)) problems.push(`${where} : « ${w} »`);
    }
  }
  for (const k of ['caption_tiktok', 'caption_instagram', 'youtube_description', 'text_reddit', 'text_x'] as const) {
    if (!post[k].includes(DISCLAIMER)) problems.push(`${k} : mention 18+ absente`);
  }
  if (post.youtube_title.length > 100) problems.push('youtube_title : plus de 100 caractères');
  if (post.youtube_description.length > 5000) problems.push('youtube_description : plus de 5 000 caractères');
  if (YT_LINK_OK.test(post.youtube_description)) problems.push('youtube_description : lien hors arakice.com');
  if (!post.youtube_description.includes(MUSIC_CREDIT)) problems.push('youtube_description : crédit musical Uppbeat absent');
  if (/https?:\/\/(?!arakice\.com)/i.test(post.text_x)) problems.push('text_x : lien hors arakice.com');
  if (/https?:\/\/|arakice\.com/i.test(post.text_reddit)) problems.push('text_reddit : lien interdit (règles Reddit)');
  return problems;
}
