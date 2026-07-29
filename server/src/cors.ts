/**
 * cors.ts — politique d'origine unique, partagée par HTTP et WebSocket.
 *
 * Pourquoi un module à part : `app.ts` traitait CORS_ORIGIN comme une liste
 * séparée par des virgules, plus une regex pour les déploiements de
 * prévisualisation Vercel, tandis que `socket.ts` passait la variable BRUTE à
 * Socket.io. Conséquence : dès que CORS_ORIGIN contient deux origines, la
 * chaîne complète « https://a.com,https://b.com » n'égale aucune origine réelle
 * et le WebSocket est refusé pour TOUT LE MONDE — y compris pour la première
 * origine, qui fonctionnait avant qu'on en ajoute une seconde. Le chat tombe
 * alors que l'API répond normalement, ce qui rend la panne difficile à
 * diagnostiquer.
 *
 * Une seule définition, deux consommateurs : les deux couches ne peuvent plus
 * diverger.
 */

/** Origines autorisées, depuis CORS_ORIGIN (liste séparée par des virgules). */
export const allowedOrigins = (
  process.env.CORS_ORIGIN || process.env.CLIENT_URL || 'http://localhost:5173'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Déploiements de prévisualisation Vercel du projet.
 * Ex. https://ice-edge-<hash>-ireina-hedad-s-projects.vercel.app
 *
 * L'ancre `^…$` est essentielle : sans elle, un domaine hostile du type
 * `https://ice-edge.vercel.app.attaquant.com` passerait.
 */
export const vercelPreview = /^https:\/\/ice-edge[a-z0-9-]*\.vercel\.app$/i;

/**
 * Une origine est-elle autorisée ?
 *
 * `undefined` = requête sans en-tête Origin (curl, sondes de santé, clients non
 * navigateur). Ce n'est pas une requête cross-origin : rien à protéger, on
 * laisse passer. Les navigateurs envoient toujours Origin en cross-origin, donc
 * cette porte n'en ouvre aucune côté navigateur.
 */
export function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;
  return allowedOrigins.includes(origin) || vercelPreview.test(origin);
}

/**
 * Callback au format attendu par le paquet `cors` — utilisé tel quel par
 * Express ET par Socket.io, qui embarque le même paquet.
 */
export function corsOriginCallback(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void {
  if (isAllowedOrigin(origin)) return cb(null, true);
  cb(new Error(`Not allowed by CORS: ${origin}`));
}
