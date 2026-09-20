import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Ce que ce fichier verrouille : **un coupon ne peut plus rester en attente
 * pour toujours**.
 *
 * Le bogue qu'il ferme ne ressemblait pas à un bogue. Le règlement automatique
 * ne connaissait pas tous les marchés que la page match propose — « X in
 * OT/SO », Winning Margin, « Kills All Penalties » — et une jambe qu'il ne
 * savait pas trancher restait indécise. Or un parlay exige que TOUTES ses
 * jambes soient gagnées : une seule jambe de ce type figeait le coupon entier
 * en `pending`, définitivement. Les matchs étaient finis, les résultats
 * connus, le coupon ne bougeait plus, et rien ne le signalait — pas d'erreur,
 * pas de log, pas de compteur. C'est un silence, et un silence ne se teste que
 * si on écrit le test exprès.
 *
 * Il n'y avait AUCUN test sur `settlement.service.ts`. C'est ce qui a rendu la
 * panne possible et invisible à la fois, donc le premier de ces cas est le plus
 * important : une jambe indécidable doit sortir du coupon, pas l'emporter avec
 * elle.
 */

const query = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => query(...args) },
}));
vi.mock('../logger', () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));
vi.mock('./jobLock', () => ({ withJobLock: vi.fn() }));

const applyXpDelta = vi.fn(async () => {});
vi.mock('./slip.service', () => ({
  applyXpDelta: (...a: unknown[]) => applyXpDelta(...a),
  xpForOutcome: (outcome: string) => (outcome === 'win' ? 100 : -40),
}));

const fetchGameById         = vi.fn();
const fetchGameScoringPlays = vi.fn();
const fetchGameBoxscore     = vi.fn();
vi.mock('./nhlApiClient', () => ({
  fetchGameById:         (...a: unknown[]) => fetchGameById(...a),
  fetchGameBoxscore:     (...a: unknown[]) => fetchGameBoxscore(...a),
  fetchGameScoringPlays: (...a: unknown[]) => fetchGameScoringPlays(...a),
  fetchGameFaceoffWins:  vi.fn(async () => new Map()),
}));

import { settlePendingSlips, resolveSlipOutcome } from './settlement.service';

const GAME_ID = '2026020001';

/** Une fiche de match FINAL. `period` 4 = prolongation, 5 = fusillade. */
function finalGame(home: number, away: number, period = 3) {
  return {
    id: GAME_ID,
    status: 'final',
    period,
    // Une heure du passé : le délai d'annulation (24 h) n'est PAS encore
    // atteint, donc rien ici n'est annulé « par le temps ». Les annulations que
    // ces cas observent viennent toutes d'une indécidabilité STRUCTURELLE.
    startTimeUTC: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    homeTeam: { abbreviation: 'TOR', score: home },
    awayTeam: { abbreviation: 'MTL', score: away },
  };
}

function goal(isHome: boolean, periodType = 'REG', strength = 'ev') {
  return { playerId: '1', assistPlayerIds: [], strength, isHome, periodNumber: 1, periodType, elapsedSeconds: 60 };
}

/** Règle un unique coupon fait de ces jambes, et rend ce qui a été écrit. */
async function settleOne(legs: any[]): Promise<{ outcome?: string; xp?: number; legs?: any[] }> {
  let written: any = {};
  query.mockReset();
  query.mockImplementation(async (sql: string, params: any[]) => {
    if (String(sql).includes('FROM bet_slips')) {
      // Premier lot : le coupon. Deuxième appel : plus rien, la passe s'arrête.
      if (written.read) return { rows: [] };
      written.read = true;
      return {
        rows: [{
          id: 's1', userId: 'u1', legs,
          placedAt: new Date('2026-09-19T00:00:00Z'),
          combinedProbability: 50,
        }],
      };
    }
    if (String(sql).includes('UPDATE bet_slips')) {
      written.outcome = params[0];
      written.xp      = params[1];
      written.legs    = JSON.parse(params[2]);
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  await settlePendingSlips(undefined, { budgetMs: 30_000 });
  return written;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchGameById.mockResolvedValue(finalGame(4, 2));
  fetchGameScoringPlays.mockResolvedValue([goal(true), goal(true), goal(true), goal(true), goal(false), goal(false)]);
  fetchGameBoxscore.mockResolvedValue(new Map());
});

const ML_TOR = { gameId: GAME_ID, marketType: 'moneyline', selectionValue: 'tor', subjectId: 'TOR' };

/**
 * Un marché que `decideLeg` ne connaît pas — et ne connaîtra pas.
 *
 * Depuis l'audit de sept. 2026, TOUS les marchés proposés à l'écran ont une
 * règle ici ; ces cas-là utilisaient `total_penalties`, qui en a une depuis.
 * Ce qu'ils vérifient n'est pourtant pas « ce marché-ci est réglé », c'est « un
 * marché SANS règle n'emporte plus le coupon avec lui » — la protection contre
 * le prochain marché ajouté à l'UI sans règle correspondante. Il faut donc un
 * nom qui ne sera jamais implémenté, pas un vrai marché en attente.
 */
const UNKNOWN_MARKET = 'corner_kicks';

describe('un marché sans règle de règlement ne fige plus le coupon', () => {
  it('la jambe est annulée et le coupon se règle sur les autres', async () => {
    const w = await settleOne([
      ML_TOR,
      { gameId: GAME_ID, marketType: UNKNOWN_MARKET, selectionValue: 'over', line: 8.5 },
    ]);
    expect(w.legs?.map((l: any) => l.result)).toEqual(['win', 'void']);
    // AVANT : `outcome` restait indéfini, le coupon ne quittait jamais la file.
    expect(w.outcome).toBe('win');
  });

  it('un coupon dont TOUTES les jambes sont annulées sort en void, sans XP', async () => {
    const w = await settleOne([
      { gameId: GAME_ID, marketType: UNKNOWN_MARKET, selectionValue: 'over', line: 8.5 },
    ]);
    expect(w.outcome).toBe('void');
    expect(w.xp).toBe(0);
    expect(applyXpDelta).toHaveBeenCalledWith('u1', 0);
  });

  it('une jambe dont le match n\'est PAS fini laisse bien le coupon en attente', async () => {
    fetchGameById.mockResolvedValue({ ...finalGame(4, 2), status: 'live' });
    const w = await settleOne([ML_TOR]);
    // « En attente » doit continuer de vouloir dire « pas encore ». C'est
    // l'autre moitié du correctif : sans elle, on réglerait des matchs en cours.
    expect(w.outcome).toBeUndefined();
  });

  it('la pénalité d\'un coupon perdu se rapporte aux jambes JUGÉES', async () => {
    // Une perdue, une annulée : la pénalité est entière, pas divisée par deux —
    // la jambe annulée ne fait pas partie du pari.
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'moneyline', selectionValue: 'mtl', subjectId: 'MTL' },
      { gameId: GAME_ID, marketType: UNKNOWN_MARKET, selectionValue: 'over', line: 8.5 },
    ]);
    expect(w.outcome).toBe('loss');
    expect(w.xp).toBe(-40);
  });
});

describe('les marchés que la page match proposait sans savoir les régler', () => {
  it('« X in OT/SO » gagne quand son équipe gagne au-delà de 60 minutes', async () => {
    fetchGameById.mockResolvedValue(finalGame(3, 2, 4));
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'ot_so_winner', selectionValue: 'tor', subjectId: 'TOR' },
    ]);
    expect(w.outcome).toBe('win');
  });

  it('… et perd quand le match est réglé en temps réglementaire', async () => {
    fetchGameById.mockResolvedValue(finalGame(3, 2, 3));
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'ot_so_winner', selectionValue: 'tor', subjectId: 'TOR' },
    ]);
    expect(w.outcome).toBe('loss');
  });

  it('… et perd aussi quand il y a prolongation mais que c\'est l\'autre qui gagne', async () => {
    fetchGameById.mockResolvedValue(finalGame(2, 3, 5));
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'ot_so_winner', selectionValue: 'tor', subjectId: 'TOR' },
    ]);
    expect(w.outcome).toBe('loss');
  });

  it('« va en prolongation » se lit sur le type de période d\'un but, pas seulement sur le compteur', async () => {
    // `periodDescriptor` manquant sur une fiche partielle : le résumé des buts
    // tranche quand même.
    fetchGameById.mockResolvedValue({ ...finalGame(3, 2), period: null });
    fetchGameScoringPlays.mockResolvedValue([goal(true), goal(false), goal(true, 'OT')]);
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'game_to_ot', selectionValue: 'yes', subjectId: 'TOR' },
    ]);
    expect(w.outcome).toBe('win');
  });

  it('une fiche sans période NI but hors temps réglementaire reste indécise', async () => {
    // `Number(null)` vaut 0, et 0 est fini : sans garde explicite, une fiche
    // sans `periodDescriptor` passait pour « période 0 », donc pour un match
    // réglé en 60 minutes — et la tuile OT était déclarée perdue sur une donnée
    // ABSENTE. Rien ne l'aurait signalé : la valeur a l'air d'une vraie réponse.
    fetchGameById.mockResolvedValue({ ...finalGame(1, 0), period: null });
    fetchGameScoringPlays.mockResolvedValue([]);
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'ot_so_winner', selectionValue: 'tor', subjectId: 'TOR' },
    ]);
    expect(w.outcome).toBeUndefined();
  });

  it('l\'écart de victoire se compte du point de vue du sujet', async () => {
    fetchGameById.mockResolvedValue(finalGame(4, 2));
    const win2 = await settleOne([
      { gameId: GAME_ID, marketType: 'winning_margin', selectionValue: '2', subjectId: 'TOR', isHome: true },
    ]);
    expect(win2.outcome).toBe('win');

    const away2 = await settleOne([
      { gameId: GAME_ID, marketType: 'winning_margin', selectionValue: '2', subjectId: 'MTL', isHome: false },
    ]);
    expect(away2.outcome).toBe('loss');
  });

  it('« Kills All Penalties » se juge sur les buts en PP de l\'ADVERSAIRE', async () => {
    fetchGameScoringPlays.mockResolvedValue([goal(true), goal(false, 'REG', 'pp')]);
    const home = await settleOne([
      { gameId: GAME_ID, marketType: 'team_penalty_kill', selectionValue: 'yes', subjectId: 'TOR' },
    ]);
    expect(home.outcome).toBe('loss'); // MTL a marqué en avantage numérique

    const away = await settleOne([
      { gameId: GAME_ID, marketType: 'team_penalty_kill', selectionValue: 'yes', subjectId: 'MTL' },
    ]);
    expect(away.outcome).toBe('win');  // TOR n'a pas marqué en PP
  });
});

describe('resolveSlipOutcome', () => {
  it('une jambe perdue emporte le coupon même s\'il reste des indécises', () => {
    expect(resolveSlipOutcome(['loss', 'unknown'])).toBe('loss');
  });
  it('une indécise sans perdante laisse en attente', () => {
    expect(resolveSlipOutcome(['win', 'unknown'])).toBeNull();
  });
  it('gagnées + annulées = gagné', () => {
    expect(resolveSlipOutcome(['win', 'void'])).toBe('win');
  });
  it('tout annulé = void', () => {
    expect(resolveSlipOutcome(['void', 'void'])).toBe('void');
  });
});

/**
 * **Le sujet d'équipe, et les données que le pari ne porte pas.**
 *
 * L'audit de sept. 2026 a trouvé que la moitié des marchés de l'application
 * n'étaient pas réglables — non par manque de données, mais parce que le
 * règlement cherchait chaque information à un seul endroit alors qu'elle est
 * enregistrée à plusieurs selon l'écran qui a posé le pari :
 *
 *  · l'ÉQUIPE est dans `selectionValue` depuis la page match, et dans
 *    `subjectId` depuis le sélecteur de marché — qui met `"yes"` dans
 *    `selectionValue` par défaut (`MarketSelectorSheet`). Un simple moneyline
 *    ajouté depuis le sélecteur n'était donc jamais réglé : le marché le plus
 *    courant, par le chemin le plus courant ;
 *  · le CÔTÉ d'un marché binaire s'écrit `yes` sur une tuile et `over` dans le
 *    sélecteur — même pari, deux mots ;
 *  · la LIGNE de certaines tuiles n'est que dans leur libellé (« −1.5 »,
 *    « Scores a PP Goal »), jamais dans `leg.line`.
 *
 * Chacun de ces cas rendait la jambe indécidable, donc — avant la migration 037
 * — figeait le coupon entier. Ce bloc les fixe un par un.
 */
describe('un pari reste décidable quelle que soit la page qui l\'a posé', () => {
  it('moneyline du sélecteur de marché : équipe dans subjectId, sélection "yes"', async () => {
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'moneyline', selectionValue: 'yes', subjectId: 'tor' },
    ]);
    expect(w.outcome).toBe('win');   // TOR 4–2
  });

  it('… et perd pour l\'autre équipe, par le même chemin', async () => {
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'moneyline', selectionValue: 'yes', subjectId: 'mtl' },
    ]);
    expect(w.outcome).toBe('loss');
  });

  it('puck line sans ligne : −1,5 est la seule du hockey', async () => {
    // La tuile dit « TOR −1.5 » dans son libellé et rien dans `leg.line`.
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'puck_line', selectionValue: 'tor', subjectId: 'TOR' },
    ]);
    expect(w.outcome).toBe('win');   // 4−2 : marge 2, couvre −1,5
  });

  it('puck line côté « no » : le complément, avec le DOMICILE pour sujet', async () => {
    // C'est la tuile « visiteur +1,5 » : même marché, côté inverse.
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'puck_line', selectionValue: 'no', subjectId: 'TOR' },
    ]);
    expect(w.outcome).toBe('loss');
  });

  it('« Scores a PP Goal » : ligne implicite 0,5 et « yes » valant « over »', async () => {
    fetchGameScoringPlays.mockResolvedValue([goal(true, 'REG', 'pp'), goal(false)]);
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'team_pp_goals', selectionValue: 'yes', subjectId: 'TOR' },
    ]);
    expect(w.outcome).toBe('win');
  });

  it('blanchissage : l\'équipe vient du sujet, « yes » du marché', async () => {
    fetchGameById.mockResolvedValue(finalGame(3, 0));
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'clean_sheet', selectionValue: 'yes', subjectId: 'tor' },
    ]);
    expect(w.outcome).toBe('win');
  });

  it('puck line alternative : le camp se dit « home » / « away »', async () => {
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'alt_puck_line', selectionValue: 'away', subjectId: 'mtl', line: 2.5 },
    ]);
    expect(w.outcome).toBe('win');   // MTL 2 + 2,5 = 4,5 > 4
  });

  it('résultat en 60 minutes : perdu si le match va en prolongation', async () => {
    fetchGameById.mockResolvedValue(finalGame(3, 2, 4));
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'regulation_result', selectionValue: 'yes', subjectId: 'tor' },
    ]);
    expect(w.outcome).toBe('loss');
  });

  it('vainqueur de la prolongation : ANNULÉ quand il n\'y en a pas', async () => {
    // Conditionnel, contrairement à `ot_so_winner` : sans prolongation le pari
    // est sans objet. Le compter perdu ferait payer une issue sur laquelle
    // personne n'a parié — c'est la règle des books.
    fetchGameById.mockResolvedValue(finalGame(4, 2, 3));
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'ot_winner', selectionValue: 'yes', subjectId: 'tor' },
    ]);
    expect(w.outcome).toBe('void');
    expect(w.xp).toBe(0);
  });

  it('minutes de pénalité du match : somme des `pim` de la feuille de match', async () => {
    fetchGameBoxscore.mockResolvedValue(new Map([
      ['1', { playerId: '1', pim: 6 }], ['2', { playerId: '2', pim: 4 }], ['3', { playerId: '3', pim: 2 }],
    ]));
    const over  = await settleOne([
      { gameId: GAME_ID, marketType: 'total_penalties', selectionValue: 'over', subjectId: 'tor', line: 10.5 },
    ]);
    expect(over.outcome).toBe('win');  // 12 > 10,5
    const under = await settleOne([
      { gameId: GAME_ID, marketType: 'total_penalties', selectionValue: 'under', subjectId: 'tor', line: 10.5 },
    ]);
    expect(under.outcome).toBe('loss');
  });

  it('une jambe sans sélection n\'est plus écartée d\'entrée', async () => {
    // La garde d'entrée refusait toute jambe sans `selectionValue`, avant même
    // d'atteindre sa règle — alors que « le joueur marque » n'en a pas besoin.
    const w = await settleOne([
      { gameId: GAME_ID, marketType: 'moneyline', subjectId: 'tor' },
    ]);
    expect(w.outcome).toBe('win');
  });
});
