/**
 * jwt.ts — décodage de la charge utile d'un JWT, côté client.
 *
 * ⚠️ Aucune vérification de signature ici, et il ne faut pas en attendre une :
 * le client lit ce jeton pour AFFICHER un nom et une route, jamais pour
 * autoriser quoi que ce soit. Toute décision d'accès est prise par le serveur,
 * qui vérifie la signature lui-même.
 *
 * ── Pourquoi ce module existe ───────────────────────────────────────────────
 * Deux appelants faisaient `JSON.parse(atob(token.split('.')[1]))`. C'est faux :
 * un JWT encode ses segments en **base64url**, pas en base64. Les deux alphabets
 * ne diffèrent que sur deux caractères (`-` au lieu de `+`, `_` au lieu de `/`)
 * et sur le remplissage `=` — donc ça marche presque toujours, et ça casse
 * exactement quand la charge utile contient un octet qui produit l'un de ces
 * caractères. `atob` lève alors `InvalidCharacterError`.
 *
 * Les deux appelants traitaient cette exception comme « jeton invalide » :
 *   • AuthContext, au démarrage → `tokenStore.clear()`, donc DÉCONNEXION de
 *     l'utilisateur, au hasard, sans qu'il ait rien fait ;
 *   • AuthCallback, après Google → redirection vers /login, donc connexion
 *     Google qui échoue « une fois sur N » sans message.
 *
 * Un bogue intermittent, invisible en test, et impossible à reproduire à la
 * demande. D'où une seule implémentation correcte, partagée.
 */

export interface JwtPayload {
  sub: string;
  email: string;
  role?: string;
  exp?: number;
  iat?: number;
  [k: string]: unknown;
}

/**
 * Décode la charge utile, ou rend `null` si le jeton est illisible.
 *
 * Rend `null` plutôt que de lever : les deux appelants voulaient déjà « en cas
 * de doute, pas de session », et une valeur de retour rend ce choix explicite
 * au lieu de le cacher derrière un `catch` qui attrape aussi bien une erreur de
 * décodage qu'un bogue de programmation.
 */
export function decodeJwtPayload(token: string | null | undefined): JwtPayload | null {
  if (!token) return null;
  const segment = token.split('.')[1];
  if (!segment) return null;

  try {
    // base64url → base64, puis remplissage à un multiple de 4.
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');

    // `atob` rend une chaîne d'octets ; les caractères non-ASCII (un prénom
    // accentué dans le jeton, par exemple) doivent repasser par UTF-8, sinon
    // « Chloé » devient « ChloÃ© ».
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);

    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' ? (payload as JwtPayload) : null;
  } catch {
    return null;
  }
}
