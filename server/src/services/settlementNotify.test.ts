import { describe, expect, it } from 'vitest';
import { settledMessages } from './settlementNotify';

describe('settledMessages', () => {
  it('un seul pari simple gagné → détail, dans les deux langues, lien vers les paris', () => {
    const [m] = settledMessages([{ userId: 'u1', outcome: 'win', xp: 45, legs: 1 }]);
    expect(m.userId).toBe('u1');
    expect(m.payload).toEqual({
      fr: { title: 'Pari gagné ✅', body: 'Ton pari est gagné · +45 XP', url: '/player/u1' },
      en: { title: 'Bet won ✅', body: 'Your bet won · +45 XP', url: '/player/u1' },
    });
  });

  it('un combiné perdu → nombre de jambes et XP négative', () => {
    const [m] = settledMessages([{ userId: 'u1', outcome: 'loss', xp: -12, legs: 3 }]);
    expect((m.payload as any).fr.body).toBe('Ton combiné de 3 paris est perdu · -12 XP');
    expect((m.payload as any).en.body).toBe('Your 3-leg parlay lost · -12 XP');
  });

  it('plusieurs coupons du même utilisateur → UNE notification résumée', () => {
    const msgs = settledMessages([
      { userId: 'u1', outcome: 'win',  xp: 40,  legs: 1 },
      { userId: 'u1', outcome: 'win',  xp: 20,  legs: 2 },
      { userId: 'u1', outcome: 'loss', xp: -10, legs: 1 },
      { userId: 'u2', outcome: 'void', xp: 0,   legs: 1 },
    ]);
    expect(msgs).toHaveLength(2);
    const u1 = msgs.find((m) => m.userId === 'u1')!.payload as any;
    expect(u1.fr).toEqual({ title: '3 paris réglés', body: '2 gagnés, 1 perdu · +50 XP', url: '/player/u1' });
    expect(u1.en).toEqual({ title: '3 bets settled', body: '2 won, 1 lost · +50 XP', url: '/player/u1' });
    const u2 = msgs.find((m) => m.userId === 'u2')!.payload as any;
    expect(u2.fr.title).toBe('Pari annulé');
  });

  it('rien de réglé → aucun message', () => {
    expect(settledMessages([])).toEqual([]);
  });
});
