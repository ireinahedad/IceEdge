#!/usr/bin/env node
/**
 * bench/run.js — lanceur des bancs.
 *
 * POURQUOI UN LANCEUR PLUTÔT QU'UNE LIGNE `ts-node` DANS LE README
 *
 * Deux raisons, toutes deux apprises en essayant de faire sans :
 *
 * 1. Les fichiers de `loadtest/` vivent HORS de `server/`, donc hors de la
 *    portée de `server/tsconfig.json` (`rootDir: ./src`) et de
 *    `server/node_modules`. Il faut des options de compilation explicites, et
 *    elles sont trop longues pour une ligne de commande qu'on retape.
 *
 * 2. `ignoreDeprecations` change de valeur acceptée d'une version de TypeScript
 *    à l'autre : TypeScript 5.9 REFUSE de compiler `moduleResolution=node10`
 *    sans `"6.0"`, et TypeScript 5.4 refuse la valeur `"6.0"`. Une ligne figée
 *    dans le README ne marche donc que sur la machine de celui qui l'a écrite.
 *    Ici la valeur est choisie d'après la version réellement installée.
 *
 * USAGE (depuis `server/`, où sont les dépendances) :
 *
 *   node ../loadtest/bench/run.js smoke
 *   node ../loadtest/bench/run.js all
 *   node ../loadtest/bench/run.js cache          # un banc précis
 *
 * Chaque banc tourne dans SON PROCESSUS (`all` en enchaîne plusieurs) : c'est
 * la seule façon d'avoir des caches réellement froids. `/metrics/reset` remet
 * les compteurs à zéro mais laisse les caches chauds — ce qui donnerait un faux
 * « 0 exécution » (README §7, scénario S3).
 */

const path = require('path');

// `ts-node` ET `typescript` sont résolus depuis `server/`, jamais depuis une
// installation globale : une version globale différente de celle du projet
// compile avec d'autres règles, et le message d'erreur ne dit pas d'où elle
// vient (vécu : `--ignoreDeprecations` invalide alors que la version du projet
// l'exige).
const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
const fromServer = (id) => require(require.resolve(id, { paths: [SERVER_DIR] }));

fromServer('ts-node').register({
  transpileOnly: true,
  // `moduleResolution` est délibérément ABSENT. Le poser explicitement (même à
  // sa valeur par défaut, `node10`) déclenche sur TypeScript ≥ 5.9 une erreur
  // de dépréciation bloquante — et `ignoreDeprecations`, la parade documentée,
  // est refusée par ts-node quand les options passent par cette API. Laissé
  // implicite, `module: commonjs` choisit la bonne résolution tout seul, sur
  // toutes les versions.
  compilerOptions: {
    module: 'commonjs',
    target: 'es2022',
    esModuleInterop: true,
    resolveJsonModule: true,
    skipLibCheck: true,
    strict: false,
  },
  // Le tsconfig de `server/` limite `rootDir` à `src/` : l'ignorer évite un
  // conflit sur des fichiers qui vivent dans `loadtest/`.
  skipProject: true,
});

const name = process.argv[2] || 'all';
const mod = require(path.join(__dirname, `${name}.ts`));

// Convention : chaque banc exporte `main()`. Un module qui s'exécuterait à
// l'import ne pourrait pas être réutilisé par l'orchestrateur `all`.
if (typeof mod.main === 'function') {
  Promise.resolve(mod.main()).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
