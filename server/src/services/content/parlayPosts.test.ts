import { describe, it, expect } from 'vitest';
import {
  buildParlayPost, parlayComplianceProblems, recordLine, etTime, pct, DISCLAIMER,
  lastNightLine, youtubePublishAt,
} from './parlayPosts';

/** Les deux vidéos des combinés : plans, légendes, garde-fous (MARKETING_PLAN Phase C). */

function leg(over: Partial<any> = {}): any {
  return {
    id: 'bb-1-ml', subjectType: 'game', marketType: 'moneyline', marketLabel: 'Moneyline',
    subjectId: '1', subjectName: 'BOS vs NYR', teamAbbr: 'BOS', label: 'BOS to win',
    selectionValue: 'bos', line: null, gameId: '1', playerId: null, score: 64.6,
    game: { date: '2026-10-22', startTimeUTC: '2026-10-22T23:00:00Z', home: 'BOS', away: 'NYR' },
    ...over,
  };
}
function parlay(rank: number, over: Partial<any> = {}): any {
  return {
    date: '2026-10-22', rank, parlayId: `p${rank}`, kind: 'moneyline',
    legs: [leg(), leg({ label: 'Over 5.5', teamAbbr: null, marketLabel: 'Total Goals', score: 58 })],
    probability: 29.64, bookPrice: null, firstStartUTC: null, frozenAt: '', status: 'pending',
    legResults: null, settledAt: null, youtubePickId: null, youtubeResultId: null,
    tiktokPickSentAt: null, tiktokResultSentAt: null, ...over,
  };
}
const record = { since: '2026-10-14', won: 4, lost: 3, void: 0, pending: 2, winPct: 57.1 };

describe('formats', () => {
  it('heure de l’Est, pourcentages, bilan', () => {
    expect(etTime('2026-10-22T23:00:00Z')).toBe('7:00 PM ET');
    expect(etTime(null)).toBe('');
    expect(pct(29.64)).toBe('30%');
    expect(pct(8.24)).toBe('8.2%');
    expect(recordLine(record)).toBe('4-3 (57%) since Oct 14');
    expect(recordLine({ ...record, won: 0, lost: 0, winPct: null })).toBeNull();
  });
});

describe('buildParlayPost — pick', () => {
  const post = buildParlayPost('pick', '2026-10-22', [parlay(1), parlay(2)], record);

  it('ouverture, un plan par combiné, carte de fin — 10 à 20 s', () => {
    expect(post.candidate_id).toBe('2026-10-22-parlays-pick');
    expect(post.slides.map((s) => s.kind)).toEqual(['intro', 'card', 'card', 'cta']);
    expect(post.slides.every((s) => s.template === 'parlay_pick')).toBe(true);
    const total = post.slides.reduce((a, s) => a + s.duration, 0);
    expect(total).toBeGreaterThanOrEqual(10);
    expect(total).toBeLessThanOrEqual(20);
    expect(post.slides[0].intro.record).toBe('Record 4-3 (57%) since Oct 14');
  });

  it('une jambe montre ce que l’API a gelé : libellé, match, heure, probabilité', () => {
    const [ml, total] = post.slides[1].parlay.legs;
    expect(ml).toMatchObject({ label: 'BOS to win', logo: 'BOS', context: 'NYR @ BOS · 7:00 PM ET', pct: '65%' });
    expect(total).toMatchObject({ logo: null, logos: ['NYR', 'BOS'] });   // total de match : les deux clubs
    expect(post.slides[1].parlay.probability).toBe('30%');
  });

  it('légendes : mention 18+, lien UTM vers arakice.com, hashtags du plan', () => {
    expect(post.caption_tiktok).toContain(DISCLAIMER);
    expect(post.youtube_description).toContain('utm_source=youtube');
    expect(post.youtube_description).toContain('https://arakice.com/match/2026-10-22');
    expect(post.youtube_title).toBe("Tonight's NHL Parlays — Oct 22 #Shorts");
    expect(post.hashtags).toEqual(['#NHL', '#hockey', '#NHLPicks', '#Parlay']);
    expect(parlayComplianceProblems(post)).toEqual([]);
  });

  it('avant le premier résultat : pas de bilan inventé', () => {
    const p = buildParlayPost('pick', '2026-10-22', [parlay(1)], { ...record, won: 0, lost: 0, winPct: null });
    expect(p.slides[0].intro.record).toBeNull();
    expect(p.caption_tiktok).not.toContain('Record');
  });
});

describe('buildParlayPost — result', () => {
  const settled = [
    parlay(1, { status: 'won', legResults: ['win', 'win'] }),
    parlay(2, { status: 'lost', legResults: ['loss', 'void'] }),
  ];
  const post = buildParlayPost('result', '2026-10-22', settled, { ...record, won: 5, lost: 4, winPct: 55.6 });

  it('✓/✗ par jambe, WON / LOST, bilan cumulé avant la carte de fin', () => {
    expect(post.slides.map((s) => s.kind)).toEqual(['intro', 'card', 'card', 'record', 'cta']);
    expect(post.slides[0].intro.line).toBe('1 of 2 hit');
    expect(post.slides[1].parlay.status).toBe('WON');
    expect(post.slides[2].parlay.status).toBe('LOST');
    expect(post.slides[2].parlay.legs.map((l: any) => l.result)).toEqual(['loss', 'void']);
    expect(post.slides[3].record).toMatchObject({ pct: '56%', line: '5-4', since: 'since Oct 14' });
    expect(post.caption_instagram).toContain('Parlay 2 — LOST: ❌ BOS to win · ➖ Over 5.5');
    expect(parlayComplianceProblems(post)).toEqual([]);
  });
});

describe('parlayComplianceProblems', () => {
  const base = buildParlayPost('pick', '2026-10-22', [parlay(1)], record);

  it('refuse une promesse de gain, un bookmaker, une mention 18+ manquante', () => {
    expect(parlayComplianceProblems({ ...base, caption_tiktok: `A guaranteed lock. ${DISCLAIMER}` }))
      .toEqual(expect.arrayContaining(['caption_tiktok : « guaranteed »', 'caption_tiktok : « lock »']));
    expect(parlayComplianceProblems({ ...base, youtube_description: `Bet it on DraftKings. ${DISCLAIMER}` }))
      .toContain('youtube_description : « draftkings »');
    expect(parlayComplianceProblems({ ...base, caption_instagram: 'no disclaimer' }))
      .toContain('caption_instagram : mention 18+ absente');
  });

  it('pas de faux positif dans un nom (« Blackhawks » ≠ « lock »)', () => {
    const p = buildParlayPost('pick', '2026-10-22', [parlay(1, {
      legs: [leg({ label: 'CHI to win', subjectName: 'Blackhawks vs Locksmiths' })],
    })], record);
    expect(parlayComplianceProblems(p)).toEqual([]);
  });

  it('refuse un lien hors arakice.com dans la description', () => {
    expect(parlayComplianceProblems({ ...base, youtube_description: `${base.youtube_description} https://example.com` }))
      .toContain('youtube_description : lien hors arakice.com');
  });
});

describe('aucun combiné', () => {
  it('lève : on ne publie pas une vidéo vide', () => {
    expect(() => buildParlayPost('pick', '2026-10-22', [], record)).toThrow();
  });
});

describe('vidéo du jour seule (2026-10-26) : « Last night » et Short programmé', () => {
  it('lastNightLine : rien sans veille ou si un combiné n’est pas réglé ; void non compté', () => {
    expect(lastNightLine(null)).toBeNull();
    expect(lastNightLine([])).toBeNull();
    expect(lastNightLine([parlay(1, { status: 'won' }), parlay(2, { status: 'pending' })])).toBeNull();
    expect(lastNightLine([parlay(1, { status: 'won' }), parlay(2, { status: 'lost' })])).toBe('Last night: 1 of 2 hit');
    expect(lastNightLine([parlay(1, { status: 'lost' }), parlay(2, { status: 'void' })])).toBe('Last night: 0 of 1 hit');
    expect(lastNightLine([parlay(1, { status: 'void' })])).toBeNull();
  });

  it('la ligne passe sur l’ouverture et dans les légendes ; jamais en mode résultat', () => {
    const y = [parlay(1, { status: 'won' }), parlay(2, { status: 'lost' })];
    const post = buildParlayPost('pick', '2026-10-22', [parlay(1)], record, y);
    expect(post.slides[0].intro.last).toBe('Last night: 1 of 2 hit');
    expect(post.caption_tiktok).toContain('Last night: 1 of 2 hit. Record: 4-3 (57%) since Oct 14.');
    expect(post.youtube_description).toContain('Last night: 1 of 2 hit.');
    expect(parlayComplianceProblems(post)).toEqual([]);
    expect(buildParlayPost('pick', '2026-10-22', [parlay(1)], record).slides[0].intro.last).toBeNull();
    const res = buildParlayPost('result', '2026-10-22', [parlay(1, { status: 'won', legResults: ['win', 'win'] })], record, y);
    expect(res.slides[0].intro.last).toBeUndefined();
  });

  it('youtubePublishAt : 1er match − 2 h, sinon tout de suite', () => {
    const now = Date.parse('2026-10-27T06:05:00Z');   // 14 h 05 à Bali
    expect(youtubePublishAt(['2026-10-27T23:00:00Z', '2026-10-27T23:30:00Z'], now)).toBe('2026-10-27T21:00:00.000Z');
    expect(youtubePublishAt(['2026-10-27T23:30:00Z', null, '2026-10-27T23:00:00Z'], now)).toBe('2026-10-27T21:00:00.000Z');
    expect(youtubePublishAt([null], now)).toBeNull();
    // Rattrapage tardif : moins de 15 min avant l'heure prévue → tout de suite.
    expect(youtubePublishAt(['2026-10-27T23:00:00Z'], Date.parse('2026-10-27T20:50:00Z'))).toBeNull();
  });
});

describe('textes Reddit / X (MARKETING_PLAN Phase G)', () => {
  const post = buildParlayPost('pick', '2026-10-22', [parlay(1), parlay(2)], record, [parlay(1, { status: 'won' }), parlay(2, { status: 'lost' })]);
  it('Reddit : jambes avec match et %, bilan, mention 18+, aucun lien', () => {
    expect(post.text_reddit).toContain('**Parlay 1 — model 30%**');
    expect(post.text_reddit).toContain('- Over 5.5 (NYR @ BOS) — 58%');
    expect(post.text_reddit).toContain('Record: 4-3 (57%) since Oct 14.');
    expect(post.text_reddit).toContain(DISCLAIMER);
    expect(post.text_reddit).not.toMatch(/https?:|arakice\.com/);
    expect(parlayComplianceProblems(post)).toEqual([]);
  });
  it('X : lien UTM x', () => {
    expect(post.text_x).toContain('utm_source=x');
    expect(post.text_x).toContain(DISCLAIMER);
  });
  it('Reddit : un lien bloque la publication', () => {
    expect(parlayComplianceProblems({ ...post, text_reddit: `${post.text_reddit} arakice.com` }))
      .toContain('text_reddit : lien interdit (règles Reddit)');
  });
  it('résultat : ✅/❌ par jambe', () => {
    const r = buildParlayPost('result', '2026-10-22', [parlay(1, { status: 'lost', legResults: ['win', 'loss'] })], record);
    expect(r.text_reddit).toContain('**Parlay 1 — LOST**');
    expect(r.text_reddit).toContain('- ❌ Over 5.5 (NYR @ BOS) — 58%');
  });
});
