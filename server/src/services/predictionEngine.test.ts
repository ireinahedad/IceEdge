import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  predictBothTeamsScore,
  predictCleanSheet,
  predictMarginDistribution,
  predictWinningMargin,
  parseMarginBucket,
  predictGameToOvertime,
  predictHighestScoringPeriod,
  predictFirstGoalScorer,
  predictLastGoalScorer,
  predictGoalieSaves,
  predictPositionBasedProp,
} from './predictionEngine';

/**
 * Ce que ce fichier prouve : les marchés qui servaient une CONSTANTE servent
 * maintenant un modèle, et ce modèle est cohérent.
 *
 * Le bug corrigé ici n'était pas une erreur de calcul — c'était l'absence de
 * calcul. `predictWinningMargin()` renvoyait 12 quelles que soient les équipes,
 * le seau demandé et le camp ; `game_to_ot` renvoyait 24 et
 * `highest_scoring_period` 38, directement dans le routeur. Chacun de ces
 * chiffres arrivait à l'écran dans la même tuile, avec la même typographie et
 * la même barre de couleur qu'une vraie probabilité.
 *
 * Les tests visent donc les propriétés qu'une constante ne peut PAS avoir :
 *   - la somme d'une partition exhaustive fait 1 (les six écarts en faisaient
 *     0,72) ;
 *   - le chiffre BOUGE quand l'affiche change ;
 *   - la prolongation est traitée (tout match nul après 60 minutes finit par un
 *     but d'écart, ce qui fait de « par 1 » le seau dominant).
 */

// ── Doubles de l'API NHL ──────────────────────────────────────────────────────

interface FakeTeam {
  id: string; abbreviation: string; conference: string;
  winPct: number; points: number; gamesPlayed: number;
  goalsForPerGame: number; goalsAgainstPerGame: number;
}

/** Attaque d'élite, défense d'élite. */
const ELITE: FakeTeam = {
  id: 'elite', abbreviation: 'ELI', conference: 'East',
  winPct: 68, points: 90, gamesPlayed: 60,
  goalsForPerGame: 3.8, goalsAgainstPerGame: 2.5,
};

/** Attaque faible, défense poreuse. */
const WEAK: FakeTeam = {
  id: 'weak', abbreviation: 'WEA', conference: 'East',
  winPct: 32, points: 50, gamesPlayed: 60,
  goalsForPerGame: 2.4, goalsAgainstPerGame: 3.7,
};

/** Deux équipes moyennes et défensives : l'égalité y est fréquente. */
const TIGHT_A: FakeTeam = {
  id: 'tighta', abbreviation: 'TGA', conference: 'West',
  winPct: 50, points: 70, gamesPlayed: 60,
  goalsForPerGame: 2.5, goalsAgainstPerGame: 2.5,
};
const TIGHT_B: FakeTeam = { ...TIGHT_A, id: 'tightb', abbreviation: 'TGB' };

/** Deux équipes qui s'envoient des matchs ouverts (~7,8 buts combinés). */
const WILD_A: FakeTeam = {
  id: 'wilda', abbreviation: 'WLA', conference: 'West',
  winPct: 50, points: 70, gamesPlayed: 60,
  goalsForPerGame: 3.5, goalsAgainstPerGame: 3.4,
};
const WILD_B: FakeTeam = { ...WILD_A, id: 'wildb', abbreviation: 'WLB' };

/** Défense de fer, attaque anémique — l'opposé exact de WEAK. */
const WALL: FakeTeam = {
  id: 'wall', abbreviation: 'WAL', conference: 'East',
  winPct: 52, points: 72, gamesPlayed: 60,
  goalsForPerGame: 2.2, goalsAgainstPerGame: 2.1,
};

/** Affiche parfaitement moyenne : sert à vérifier la calibration. */
const AVG_A: FakeTeam = {
  id: 'avga', abbreviation: 'AVA', conference: 'West',
  winPct: 50, points: 70, gamesPlayed: 60,
  goalsForPerGame: 3.05, goalsAgainstPerGame: 3.05,
};
const AVG_B: FakeTeam = { ...AVG_A, id: 'avgb', abbreviation: 'AVB' };

const TEAMS = [ELITE, WEAK, TIGHT_A, TIGHT_B, WILD_A, WILD_B, WALL, AVG_A, AVG_B];

const { fetchTeams } = vi.hoisted(() => ({ fetchTeams: vi.fn() }));
fetchTeams.mockImplementation(async () => TEAMS);

/** Joueurs renvoyés par `fetchPlayerById`, indexés par id. */
const PLAYERS: Record<string, any> = {
  // Marqueur d'élite : 0,7 but/match.
  sniper: {
    id: 'sniper', name: 'Sniper', teamAbbr: 'ELI', position: 'C',
    gamesPlayed: 60, goals: 42, assists: 40, points: 82, shots: 240,
    ppPoints: 25, penaltyMinutes: 30, avgToi: 21.5,
    savePct: null, shotsAgainst: null, goalsAgainst: null,
  },
  // Quatrième trio : 0,1 but/match.
  grinder: {
    id: 'grinder', name: 'Grinder', teamAbbr: 'ELI', position: 'L',
    gamesPlayed: 60, goals: 6, assists: 8, points: 14, shots: 70,
    ppPoints: 0, penaltyMinutes: 72, avgToi: 9.8,
    savePct: null, shotsAgainst: null, goalsAgainst: null,
  },
  // Gardien très sollicité : 33 tirs subis par match.
  busyGoalie: {
    id: 'busyGoalie', name: 'Busy', teamAbbr: 'WEA', position: 'G',
    gamesPlayed: 50, goals: 0, assists: 0, points: 0, shots: 0,
    ppPoints: 0, penaltyMinutes: 2, avgToi: 58,
    savePct: 0.912, shotsAgainst: 1650, goalsAgainst: 145,
  },
  // Gardien d'une équipe qui verrouille : 24 tirs subis par match.
  quietGoalie: {
    id: 'quietGoalie', name: 'Quiet', teamAbbr: 'ELI', position: 'G',
    gamesPlayed: 50, goals: 0, assists: 0, points: 0, shots: 0,
    ppPoints: 0, penaltyMinutes: 0, avgToi: 58,
    savePct: 0.920, shotsAgainst: 1200, goalsAgainst: 96,
  },
  // Recrue qui n'a pas encore joué.
  rookie: {
    id: 'rookie', name: 'Rookie', teamAbbr: 'ELI', position: 'R',
    gamesPlayed: 0, goals: 0, assists: 0, points: 0, shots: 0,
    ppPoints: 0, penaltyMinutes: 0, avgToi: 0,
    savePct: null, shotsAgainst: null, goalsAgainst: null,
  },
};

const { fetchPlayerById } = vi.hoisted(() => ({ fetchPlayerById: vi.fn() }));
fetchPlayerById.mockImplementation(async (id: string) => {
  const p = PLAYERS[id];
  if (!p) throw new Error(`unknown player ${id}`);
  return p;
});

vi.mock('./nhlApiClient', () => ({ fetchTeams, fetchPlayerById }));

// `clearAllMocks` effacerait les implémentations ci-dessus et rendrait
// `undefined` à chaque appel : on ne remet à zéro que les compteurs.
beforeEach(() => { vi.clearAllMocks(); fetchTeams.mockClear(); fetchPlayerById.mockClear(); });

// ── Écart de victoire ─────────────────────────────────────────────────────────

describe('predictWinningMargin — six seaux qui somment à 1, pas six fois 12 %', () => {
  it('la partition est exhaustive : les six seaux somment à 1', async () => {
    const d = await predictMarginDistribution('ELI', 'WEA', true);
    expect(d).not.toBeNull();
    const total = Object.values(d!).reduce((s, p) => s + p, 0);
    // C'est LE test de non-régression : la version constante donnait
    // 6 × 12 % = 72 % pour une partition qui couvre toutes les issues d'un
    // match de hockey (il n'y a pas de match nul en NHL).
    expect(total).toBeCloseTo(1, 6);
  });

  it('« par 1 » domine, parce que toute égalité après 60 minutes finit ainsi', async () => {
    const d = (await predictMarginDistribution('TGA', 'TGB', true))!;
    const byOne = d.win_1 + d.lose_1;
    expect(byOne).toBeGreaterThan(d.win_2 + d.lose_2);
    expect(byOne).toBeGreaterThan(d.win_3plus + d.lose_3plus);
    // Une affiche serrée envoie beaucoup de matchs en prolongation : la part des
    // matchs à un but doit dépasser largement la moitié.
    expect(byOne).toBeGreaterThan(0.5);
  });

  it('le favori a plus de chances de gagner par 3+ que l\'outsider', async () => {
    const d = (await predictMarginDistribution('ELI', 'WEA', true))!;
    expect(d.win_3plus).toBeGreaterThan(d.lose_3plus);
    expect(d.win_1 + d.win_2 + d.win_3plus).toBeGreaterThan(0.5);
  });

  it('le chiffre BOUGE selon l\'affiche — une constante ne le ferait pas', async () => {
    const tight = await predictWinningMargin('TGA', 'TGB', true, '3+');
    const blowy = await predictWinningMargin('WLA', 'WLB', true, '3+');
    // Deux équipes à 3,9 buts/match produisent bien plus de gros écarts que deux
    // équipes à 2,5. Les deux sortaient à 12 % avant.
    expect(blowy!).toBeGreaterThan(tight!);
  });

  it('les deux camps du même match donnent des chiffres différents', async () => {
    const favourite = await predictWinningMargin('ELI', 'WEA', true,  '1');
    const underdog  = await predictWinningMargin('WEA', 'ELI', false, '1');
    expect(favourite).not.toBe(underdog);
  });

  it('sans seau lisible : null, pas une valeur par défaut', async () => {
    expect(await predictWinningMargin('ELI', 'WEA', true, undefined)).toBeNull();
    expect(await predictWinningMargin('ELI', 'WEA', true, 'banane')).toBeNull();
  });

  describe('parseMarginBucket — les deux vocabulaires de l\'UI tombent au même endroit', () => {
    it('la taille seule prend le côté du sujet', () => {
      expect(parseMarginBucket('1',  true )).toBe('win_1');
      expect(parseMarginBucket('3+', true )).toBe('win_3plus');
      expect(parseMarginBucket('1',  false)).toBe('win_1');
    });

    it('le couple explicite de betMarkets.ts est relu du point de vue du sujet', () => {
      // Sujet = domicile, seau = « le domicile gagne par 1 » → le sujet gagne.
      expect(parseMarginBucket('home_1', true)).toBe('win_1');
      // Même seau, mais le sujet est l'extérieur → le sujet perd par 1.
      expect(parseMarginBucket('home_1', false)).toBe('lose_1');
      expect(parseMarginBucket('away_2plus', false)).toBe('win_2plus');
      expect(parseMarginBucket('away_2plus', true )).toBe('lose_2plus');
    });

    it('« 2 ou plus » n\'est pas « exactement 2 »', async () => {
      const d       = (await predictMarginDistribution('ELI', 'WEA', true))!;
      const twoPlus = await predictWinningMargin('ELI', 'WEA', true, 'home_2plus');
      const exactly = await predictWinningMargin('ELI', 'WEA', true, '2');
      expect(twoPlus!).toBeGreaterThan(exactly!);
      expect(twoPlus!).toBe(Math.round((d.win_2 + d.win_3plus) * 100));
    });
  });
});

// ── Prolongation ──────────────────────────────────────────────────────────────

describe('predictGameToOvertime — remplace la constante 24', () => {
  it('une affiche fermée envoie plus souvent en prolongation qu\'une affiche ouverte', async () => {
    const tight = await predictGameToOvertime('TGA', 'TGB');
    const wild  = await predictGameToOvertime('WLA', 'WLB');
    expect(tight).toBeGreaterThan(wild);
  });

  it('une affiche moyenne retrouve le taux de ligue observé (~23 %)', async () => {
    // C'est la calibration de TIE_INFLATION qui est testée ici. Sans elle, le
    // modèle indépendant donnait 14 % sur cette affiche : un chiffre dérivé,
    // certes, mais faux d'un tiers — et un chiffre faux reste un chiffre faux,
    // qu'il vienne d'une constante ou d'un calcul.
    const p = await predictGameToOvertime('AVA', 'AVB');
    expect(p).toBeGreaterThanOrEqual(21);
    expect(p).toBeLessThanOrEqual(25);
  });

  it('reste dans une fourchette plausible sur TOUTE la grille NHL réaliste', async () => {
    // Bien plus probant que quelques affiches choisies à la main : on balaie la
    // vraie étendue 2024-25 des statistiques d'équipe (buts pour 2.5–3.6, buts
    // contre 2.5–3.5) et on vérifie que rien ne sort de la fourchette.
    const gf = [2.5, 2.8, 3.05, 3.3, 3.6];
    const ga = [2.5, 2.8, 3.05, 3.3, 3.5];
    const out: number[] = [];
    for (const agf of gf) for (const aga of ga)
      for (const bgf of gf) for (const bga of ga) {
        fetchTeams.mockResolvedValue([
          { id: 'A', abbreviation: 'A', gamesPlayed: 60, goalsForPerGame: agf, goalsAgainstPerGame: aga },
          { id: 'B', abbreviation: 'B', gamesPlayed: 60, goalsForPerGame: bgf, goalsAgainstPerGame: bga },
        ]);
        out.push(await predictGameToOvertime('A', 'B'));
      }
    fetchTeams.mockImplementation(async () => TEAMS);
    out.sort((a, b) => a - b);
    expect(out[0]).toBeGreaterThanOrEqual(12);
    expect(out[out.length - 1]).toBeLessThanOrEqual(34);
    const median = out[Math.floor(out.length / 2)];
    expect(median).toBeGreaterThanOrEqual(19);
    expect(median).toBeLessThanOrEqual(24);
  });

  it('sans statistiques exploitables, sert le taux de ligue et non un calcul bidon', async () => {
    const p = await predictGameToOvertime('INCONNU', 'AUTRE');
    expect(p).toBe(22);   // LEAGUE_OT_RATE = 0.2204, mesuré
  });
});

// ── Période la plus prolifique ────────────────────────────────────────────────

describe('predictHighestScoringPeriod — remplace la constante 38', () => {
  it('les trois périodes plus l\'égalité somment à 100', async () => {
    const [p1, p2, p3, tie] = await Promise.all(
      ['P1', 'P2', 'P3', 'tie'].map(s => predictHighestScoringPeriod('ELI', 'WEA', s))
    );
    // Trois périodes à 38 % faisaient 114 % pour trois issues qui s'excluent.
    expect(p1! + p2! + p3! + tie!).toBeCloseTo(100, 0);
  });

  it('les trois périodes sont équivalentes sous ce modèle, et c\'est assumé', async () => {
    const p1 = await predictHighestScoringPeriod('ELI', 'WEA', 'P1');
    const p3 = await predictHighestScoringPeriod('ELI', 'WEA', '3');
    expect(p1).toBe(p3);
  });

  it('un match ouvert rend l\'égalité moins probable qu\'un match fermé', async () => {
    const tieTight = await predictHighestScoringPeriod('TGA', 'TGB', 'tie');
    const tieWild  = await predictHighestScoringPeriod('WLA', 'WLB', 'tie');
    // Plus il se marque de buts, moins les trois périodes finissent à égalité.
    expect(tieWild!).toBeLessThan(tieTight!);
  });

  it('sans période lisible : null', async () => {
    expect(await predictHighestScoringPeriod('ELI', 'WEA', undefined)).toBeNull();
    expect(await predictHighestScoringPeriod('ELI', 'WEA', 'P4')).toBeNull();
  });
});

// ── Premier / dernier buteur ──────────────────────────────────────────────────

describe('premier / dernier buteur', () => {
  it('un marqueur d\'élite sort bien au-dessus d\'un joueur de quatrième trio', async () => {
    const sniper  = await predictFirstGoalScorer('sniper',  'WEA');
    const grinder = await predictFirstGoalScorer('grinder', 'WEA');
    expect(sniper!).toBeGreaterThan(grinder! * 3);
  });

  it('l\'adversaire compte : le même joueur ne sort pas pareil selon l\'affiche', async () => {
    const vsPorous = await predictFirstGoalScorer('sniper', 'WEA');
    const vsWall   = await predictFirstGoalScorer('sniper', 'WAL');
    // L'ancien `anytime / 4.5` ignorait complètement l'adversaire : les deux
    // appels rendaient strictement le même nombre. Face à un mur, l'attaque du
    // sujet baisse mais celle d'en face bien davantage, donc SA part des buts du
    // match monte — la part, pas le nombre de buts.
    expect(vsWall).not.toBe(vsPorous);
    expect(vsWall!).toBeGreaterThan(vsPorous!);
  });

  it('dernier buteur = premier buteur sous ce modèle, délibérément', async () => {
    const first = await predictFirstGoalScorer('sniper', 'WEA');
    const last  = await predictLastGoalScorer('sniper', 'WEA');
    // L'égalité n'est pas le bug : le bug était qu'elle n'était dite nulle part.
    // Le routeur remonte `caveat: "shared_with_first_goal"` avec ce chiffre —
    // voir ml.routes.test.ts.
    expect(last).toBe(first);
  });

  it('un joueur sans match joué : null, pas une cadence extrapolée de rien', async () => {
    expect(await predictFirstGoalScorer('rookie', 'WEA')).toBeNull();
  });
});

// ── Props par joueur ──────────────────────────────────────────────────────────

describe('predictGoalieSaves — chaque gardien a sa propre cadence', () => {
  it('deux gardiens de charge de travail différente ne reçoivent plus λ = 26', async () => {
    // Busy : (1650 − 145) / 50 = 30,1 arrêts/match.
    // Quiet : (1200 − 96)  / 50 = 22,1 arrêts/match.
    const busy  = await predictGoalieSaves('busyGoalie',  27.5, 'over');
    const quiet = await predictGoalieSaves('quietGoalie', 27.5, 'over');
    expect(busy!).toBeGreaterThan(60);
    expect(quiet!).toBeLessThan(25);
  });

  it('« over » et « under » sont complémentaires', async () => {
    const over  = await predictGoalieSaves('busyGoalie', 27.5, 'over');
    const under = await predictGoalieSaves('busyGoalie', 27.5, 'under');
    expect(over! + under!).toBeCloseTo(100, 0);
  });

  it('un skater n\'a pas de statistiques de gardien : null', async () => {
    expect(await predictGoalieSaves('sniper', 27.5, 'over')).toBeNull();
  });
});

describe('predictPositionBasedProp — dit quand le chiffre n\'est PAS par joueur', () => {
  it('les arrêts sont maintenant par joueur', async () => {
    const est = await predictPositionBasedProp('busyGoalie', 'goalie_saves_ou', 27.5, 'over');
    expect(est?.playerSpecific).toBe(true);
  });

  it('les minutes de pénalité aussi, depuis que fetchPlayerById les mappe', async () => {
    const est = await predictPositionBasedProp('grinder', 'penalty_minutes_ou', 0.5, 'over');
    expect(est?.playerSpecific).toBe(true);
    // 72 PIM en 60 matchs = 1,2/match : bien au-dessus du 0,4 de ligue.
    const league = await predictPositionBasedProp('rookie', 'penalty_minutes_ou', 0.5, 'over');
    expect(est!.probability).toBeGreaterThan(league!.probability);
  });

  it('le temps de jeu aussi', async () => {
    const top    = await predictPositionBasedProp('sniper',  'time_on_ice_ou', 18.5, 'over');
    const fourth = await predictPositionBasedProp('grinder', 'time_on_ice_ou', 18.5, 'over');
    expect(top?.playerSpecific).toBe(true);
    expect(top!.probability).toBeGreaterThan(fourth!.probability);
  });

  it('mises en échec et tirs bloqués restent des moyennes de ligue, ET LE DISENT', async () => {
    for (const market of ['hits_ou', 'blocked_shots_ou', 'faceoff_wins_ou']) {
      const est = await predictPositionBasedProp('sniper', market, 1.5, 'over');
      expect(est).not.toBeNull();
      // Le drapeau est le contrat : le jour où une vraie source est branchée
      // pour l'un de ces marchés, il doit passer à `true` en même temps.
      expect(est!.playerSpecific).toBe(false);
    }
  });

  it('deux joueurs du même poste reçoivent le même chiffre — d\'où le drapeau', async () => {
    const a = await predictPositionBasedProp('sniper',  'hits_ou', 1.5, 'over');
    const b = await predictPositionBasedProp('grinder', 'hits_ou', 1.5, 'over');
    expect(a!.probability).toBe(b!.probability);
  });

  it('un marché inconnu rend null, pas un λ de 3,0 sorti de nulle part', async () => {
    expect(await predictPositionBasedProp('sniper', 'giveaways_ou', 1.5, 'over')).toBeNull();
  });
});


// ── Calibration ───────────────────────────────────────────────────────────────

/**
 * Ce bloc est le garde-fou de la calibration. Les valeurs de droite sont
 * MESURÉES sur `ml/data/games_spine.csv` (2022-2025, 5 248 matchs) — pas
 * choisies pour faire passer le test. Si quelqu'un touche à MARGIN_TILT, à
 * LEAGUE_AVG_GPG ou à la loi des buts, c'est ici que ça doit se voir.
 *
 * Les trois constantes de ligue de ce fichier étaient fausses avant cette
 * mesure : BTTS 83 % contre 90.0 % observés, blanchissage 8.5 % contre 4.98 %,
 * et `GOALS_DISPERSION_K = 6.5` justifié par une sur-dispersion que les données
 * démentent (variance/moyenne = 0.979, donc légèrement SOUS-dispersé).
 */
describe('calibration — affiche moyenne contre les taux observés', () => {
  const AVG = { gamesPlayed: 60, goalsForPerGame: 3.05, goalsAgainstPerGame: 3.05 };

  beforeEach(() => {
    fetchTeams.mockResolvedValue([
      { id: 'X', abbreviation: 'X', ...AVG },
      { id: 'Y', abbreviation: 'Y', ...AVG },
    ]);
  });

  it('écarts de victoire : 40.0 / 19.5 / 40.5 observés', async () => {
    const d = (await predictMarginDistribution('X', 'Y', true))!;
    const by1 = d.win_1 + d.lose_1;
    const by2 = d.win_2 + d.lose_2;
    const by3 = d.win_3plus + d.lose_3plus;
    expect(by1).toBeGreaterThan(0.37); expect(by1).toBeLessThan(0.44);
    expect(by2).toBeGreaterThan(0.16); expect(by2).toBeLessThan(0.22);
    expect(by3).toBeGreaterThan(0.37); expect(by3).toBeLessThan(0.44);
    expect(by1 + by2 + by3).toBeCloseTo(1, 6);
  });

  it('prolongation : 22.0 % observés', async () => {
    const p = await predictGameToOvertime('X', 'Y');
    expect(p).toBeGreaterThanOrEqual(21);
    expect(p).toBeLessThanOrEqual(23);
  });

  it('les deux marquent : 90.0 % observés', async () => {
    const p = await predictBothTeamsScore('X', 'Y');
    expect(p).toBeGreaterThanOrEqual(87);
    expect(p).toBeLessThanOrEqual(92);
  });

  it('blanchissage : 4.98 % par équipe-match observés', async () => {
    const p = await predictCleanSheet('X', 'Y');
    expect(p).toBeGreaterThanOrEqual(4);
    expect(p).toBeLessThanOrEqual(7);
  });
});

describe('cohérence entre marchés — impossible par construction', () => {
  /**
   * P(l'adversaire est blanchi) ne peut jamais dépasser P(quelqu'un est
   * blanchi) = 100 − BTTS. Les deux se lisent sur la même matrice, donc
   * l'inégalité tient mécaniquement.
   *
   * Ce n'est pas une précaution théorique : le service Python calcule encore
   * ces deux marchés par deux chemins différents et viole l'inégalité pour de
   * vrai — BOS–SJS, 92 % « les deux marquent » et 10 % « blanchissage ».
   */
  it('blanchissage ≤ 100 − BTTS sur toute la grille', async () => {
    const gf = [2.5, 3.05, 3.6];
    const ga = [2.5, 3.05, 3.5];
    for (const agf of gf) for (const aga of ga)
      for (const bgf of gf) for (const bga of ga) {
        fetchTeams.mockResolvedValue([
          { id: 'A', abbreviation: 'A', gamesPlayed: 60, goalsForPerGame: agf, goalsAgainstPerGame: aga },
          { id: 'B', abbreviation: 'B', gamesPlayed: 60, goalsForPerGame: bgf, goalsAgainstPerGame: bga },
        ]);
        const btts  = await predictBothTeamsScore('A', 'B');
        const clean = await predictCleanSheet('A', 'B');
        expect(clean).toBeLessThanOrEqual(100 - btts);
      }
    fetchTeams.mockImplementation(async () => TEAMS);
  });
});
