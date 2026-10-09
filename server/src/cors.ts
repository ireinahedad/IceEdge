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
 *
 * ⚠️ LE SUFFIXE D'ÉQUIPE EST LA PARTIE QUI PROTÈGE, PAS LE PRÉFIXE.
 * La version précédente était `^https://ice-edge[a-z0-9-]*\.vercel\.app$`, donc
 * elle acceptait AUSSI `https://ice-edge-nimportequoi.vercel.app`. Or un
 * sous-domaine `<projet>.vercel.app` s'attribue au premier arrivé, sur
 * N'IMPORTE QUEL compte Vercel : il suffisait de créer un projet nommé
 * `ice-edge-x` pour obtenir une origine autorisée. Avec `credentials: true` et
 * le cookie de refresh en SameSite=None, une page hébergée là pouvait appeler
 * POST /api/auth/refresh avec les cookies de la victime ET LIRE LA RÉPONSE —
 * donc repartir avec un jeton d'accès valide. Prise de contrôle de compte
 * complète, sans XSS.
 *
 * Le slug d'équipe (`-ireina-hedad-s-projects`) n'est pas attribuable à un
 * tiers : il vient du compte propriétaire. C'est lui qui ferme la porte.
 * Si le nom de l'équipe Vercel change, cette constante doit changer avec.
 *
 * Le domaine de production (arakice.com, ice-edge.vercel.app) n'a rien à faire
 * ici : il se déclare dans CORS_ORIGIN, explicitement.
 */
const VERCEL_TEAM_SLUG = process.env.VERCEL_TEAM_SLUG || 'ireina-hedad-s-projects';
export const vercelPreview = new RegExp(
  `^https://ice-edge-[a-z0-9-]+-${VERCEL_TEAM_SLUG.replace(/[^a-z0-9-]/gi, '')}\\.vercel\\.app$`,
  'i',
);

/**
 * Une origine est-elle autorisée ?
 *
 * `undefined` = requête sans en-tête Origin (curl, sondes de santé, clients non
 * navigateur). Ce n'est pas une requête cross-origin : rien à protéger, on
 * laisse passer. Les navigateurs envoient toujours Origin en cross-origin, donc
 * cette porte n'en ouvre aucune côté navigateur.
 */
/**
 * APPLE_PLAN 3.4 — the iOS app's WebView origin (Capacitor). In code rather than
 * in CORS_ORIGIN so a Railway variable edit can never lock the app out. Shared
 * with Socket.io through `socket.ts`, like the rest of this file.
 */
export const nativeOrigins = ['capacitor://localhost', 'ionic://localhost'];

export function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;
  return allowedOrigins.includes(origin) || nativeOrigins.includes(origin) || vercelPreview.test(origin);
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
