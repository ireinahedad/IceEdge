/**
 * slipCommandLlm.ts — le renfort LLM du Bet builder IA (tâche
 * `parse_bet_command`, SLIP_COMMANDE_PLAN.md § 5).
 *
 * L'analyseur local (`slipCommand.ts`) lit gratuitement ce qu'il sait lire.
 * Quand il rend `unknown` — et SEULEMENT dans ce cas (décision du user,
 * 2026-09-28 : une ambiguïté a déjà ses choix cliquables) —, le client envoie
 * la phrase au LLM. Ce module prépare cet appel et relit la réponse :
 *
 *   1. `llmCandidates`  — les matchs et joueurs à montrer au modèle : ceux des
 *      équipes nommées, et les joueurs dont le nom ressemble à un mot de la
 *      phrase (fautes de frappe comprises). Jamais les 700 joueurs de la ligue.
 *   2. `buildParsePrompt` — l'invite système (fr / en) avec ces listes, les
 *      marchés et leurs lignes permises. Bornée en taille : voir
 *      `PARSE_MAX_SYSTEM_CHARS`.
 *   3. `PARSE_RESPONSE_FORMAT` — le schéma JSON imposé au modèle (structured
 *      outputs, `strict`).
 *   4. `readParseResponse` — relit la réponse et passe CHAQUE intention dans
 *      `validateIntent`, le même garde-fou que pour l'analyseur local. Une
 *      seule intention invalide et rien n'est transmis : le modèle n'a pas le
 *      droit d'inventer un match, un joueur ou une ligne.
 *
 * Le modèle ne produit JAMAIS de chiffre : il traduit une phrase en
 * intentions ; la probabilité vient ensuite de `getSinglePrediction` côté
 * client, par `buildLeg`, comme pour une jambe ajoutée à la main.
 *
 * Module pur : aucune dépendance base ou réseau. La route (`llm.routes.ts`)
 * construit le contexte avec les mêmes sources que le client.
 */

import {
  SLIP_COMMAND_MARKETS, SLIP_COMMAND_MAX_LENGTH, TEAM_ALIAS_INDEX,
  normalizeCommand, normalizeName, validateIntent,
  type SlipContext, type SlipGame, type SlipIntent, type SlipMarket, type SlipPlayer,
} from './slipCommand';

/** Au plus autant de matchs dans l'invite (plan § 5.3). */
export const PARSE_MAX_GAMES = 15;
/** Au plus autant de joueurs dans l'invite. */
export const PARSE_MAX_PLAYERS = 60;
/** Au plus autant d'intentions dans une réponse — même borne que l'analyseur local. */
export const PARSE_MAX_INTENTS = 6;
/** Une question de précision plus longue n'est pas une question : on la coupe. */
export const PARSE_MAX_CLARIFICATION = 200;

/**
 * Taille maximale de l'invite système de cette tâche, par défaut.
 *
 * ⚠️ Le coût pire-cas d'une requête — donc le plafond mensuel — est calculé par
 * `llmQuota.service` sur `LLM_MAX_PROMPT_CHARS` + `LLM_MAX_SYSTEM_CHARS`
 * (`PROMPT_BUDGET_CHARS`). La route passe donc à `buildParsePrompt` la plus
 * petite des deux bornes : celle-ci, et ce budget moins la phrase
 * (`SLIP_COMMAND_MAX_LENGTH`). Avec 8 000 + 2 000 c'est 7 000 ; avec les
 * 4 000 + 2 000 de `.env.example` c'est 5 800. Le budget de sortie est le même
 * que pour `explain_bet`.
 */
export const PARSE_MAX_SYSTEM_CHARS = 7_000;

export type ParseLocale = 'fr' | 'en';

// ── 1. Candidats ────────────────────────────────────────────────────────────

/**
 * Distance d'édition où l'inversion de deux lettres voisines compte pour UNE
 * faute (« mcdavdi » → « mcdavid ») — la faute de frappe la plus courante,
 * que la distance de Levenshtein compterait double. Les mots comparés sont
 * courts (des noms de famille) : le calcul complet est négligeable.
 */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Tolérance aux fautes selon la longueur du mot : « suzuky » → Suzuki, pas « ek » → n'importe qui. */
const tolerance = (len: number) => (len >= 8 ? 2 : len >= 5 ? 1 : 0);

/**
 * Les matchs et joueurs à montrer au modèle.
 *
 * Équipes retenues : celles qu'un alias de la phrase désigne (les collisions
 * comme « new york » gardent LES DEUX équipes : c'est au modèle de trancher,
 * ou de demander), plus celles des joueurs reconnus. Joueurs : l'effectif de
 * ces équipes, les joueurs reconnus en tête. Matchs : ceux de ces équipes ;
 * sans aucune équipe, les premiers de la fenêtre.
 */
export function llmCandidates(text: string, ctx: SlipContext): { games: SlipGame[]; players: SlipPlayer[] } {
  const norm = ` ${normalizeCommand(text)} `;
  const words = norm.trim().split(' ').filter((w) => w.length >= 3);

  const teams = new Set<string>();
  for (const [alias, abbrs] of TEAM_ALIAS_INDEX) {
    if (norm.includes(` ${alias} `)) abbrs.forEach((a) => teams.add(a));
  }

  const matched: SlipPlayer[] = [];
  for (const p of ctx.players) {
    const name = normalizeName(p.name);
    const parts = name.split(' ');
    const last = parts[parts.length - 1];
    const hit = norm.includes(` ${name} `)
      || (last.length >= 3 && words.some((w) => editDistance(w, last, tolerance(last.length)) <= tolerance(last.length)));
    if (hit) matched.push(p);
  }
  for (const p of matched) teams.add(p.teamAbbr.toUpperCase());

  const inTeams = (abbr: string) => teams.has(abbr.toUpperCase());
  const roster = ctx.players.filter((p) => inTeams(p.teamAbbr) && !matched.includes(p));
  const players = [...matched, ...roster].slice(0, PARSE_MAX_PLAYERS);

  const games = ctx.games
    .filter((g) => teams.size === 0 || inTeams(g.homeAbbr) || inTeams(g.awayAbbr))
    .filter((g) => g.date >= ctx.today)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, PARSE_MAX_GAMES);

  return { games, players };
}

// ── 2. Invite ───────────────────────────────────────────────────────────────

const MARKET_DOC: Record<SlipMarket, { subject: 'team' | 'game' | 'player'; fr: string; en: string }> = {
  moneyline:          { subject: 'team',   fr: "l'équipe gagne (prolongation et tirs de barrage compris) ; selection = id de l'équipe", en: 'team wins (incl. OT/SO); selection = team id' },
  regulation_result:  { subject: 'team',   fr: "l'équipe gagne en 60 minutes ; selection = id de l'équipe", en: 'team wins in regulation; selection = team id' },
  puck_line:          { subject: 'team',   fr: "l'équipe gagne par 2 buts ou plus (-1.5) ; selection = id de l'équipe", en: 'team wins by 2+ goals (-1.5); selection = team id' },
  team_total_goals:   { subject: 'team',   fr: "buts d'UNE équipe ; selection = over|under", en: "ONE team's goals; selection = over|under" },
  total_goals:        { subject: 'game',   fr: 'buts du match ; selection = over|under', en: 'game goals; selection = over|under' },
  both_teams_score:   { subject: 'game',   fr: 'les deux équipes marquent ; selection = yes', en: 'both teams score; selection = yes' },
  game_to_ot:         { subject: 'game',   fr: 'le match va en prolongation ; selection = yes', en: 'game goes to OT; selection = yes' },
  anytime_goal:       { subject: 'player', fr: 'le joueur marque ; selection = yes', en: 'player scores; selection = yes' },
  first_goal_scorer:  { subject: 'player', fr: 'le joueur marque le premier but du match ; selection = yes', en: "player scores the game's first goal; selection = yes" },
  shots_ou:           { subject: 'player', fr: 'tirs du joueur ; selection = over|under', en: 'player shots; selection = over|under' },
  points_ou:          { subject: 'player', fr: 'points du joueur ; selection = over|under', en: 'player points; selection = over|under' },
  assists_ou:         { subject: 'player', fr: 'passes du joueur ; selection = over|under', en: 'player assists; selection = over|under' },
  goalie_saves_ou:    { subject: 'player', fr: 'arrêts du gardien (position G) ; selection = over|under', en: 'goalie saves (position G); selection = over|under' },
};

const RULES: Record<ParseLocale, string> = {
  fr: [
    "Tu traduis une demande de pari LNH en intentions structurées pour une application d'analyse. Tu ne calcules RIEN.",
    'Règles :',
    "- N'utilise QUE les id des listes MATCHS et JOUEURS ci-dessous. Si le match ou le joueur n'y est pas, ne l'invente pas : pose une question dans `clarification`.",
    "- Id d'équipe = abréviation en minuscules (ex. mtl). subjectType « team » : subjectId = id d'équipe. « game » : subjectId = gameId. « player » : subjectId = id du joueur.",
    "- `line` : uniquement une des lignes permises du marché, sinon null pour les marchés sans ligne. « au moins 3 » = over 2.5 si 2.5 est permise.",
    '- « gagne » sans autre précision = moneyline. Plusieurs paris dans une phrase = plusieurs intentions (6 au plus).',
    '- Sans jour précisé : le prochain match du sujet. « ce soir » = AUJOURD\'HUI, « demain » = le lendemain.',
    "- Si la demande est ambiguë, impossible avec ces marchés, ou n'est pas une demande de pari : intents = [] et `clarification` = UNE question courte, en français.",
    '- Sinon clarification = null.',
  ].join('\n'),
  en: [
    'You translate an NHL bet request into structured intents for an analytics app. You compute NOTHING.',
    'Rules:',
    '- Use ONLY ids from the GAMES and PLAYERS lists below. If the game or player is not there, do not invent it: ask in `clarification`.',
    "- Team id = lower-case abbreviation (e.g. mtl). subjectType 'team': subjectId = team id. 'game': subjectId = gameId. 'player': subjectId = player id.",
    "- `line`: only one of the market's allowed lines, otherwise null for markets without a line. 'at least 3' = over 2.5 when 2.5 is allowed.",
    "- 'win' with nothing else = moneyline. Several bets in one sentence = several intents (6 at most).",
    "- No day given: the subject's next game. 'tonight' = TODAY, 'tomorrow' = the next day.",
    '- If the request is ambiguous, impossible with these markets, or not a bet request: intents = [] and `clarification` = ONE short question, in English.',
    '- Otherwise clarification = null.',
  ].join('\n'),
};

function marketsBlock(ctx: SlipContext, locale: ParseLocale): string {
  return SLIP_COMMAND_MARKETS.map((m) => {
    const doc = MARKET_DOC[m];
    const lines = ctx.lines[m];
    return `${m} [${doc.subject}] ${doc[locale]}${lines ? ` ; lines: ${lines.join(', ')}` : ''}`;
  }).join('\n');
}

/**
 * L'invite système et le message utilisateur. La phrase du joueur reste dans
 * le message UTILISATEUR, jamais dans l'invite système : c'est le serveur qui
 * écrit les règles.
 */
export function buildParsePrompt(
  text: string, ctx: SlipContext, locale: ParseLocale, maxSystemChars: number = PARSE_MAX_SYSTEM_CHARS,
): { system: string; user: string } {
  const { games, players } = llmCandidates(text, ctx);
  const gameLine = (g: SlipGame) => `${g.id} | ${g.date} | ${g.awayAbbr.toLowerCase()} @ ${g.homeAbbr.toLowerCase()}`;
  const playerLine = (p: SlipPlayer) => `${p.id} | ${p.name} | ${p.teamAbbr.toLowerCase()} | ${p.position ?? '?'}`;
  const head = locale === 'fr' ? ['AUJOURD\'HUI', 'MATCHS (id | date | extérieur @ domicile)', 'JOUEURS (id | nom | équipe | position)', 'MARCHÉS']
    : ['TODAY', 'GAMES (id | date | away @ home)', 'PLAYERS (id | name | team | position)', 'MARKETS'];

  const assemble = (ps: SlipPlayer[]) => [
    RULES[locale],
    `${head[0]}: ${ctx.today}`,
    `${head[1]}:\n${games.map(gameLine).join('\n') || '-'}`,
    `${head[2]}:\n${ps.map(playerLine).join('\n') || '-'}`,
    `${head[3]}:\n${marketsBlock(ctx, locale)}`,
  ].join('\n\n');

  // La borne de taille se tient en retirant des joueurs par la fin (l'effectif
  // des équipes nommées), jamais en coupant une ligne au milieu.
  let kept = players;
  let system = assemble(kept);
  while (system.length > maxSystemChars && kept.length > 0) {
    kept = kept.slice(0, Math.max(0, kept.length - 5));
    system = assemble(kept);
  }
  return { system: system.slice(0, maxSystemChars), user: text.slice(0, SLIP_COMMAND_MAX_LENGTH) };
}

// ── 3. Schéma de réponse ────────────────────────────────────────────────────

/**
 * `response_format` des structured outputs OpenAI. `strict` : le modèle ne
 * peut rendre que cette forme. Pas de `maxItems` (mot-clé non garanti en mode
 * strict) : la borne de 6 est tenue par `readParseResponse`.
 */
export const PARSE_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'bet_command',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['intents', 'clarification'],
      properties: {
        intents: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['subjectType', 'subjectId', 'marketType', 'selection', 'line', 'gameId'],
            properties: {
              subjectType: { type: 'string', enum: ['team', 'player', 'game'] },
              subjectId: { type: 'string' },
              marketType: { type: 'string', enum: [...SLIP_COMMAND_MARKETS] },
              selection: { type: 'string' },
              line: { type: ['number', 'null'] },
              gameId: { type: 'string' },
            },
          },
        },
        clarification: { type: ['string', 'null'] },
      },
    },
  },
} as const;

// ── 4. Relecture ────────────────────────────────────────────────────────────

export type ParseOutcome =
  | { ok: true; intents: SlipIntent[] }
  /** `clarification` absente = réponse inutilisable : le client affiche son propre message. */
  | { ok: false; clarification?: string };

/**
 * Relit le contenu rendu par le modèle. Tout ou rien, comme l'analyseur local :
 * une intention que `validateIntent` refuse fait rejeter la réponse entière.
 */
export function readParseResponse(content: unknown, ctx: SlipContext): ParseOutcome {
  let data: unknown;
  try { data = typeof content === 'string' ? JSON.parse(content) : null; } catch { return { ok: false }; }
  if (!data || typeof data !== 'object') return { ok: false };
  const { intents, clarification } = data as { intents?: unknown; clarification?: unknown };

  const question = typeof clarification === 'string' ? clarification.trim().slice(0, PARSE_MAX_CLARIFICATION) : '';
  if (!Array.isArray(intents) || intents.length === 0) {
    return question ? { ok: false, clarification: question } : { ok: false };
  }
  if (intents.length > PARSE_MAX_INTENTS) return { ok: false };

  const out: SlipIntent[] = [];
  const seen = new Set<string>();
  for (const raw of intents) {
    // `line: null` (la forme imposée par le schéma pour « pas de ligne ») est
    // acceptée par `validateIntent`, qui ne la recopie pas.
    const v = validateIntent(raw, ctx);
    if (!v.ok) return { ok: false };
    const key = [v.intent.subjectType, v.intent.subjectId, v.intent.marketType, v.intent.selection, v.intent.line ?? '', v.intent.gameId].join('|');
    if (!seen.has(key)) { seen.add(key); out.push(v.intent); }
  }
  return { ok: true, intents: out };
}
