/**
 * bench/spawn.ts — exécute un palier de banc dans un PROCESSUS NEUF.
 *
 * POURQUOI — plusieurs bancs ne veulent mesurer qu'une chose : ce qui se passe
 * sur un cache FROID. Or `resetMetrics()` remet les compteurs à zéro sans vider
 * les caches (c'est documenté, et c'est le bon choix pour un tir de charge).
 * Mesurer deux paliers dans le même processus reviendrait donc à mesurer le
 * premier à froid et tous les suivants à chaud — en affichant les deux dans la
 * même colonne. Un processus par palier est la seule façon honnête.
 *
 * Le palier parle au parent par une ligne unique sur la sortie standard,
 * préfixée `##RESULT##`, ce qui laisse le reste du flux libre pour les
 * journaux sans brouiller le résultat.
 */

import { spawnSync } from 'child_process';
import { join } from 'path';

const RUNNER = join(__dirname, 'run.js');
const SERVER_DIR = join(__dirname, '..', '..', 'server');

export const MARK = '##RESULT##';

/** Depuis un palier : publie le résultat à destination du parent. */
export function emit(payload: unknown): void {
  process.stdout.write(`\n${MARK}${JSON.stringify(payload)}\n`);
}

/** Depuis l'orchestrateur : exécute `bench` avec `env`, rend son résultat. */
export function runChild<T = any>(bench: string, env: Record<string, string> = {}): T {
  const res = spawnSync(process.execPath, [RUNNER, bench], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  const out = `${res.stdout ?? ''}`;
  const line = out.split('\n').find((l) => l.startsWith(MARK));
  if (!line) {
    throw new Error(
      `Palier « ${bench} » sans résultat (code ${res.status}).\n` +
      `${(res.stderr ?? '').slice(-2000)}\n${out.slice(-2000)}`,
    );
  }
  return JSON.parse(line.slice(MARK.length)) as T;
}

/**
 * Exécute un banc qui imprime lui-même son tableau et rend sa sortie brute.
 *
 * Pour les bancs qui n'ont pas de « paliers » à agréger (B6, B8, B9) : ils
 * écrivent leur restitution, l'orchestrateur la relaie telle quelle. Passer par
 * un enfant reste nécessaire — ces bancs démarrent l'application, et
 * l'orchestrateur ne doit pas en héberger une.
 */
export function runChildOutput(bench: string, env: Record<string, string> = {}): string {
  const res = spawnSync(process.execPath, [RUNNER, bench], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`Banc « ${bench} » en échec (code ${res.status}).\n${(res.stderr ?? '').slice(-2000)}`);
  }
  return (res.stdout ?? '').trimEnd();
}

/**
 * Comme `runChild`, mais avec des options passées à Node lui-même.
 *
 * Sert à B13, qui a besoin de `--expose-gc` : sans déclencher le ramasse-miettes
 * avant chaque relevé, la courbe de RSS mesure surtout le MOMENT où V8 a décidé
 * de collecter, et une sciure de 40 Mo ressemble à une fuite. Un banc de fuite
 * mémoire qui ne peut pas distinguer les deux ne sert à rien.
 */
export function runChildNode<T = any>(
  bench: string,
  env: Record<string, string> = {},
  nodeArgs: string[] = [],
): T {
  const res = spawnSync(process.execPath, [...nodeArgs, RUNNER, bench], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout ?? ''}`;
  const line = out.split('\n').find((l) => l.startsWith(MARK));
  if (!line) {
    throw new Error(
      `Banc « ${bench} » sans résultat (code ${res.status}).\n` +
      `${(res.stderr ?? '').slice(-2000)}\n${out.slice(-2000)}`,
    );
  }
  return JSON.parse(line.slice(MARK.length)) as T;
}

/** Lit un entier d'environnement, avec défaut — les paliers se configurent ainsi. */
export function envInt(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}
