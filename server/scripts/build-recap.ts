/**
 * build-recap.ts — le récap d'après-match
 * ========================================
 * Matchs terminés  →  content/output/<date>-recap/posts.json (+ candidates.json)
 *
 * Usage :
 *   npm run content:recap                      la nuit qui vient de finir
 *   npm run content:recap -- --date=2026-11-04 forcer la date de la soirée
 *   npm run content:recap -- --game=MTL        cadrer sur un match précis
 *   npm run content:recap -- --game=all        un court + un long PAR match
 *   npm run content:recap -- --no-night        seulement le match, pas la soirée
 *   npm run content:recap -- --require-all     refuser de sortir si un match traîne
 *
 * Puis, sans rien coller nulle part :
 *   npm run content:render -- --date=<date>-recap
 *   npm run content:video  -- --date=<date>-recap
 *
 * ---------------------------------------------------------------------------
 * POURQUOI IL N'Y A PAS DE LLM ICI, ET POURQUOI C'EST DIFFÉRENT DU PIPELINE
 * QUOTIDIEN. mine-stories choisit un angle parmi 600 lignes, et un humain (ou un
 * modèle) doit ensuite écrire une phrase qui vaut la peine d'être lue. Un récap
 * n'a rien à choisir ni à interpréter : le score est le score, les étoiles sont
 * celles que la LNH a désignées, la feuille de match est publique. Tout ce qu'un
 * modèle pourrait ajouter ici est soit une redite, soit une invention. Le script
 * écrit donc posts.json de bout en bout — une commande, aucun copier-coller,
 * aucun chiffre qui ne vienne pas de l'API.
 *
 * Conséquence directe : `content:check` NE S'APPLIQUE PAS aux récaps. Ce
 * garde-fou existe pour rattraper un rédacteur — identifiants de hooks, budgets
 * de mots, chiffres non tracés. Ici il n'y a pas de rédacteur. La seule de ses
 * vérifications qui garde un sens est le vocabulaire interdit, et elle est
 * rejouée en fin de script sur la liste partagée `lib/compliance.ts` : une
 * occurrence bloque la sortie, exactement comme dans check-posts.
 *
 * DOSSIER SÉPARÉ, `<date>-recap`. Le récap et les posts du jour vivent le même
 * jour. Écrire dans `content/output/<date>/` écraserait le posts.json du
 * pipeline quotidien un soir sur deux. Le suffixe fait de la date une simple
 * clé de dossier, ce que render-slides et build-video traitent déjà comme telle :
 * les deux étapes suivantes fonctionnent sans une ligne de modification.
 * ---------------------------------------------------------------------------
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fetchGamesByDate, fetchGameDetail } from '../src/services/nhlApiClient';
import { BANNED, findBanned } from './lib/compliance';

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const OUTPUT_ROOT = path.join(REPO_ROOT, 'content', 'output');
const LOGO_DIR    = path.join(REPO_ROOT, 'content', 'assets', 'logos');
const HASHTAGS    = path.join(REPO_ROOT, 'content', 'library', 'hashtags.md');

// ===========================================================================
// Rythme
// ===========================================================================

/**
 * Durées, en secondes. Elles ne se déduisent pas d'un nombre de mots comme dans
 * check-posts : un plan de récap se PARCOURT (six scores, neuf buts), il ne se
 * lit pas d'un bloc. Le temps se compte donc par LIGNE, pas par mot.
 *
 * Les valeurs par ligne viennent d'un test simple : lire une ligne de tableau
 * de scores et retenir le résultat prend une seconde et demie ; une ligne de
 * but, un peu plus court, une seconde.
 */
const D = {
  hook:       2.0,   // identique au pipeline quotidien : une amorce, pas une lecture
  score:      5.0,   // le score final, format long
  scoreNight: 3.5,   // le même plan dans l'enchaînement de la nuit
  boardRow:   1.4,
  boardBase:  1.6,
  goalRow:    1.2,
  goalBase:   2.0,
  stats:      7.0,
  stars3:     5.5,
  star1:      3.5,
  cta:        2.5,
};

/**
 * Plafonds de lignes par plan. Ce ne sont pas des préférences : au-delà, le bloc
 * dépasse la hauteur utile (1345 px entre les deux zones de sécurité) et
 * Playwright coupe le bas de l'image sans rien signaler. Voir _shared.css.
 */
const BOARD_ROWS_MAX = 6;
const GOAL_ROWS_MAX  = 9;

const round1 = (n: number) => Math.round(n * 10) / 10;

// ===========================================================================
// Arguments et date
// ===========================================================================

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

/**
 * La soirée qui vient de se terminer, sans bibliothèque de fuseaux.
 *
 * Les matchs d'une date D de calendrier LNH courent de D 23 h UTC à D+1 6 h UTC.
 * Reculer de 30 heures tombe donc toujours dans la bonne journée, quelle que
 * soit l'heure d'exécution : juste après le dernier match (D+1 6 h 30 → D),
 * l'après-midi suivant (D+1 20 h → D), et même pendant la soirée d'après
 * (D+2 2 h → D, ce qui est correct : la soirée en cours n'est pas finie).
 *
 * Utile ici parce que la machine qui lance le script est à UTC+8 : la nuit de
 * hockey s'y termine en fin de matinée, jamais le soir.
 */
function defaultDate(): string {
  return new Date(Date.now() - 30 * 3_600_000).toISOString().slice(0, 10);
}

// ===========================================================================
// Petites formes
// ===========================================================================

const lastName = (full: string): string => {
  const s = String(full ?? '').trim();
  const i = s.indexOf(' ');
  return i === -1 ? s : s.slice(i + 1);
};

const periodLabel = (label: string): string =>
  label === 'OT' || label === 'SO' ? label
    : label === '1' ? '1ST' : label === '2' ? '2ND' : label === '3' ? '3RD' : `${label}TH`;

/** `.939` — la forme lue sur toutes les feuilles de match. */
function savePct(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  return n.toFixed(3).replace(/^0/, '');
}

/** « 2G 1A », et « 1G » quand il n'y a rien d'autre. */
function statLine(goals: number, assists: number): string {
  const parts: string[] = [];
  if (goals) parts.push(`${goals}G`);
  if (assists) parts.push(`${assists}A`);
  return parts.length ? parts.join(' ') : '0 PTS';
}

// ===========================================================================
// Logos
// ===========================================================================

/**
 * Télécharge une fois pour toutes les logos utiles dans content/assets/logos/.
 *
 * Ils sont pris à la source officielle en version « light » — le blanc et les
 * couleurs claires, seuls lisibles sur le fond sombre des cartes. Le
 * téléchargement est fait ICI et pas au rendu : render-slides doit pouvoir
 * tourner sans réseau, comme aujourd'hui.
 *
 * Un logo manquant n'arrête rien : la carte tombe sur l'abréviation seule.
 */
async function ensureLogos(abbrs: string[]): Promise<void> {
  await fs.mkdir(LOGO_DIR, { recursive: true });
  const missing: string[] = [];
  for (const abbr of [...new Set(abbrs)].filter(Boolean)) {
    const file = path.join(LOGO_DIR, `${abbr}.svg`);
    try { await fs.access(file); } catch { missing.push(abbr); }
  }
  if (!missing.length) return;

  for (const abbr of missing) {
    const url = `https://assets.nhle.com/logos/nhl/svg/${abbr}_light.svg`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const svg = await res.text();
      if (!svg.includes('<svg')) throw new Error('réponse non SVG');
      await fs.writeFile(path.join(LOGO_DIR, `${abbr}.svg`), svg, 'utf8');
      console.log(`    logo ${abbr} téléchargé`);
    } catch (e: any) {
      console.log(`    ⚠ logo ${abbr} indisponible (${e.message}) — abréviation seule`);
    }
  }
}

// ===========================================================================
// Hashtags — lus dans la bibliothèque, jamais improvisés
// ===========================================================================

/**
 * Parse le tableau « 2. Équipes » de hashtags.md, comme check-posts parse
 * hooks.md. Dupliquer ces formes en JSON garantirait qu'elles divergent au
 * troisième mois ; la bibliothèque markdown reste la seule source.
 */
async function loadTeamTags(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const text = await fs.readFile(HASHTAGS, 'utf8');
    for (const line of text.split('\n')) {
      const m = /^\|\s*([A-Z]{3})\s*\|\s*`(#[a-z0-9]+)`/.exec(line.trim());
      if (m) out.set(m[1], m[2]);
    }
  } catch { /* la bibliothèque manque : on sort sans hashtag d'équipe */ }
  return out;
}

// ===========================================================================
// Lecture des matchs
// ===========================================================================

interface Team { abbr: string; nick: string; full: string; score: number; win: boolean; }

interface Game {
  id: string;
  away: Team;
  home: Team;
  winner: Team;
  loser: Team;
  ending: string;          // FINAL · FINAL / OT · FINAL / SO
  endingTag: string;       // '' · OT · SO
  detail: any;
  totalGoals: number;
  margin: number;
}

function toTeam(side: any, nick: string, other: any): Team {
  return {
    abbr: String(side?.abbr ?? ''),
    nick: nick || String(side?.abbr ?? ''),
    full: String(side?.name ?? side?.abbr ?? ''),
    score: Number(side?.score ?? 0),
    win: Number(side?.score ?? 0) > Number(other?.score ?? 0),
  };
}

async function loadGames(dateKey: string, requireAll: boolean): Promise<Game[]> {
  const schedule = await fetchGamesByDate(dateKey);
  if (!schedule.length) throw new Error(`aucun match au calendrier le ${dateKey}`);

  const pending = schedule.filter((g: any) => g.status !== 'final');
  if (pending.length) {
    const list = pending.map((g: any) => `${g.awayTeam.abbreviation}@${g.homeTeam.abbreviation}`).join(', ');
    if (requireAll) {
      throw new Error(`${pending.length} match(s) non terminé(s) : ${list}\n  Relancer plus tard, ou sans --require-all.`);
    }
    console.log(`  ⚠ ${pending.length} match(s) non terminé(s), écarté(s) : ${list}`);
  }

  const finals = schedule.filter((g: any) => g.status === 'final');
  if (!finals.length) throw new Error(`aucun match TERMINÉ le ${dateKey}`);

  const games: Game[] = [];
  for (const s of finals) {
    const detail = await fetchGameDetail(String(s.id));
    // Les noms courts (« Canadiens ») viennent du calendrier, le détail ne
    // renvoie que le nom complet. Les deux servent : le court dans les phrases,
    // le complet sur la carte de score.
    const away = toTeam(detail.away, s.awayTeam?.name, detail.home);
    const home = toTeam(detail.home, s.homeTeam?.name, detail.away);
    const [winner, loser] = away.win ? [away, home] : [home, away];
    const last = String(detail.lastPeriodType ?? 'REG');
    games.push({
      id: String(s.id),
      away, home, winner, loser, detail,
      ending: last === 'SO' ? 'FINAL / SO' : last === 'OT' ? 'FINAL / OT' : 'FINAL',
      endingTag: last === 'SO' ? 'SO' : last === 'OT' ? 'OT' : '',
      totalGoals: away.score + home.score,
      margin: Math.abs(away.score - home.score),
    });
  }
  // Ordre de la soirée : l'heure de début, pas l'identifiant.
  games.sort((a, b) => String(a.detail.startTimeUTC ?? '').localeCompare(String(b.detail.startTimeUTC ?? '')));
  return games;
}

// ===========================================================================
// Choix du match mis en avant
// ===========================================================================

/**
 * Le match de la nuit, choisi par barème et non « au feeling ».
 *
 * Même principe que mine-stories : la règle est ennuyeuse, mais elle donne deux
 * fois le même résultat sur la même soirée et se corrige en changeant un
 * chiffre. Un match nul jusqu'au bout vaut mieux qu'un 6-1, et une remontée
 * vaut mieux qu'un match mené de bout en bout.
 */
function gameScore(g: Game): number {
  let s = 0;
  if (g.endingTag === 'SO') s += 3;
  if (g.endingTag === 'OT') s += 4;
  if (g.margin <= 1) s += 2;
  if (g.totalGoals >= 7) s += 2;
  if (g.loser.score === 0) s += 1;
  if (comebackSize(g) >= 2) s += 3;
  return s;
}

/** Le plus grand retard comblé par le vainqueur, en buts. */
function comebackSize(g: Game): number {
  let worst = 0;
  for (const goal of g.detail.scoring ?? []) {
    const winnerIsHome = g.winner.abbr === g.home.abbr;
    const winnerScore = winnerIsHome ? Number(goal.homeScore ?? 0) : Number(goal.awayScore ?? 0);
    const otherScore  = winnerIsHome ? Number(goal.awayScore ?? 0) : Number(goal.homeScore ?? 0);
    worst = Math.max(worst, otherScore - winnerScore);
  }
  return worst;
}

function featured(games: Game[]): Game {
  return [...games].sort((a, b) =>
    gameScore(b) - gameScore(a) || b.totalGoals - a.totalGoals || a.id.localeCompare(b.id))[0];
}

// ===========================================================================
// Étoiles
// ===========================================================================

interface Star { rank: number; name: string; abbr: string; line: string; meta: string; weight: number; }

/**
 * Les trois étoiles d'un match sont celles de la LNH, telles quelles.
 *
 * Pour la NUIT, il faut en revanche classer entre elles des étoiles de matchs
 * différents, ce que la ligue ne fait pas. Le barème ci-dessous est volontairement
 * primaire : trois points par but, deux par passe pour un patineur ; pour un
 * gardien, un point par tranche de douze arrêts plus un bonus de blanchissage,
 * ce qui place un blanchissage à 35 arrêts au niveau d'un tour du chapeau.
 * Il est faux dans les cas limites — mais il est stable, et lisible dans le
 * fichier plutôt que dans une intuition.
 */
function starsOf(g: Game): Star[] {
  const goalieByName = new Map<string, any>();
  for (const side of ['home', 'away'] as const) {
    for (const gk of g.detail.players?.[side]?.goalies ?? []) goalieByName.set(String(gk.name), gk);
  }
  return (g.detail.threeStars ?? []).map((s: any) => {
    const gk = s.position === 'G' ? goalieByName.get(String(s.name)) : null;
    const line = gk
      ? `${gk.saves} SV${savePct(gk.savePct) ? ` · ${savePct(gk.savePct)}` : ''}`
      : statLine(Number(s.goals ?? 0), Number(s.assists ?? 0));
    const weight = gk
      ? gk.saves / 12 + (Number(gk.goalsAgainst ?? 1) === 0 ? 3 : 0)
      : 3 * Number(s.goals ?? 0) + 2 * Number(s.assists ?? 0);
    return {
      rank: Number(s.star ?? 0),
      name: String(s.name ?? ''),
      abbr: String(s.teamAbbr ?? ''),
      line,
      meta: `${s.position ?? ''} · ${s.teamAbbr ?? ''}`.replace(/^ · /, ''),
      weight,
    };
  }).filter((s: Star) => s.name);
}

function nightStars(games: Game[], count: number): Star[] {
  const all = games.flatMap((g) => starsOf(g));
  return all
    .sort((a, b) => b.weight - a.weight || a.rank - b.rank || a.name.localeCompare(b.name))
    .slice(0, count)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

// ===========================================================================
// Fabrication des plans
// ===========================================================================

/**
 * Découpe ÉQUILIBRÉE, et pas par paquets pleins.
 *
 * Sept matchs découpés à six donnent 6 + 1 : une carte pleine, puis une carte
 * d'une seule ligne qui reste presque aussi longtemps à l'écran. 4 + 3 se
 * regarde. Le plafond reste un plafond — il n'est jamais dépassé, seulement
 * réparti.
 */
const chunk = <T>(list: T[], max: number): T[][] => {
  const parts = Math.max(1, Math.ceil(list.length / max));
  const size = Math.ceil(list.length / parts);
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

function sideOf(t: Team) {
  return { abbr: t.abbr, nick: t.nick, full: t.full, score: t.score, win: t.win };
}

function scoreSlide(g: Game, n: number, seconds: number, text: string) {
  return {
    n,
    template: 'score_card',
    duration: seconds,
    text,
    game: {
      away: sideOf(g.away),
      home: sideOf(g.home),
      ending: g.ending,
      periods: (g.detail.periods ?? []).map((p: any) => ({
        label: String(p.label), away: Number(p.away ?? 0), home: Number(p.home ?? 0),
      })),
    },
  };
}

/** Le meneur du match, en une ligne : le premier patineur puis le gardien vainqueur. */
function heroLine(g: Game): string {
  const stars = starsOf(g);
  const first = stars[0];
  const gk = (['home', 'away'] as const)
    .flatMap((s) => g.detail.players?.[s]?.goalies ?? [])
    .find((k: any) => k.decision === 'W');
  const bits: string[] = [];
  if (first) bits.push(`${first.name} ${first.line}`);
  if (gk && (!first || lastName(first.name) !== lastName(gk.name))) {
    bits.push(`${gk.name} ${gk.saves} SV`);
  }
  return bits.join(' · ');
}

function starsSlide(stars: Star[], n: number, seconds: number, title = '') {
  return {
    n,
    template: 'stars_card',
    duration: seconds,
    text: '',
    // Au-DESSUS du bloc, pas en dessous : « Three stars » lu après les trois
    // noms n'apprend plus rien, lu avant il dit comment lire ce qui suit.
    title,
    stars: stars.map((s) => ({ rank: s.rank, name: s.name, abbr: s.abbr, line: s.line, meta: s.meta })),
  };
}

function summarySlides(g: Game, from: number): any[] {
  const goals = (g.detail.scoring ?? []).map((x: any) => ({
    when: `${periodLabel(String(x.period))} ${x.time}`,
    abbr: String(x.teamAbbr ?? ''),
    scorer: String(x.scorer ?? ''),
    assists: (x.assists ?? []).map(lastName).join(', '),
    strength: x.strength === 'pp' ? 'PP' : x.strength === 'sh' ? 'SH' : '',
    run: `${x.awayScore ?? ''}-${x.homeScore ?? ''}`,
  })).filter((x: any) => x.scorer);

  // Une fusillade n'a pas de feuille de buts lisible : le seul but compté est
  // celui du tableau d'affichage, et il n'appartient à personne en particulier.
  const listed = goals.filter((x: any) => !x.when.startsWith('SO'));
  if (!listed.length) return [];

  return chunk(listed, GOAL_ROWS_MAX).map((rows, i) => ({
    n: from + i,
    template: 'summary_card',
    duration: round1(D.goalBase + D.goalRow * rows.length),
    text: '',
    goals: rows,
  }));
}

function statsSlide(g: Game, n: number): any | null {
  const ts = g.detail.teamStats;
  if (!ts) return null;
  const row = (label: string, key: string) => ({
    label, away: Number(ts.away?.[key] ?? 0), home: Number(ts.home?.[key] ?? 0),
  });
  const goalies = (['away', 'home'] as const).flatMap((side) =>
    (g.detail.players?.[side]?.goalies ?? [])
      .filter((k: any) => Number(k.shotsAgainst ?? 0) > 0)
      .map((k: any) => ({
        abbr: side === 'away' ? g.away.abbr : g.home.abbr,
        name: k.name,
        decision: k.decision ?? '',
        line: `${k.saves}/${k.shotsAgainst}${savePct(k.savePct) ? ` · ${savePct(k.savePct)}` : ''}`,
      })));

  return {
    n,
    template: 'teamstats_card',
    duration: D.stats,
    text: '',
    stats: {
      away: { abbr: g.away.abbr },
      home: { abbr: g.home.abbr },
      rows: [
        row('Shots', 'sog'),
        row('Hits', 'hits'),
        row('Blocks', 'blockedShots'),
        row('Power-play goals', 'ppGoals'),
        row('Penalty minutes', 'pim'),
      ],
      goalies,
    },
  };
}

const ctaSlide = (n: number) => ({ n, template: 'cta_card', duration: D.cta, text: 'arakice.com' });
const hookSlide = (text: string) => ({ n: 1, template: 'hook_card', duration: D.hook, text });

/** Le hook d'un match : la seule phrase du récap, et elle décrit un fait. */
function gameHook(g: Game): string {
  const w = g.winner.nick;
  if (g.endingTag === 'SO') return `${w} win it in a shootout.`;
  if (g.endingTag === 'OT') return `${w} win it in overtime.`;
  if (comebackSize(g) >= 2) return `${w} came all the way back.`;
  if (g.loser.score === 0) return `${w} shut the door.`;
  if (g.margin >= 4) return `${w} ran away with this one.`;
  if (g.margin === 1) return `${w} hold on by one.`;
  return `${w} take care of business.`;
}

// ===========================================================================
// Les quatre variantes
// ===========================================================================

const monthDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

function nightShort(dateKey: string, games: Game[]) {
  const slides: any[] = [hookSlide(`${games.length} games. Here is how the night ended.`)];
  let n = 2;
  chunk(games, BOARD_ROWS_MAX).forEach((rows, i) => {
    slides.push({
      n: n++,
      template: 'scoreboard_card',
      duration: round1(D.boardBase + D.boardRow * rows.length),
      text: '',
      title: i === 0 ? `${monthDay(dateKey)} · every final` : '',
      games: rows.map((g) => ({ away: sideOf(g.away), home: sideOf(g.home), tag: g.endingTag })),
    });
  });
  slides.push(starsSlide(nightStars(games, 1), n++, D.star1, 'Star of the night'));
  slides.push(ctaSlide(n));
  return slides;
}

function nightLong(dateKey: string, games: Game[]) {
  const slides: any[] = [hookSlide(`${games.length} games. Every final score.`)];
  let n = 2;
  for (const g of games) slides.push(scoreSlide(g, n++, D.scoreNight, heroLine(g)));
  slides.push(starsSlide(nightStars(games, 3), n++, D.stars3, 'Three stars of the night'));
  slides.push(ctaSlide(n));
  return slides;
}

function gameShort(g: Game) {
  const slides: any[] = [hookSlide(gameHook(g))];
  let n = 2;
  slides.push(scoreSlide(g, n++, D.score, heroLine(g)));
  const stars = starsOf(g);
  if (stars.length) slides.push(starsSlide(stars.slice(0, 3), n++, D.stars3, 'Three stars'));
  slides.push(ctaSlide(n));
  return slides;
}

function gameLong(g: Game) {
  const slides: any[] = [hookSlide(gameHook(g))];
  let n = 2;
  slides.push(scoreSlide(g, n++, D.score, heroLine(g)));
  const summary = summarySlides(g, n);
  slides.push(...summary);
  n += summary.length;
  const stats = statsSlide(g, n);
  if (stats) { slides.push(stats); n += 1; }
  const stars = starsOf(g);
  if (stars.length) slides.push(starsSlide(stars.slice(0, 3), n++, D.stars3, 'Three stars'));
  slides.push(ctaSlide(n));
  return slides;
}

// ===========================================================================
// Légendes
// ===========================================================================

const BASE_TAGS = ['#nhl', '#hockey'];
const RECAP_TAGS = ['#nhlrecap', '#nhlscores'];
const NICHE_TAGS = ['#nhlstats', '#hockeystats'];

function nightCaptions(dateKey: string, games: Game[]) {
  const lead = `Every final score from a ${games.length}-game night in the NHL, ${monthDay(dateKey)}.`;
  return {
    caption_tiktok: `${lead} Full team and player numbers at arakice.com`,
    caption_instagram: `${lead}\n\nBox scores, team totals and season numbers at arakice.com`,
    hashtags: [...BASE_TAGS, ...RECAP_TAGS, ...NICHE_TAGS],
  };
}

function gameCaptions(g: Game, teamTags: Map<string, string>) {
  const lead = `${g.ending.replace(' / ', '/')} — ${g.away.nick} ${g.away.score}, ${g.home.nick} ${g.home.score}.`;
  const tags = [g.away.abbr, g.home.abbr].map((a) => teamTags.get(a)).filter(Boolean) as string[];
  return {
    caption_tiktok: `${lead} Full box score at arakice.com`,
    caption_instagram: `${lead}\n\nGoals, team totals and goalie lines at arakice.com`,
    hashtags: [...BASE_TAGS, ...tags, ...RECAP_TAGS.slice(0, 1), ...NICHE_TAGS.slice(0, 1)],
  };
}

// ===========================================================================
// Assemblage
// ===========================================================================

function totalSeconds(slides: any[]): number {
  return round1(slides.reduce((a, s) => a + Number(s.duration || 0), 0));
}

/**
 * Cible de durée déclarée POST PAR POST, et lue par build-video.
 *
 * Le pipeline quotidien vise 8-15 s ; un récap long en dure quarante. Sans cette
 * déclaration, build-video signalerait « hors cible » sur chaque récap, et un
 * avertissement qui se déclenche toujours cesse d'être lu.
 */
const TARGET = {
  night_short: [12, 32] as [number, number],   // douze matchs font deux tableaux
  night_long:  [20, 75] as [number, number],
  game_short:  [10, 20] as [number, number],
  game_long:   [22, 60] as [number, number],
};

async function main() {
  const dateKey = arg('date') ?? defaultDate();
  const gameArg = (arg('game') ?? '').trim();
  const outKey  = `${dateKey}-recap`;
  const dir     = path.join(OUTPUT_ROOT, outKey);

  console.log(`\nbuild-recap — soirée du ${dateKey}\n`);

  const games = await loadGames(dateKey, flag('require-all'));
  console.log(`  ${games.length} match(s) terminé(s)`);

  await ensureLogos(games.flatMap((g) => [g.away.abbr, g.home.abbr]));
  const teamTags = await loadTeamTags();

  // Quels matchs reçoivent leur propre paire de vidéos.
  let picked: Game[];
  if (gameArg.toLowerCase() === 'all') {
    picked = games;
  } else if (gameArg) {
    const key = gameArg.toUpperCase();
    picked = games.filter((g) => g.away.abbr === key || g.home.abbr === key || g.id.includes(gameArg));
    if (!picked.length) {
      throw new Error(
        `aucun match terminé pour --game=${gameArg}\n` +
        `  Disponibles : ${games.map((g) => `${g.away.abbr}@${g.home.abbr}`).join(', ')}`,
      );
    }
    picked = picked.slice(0, 1);
  } else {
    picked = [featured(games)];
  }

  // Une seule affiche dans la soirée : le tableau des scores et le récap du
  // match diraient la même chose, avec une carte de moins pour le second.
  const withNight = games.length > 1 && !flag('no-night');

  const posts: any[] = [];
  const candidates: any[] = [];

  const push = (
    suffix: string, template: string, entity: any, facts: any,
    slides: any[], captions: any, target: [number, number],
  ) => {
    const id = `${outKey}-${suffix}`;
    posts.push({
      candidate_id: id,
      variant: suffix.endsWith('-long') ? 'long' : 'short',
      duration_target: target,
      slides,
      ...captions,
      numbers_used: Object.keys(facts),
    });
    candidates.push({ id, rule: 'recap', family: 'recap', template, entity, facts, chart: { kind: null, file: null } });
  };

  if (withNight) {
    const facts = {
      games: games.length,
      finals: games.map((g) => `${g.away.abbr} ${g.away.score}-${g.home.score} ${g.home.abbr}${g.endingTag ? ` ${g.endingTag}` : ''}`).join(' · '),
      goals: games.reduce((a, g) => a + g.totalGoals, 0),
      overtime: games.filter((g) => g.endingTag).length,
    };
    const entity = { type: 'games', name: `NHL ${dateKey}`, team: null };
    const caps = nightCaptions(dateKey, games);
    push('night-short', 'recap_night', entity, facts, nightShort(dateKey, games), caps, TARGET.night_short);
    push('night-long', 'recap_night', entity, facts, nightLong(dateKey, games), caps, TARGET.night_long);
  }

  for (const g of picked) {
    const slug = `${g.away.abbr}-${g.home.abbr}`.toLowerCase();
    const facts = {
      away: g.away.abbr, home: g.home.abbr,
      away_score: g.away.score, home_score: g.home.score,
      ending: g.ending,
      away_sog: g.detail.teamStats?.away?.sog ?? null,
      home_sog: g.detail.teamStats?.home?.sog ?? null,
      goals: g.totalGoals,
      first_star: starsOf(g)[0]?.name ?? null,
    };
    const entity = { type: 'matchup', name: `${g.away.abbr} VS ${g.home.abbr}`, team: g.winner.abbr };
    const caps = gameCaptions(g, teamTags);
    push(`${slug}-short`, 'recap_game', entity, facts, gameShort(g), caps, TARGET.game_short);
    push(`${slug}-long`, 'recap_game', entity, facts, gameLong(g), caps, TARGET.game_long);
  }

  // --- Le seul contrôle qui reste : le vocabulaire ------------------------
  //
  // Tout le reste de check-posts vise un rédacteur. Celui-ci vise le code : un
  // nom d'équipe, un patronyme ou une tournure ajoutée un jour de fatigue peut
  // faire entrer un mot de la liste. Une occurrence coûte la portée du compte.
  const offenders: string[] = [];
  for (const post of posts) {
    const haystack = [
      ...post.slides.map((s: any) => `${s.text ?? ''}`),
      post.caption_tiktok, post.caption_instagram, post.hashtags.join(' '),
    ].join(' ');
    for (const word of findBanned(haystack)) offenders.push(`${post.candidate_id} : "${word}"`);
  }
  if (offenders.length) {
    throw new Error(
      `vocabulaire interdit (${BANNED.length} mots surveillés) :\n    ` + offenders.join('\n    ') +
      '\n  Reformuler dans build-recap.ts avant de publier.',
    );
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'candidates.json'),
    JSON.stringify({ date: outKey, source: 'build-recap', candidates }, null, 2), 'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'posts.json'),
    JSON.stringify({ date: outKey, retrospective: false, generated_by: 'build-recap', posts }, null, 2), 'utf8',
  );

  console.log('');
  for (const post of posts) {
    console.log(`  ${post.candidate_id.replace(`${outKey}-`, '').padEnd(22)} ${post.slides.length} plans · ${totalSeconds(post.slides)} s`);
  }
  console.log(`\n  Écrit dans content\\output\\${outKey}\\`);
  console.log(`\n  Suite :`);
  console.log(`    npm run content:render -- --date=${outKey}`);
  console.log(`    npm run content:video  -- --date=${outKey}\n`);
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
