/**
 * manual.routes.ts — saisie manuelle (blessures, alignements, arbitres).
 *
 * Remplace `injuries.routes.ts`, qui écrivait avec `writeFileSync` dans un
 * `dist/data/` inexistant en production (ENOENT → 500) et dont le contenu
 * aurait de toute façon été effacé au redéploiement suivant. Tout passe
 * désormais par `manual_data` (migration 034).
 *
 * ── Tout est réservé aux admins, y compris la lecture ───────────────────────
 * `GET /api/injuries` était public, au motif que « le facteur est déjà public
 * via les prédictions ». C'est vrai du RÉSULTAT (une probabilité), pas de la
 * saisie : la liste nominative des joueurs qu'on croit absents, avec la
 * pondération qu'on leur donne, c'est la méthode du modèle. Elle n'a pas à être
 * lisible par un `curl`. Le seul appelant était la carte admin, qui envoie déjà
 * un jeton pour ses écritures.
 *
 * ── Une route de plus qu'avant : `/lineups` ─────────────────────────────────
 * Les gardiens partants et les absents du soir se saisissaient dans deux
 * fichiers JSON, sur la machine de développement, 1-2 h avant la mise au jeu.
 * C'était infaisable en pratique (les matchs sont le soir en Amérique) et sans
 * effet en production (le dossier `ml/` n'est pas dans l'image). Ces deux
 * entrées — celles qui déplacent le plus les probabilités, d'après
 * SAISIE_MANUELLE.md — deviennent une route et un écran.
 */

import { Router, Request, Response } from 'express';
import { authenticate, requireRole } from '../middleware/auth.middleware';
import { validateBody } from '../middleware/validate.middleware';
import {
  injuriesEntrySchema, lineupsEntrySchema, refereesTableSchema, refAssignmentSchema,
  longInjuriesSchema, manualNewsSchema,
} from '../validation/schemas';
import { addManualNews, deleteNews, listNews } from '../services/newsSync.service';
import { normalizeManualUrl, authorFromManualUrl } from '../services/newsFeed';
import * as Manual from '../services/manualData.service';
import { fetchGamesByDate } from '../services/nhlApiClient';
import { normalizeRefName } from '../services/refereeStore';
import type { GameInjuries } from '../services/injuryStore';
import type { GoalieDay } from '../services/startingGoalies';
import type { ScratchDay } from '../services/scratches';
import { mergeManualSave, type LongInjury, type LongInjuryEntry } from '../services/longInjuries';

const router = Router();

// Lecture ET écriture réservées aux admins — voir l'en-tête.
router.use(authenticate, requireRole('admin'));

// ── Validation des clés d'URL ────────────────────────────────────────────────
// Les corps passent par zod ; les clés d'URL, elles, entrent dans une clé
// primaire et dans une clé de cache. Une clé libre laisserait n'importe quel
// admin faire grossir la table et le cache avec des entrées qu'aucune lecture
// ne retrouvera jamais.

const GAME_KEY_RE = /^[A-Z]{2,4}@[A-Z]{2,4}$/;
const DATE_RE     = /^\d{4}-\d{2}-\d{2}$/;

function gameKeyParam(req: Request, res: Response): string | null {
  const key = String(req.params.key ?? '').trim().toUpperCase();
  if (!GAME_KEY_RE.test(key)) {
    res.status(400).json({ error: 'clé de match invalide — format attendu : VISITEUR@MAISON (ex. TOR@BOS)' });
    return null;
  }
  return key;
}

function dateParam(req: Request, res: Response): string | null {
  const date = String(req.params.date ?? '').trim();
  if (!DATE_RE.test(date)) {
    res.status(400).json({ error: 'date invalide — format attendu : YYYY-MM-DD' });
    return null;
  }
  return date;
}

const actor = (req: Request) => (req as any).user?.sub as string | undefined;

/** Aujourd'hui en heure de l'Est — les jours de match NHL y sont référencés. */
const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// ═════════════════════════════════════════════════════════════════════════════
//  Couverture — « est-ce que le modèle est nourri, ce soir ? »
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/manual/coverage?date=YYYY-MM-DD
 *
 * ── Pourquoi cette route existe ─────────────────────────────────────────────
 * La migration 034 a réparé le CHEMIN de lecture des quatre sources de données
 * du modèle ; elle ne les a pas rendues vivantes. Une table vide produit
 * exactement les mêmes probabilités qu'un fichier introuvable : facteur neutre,
 * sans un mot. C'est le mode de panne d'origine — quatre entrées mortes pendant
 * des mois sans symptôme — et il ne demande qu'à revenir, cette fois par simple
 * absence de saisie.
 *
 * La route répond donc à la seule question qui compte : sur les matchs de ce
 * soir, combien sont renseignés ? `attendu` est le nombre de matchs (ou
 * d'équipes) du jour, `saisi` ce qu'on a. `actif: false` veut dire « ce facteur
 * ne fait rien ce soir ».
 *
 * Le facteur arbitre est le seul à se remplir tout seul (`ref_tendency_auto`,
 * relevé dans les billets Scouting the Refs), d'où son décompte à part.
 */
router.get('/coverage', async (req: Request, res: Response) => {
  const raw = String(req.query.date ?? '').trim();
  if (raw && !DATE_RE.test(raw)) {
    return res.status(400).json({ error: 'date invalide — format attendu : YYYY-MM-DD' });
  }
  const date = raw || todayET();

  const [games, injuries, goalies, scratches, cov] = await Promise.all([
    // Un jour sans match n'est pas une erreur : la couverture vaut alors 0/0.
    fetchGamesByDate(date).catch(() => [] as any[]),
    Manual.mapEntries<GameInjuries>('injuries'),
    Manual.getEntry<GoalieDay>('starting_goalies', date),
    Manual.getEntry<ScratchDay>('scratches', date),
    Manual.coverage(),
  ]);

  const cles = games.map((g: any) =>
    `${String(g?.awayTeam?.abbreviation ?? '').toUpperCase()}@${String(g?.homeTeam?.abbreviation ?? '').toUpperCase()}`);
  const equipes = cles.length * 2;

  const bloc = (saisi: number, attendu: number) => ({ saisi, attendu, actif: saisi > 0 });

  return res.json({
    date,
    matchs: cles.length,
    blessures:        bloc(cles.filter((k) => injuries[k]).length, cles.length),
    gardiensPartants: bloc(Object.keys(goalies   ?? {}).length, equipes),
    absents:          bloc(Object.keys(scratches ?? {}).length, equipes),
    arbitres: {
      saisiManuellement: cov.ref_tendency      ?? 0,
      releveAutomatique: cov.ref_tendency_auto ?? 0,
      actif: ((cov.ref_tendency ?? 0) + (cov.ref_tendency_auto ?? 0)) > 0,
    },
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Blessures / alignement — clé « VISITEUR@MAISON »
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/manual/injuries — toutes les entrées, `{ "TOR@BOS": {…} }`. */
router.get('/injuries', async (_req: Request, res: Response) => {
  res.json(await Manual.mapEntries<GameInjuries>('injuries'));
});

/** PUT /api/manual/injuries/:key — crée ou remplace l'entrée d'un match. */
router.put('/injuries/:key', validateBody(injuriesEntrySchema), async (req: Request, res: Response) => {
  const key = gameKeyParam(req, res);
  if (!key) return;

  const body = req.body as GameInjuries;
  // Une entrée vide n'est pas une entrée : la supprimer évite une table qui se
  // remplit de lignes neutres au fil des soirs où l'on a ouvert l'écran sans
  // rien saisir.
  const isEmpty =
    !(body.home?.length) && !(body.away?.length) &&
    !body.lineupAdj && !body.lineupNote?.trim();

  if (isEmpty) {
    await Manual.deleteEntry('injuries', key);
    return res.json({ ok: true, key, entry: null });
  }

  const entry: GameInjuries = {
    home:       body.home ?? [],
    away:       body.away ?? [],
    lineupAdj:  body.lineupAdj ?? 0,
    lineupNote: body.lineupNote ?? '',
  };
  await Manual.setEntry('injuries', key, entry, actor(req));
  return res.json({ ok: true, key, entry });
});

/** DELETE /api/manual/injuries/:key */
router.delete('/injuries/:key', async (req: Request, res: Response) => {
  const key = gameKeyParam(req, res);
  if (!key) return;
  const existed = await Manual.deleteEntry('injuries', key);
  return res.json({ ok: true, key, existed });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Gardiens partants + absents — clé « YYYY-MM-DD » (heure de l'Est)
// ═════════════════════════════════════════════════════════════════════════════
//
// Les deux jeux sont servis ensemble parce qu'ils se saisissent ensemble, dans
// la même passe, sur le même écran. Ils restent DEUX lignes en base : le modèle
// les consomme séparément (gardien → feature ML dédiée, absents → dérivation
// `stars_missing`), et les fusionner obligerait chaque lecture à trier.

/**
 * GET /api/manual/long-injuries — `{ "TOR": [{ player, impact, since }] }`.
 *
 * Lecture BRUTE de la table (pas `getLongInjuries`) : l'écran doit voir ce qui
 * est enregistré, tel quel, pour pouvoir le corriger.
 */
router.get('/long-injuries', async (_req: Request, res: Response) => {
  const rows = await Manual.mapEntries<LongInjuryEntry>('long_injuries');
  const out: Record<string, LongInjury[]> = {};
  for (const [abbr, entry] of Object.entries(rows)) out[abbr] = entry?.players ?? [];
  res.json(out);
});

/**
 * PUT /api/manual/long-injuries/:abbr — remplace la liste d'une équipe.
 *
 * La liste envoyée est fusionnée avec la ligne en base par `mergeManualSave` :
 * l'écran ne connaît pas `dismissed`, et c'est au serveur de décider si une
 * entrée automatique le reste (voir `longInjuries.ts`). La ligne n'est effacée
 * que si elle ne porte plus NI joueur NI rejet : effacer les rejets ferait
 * revenir dès la synchro suivante un joueur que l'admin vient de retirer.
 */
router.put('/long-injuries/:abbr', validateBody(longInjuriesSchema), async (req: Request, res: Response) => {
  const abbr = String(req.params.abbr ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(abbr)) {
    return res.status(400).json({ error: 'abréviation d\'équipe invalide (ex. TOR)' });
  }
  const seen = new Set<string>();
  const incoming: LongInjury[] = (req.body as LongInjuryEntry).players
    .map((p) => ({ ...p, player: p.player.trim() }))
    .filter((p) => !seen.has(p.player.toLowerCase()) && !!seen.add(p.player.toLowerCase()));

  const existing = await Manual.getEntry<LongInjuryEntry>('long_injuries', abbr);
  const next = mergeManualSave(existing, incoming);

  if (next.players.length === 0 && !next.dismissed?.length) {
    await Manual.deleteEntry('long_injuries', abbr);
    return res.json({ ok: true, abbr, players: [] });
  }
  await Manual.setEntry('long_injuries', abbr, next, actor(req));
  return res.json({ ok: true, abbr, players: next.players });
});

/** GET /api/manual/lineups?date=YYYY-MM-DD (défaut : aujourd'hui, heure Est). */
router.get('/lineups', async (req: Request, res: Response) => {
  const raw  = String(req.query.date ?? '').trim();
  if (raw && !DATE_RE.test(raw)) {
    return res.status(400).json({ error: 'date invalide — format attendu : YYYY-MM-DD' });
  }
  const date = raw || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const [goalies, scratches] = await Promise.all([
    Manual.getEntry<GoalieDay>('starting_goalies', date),
    Manual.getEntry<ScratchDay>('scratches', date),
  ]);
  return res.json({ date, goalies: goalies ?? {}, scratches: scratches ?? {} });
});

/**
 * PUT /api/manual/lineups/:date — `{ goalies?, scratches? }`.
 *
 * Chaque champ FOURNI remplace intégralement sa journée ; un champ absent est
 * laissé tel quel. Ce n'est pas une fusion par équipe, et c'est voulu : retirer
 * un gardien saisi par erreur doit être possible, et une fusion ne permettrait
 * que d'ajouter. L'écran envoie toujours l'état complet de ce qu'il affiche.
 */
router.put('/lineups/:date', validateBody(lineupsEntrySchema), async (req: Request, res: Response) => {
  const date = dateParam(req, res);
  if (!date) return;

  const { goalies, scratches } = req.body as { goalies?: GoalieDay; scratches?: ScratchDay };
  const by = actor(req);

  if (goalies !== undefined) {
    const clean: GoalieDay = {};
    for (const [abbr, name] of Object.entries(goalies)) {
      if (name && name.trim()) clean[abbr.toUpperCase()] = name.trim();
    }
    // Journée vidée → on supprime la ligne plutôt que d'écrire `{}`.
    if (Object.keys(clean).length) await Manual.setEntry('starting_goalies', date, clean, by);
    else await Manual.deleteEntry('starting_goalies', date);
  }

  if (scratches !== undefined) {
    const clean: ScratchDay = {};
    for (const [abbr, list] of Object.entries(scratches)) {
      const names = (list ?? []).map((n) => n.trim()).filter(Boolean);
      if (names.length) clean[abbr.toUpperCase()] = names;
    }
    if (Object.keys(clean).length) await Manual.setEntry('scratches', date, clean, by);
    else await Manual.deleteEntry('scratches', date);
  }

  const [g, s] = await Promise.all([
    Manual.getEntry<GoalieDay>('starting_goalies', date),
    Manual.getEntry<ScratchDay>('scratches', date),
  ]);
  return res.json({ ok: true, date, goalies: g ?? {}, scratches: s ?? {} });
});

/** DELETE /api/manual/lineups/:date — efface la journée (les deux jeux). */
router.delete('/lineups/:date', async (req: Request, res: Response) => {
  const date = dateParam(req, res);
  if (!date) return;
  await Promise.all([
    Manual.deleteEntry('starting_goalies', date),
    Manual.deleteEntry('scratches', date),
  ]);
  return res.json({ ok: true, date });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Tendance PP des arbitres — une passe par saison
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/manual/referees — la table complète + la moyenne ligue. */
router.get('/referees', async (_req: Request, res: Response) => {
  const [rows, config] = await Promise.all([
    Manual.listEntries<{ name: string; ppPerGame: number; note?: string }>('ref_tendency'),
    Manual.getEntry<{ avgPpPerGame: number }>('ref_config', 'league'),
  ]);
  res.json({
    leagueAvgPpPerGame: config?.avgPpPerGame ?? 6.2,
    referees: rows
      .map((r) => r.payload)
      .sort((a, b) => a.name.localeCompare(b.name)),
  });
});

/**
 * PUT /api/manual/referees — remplace la table.
 *
 * Remplacement atomique et non incrémental : la saisie se fait en une passe
 * depuis les moyennes de saison de Scouting the Refs, et un état où la moitié
 * des arbitres viennent de la saison passée est pire que pas de table du tout.
 * Omettre `referees` ne met à jour que la moyenne ligue.
 */
router.put('/referees', validateBody(refereesTableSchema), async (req: Request, res: Response) => {
  const { leagueAvgPpPerGame, referees } = req.body as {
    leagueAvgPpPerGame?: number;
    referees?: Array<{ name: string; ppPerGame: number; note?: string }>;
  };
  const by = actor(req);

  if (leagueAvgPpPerGame !== undefined) {
    await Manual.setEntry('ref_config', 'league', { avgPpPerGame: leagueAvgPpPerGame }, by);
  }
  if (referees !== undefined) {
    await Manual.replaceKind(
      'ref_tendency',
      referees.map((r) => ({
        key: normalizeRefName(r.name),
        // `trim()` seul laissait « Wes   McCauley » tel quel : zod a déjà rogné
        // les bords, pas les espaces du milieu. La CLÉ, elle, est normalisée
        // (donc « wes mccauley »), si bien que le matching fonctionnait mais que
        // le nom affiché gardait ses doublons d'espaces. On aligne les deux.
        payload: {
          name: r.name.replace(/\s+/g, ' ').trim(),
          ppPerGame: r.ppPerGame,
          note: r.note?.trim() || undefined,
        },
      })),
      by,
    );
  }
  return res.json({ ok: true, count: referees?.length ?? null });
});

/** DELETE /api/manual/referees/:name — retire un arbitre de la table. */
router.delete('/referees/:name', async (req: Request, res: Response) => {
  const key = normalizeRefName(String(req.params.name ?? ''));
  if (!key) return res.status(400).json({ error: 'nom d\'arbitre invalide' });
  const existed = await Manual.deleteEntry('ref_tendency', key);
  return res.json({ ok: true, name: req.params.name, existed });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Assignation d'arbitres — secours quand le scrape Scouting the Refs casse
// ═════════════════════════════════════════════════════════════════════════════

/** GET /api/manual/ref-assignments */
router.get('/ref-assignments', async (_req: Request, res: Response) => {
  res.json(await Manual.mapEntries<{ refs: string[] }>('ref_assignment'));
});

/** PUT /api/manual/ref-assignments/:key — `{ refs: ["…"] }`, prioritaire sur le scrape. */
router.put('/ref-assignments/:key', validateBody(refAssignmentSchema), async (req: Request, res: Response) => {
  const key = gameKeyParam(req, res);
  if (!key) return;
  const refs = (req.body as { refs: string[] }).refs.map((r) => r.trim()).filter(Boolean);
  await Manual.setEntry('ref_assignment', key, { refs }, actor(req));
  return res.json({ ok: true, key, refs });
});

/** DELETE /api/manual/ref-assignments/:key — rend la main au scrape. */
router.delete('/ref-assignments/:key', async (req: Request, res: Response) => {
  const key = gameKeyParam(req, res);
  if (!key) return;
  const existed = await Manual.deleteEntry('ref_assignment', key);
  return res.json({ ok: true, key, existed });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Fil de nouvelles — lien collé à la main (NEWS_CONSENSUS_PLAN.md, F1)
// ═════════════════════════════════════════════════════════════════════════════
// Le cas d'usage : une nouvelle vue sur X ou sur Discord, qu'aucune source
// Bluesky ne couvre. Un humain lit et colle le lien : rien n'est lu par robot.

router.get('/news', async (req: Request, res: Response) => {
  const teams = String(req.query.teams ?? '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
  if (teams.length === 0) { res.status(400).json({ error: 'teams requis (ex. VGK,STL)' }); return; }
  res.json({ items: await listNews(teams, 72, 50) });
});

router.post('/news', validateBody(manualNewsSchema), async (req: Request, res: Response) => {
  const url = normalizeManualUrl(req.body.url);
  if (!url) {
    res.status(400).json({ error: 'lien refusé — https://x.com, bsky.app ou nhl.com seulement' });
    return;
  }
  const id = await addManualNews({
    url, teams: req.body.teams, author: authorFromManualUrl(url),
    excerpt: req.body.excerpt, flags: req.body.flags, userId: actor(req),
  });
  if (id === null) { res.status(409).json({ error: 'ce lien est déjà dans le fil' }); return; }
  res.status(201).json({ id });
});

router.delete('/news/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: 'id invalide' }); return; }
  res.status((await deleteNews(id)) ? 204 : 404).end();
});

export default router;
