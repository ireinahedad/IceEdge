/**
 * Bundle le harnais avec esbuild, en remplaçant les quatre bords du hook par
 * des doublures.
 *
 * ⚠️ L'option `alias` d'esbuild REFUSE les chemins relatifs — d'où le plugin
 *    `onResolve`, qui est le seul moyen d'intercepter `../services/authService`.
 * ⚠️ `jsx: 'automatic'` est obligatoire, sinon la page meurt sur
 *    « React is not defined ».
 *
 * CLIENT = une copie de `client/` avec ses node_modules installés POUR LINUX
 * (voir la recette du conteneur cloud dans PRE_IOS_PLAN.md). Le node_modules
 * du poste Windows ne convient pas.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICI = dirname(fileURLToPath(import.meta.url));
const CLIENT = process.env.CLIENT ?? '/tmp/cli';

const esbuild = await import(join(CLIENT, 'node_modules/esbuild/lib/main.js'));

// Le chemin du hook n'est connu qu'ici : on le pose dans une copie du harnais.
const src = readFileSync(join(ICI, 'harness.tsx'), 'utf8')
  .replace('__HOOK__', join(CLIENT, 'src/app/hooks/useChatSocket'));
writeFileSync(join(ICI, '.harness.build.tsx'), src);

const doublures = {
  'socket.io-client':         join(ICI, 'stubs/socket.io-client.ts'),
  '../services/authService':  join(ICI, 'stubs/authService.ts'),
  '../services/tokenStore':   join(ICI, 'stubs/tokenStore.ts'),
  '../env':                   join(ICI, 'stubs/env.ts'),
};

await esbuild.build({
  entryPoints: [join(ICI, '.harness.build.tsx')],
  bundle: true,
  outfile: join(ICI, 'bundle.js'),
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  nodePaths: [join(CLIENT, 'node_modules')],
  plugins: [{
    name: 'doublures',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) =>
        doublures[args.path] ? { path: doublures[args.path] } : null);
    },
  }],
});

console.log('bundle ok');
