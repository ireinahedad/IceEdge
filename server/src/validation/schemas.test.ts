import { describe, it, expect } from 'vitest';
import {
  registerSchema, loginSchema, avatarSchema, slipSubmitSchema, ruleWeightsSchema, profileUpdateSchema,
  singlePredictionSchema, parlayPredictionSchema, predictFactorsSchema,
  playerPropSchema, predictFuturesSchema, predictMlSchema,
} from './schemas';

describe('registerSchema', () => {
  it('rejects passwords under 8 chars', () => {
    const r = registerSchema.safeParse({ email: 'a@b.co', username: 'abc', password: 'short' });
    expect(r.success).toBe(false);
  });

  it('rejects usernames with invalid characters', () => {
    const r = registerSchema.safeParse({ email: 'a@b.co', username: 'bad name!', password: 'longenough' });
    expect(r.success).toBe(false);
  });

  it('normalises email (trim + lowercase)', () => {
    const r = registerSchema.safeParse({ email: '  A@B.CO ', username: 'abc', password: 'longenough' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe('a@b.co');
  });
});

describe('loginSchema', () => {
  it('accepts an optional remember flag', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x', remember: true }).success).toBe(true);
  });
});

describe('avatarSchema', () => {
  it('rejects a non data-URI', () => {
    expect(avatarSchema.safeParse({ avatarDataUrl: 'http://x/y.png' }).success).toBe(false);
  });
  it('rejects oversized images', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(2_900_000);
    expect(avatarSchema.safeParse({ avatarDataUrl: huge }).success).toBe(false);
  });
});

describe('slipSubmitSchema', () => {
  it('requires at least one leg', () => {
    expect(slipSubmitSchema.safeParse({ legs: [] }).success).toBe(false);
  });
  it('rejects more than 30 legs', () => {
    expect(slipSubmitSchema.safeParse({ legs: Array(31).fill({ a: 1 }) }).success).toBe(false);
  });
  it('accepts a bounded slip with a percentage probability', () => {
    expect(slipSubmitSchema.safeParse({ legs: [{ a: 1 }], sport: 'hockey', combinedProbability: 45 }).success).toBe(true);
  });
});

describe('ruleWeightsSchema', () => {
  it('accepts the shape the client actually stores', () => {
    const r = ruleWeightsSchema.safeParse({
      match:  { quality: 40, homeIce: 20, fatigue: 15, odds: 25 },
      totals: { expectedTotal: 60, shotPace: 40 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty store (aucun réglage)', () => {
    expect(ruleWeightsSchema.safeParse({}).success).toBe(true);
  });

  it('rejects a flat map — ce n_est pas la forme du store', () => {
    expect(ruleWeightsSchema.safeParse({ quality: 40 }).success).toBe(false);
  });

  it('rejects weights outside 0-100', () => {
    expect(ruleWeightsSchema.safeParse({ match: { quality: 101 } }).success).toBe(false);
    expect(ruleWeightsSchema.safeParse({ match: { quality: -1 } }).success).toBe(false);
  });

  it('rejects unbounded payloads (familles, facteurs, longueur de clé)', () => {
    const families = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, { a: 1 }]));
    expect(ruleWeightsSchema.safeParse(families).success).toBe(false);

    const factors = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, 1]));
    expect(ruleWeightsSchema.safeParse({ match: factors }).success).toBe(false);

    expect(ruleWeightsSchema.safeParse({ ['x'.repeat(33)]: { a: 1 } }).success).toBe(false);
    expect(ruleWeightsSchema.safeParse({ match: { ['y'.repeat(41)]: 1 } }).success).toBe(false);
  });

  it('rejects reserved keys', () => {
    expect(ruleWeightsSchema.safeParse({ ['__proto__']: { quality: 1 } }).success).toBe(false);
    expect(ruleWeightsSchema.safeParse({ match: { ['__proto__']: 1 } }).success).toBe(false);
  });

  it('rejects non-numeric weights', () => {
    expect(ruleWeightsSchema.safeParse({ match: { quality: '40' } }).success).toBe(false);
    expect(ruleWeightsSchema.safeParse({ match: { quality: NaN } }).success).toBe(false);
  });
});

describe('profileUpdateSchema', () => {
  it('accepte ce que l’écran Paramètres envoie réellement', () => {
    const r = profileUpdateSchema.safeParse({
      username: 'ireina',
      displayName: 'Ireina',
      bio: 'Fan des Bruins',
      favoriteTeam: 'BOS',
      isPublic: true,
      showSlips: false,
      notifyValueBets: true,
      valueBetMinEvPct: 3,
      openaiApiKey: null,
    });
    expect(r.success).toBe(true);
  });

  it('retire les clés inconnues au lieu de les laisser filer jusqu’au service', () => {
    const r = profileUpdateSchema.safeParse({ bio: 'ok', tier: 'legend', performanceScore: 9999 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ bio: 'ok' });
  });

  it('refuse les champs texte démesurés — c’est tout l’objet du schéma', () => {
    // Colonnes `TEXT` : sans borne ici, ces 100 ko partaient en base et
    // revenaient dans CHAQUE lecture de profil.
    expect(profileUpdateSchema.safeParse({ bio: 'x'.repeat(100_000) }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ displayName: 'x'.repeat(500) }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ openaiApiKey: 'x'.repeat(5_000) }).success).toBe(false);
  });

  it('refuse un type qui ne correspond pas', () => {
    expect(profileUpdateSchema.safeParse({ isPublic: 'oui' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ valueBetMinEvPct: 'beaucoup' }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ ruleWeights: { match: { quality: 101 } } }).success).toBe(false);
  });

  it('laisse passer `null` là où le client efface une valeur', () => {
    expect(profileUpdateSchema.safeParse({ openaiApiKey: null }).success).toBe(true);
    expect(profileUpdateSchema.safeParse({ avatarUrl: null }).success).toBe(true);
    expect(profileUpdateSchema.safeParse({ ruleWeights: null }).success).toBe(true);
  });

  it('garde `username` large — la vraie règle vit dans le service', () => {
    // Le service tranche 3-20 minuscules AVEC le contrôle d'unicité et le
    // message affiché par l'UI ; dupliquer la règle ici la ferait diverger.
    expect(profileUpdateSchema.safeParse({ username: 'Deux Mots' }).success).toBe(true);
  });
});


// ── Prédiction ────────────────────────────────────────────────────────────────
//
// Ces schémas gardent les routes les plus chères du serveur. Les cas ci-dessous
// sont donc écrits dans les deux sens : ce qu'ils doivent refuser (l'abus), et
// ce qu'ils NE DOIVENT PAS refuser (les corps que le client envoie vraiment
// aujourd'hui — c'est le vrai risque de régression).

describe('singlePredictionSchema', () => {
  it("accepte le corps de la landing (gameId seul)", () => {
    expect(singlePredictionSchema.safeParse(
      { marketType: 'total_goals', gameId: '2025020123', selection: 'over', line: 5.5 },
    ).success).toBe(true);
  });

  it("accepte teamId vide — GamePrediction.tsx l'envoie ainsi", () => {
    // `resolveSubjects` déduit les équipes depuis `gameId` ; refuser la chaîne
    // vide casserait la page de prédiction d'un match.
    const r = singlePredictionSchema.safeParse({ marketType: 'moneyline', gameId: '2025020123', teamId: '' });
    expect(r.success).toBe(true);
  });

  it('accepte un marché hors union — le moteur en connaît plus que le type', () => {
    // `computeProbability` traite `last_goal_scorer`, absent de `BetMarketType`.
    expect(singlePredictionSchema.safeParse({ marketType: 'last_goal_scorer', playerId: '8478402' }).success).toBe(true);
  });

  it('refuse un marketType qui n\'en est pas un', () => {
    expect(singlePredictionSchema.safeParse({ marketType: 'A'.repeat(200) }).success).toBe(false);
    expect(singlePredictionSchema.safeParse({ marketType: { $ne: null } }).success).toBe(false);
    expect(singlePredictionSchema.safeParse({}).success).toBe(false);
  });

  it('refuse une ligne non finie', () => {
    expect(singlePredictionSchema.safeParse({ marketType: 'shots_ou', line: 1e9 }).success).toBe(false);
  });

  it('retire les champs que le serveur ne lit pas', () => {
    const r = singlePredictionSchema.safeParse({ marketType: 'moneyline', period: 2, seasonContext: { lastNGames: 5 } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('period' in r.data).toBe(false);
      expect('seasonContext' in r.data).toBe(false);
    }
  });
});

describe('parlayPredictionSchema', () => {
  it('accepte un coupon normal', () => {
    expect(parlayPredictionSchema.safeParse({
      legs: [{ marketType: 'moneyline', probability: 62 }, { marketType: 'total_goals', probability: 55 }],
    }).success).toBe(true);
  });

  it('refuse une probabilité non numérique — la route renvoyait NaN au client', () => {
    expect(parlayPredictionSchema.safeParse({ legs: [{ marketType: 'moneyline', probability: null }] }).success).toBe(false);
    expect(parlayPredictionSchema.safeParse({ legs: [{ marketType: 'moneyline', probability: '62' }] }).success).toBe(false);
    expect(parlayPredictionSchema.safeParse({ legs: [{ marketType: 'moneyline', probability: 140 }] }).success).toBe(false);
  });

  it('exige au moins une jambe et en plafonne 30', () => {
    expect(parlayPredictionSchema.safeParse({ legs: [] }).success).toBe(false);
    const leg = { marketType: 'moneyline', probability: 50 };
    // 30 = le plafond de `slipSubmitSchema` : un coupon soumettable doit rester
    // calculable.
    expect(parlayPredictionSchema.safeParse({ legs: Array(30).fill(leg) }).success).toBe(true);
    expect(parlayPredictionSchema.safeParse({ legs: Array(31).fill(leg) }).success).toBe(false);
  });
});

describe('predictFactorsSchema', () => {
  it('refuse un type hors des deux branches de buildRealFactors', () => {
    expect(predictFactorsSchema.safeParse({ type: 'team', id: 'TOR' }).success).toBe(true);
    expect(predictFactorsSchema.safeParse({ type: 'goalie', id: 'x' }).success).toBe(false);
  });

  it('borne fallbackPct', () => {
    expect(predictFactorsSchema.safeParse({ type: 'player', id: '8478402', context: { fallbackPct: 63 } }).success).toBe(true);
    expect(predictFactorsSchema.safeParse({ type: 'player', id: '8478402', context: { fallbackPct: 900 } }).success).toBe(false);
  });
});

describe('playerPropSchema', () => {
  it('accepte le corps de PlayerPropPrediction.tsx', () => {
    const r = playerPropSchema.safeParse({
      playerId: '8478402', playerName: 'Connor McDavid', propType: 'points', line: 118,
      season: '2025-26', currentGoals: 30, currentPoints: 80, gamesPlayed: 50,
    });
    expect(r.success).toBe(true);
    // Les stats du client sont retirées : le handler les recalcule depuis
    // `fetchPlayerById`, et un chiffre venu du client ne doit jamais entrer.
    if (r.success) expect('currentPoints' in r.data).toBe(false);
  });

  it('refuse un propType inconnu', () => {
    expect(playerPropSchema.safeParse({ playerName: 'X', propType: 'hits', line: 10 }).success).toBe(false);
  });
});

describe('predictFuturesSchema', () => {
  it('accepte les trois marchés à terme, refuse le reste', () => {
    expect(predictFuturesSchema.safeParse({ teamName: 'Maple Leafs', teamId: 'TOR', propType: 'cup' }).success).toBe(true);
    expect(predictFuturesSchema.safeParse({ teamName: 'Maple Leafs', propType: 'president' }).success).toBe(false);
  });
});

describe('predictMlSchema', () => {
  it('accepte le corps de BestBetsSection (landing, sans compte)', () => {
    expect(predictMlSchema.safeParse({ type: 'game', subjectId: 'TOR', opponentId: '2025020123' }).success).toBe(true);
  });

  it('exige un subjectId non vide — c\'est la clé de cache de mlApiClient', () => {
    expect(predictMlSchema.safeParse({ type: 'game', subjectId: '' }).success).toBe(false);
    expect(predictMlSchema.safeParse({ type: 'game' }).success).toBe(false);
  });

  it('refuse un type inconnu', () => {
    expect(predictMlSchema.safeParse({ type: 'goalie', subjectId: 'x' }).success).toBe(false);
  });
});
