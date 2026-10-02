/**
 * build-recap.ts — le récap d'après-match
 * ========================================
 * Matchs terminés  →  content/output/<date>-recap/posts.json (+ candidates.json)
 *
 * Usage :
 *   npm run content:recap                      la nuit qui vient de finir
 *   npm run content:recap -- --date=2026-11-04 forcer la date de la soirée
 *   npm run content:recap -- --game=MTL        cadrer sur un match précis
 *   npm run content:recap -- --game=all        un short PAR match
 *   npm run content:recap -- --no-night        seulement le match, pas la soirée
 *   npm run content:recap -- --require-all     refuser de sortir si un match traîne
 *   npm run content:recap -- --fixture=..\content\fixtures\night-2026-11-04.json
 *                                              soirée inventée, hors saison
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
import {
  fetchGamesByDate as apiGamesByDate,
  fetchGameDetail as apiGameDetail,
} from '../src/services/nhlApiClient';
import { fetchNHL } from '../src/services/nhl/core';
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
  intro:      2.0,   // carte d'ouverture des shorts : jour, date, affiches…
  introRow:   0.15,  // … plus un souffle par affiche quand la soirée est chargée
  introScore: 0.35,  // … ou plus, quand l'affiche porte son score final (night-long)
  matchBase:  1.0,   // carte de match : score, fiches, tirs…
  matchRow:   0.35,  // … plus une ligne de marqueurs, lue d'un coup d'œil…
  matchMax:   3.0,   // … sans jamais dépasser trois secondes par carte
  stars3:     5.5,   // les trois étoiles d'un match
  cta:        2.5,
};

/**
 * Lignes de marqueurs par carte de match. Tous les pointeurs sont listés
 * (points, puis buts, puis nom) ; au-delà de ce nombre, le match se poursuit sur une seconde
 * carte (même en-tête, tableau continué) plutôt que de déborder. La carte a
 * une mise en page FIXE : en-tête toujours à la même hauteur, les lignes
 * s'ajoutent vers le bas. Le plafond est ce qui tient avant la zone de sécurité
 * du bas — voir matchBlock dans render-slides.ts et _shared.css.
 */
const MATCH_ROWS_PER_CARD = 11;

const round1 = (n: number) => Math.round(n * 10) / 10;

// ===========================================================================
// Arguments et date
// ===========================================================================

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`);

// ===========================================================================
// Soirée inventée — `--fixture`
// ===========================================================================

/**
 * Hors saison, l'API ne renvoie aucun match : de mai à octobre, le pipeline
 * entier devient intestable. Le seul moment de l'année où l'on a le temps de
 * revoir une carte est précisément celui où il n'y a rien à mettre dedans.
 *
 * `--fixture=<fichier>` substitue un JSON local aux deux appels réseau, ET RIEN
 * D'AUTRE : le choix du match de la nuit, le barème des étoiles, le découpage
 * des plans, les légendes et le contrôle de vocabulaire s'exécutent tels quels.
 * Ce qui sort est un posts.json ordinaire, que render et video traitent sans
 * savoir d'où il vient — c'est tout l'intérêt, sinon l'essai ne prouverait rien
 * du chemin réel.
 *
 * Le drapeau est EXPLICITE et ne se déduit jamais d'un contexte : sans lui, pas
 * une ligne de ce fichier ne change de comportement. La sortie porte la mention
 * `fixture` dans posts.json et un bandeau dans la console, parce qu'un lot
 * inventé ne doit pas pouvoir se confondre avec une vraie soirée au moment de
 * publier.
 */
interface Fixture {
  date?: string;
  schedule: any[];
  details: Record<string, any>;
  /** Fiches APRÈS le match, « 12-5-2 » par abréviation. Facultatif. */
  records?: Record<string, string>;
}

let FIXTURE: Fixture | null = null;

async function fetchGamesByDate(dateKey: string): Promise<any[]> {
  return FIXTURE ? FIXTURE.schedule : apiGamesByDate(dateKey);
}

async function fetchGameDetail(id: string): Promise<any> {
  if (!FIXTURE) return apiGameDetail(id);
  const detail = FIXTURE.details?.[id];
  if (!detail) {
    throw new Error(
      `fixture : aucun détail pour le match ${id}\n` +
      `  Chaque entrée de "schedule" doit avoir sa clé dans "details".`,
    );
  }
  return detail;
}

async function loadFixture(file: string): Promise<Fixture> {
  // Résolu depuis le répertoire courant : les commandes se lancent depuis
  // `server\`, un chemin relatif y est donc ce que l'on tape naturellement.
  const full = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  let raw: string;
  try {
    raw = await fs.readFile(full, 'utf8');
  } catch {
    throw new Error(`fixture introuvable : ${full}`);
  }
  let data: Fixture;
  try {
    data = JSON.parse(raw) as Fixture;
  } catch (e: any) {
    throw new Error(`fixture illisible (${full}) : ${e.message}`);
  }
  if (!Array.isArray(data.schedule) || !data.schedule.length) {
    throw new Error(`fixture sans "schedule" utilisable : ${full}`);
  }
  return data;
}

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

/** « C. Caufield » : l'initiale du prénom, puis le nom — la forme des cartes de match. */
const shortName = (full: string): string => {
  const s = String(full ?? '').trim();
  const i = s.indexOf(' ');
  return i === -1 ? s : `${s[0]}. ${s.slice(i + 1)}`;
};

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

/**
 * Comment le match s'est terminé : REG, OT ou SO.
 *
 * `gameOutcome.lastPeriodType` manque sur certaines feuilles (vu en
 * préparatoire : une victoire de Boston en fusillade sortait « FINAL »). On
 * recoupe donc, dans l'ordre : le champ officiel, le type de la dernière
 * période, les colonnes de périodes, puis le numéro de la dernière période
 * (4 = prolongation, 5 et plus = fusillade hors séries).
 */
function lastPeriodOf(detail: any): string {
  // Un champ présent (« REG » compris) fait foi ; seul un champ absent passe
  // la main au suivant.
  const norm = (v: unknown) => {
    const t = String(v ?? '').toUpperCase();
    return t === 'SO' || t === 'OT' || t === 'REG' ? t : '';
  };
  const official = norm(detail.lastPeriodType);
  if (official) return official;
  const current = norm(detail.periodType);
  if (current) return current;
  const labels = (detail.periods ?? []).map((p: any) => String(p.label));
  if (labels.includes('SO') || (detail.scoring ?? []).some((x: any) => String(x.period) === 'SO')) return 'SO';
  const num = Number(detail.period ?? 0);
  const playoff = detail.gameType === 'playoff';
  if (!playoff && num >= 5) return 'SO';
  if (labels.includes('OT') || num >= 4) return 'OT';
  return 'REG';
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
    const last = lastPeriodOf(detail);
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

interface Star { rank: number; name: string; abbr: string; line: string; meta: string; }

/**
 * Les trois étoiles d'un match sont celles de la LNH, telles quelles.
 *
 * Elles ont leur plan dans <match>-short (stars_card, « Three stars »), pas
 * dans night-long.
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
    return {
      rank: Number(s.star ?? 0),
      name: String(s.name ?? ''),
      abbr: String(s.teamAbbr ?? ''),
      line,
      meta: `${s.position ?? ''} · ${s.teamAbbr ?? ''}`.replace(/^ · /, ''),
    };
  }).filter((s: Star) => s.name);
}

// ===========================================================================
// Fabrication des plans
// ===========================================================================

/**
 * Découpe en remplissant la PREMIÈRE carte au maximum.
 *
 * La première carte prend autant de lignes que le plafond permet, le reste
 * passe sur la suivante, même si les deux cartes n'ont pas le même nombre de
 * lignes (13 lignes à 11 → 11 + 2). Le plafond n'est jamais dépassé.
 */
const chunk = <T>(list: T[], max: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += max) out.push(list.slice(i, i + max));
  return out.length ? out : [[]];
};

function sideOf(t: Team) {
  return { abbr: t.abbr, nick: t.nick, full: t.full, score: t.score, win: t.win };
}

/**
 * Carte de match — gabarit `matchcard_card`, UN match par carte, partout où un
 * score est montré (night-long, <match>-short).
 *
 * Deux moitiés en miroir, une par équipe : logo, fiche de la saison
 * (V-D-DP), score, tirs, puis les marqueurs avec buts / passes / points. Les points sont comptés
 * depuis la feuille de buts elle-même (`scoring`), pas depuis la liste des
 * patineurs : c'est la seule source présente à la fois dans l'API et dans les
 * fixtures, et elle ne peut pas contredire le score affiché au-dessus. Les buts
 * de fusillade n'y entrent pas — ils ne comptent pour personne.
 */
interface Pointer { name: string; g: number; a: number; p: number; }

function pointersOf(g: Game): { away: Pointer[]; home: Pointer[] } {
  const bySide = { away: new Map<string, Pointer>(), home: new Map<string, Pointer>() };
  const bump = (side: 'away' | 'home', full: string, key: 'g' | 'a') => {
    const name = String(full ?? '').trim();
    if (!name) return;
    const row = bySide[side].get(name) ?? { name, g: 0, a: 0, p: 0 };
    row[key] += 1;
    row.p += 1;
    bySide[side].set(name, row);
  };
  for (const x of g.detail.scoring ?? []) {
    if (String(x.period) === 'SO') continue;
    const side = String(x.teamAbbr ?? '') === g.home.abbr ? 'home' : 'away';
    bump(side, x.scorer, 'g');
    for (const a of x.assists ?? []) bump(side, a, 'a');
  }
  const sorted = (m: Map<string, Pointer>) => [...m.values()]
    .sort((a, b) => b.p - a.p || b.g - a.g || lastName(a.name).localeCompare(lastName(b.name)));
  return { away: sorted(bySide.away), home: sorted(bySide.home) };
}

/**
 * Les cartes d'un match : une seule le plus souvent, deux (ou plus) qui se
 * suivent quand les marqueurs dépassent MATCH_ROWS_PER_CARD. La première carte
 * est remplie au maximum, le reste va sur la suivante (13 lignes → 11 + 2), et
 * le découpage coupe les deux colonnes au même rang, pour que la seconde carte
 * se lise comme la suite exacte de la première.
 */
function matchSlides(g: Game, from: number, records: Map<string, string | null>) {
  const pts = pointersOf(g);
  const rows = Math.max(pts.away.length, pts.home.length);
  const sog = (side: 'away' | 'home') => {
    const v = g.detail.teamStats?.[side]?.sog ?? g.detail[side]?.sog;
    return v === null || v === undefined ? null : Number(v);
  };
  const ranges = rows
    ? chunk([...Array(rows).keys()], MATCH_ROWS_PER_CARD).map((ix) => [ix[0], ix[ix.length - 1] + 1])
    : [[0, 0]];
  return ranges.map(([lo, hi], i) => {
    const half = (t: Team, side: 'away' | 'home') => ({
      ...sideOf(t),
      record: records.get(t.abbr) ?? null,
      sog: sog(side),
      players: pts[side].slice(lo, hi).map((p) => ({ name: shortName(p.name), g: p.g, a: p.a, p: p.p })),
    });
    return {
      n: from + i,
      template: 'matchcard_card',
      duration: round1(Math.min(D.matchMax, D.matchBase + D.matchRow * (hi - lo))),
      text: '',
      match: {
        ending: g.ending,
        part: ranges.length > 1 ? `${i + 1}/${ranges.length}` : '',
        away: half(g.away, 'away'),
        home: half(g.home, 'home'),
      },
    };
  });
}

// ===========================================================================
// Fiches de la saison (V-D-DP)
// ===========================================================================

/**
 * La fiche d'une équipe APRÈS le match affiché, calculée et non lue.
 *
 * `standings/<date>` donnerait un chiffre, mais sans garantie qu'il inclue déjà
 * les matchs de la soirée. On recompte donc depuis le calendrier du club
 * (`club-schedule-season`, le même que teamSeasons.ts) : les matchs du même
 * type joués AVANT la date, puis le match du soir d'après notre propre feuille,
 * qui ne peut pas contredire le score de la carte.
 *
 * Toujours TROIS chiffres, V-D-DP, zéros compris : une défaite en prolongation
 * OU en fusillade compte en DP, quel que soit le type de match (préparatoire,
 * saison, séries). Seuls les matchs du même type que celui affiché comptent.
 *
 * Un échec réseau ne bloque rien : la carte s'affiche sans fiche.
 */
const scheduleCache = new Map<string, Promise<any[]>>();

function clubSchedule(abbr: string, season: string): Promise<any[]> {
  const key = `${abbr}:${season}`;
  let hit = scheduleCache.get(key);
  if (!hit) {
    hit = fetchNHL<any>(`v1/club-schedule-season/${abbr}/${season}`).then((d) => d?.games ?? []);
    scheduleCache.set(key, hit);
  }
  return hit;
}

async function teamRecord(t: Team, g: Game, dateKey: string): Promise<string | null> {
  if (FIXTURE) return FIXTURE.records?.[t.abbr] ?? null;
  const id = g.id;
  if (!/^\d{10}$/.test(id)) return null;
  const season = `${id.slice(0, 4)}${Number(id.slice(0, 4)) + 1}`;
  const type = Number(id.slice(4, 6));
  const games = await clubSchedule(t.abbr, season);
  let w = 0, l = 0, otl = 0;
  for (const x of games) {
    if (Number(x.gameType) !== type) continue;
    if (String(x.id) === id || !(String(x.gameDate ?? '') < dateKey)) continue;
    const hs = x.homeTeam?.score, as = x.awayTeam?.score;
    if (hs == null || as == null) continue;
    const isHome = x.homeTeam?.abbrev === t.abbr;
    const gf = isHome ? hs : as, ga = isHome ? as : hs;
    // Même précaution que lastPeriodOf : le champ officiel manque parfois.
    const last = x.gameOutcome?.lastPeriodType ?? x.periodDescriptor?.periodType
      ?? (Number(x.periodDescriptor?.number ?? 0) >= 5 ? 'SO' : Number(x.periodDescriptor?.number ?? 0) === 4 ? 'OT' : 'REG');
    if (gf > ga) w++; else if (last === 'OT' || last === 'SO') otl++; else l++;
  }
  if (t.win) w++; else if (g.endingTag) otl++; else l++;
  return `${w}-${l}-${otl}`;
}

async function loadRecords(games: Game[], dateKey: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const g of games) {
    for (const t of [g.away, g.home]) {
      try {
        out.set(t.abbr, await teamRecord(t, g, dateKey));
      } catch (e: any) {
        console.log(`    ⚠ fiche ${t.abbr} indisponible (${e.message}) — carte sans fiche`);
        out.set(t.abbr, null);
      }
    }
  }
  return out;
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

const ctaSlide = (n: number) => ({ n, template: 'cta_card', duration: D.cta, text: 'arakice.com' });

/**
 * Carte d'ouverture : le jour, la date et les affiches de la soirée (ou
 * l'affiche du match), logos compris. La phrase d'amorce reste dessous.
 * `withScores` (night-long) ajoute le score final de chaque affiche, avec OT /
 * SO : la première page donne déjà tous les résultats de la soirée.
 */
function introSlide(dateKey: string, games: Game[], text: string, withScores = false) {
  const d = new Date(`${dateKey}T12:00:00Z`);
  const perRow = withScores ? D.introScore : D.introRow;
  return {
    n: 1,
    template: 'intro_card',
    duration: round1(D.intro + (games.length > 1 ? perRow * games.length : 0)),
    text,
    intro: {
      weekday: d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
      date: d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
      games: games.map((g) => ({
        away: g.away.abbr,
        home: g.home.abbr,
        ...(withScores ? { score: { away: g.away.score, home: g.home.score, tag: g.endingTag } } : {}),
      })),
    },
  };
}

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
// Les deux variantes : night-long (la soirée) et <match>-short (un match).
// ===========================================================================

const monthDay = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

function nightLong(dateKey: string, games: Game[], records: Map<string, string | null>) {
  const slides: any[] = [introSlide(dateKey, games, '', true)];
  let n = 2;
  for (const g of games) {
    const cards = matchSlides(g, n, records);
    slides.push(...cards);
    n += cards.length;
  }
  slides.push(ctaSlide(n));
  return slides;
}

function gameShort(dateKey: string, g: Game, records: Map<string, string | null>) {
  const slides: any[] = [introSlide(dateKey, [g], gameHook(g))];
  let n = 2;
  const cards = matchSlides(g, n, records);
  slides.push(...cards);
  n += cards.length;
  // Les trois étoiles du match, désignées par la LNH — comme avant la refonte.
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
  night_long:  [8, 70] as [number, number],    // ~2-4 s par carte de match
  game_short:  [10, 20] as [number, number],
};

async function main() {
  const fixtureArg = arg('fixture');
  if (fixtureArg) FIXTURE = await loadFixture(fixtureArg);

  // La date de la fixture ne l'emporte jamais sur `--date=` : forcer une autre
  // date sur une soirée inventée reste possible, et le dossier suit.
  const dateKey = arg('date') ?? FIXTURE?.date ?? defaultDate();
  const gameArg = (arg('game') ?? '').trim();
  const outKey  = `${dateKey}-recap`;
  const dir     = path.join(OUTPUT_ROOT, outKey);

  console.log(`\nbuild-recap — soirée du ${dateKey}\n`);
  if (FIXTURE) {
    console.log(`  ⚠ SOIRÉE INVENTÉE — ${fixtureArg}`);
    console.log(`    Aucun appel à l'API. Ne pas publier ce lot.\n`);
  }

  const games = await loadGames(dateKey, flag('require-all'));
  console.log(`  ${games.length} match(s) terminé(s)`);

  await ensureLogos(games.flatMap((g) => [g.away.abbr, g.home.abbr]));
  const teamTags = await loadTeamTags();
  const records = await loadRecords(games, dateKey);

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

  // Une seule affiche dans la soirée : night-long et le short du match
  // diraient la même chose ; seul le short sort.
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
    push('night-long', 'recap_night', entity, facts, nightLong(dateKey, games, records), caps, TARGET.night_long);
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
    push(`${slug}-short`, 'recap_game', entity, facts, gameShort(dateKey, g, records), caps, TARGET.game_short);
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

  // Un lot inventé se reconnaît dans le fichier, pas seulement dans la console :
  // le dossier reste ouvert longtemps après que le bandeau a défilé.
  const SOURCE = FIXTURE ? `build-recap (fixture ${fixtureArg})` : 'build-recap';

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'candidates.json'),
    JSON.stringify({ date: outKey, source: SOURCE, candidates }, null, 2), 'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'posts.json'),
    JSON.stringify({ date: outKey, retrospective: false, generated_by: SOURCE, posts }, null, 2), 'utf8',
  );

  console.log('');
  for (const post of posts) {
    console.log(`  ${post.candidate_id.replace(`${outKey}-`, '').padEnd(22)} ${post.slides.length} plans · ${totalSeconds(post.slides)} s`);
  }
  console.log(`\n  Écrit dans content\\output\\${outKey}\\`);
  console.log(`\n  Suite :`);
  console.log(`    npm run content:render -- --date=${outKey}`);
  console.log(`    npm run content:video  -- --date=${outKey}\n`);
  if (FIXTURE) {
    console.log(`  ⚠ Lot inventé. Une fois regardé :`);
    console.log(`    rmdir /s /q ..\\content\\output\\${outKey}\n`);
  }
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
