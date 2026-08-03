/**
 * concurrency.ts
 * ------------------------------------------------------------------
 * Parallélisme BORNÉ. Une seule fonction, `mapLimit`, qui remplace les
 * `Promise.all(items.map(…))` dont la largeur dépend d'une donnée de la base.
 *
 * POURQUOI CE MODULE EXISTE
 *
 * `Promise.all` ne parallélise pas : il démarre TOUT, immédiatement. Sur une
 * liste de 10 éléments c'est identique à une boucle bornée ; sur une liste dont
 * la taille est le nombre d'abonnés, c'est un mode de défaillance :
 *
 *   - N sockets sortantes ouvertes d'un coup depuis un process Node unique —
 *     les descripteurs de fichiers et les ports éphémères s'épuisent bien avant
 *     le CPU, et l'erreur qui en sort (`EMFILE`, `EADDRNOTAVAIL`) ne ressemble
 *     en rien à sa cause ;
 *   - N requêtes Postgres lancées sur un pool de 10 : les N−10 autres attendent
 *     dans la file du pool, y compris celles des requêtes HTTP des utilisateurs,
 *     qui n'ont rien demandé. Le job de fond fait alors tomber l'API.
 *
 * Un plafond transforme les deux en « c'est plus lent », qui est un incident
 * qu'on n'a pas.
 *
 * POURQUOI PAS `p-limit` — c'est une dépendance de plus (et ESM-only depuis la
 * v4, ce que la compilation CommonJS de ce serveur ne prend pas) pour ~25
 * lignes. Le repo a déjà tranché de la même façon pour `TtlCache` vs
 * `lru-cache`.
 */

/**
 * Applique `fn` à chaque élément avec au plus `limit` exécutions simultanées.
 *
 * Sémantique volontairement identique à `Promise.all(items.map(fn))`, à la
 * largeur près :
 *   - les résultats sont renvoyés DANS L'ORDRE des entrées, pas dans l'ordre
 *     d'achèvement ;
 *   - la première erreur rejette (les tâches déjà démarrées vont à leur terme,
 *     comme avec `Promise.all` ; aucune nouvelle n'est démarrée).
 *
 * Un appelant qui veut « continuer malgré les échecs » — c'est le cas du
 * fan-out push, où l'échec d'un appareil ne doit pas priver les autres — attrape
 * l'erreur DANS `fn` et renvoie un résultat. C'est explicite, donc lisible, et
 * ça évite un second mode de fonctionnement caché dans ce helper.
 *
 * @param limit plafond de tâches simultanées. ≤ 0 ou non fini → traitement
 *              séquentiel (1), jamais illimité : une valeur de configuration
 *              aberrante ne doit pas rouvrir le trou que cette fonction ferme.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
  const results = new Array<R>(items.length);
  let next = 0;

  // `width` consommateurs qui se partagent le curseur. Pas de récursion : la
  // profondeur de pile ne dépend donc pas du nombre d'éléments.
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
  return results;
}
