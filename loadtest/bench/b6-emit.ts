/** B6 exécuté dans un processus enfant : sa sortie remonte à l'orchestrateur. */

import { run } from './b6-concurrence';
import { emit } from './spawn';

export async function main() {
  const { lignes, mesures } = await run(true);
  emit({ sortie: lignes.join('\n'), mesures });
}
