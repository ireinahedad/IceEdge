#!/usr/bin/env node
/**
 * h2h-export.mjs — fige l'historique des confrontations dans un fichier suivi.
 *
 * POURQUOI
 * `seo-gen.mjs` lit l'historique dans `ml/data/nhl_games_v4.csv` (43 Mo), que
 * `.gitignore` exclut du dépôt : le fichier n'existe que sur la machine qui
 * entraîne le modèle. Le générateur de pages de match, lui, tourne dans GitHub
 * Actions, où ce CSV n'existera jamais. Sans ce pont, les pages de match
 * seraient générées sans une ligne d'historique — c'est-à-dire sans la seule
 * chose qui les distingue d'un gabarit.
 *
 * CE QUE ÇA FAIT
 * Relit le CSV avec `loadH2H()` — la MÊME fonction que les pages d'affiche, pas
 * une deuxième lecture qui pourrait diverger — et écrit
 * `client/scripts/h2h-compact.json`, suivi par git (~300 Ko).
 *
 * Format : un tableau positionnel par match plutôt qu'un objet par match.
 * `{"d":"2024-10-08","h":"BOS",…}` coûte ~60 octets, `["2024-10-08","BOS",…]`
 * en coûte ~40 : sur 6 500 matchs c'est 130 Ko de diff en moins à chaque
 * réexport.
 *
 * QUAND LE RELANCER
 * À chaque rafraîchissement du jeu de données ML (donc rarement : une fois par
 * mois en saison suffit). Les rencontres de la saison en cours qui manquent au
 * CSV ne cassent rien — le générateur les complète depuis le calendrier NHL.
 *
 * Usage:  node scripts/h2h-export.mjs
 *         H2H_CSV=… node scripts/h2h-export.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadH2H } from "./seo-gen.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.H2H_OUT || path.join(__dirname, "h2h-compact.json");

const h2h = await loadH2H();
if (!h2h.size) {
  // Écrire un fichier vide écraserait en silence un export valide déjà commité
  // et viderait l'historique de toutes les pages au prochain déploiement.
  console.error("Aucune confrontation lue — le CSV est absent ou illisible. Rien n'a été écrit.");
  process.exit(1);
}

const pairs = {};
let games = 0;
for (const [key, list] of h2h) {
  pairs[key] = list.map((g) => [g.date, g.home, g.away, g.hs, g.as, g.ot ? 1 : 0]);
  games += list.length;
}

const payload = {
  _comment:
    "Généré par scripts/h2h-export.mjs depuis ml/data/nhl_games_v4.csv. Ne pas éditer à la main. Colonnes : [date, domicile, visiteur, buts_domicile, buts_visiteur, prolongation].",
  generatedAt: new Date().toISOString().slice(0, 10),
  pairs,
};

// Une paire par ligne : un diff lisible, et seules les paires qui ont joué
// depuis le dernier export bougent.
const body = Object.keys(pairs)
  .sort()
  .map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(pairs[k])}`)
  .join(",\n");
const json = `{
  "_comment": ${JSON.stringify(payload._comment)},
  "generatedAt": ${JSON.stringify(payload.generatedAt)},
  "pairs": {
${body}
  }
}
`;

await fs.writeFile(OUT, json, "utf-8");
console.log(`h2h-compact.json écrit : ${Object.keys(pairs).length} paires, ${games} matchs, ${(json.length / 1024).toFixed(0)} Ko → ${OUT}`);
