/**
 * B5 — EXPLOSION AVEC LE NOMBRE DE MATCHS / ÉQUIPES / JOUEURS
 *
 * LA QUESTION : le coût d'UNE exécution de `best-bets` grandit-il comme les
 * données, ou plus vite ?
 *
 * C'est la question qui ne se pose jamais en septembre et qui se paie en
 * janvier. Un soir de 4 matchs, tout va bien ; un soir de 14 matchs avec les
 * mêmes visiteurs, l'exécution coûte trois fois et demie plus cher — ou dix
 * fois, si un appel est émis par PAIRE de sujets au lieu d'un par sujet. Les
 * deux sont indiscernables tant qu'on ne mesure qu'un seul soir.
 *
 * CE QUI EST ACCEPTABLE : une croissance LINÉAIRE et bornée. `best-bets` doit
 * demander un calendrier par date, un classement pour toute la ligue, une fiche
 * par joueur distinct, et au plus `mlDepth` inférences (30 par défaut) quel que
 * soit le nombre de candidats. Le nombre d'appels ML, en particulier, ne doit
 * PAS suivre le nombre de matchs : il est plafonné par construction, et si le
 * plafond saute, la facture Python suit le calendrier NHL.
 *
 * CE QUI NE L'EST PAS : une croissance quadratique, ou un appel par candidat
 * généré (5 par match + 4 par joueur) au lieu d'un par sujet.
 *
 * La colonne « appels / sujet » est la plus lisible : c'est elle qui doit rester
 * plate. Un processus par palier, toujours pour la même raison.
 */

import { runChild } from './spawn';

/** Paliers : de la soirée creuse au calendrier complet de samedi soir. */
const PALIERS: Array<{ teams: number; games: number; players: number }> = [
  { teams: 8,  games: 4,  players: 10 },
  { teams: 16, games: 8,  players: 20 },
  { teams: 24, games: 12, players: 30 },
  { teams: 32, games: 16, players: 50 },
];

export interface B5Row {
  teams: number; games: number; players: number;
  status: number; ms: number; scanned: number; bets: number;
  nhl: number; odds: number; ml: number; sql: number;
  appels: number; gaspillage: number; mlMisses: number; mlDedup: number;
}

export function runB5(): B5Row[] {
  return PALIERS.map((p) => runChild<B5Row>('b5-rung', {
    BENCH_TEAMS: String(p.teams),
    BENCH_GAMES: String(p.games),
    BENCH_PLAYERS: String(p.players),
  }));
}

export function printB5(rows: B5Row[]): void {
  console.log('\n═══ B5 · Croissance avec la taille de la ligue — 1 exécution froide de best-bets ═══\n');
  console.log(' équipes │ matchs │ joueurs │ candidats │ nhl │ ml │ odds │ sql │ appels │ appels/sujet │ ms');
  console.log('─────────┼────────┼─────────┼───────────┼─────┼────┼──────┼─────┼────────┼──────────────┼─────');
  for (const r of rows) {
    const sujets = r.games + r.players;
    const parSujet = sujets ? (r.appels / sujets).toFixed(2) : '—';
    console.log(
      ` ${String(r.teams).padStart(7)} │ ${String(r.games).padStart(6)} │ ${String(r.players).padStart(7)} │` +
      ` ${String(r.scanned).padStart(9)} │ ${String(r.nhl).padStart(3)} │ ${String(r.ml).padStart(2)} │` +
      ` ${String(r.odds).padStart(4)} │ ${String(r.sql).padStart(3)} │ ${String(r.appels).padStart(6)} │` +
      ` ${parSujet.padStart(12)} │ ${String(r.ms).padStart(4)}`,
    );
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const facteurSujets = (last.games + last.players) / (first.games + first.players);
  const facteurAppels = first.appels ? last.appels / first.appels : 0;

  console.log(
    `\n  Sujets ×${facteurSujets.toFixed(1)}  →  appels sortants ×${facteurAppels.toFixed(1)}`,
  );
  if (facteurAppels > facteurSujets * 1.5) {
    console.log('  ✗ les appels croissent PLUS VITE que les données : chercher un appel par paire ou par candidat.');
  } else {
    console.log('  ✓ croissance au plus linéaire en nombre de sujets.');
  }

  // Le plafond ML est le garde-fou le plus important pour la facture : il doit
  // tenir quel que soit le calendrier.
  const mlMax = Math.max(...rows.map((r) => r.ml));
  const mlCroit = last.ml > first.ml * 2;
  console.log(
    mlMax > 60
      ? `  ✗ ${mlMax} inférences ML sur une exécution : le plafond mlDepth ne borne plus rien.`
      : `  ✓ inférences ML plafonnées (max observé : ${mlMax}${mlCroit ? ', croissantes mais bornées' : ', stables'}).`,
  );

  const odds = rows.map((r) => r.odds);
  console.log(
    odds.every((v) => v <= 2)
      ? `  ✓ appels The Odds API : ${odds.join(' / ')} — une passe par exécution, quel que soit le calendrier.`
      : `  ✗ appels The Odds API : ${odds.join(' / ')} — le seul amont facturé à l'appel suit les données.`,
  );

  const g = rows.filter((r) => r.gaspillage > 0);
  if (g.length) console.log(`  ⚠ gaspillage (même appel émis deux fois) à ${g.map((r) => `${r.games} matchs → ${r.gaspillage}`).join(', ')}`);
}

export function main(): void {
  printB5(runB5());
}
