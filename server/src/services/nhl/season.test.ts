import { describe, it, expect, vi, afterEach } from 'vitest';
import { currentSeason, previousSeason } from './core';

/**
 * Ce que ce fichier protège : la BASCULE de saison, et le fait qu'elle tombe
 * en septembre.
 *
 * C'est un bogue qui ne se voit qu'une fois par an, pendant six semaines, et
 * jamais dans les journaux — les chiffres servis sont vrais, ce sont ceux de la
 * saison précédente. Au 19 septembre 2026, la fiche d'une équipe annonçait
 * « 48-22-8 » pour une saison où elle n'avait pas joué une minute. Personne
 * n'écrit un test après coup pour une fenêtre de six semaines déjà refermée ;
 * il faut donc l'écrire maintenant.
 */
describe('bascule de saison', () => {
  afterEach(() => { vi.useRealTimers(); });

  /**
   * ⚠️ Heure LOCALE, pas UTC.
   *
   * `currentSeason()` lit `new Date().getMonth()`, qui est local. Une date
   * écrite en UTC (« 2026-08-31T12:00:00Z ») tombe le 1er septembre pour qui
   * vit à UTC+8 — et le test du dernier jour d'août échouerait sur sa machine
   * tout en passant en CI. Le constructeur à composantes est local des deux
   * côtés, donc le test dit la même chose partout.
   *
   * `month` est l'indice JavaScript : 0 = janvier, 7 = août, 8 = septembre.
   */
  const at = (year: number, month: number, day: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(year, month, day, 12, 0, 0));
  };

  it('septembre appartient DÉJÀ à la nouvelle saison', () => {
    // Le cas qui a motivé le changement. Avec l'ancienne borne (octobre),
    // ce test rendait « 20252026 ».
    at(2026, 8, 19);
    expect(currentSeason()).toBe('20262027');
    expect(previousSeason()).toBe('20252026');
  });

  it('le 31 août appartient encore à la saison écoulée', () => {
    // La borne basse : un jour plus tôt, rien ne bascule.
    at(2026, 7, 31);
    expect(currentSeason()).toBe('20252026');
  });

  it('la saison régulière et les séries gardent la même saison', () => {
    at(2027, 0, 15);
    expect(currentSeason()).toBe('20262027');
    at(2027, 4, 20);   // finales
    expect(currentSeason()).toBe('20262027');
  });

  it('la bascule se rejoue seule chaque année', () => {
    // Rien à toucher l'an prochain : c'est la garantie demandée.
    at(2027, 8, 1);
    expect(currentSeason()).toBe('20272028');
    at(2028, 8, 1);
    expect(currentSeason()).toBe('20282029');
  });

  it('previousSeason précède toujours currentSeason d\'un an', () => {
    for (const [y, m, d] of [[2026, 8, 19], [2027, 0, 15], [2027, 5, 30], [2028, 8, 2]]) {
      at(y, m, d);
      const cur = Number(currentSeason().slice(0, 4));
      const prev = Number(previousSeason().slice(0, 4));
      expect(prev).toBe(cur - 1);
    }
  });
});
