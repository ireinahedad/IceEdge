/**
 * B13 — ENDURANCE / FUITE MÉMOIRE (scénario S5)
 *
 * L'AUDIT LE CLASSE « le plus important pour le coût », et il a raison : une
 * fuite ne se voit sur aucune latence. Le serveur répond parfaitement jusqu'au
 * moment où le conteneur est tué pour dépassement mémoire — ce qui vide tous
 * les caches, provoque une tempête de requêtes amont au redémarrage, et
 * recommence. Le symptôme visible est « ça redémarre parfois » ; la cause se
 * lit uniquement sur une COURBE.
 *
 * LE PROFIL QUI RÉVÈLE : des clés de cache toutes différentes. Un trafic
 * répétitif tape toujours les mêmes entrées, donc une `Map` non bornée y
 * ressemble exactement à une `Map` bornée. Chaque itération demande ici une
 * date de calendrier, un joueur et une équipe jamais demandés — c'est la
 * consigne de S5, et c'est ce qui a motivé le plafond de `TtlCache` (un visiteur
 * qui fait défiler le calendrier créait une clé par plage consultée).
 *
 * CE QU'ON LIT : le RSS doit atteindre un PLATEAU. Une croissance linéaire
 * prédit un OOM, et la pente donne le délai. Les colonnes `taille/plafond` et
 * `évictions` disent pourquoi le plateau tient : c'est le bornage des caches
 * qui le produit, pas la chance.
 *
 * CE QUE CE BANC N'EST PAS. S5 demande 2 à 4 heures ; celui-ci tourne quelques
 * minutes. Il attrape une fuite FRANCHE — une structure qui grossit à chaque
 * requête — et il ne dira rien d'une fuite lente qui se compte en mégaoctets
 * par heure. Pour celle-là, il faut relever `memory.rssMb` sur `/api/dev/metrics`
 * en préproduction pendant une vraie soirée. Le banc borne le risque, il ne le
 * supprime pas.
 */

import { runChildNode } from './spawn';

export interface B13Releve {
  tMs: number; rssMb: number; heapMb: number;
  caches: Record<string, { size: number; maxEntries: number; evictions: number; hitRate: number }>;
}
export interface B13Row {
  dureeMs: number; pasMs: number; vus: number;
  iterations: number; erreurs: number; gcForce: boolean;
  releves: B13Releve[];
}

export function runB13(): B13Row {
  return runChildNode<B13Row>(
    'b13-rung',
    { BENCH_ENDURANCE_SECONDS: process.env.BENCH_ENDURANCE_SECONDS ?? '180' },
    // Sans `--expose-gc`, la courbe mesure le calendrier du ramasse-miettes.
    ['--expose-gc'],
  );
}

/** Pente par moindres carrés, en Mo par minute. */
function pente(points: Array<{ t: number; v: number }>): number {
  const n = points.length;
  if (n < 2) return 0;
  const mt = points.reduce((a, p) => a + p.t, 0) / n;
  const mv = points.reduce((a, p) => a + p.v, 0) / n;
  const num = points.reduce((a, p) => a + (p.t - mt) * (p.v - mv), 0);
  const den = points.reduce((a, p) => a + (p.t - mt) ** 2, 0);
  return den === 0 ? 0 : (num / den) * 60_000;
}

export function printB13(r: B13Row): void {
  console.log(
    `\n═══ B13 · Endurance — ${r.vus} boucles, ${Math.round(r.dureeMs / 1000)} s, clés de cache toutes différentes ═══\n` +
    `    ${r.iterations} itérations · ${r.erreurs} erreur(s) · ramasse-miettes forcé : ${r.gcForce ? 'oui' : 'NON (courbe bruitée)'}\n`,
  );

  console.log(' t (s) │  RSS (Mo) │ heap (Mo) │ caches (taille/plafond, évictions)');
  console.log('───────┼───────────┼───────────┼───────────────────────────────────');
  for (const e of r.releves) {
    const resume = Object.entries(e.caches)
      .filter(([, c]) => c.size > 0)
      .map(([nom, c]) => `${nom} ${c.size}/${c.maxEntries}${c.evictions ? ` év.${c.evictions}` : ''}`)
      .join('  ');
    console.log(
      ` ${String(Math.round(e.tMs / 1000)).padStart(5)} │ ${String(e.rssMb).padStart(9)} │` +
      ` ${String(e.heapMb).padStart(9)} │ ${resume}`,
    );
  }

  // ── Régime établi ───────────────────────────────────────────────────────
  //
  // Le premier quart est la MONTÉE EN RÉGIME : les caches se remplissent, le
  // JIT compile, le working set s'installe. Ici, 278 → 405 Mo en dix secondes,
  // puis plus rien. Ce n'est pas une fuite, c'est le coût d'exister — le lire
  // comme une pente ferait crier au loup à chaque exécution.
  const debutRegime = Math.max(1, Math.floor(r.releves.length / 4));
  const regime = r.releves.slice(debutRegime);
  const penteRss = pente(regime.map((e) => ({ t: e.tMs, v: e.rssMb })));
  const penteHeap = pente(regime.map((e) => ({ t: e.tMs, v: e.heapMb })));
  const premier = r.releves[0];
  const dernier = r.releves[r.releves.length - 1];
  const delta = dernier.rssMb - regime[0].rssMb;

  /**
   * Le BRUIT du relevé, mesuré et non supposé : l'écart typique entre deux
   * points consécutifs en régime établi. Même avec `--expose-gc`, le RSS
   * respire de quelques mégaoctets. Une pente plus petite que ce bruit n'est
   * pas une mesure, c'est une coïncidence — et un banc qui l'annonce comme une
   * fuite finit par être ignoré, ce qui est pire que pas de banc.
   */
  const ecarts = regime.slice(1).map((e, i) => Math.abs(e.rssMb - regime[i].rssMb));
  const bruit = ecarts.length ? ecarts.sort((a, b) => a - b)[Math.floor(ecarts.length / 2)] : 0;
  const minutes = (dernier.tMs - regime[0].tMs) / 60_000;
  /** Ce que cette durée permet de RÉSOUDRE : sous ce seuil, le banc ne sait pas. */
  const resolution = minutes > 0 ? Math.max(1, bruit * 3) / minutes : Infinity;

  console.log(
    `\n  RSS : ${premier.rssMb} → ${dernier.rssMb} Mo` +
    `  ·  en régime établi (après ${Math.round(regime[0].tMs / 1000)} s) : ` +
    `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} Mo en ${minutes.toFixed(1)} min` +
    `, soit ${penteRss >= 0 ? '+' : ''}${penteRss.toFixed(1)} Mo/min (heap ${penteHeap >= 0 ? '+' : ''}${penteHeap.toFixed(1)})`,
  );
  console.log(
    `  · bruit du relevé : ±${bruit.toFixed(1)} Mo entre deux points →` +
    ` ce tir ne sait pas distinguer une pente inférieure à ~${resolution.toFixed(1)} Mo/min.`,
  );

  /**
   * UNE PENTE POSITIVE N'EST PAS UNE FUITE, et confondre les deux est le piège
   * de ce banc.
   *
   * Observé ici même : RSS plat à 353 Mo pendant trente secondes, puis une
   * MARCHE à 412 Mo, puis plat de nouveau. Par moindres carrés ça fait
   * +65 Mo/min et « OOM dans une minute » — alors que la courbe est un palier.
   * V8 et l'allocateur système réservent par blocs et ne rendent pas la mémoire
   * à l'OS ; le RSS monte donc en escalier, pas en pente.
   *
   * Deux discriminants, qu'il faut réunir pour parler de fuite :
   *
   *  1. **La fin monte aussi.** Une fuite ne s'arrête pas : le dernier tiers
   *     doit croître comme le reste. Une marche suivie d'un plat, non.
   *  2. **Le TAS monte aussi.** Une fuite JavaScript retient des objets, donc
   *     `heapUsed` grossit. Un RSS qui monte à tas constant décrit l'allocateur,
   *     pas le code.
   */
  const dernierTiers = regime.slice(Math.max(0, regime.length - Math.max(3, Math.ceil(regime.length / 3))));
  const penteFin = pente(dernierTiers.map((e) => ({ t: e.tMs, v: e.rssMb })));

  const auDessusDuBruit = delta > Math.max(10, bruit * 3);
  const croitJusquAuBout = penteFin > resolution;
  const tasCroit = penteHeap > 1;

  if (auDessusDuBruit && penteRss > resolution && penteRss > 2 && croitJusquAuBout && tasCroit) {
    const marge = Math.max(0, 480 - dernier.rssMb);
    console.log(
      `  ✗ FUITE : la mémoire croît jusqu'au bout (+${penteFin.toFixed(1)} Mo/min sur le dernier tiers)\n` +
      `    ET le tas suit (+${penteHeap.toFixed(1)} Mo/min) — ce n'est donc pas l'allocateur.\n` +
      `    À ce rythme, il reste environ ${Math.round(marge / penteRss)} min avant 480 Mo.\n` +
      '    Chercher une structure indexée par une clé venue de la requête et jamais bornée.',
    );
  } else if (auDessusDuBruit && penteRss > 2) {
    console.log(
      `  ✓ MARCHE puis plateau, pas une fuite : +${delta.toFixed(1)} Mo sur la fenêtre, mais le dernier\n` +
      `    tiers est à ${penteFin >= 0 ? '+' : ''}${penteFin.toFixed(1)} Mo/min et le tas à ${penteHeap >= 0 ? '+' : ''}${penteHeap.toFixed(1)} Mo/min (plat).\n` +
      '    C\'est l\'allocateur qui réserve par blocs sans rendre à l\'OS — le code, lui, ne retient rien.',
    );
  } else {
    console.log(
      `  ✓ plateau : la mémoire ne suit plus le trafic` +
      ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} Mo sur ${minutes.toFixed(1)} min, dans le bruit).`,
    );
  }

  // Le plateau doit s'expliquer : c'est le bornage des caches qui le produit.
  const derniersCaches = Object.entries(dernier.caches);
  // Un cache à `maxEntries: 1` (leaderboard, odds-client) est plein dès sa
  // première entrée, par construction. Le signaler comme « saturé » serait du
  // bruit : ce qui compte est qu'il ÉVINCE, c'est-à-dire qu'il se vide lui-même.
  const satures = derniersCaches.filter(([, c]) => c.size >= c.maxEntries && c.evictions > 0 && c.maxEntries > 2);
  const evinces = derniersCaches.filter(([, c]) => c.evictions > 0);
  console.log(
    evinces.length
      ? `  · caches qui évincent (donc bornés, donc c'est bien EUX qui tiennent le plateau) :\n` +
        evinces.map(([n, c]) => `      ${n} — ${c.size}/${c.maxEntries}, ${c.evictions} évictions, ${(c.hitRate * 100).toFixed(1)} % de hits`).join('\n')
      : '  · aucune éviction : les plafonds n\'ont pas été atteints sur cette durée.',
  );
  if (satures.length) {
    console.log(
      `  ⚠ ${satures.map(([n]) => n).join(', ')} au plafond : le taux de hit s'effondre quand le cache\n` +
      '    se vide lui-même. Relever le plafond coûte de la mémoire ; ne pas le relever coûte\n' +
      '    de l\'amont. C\'est un arbitrage, pas un défaut — mais il se décide avec ce chiffre.',
    );
  }

  console.log(
    '\n  Rappel : S5 demande 2 à 4 h. Ceci attrape une fuite FRANCHE, pas une fuite lente\n' +
    '  de quelques mégaoctets par heure — pour celle-là, relever `memory.rssMb` sur\n' +
    '  `/api/dev/metrics` en préproduction pendant une vraie soirée de matchs.',
  );
}

export function main(): void {
  printB13(runB13());
}
