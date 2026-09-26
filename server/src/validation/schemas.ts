/**
 * schemas.ts — zod validation schemas for request bodies (H3).
 * Bounds every field so oversized/malformed input is rejected at the boundary.
 * Kept intentionally close to the existing hand-rolled checks so behaviour and
 * error messages don't change, only coverage and consistency.
 */

import { z } from 'zod';

const email    = z.string().trim().toLowerCase().email().max(255);
const password = z.string().min(8, 'Password must be at least 8 characters').max(200);
const code     = z.string().trim().regex(/^\d{6}$/, 'code must be 6 digits');

// ── Auth ──────────────────────────────────────────────────────────────────────
export const registerSchema = z.object({
  email,
  username:   z.string().trim().min(3).max(100).regex(/^[a-zA-Z0-9_.-]+$/, 'username has invalid characters'),
  password,
  first_name: z.string().trim().max(100).optional(),
  last_name:  z.string().trim().max(100).optional(),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
  remember: z.boolean().optional(),
});

export const verifyEmailSchema      = z.object({ email, code });
export const resendVerificationSchema = z.object({ email });
export const forgotPasswordSchema   = z.object({ email });
export const resetPasswordSchema    = z.object({ email, code, new_password: password });

// ── Slips ─────────────────────────────────────────────────────────────────────
// Leg shape varies (hockey/tennis/props); keep it permissive but bounded so a
// caller can't submit an unbounded or non-object legs payload.
export const slipSubmitSchema = z.object({
  legs: z.array(z.record(z.any())).min(1, 'legs array is required').max(30, 'too many legs'),
  sport: z.string().trim().max(20).optional(),
  // Stored/consumed as a percentage (see xpForOutcome, clamps 1..99). Accept the
  // full 0..100 range plus null so existing clients aren't rejected.
  combinedProbability: z.number().min(0).max(100).nullable().optional(),
});

// `PATCH /users/:id` (admin). `.strict()` : un champ inconnu (`role`, `password_hash`…)
// est refusé plutôt qu'ignoré en silence.
export const adminUpdateUserSchema = z.object({
  email:      z.string().trim().email().max(254).optional(),
  username:   z.string().trim().min(1).max(50).optional(),
  first_name: z.string().trim().max(100).nullable().optional(),
  last_name:  z.string().trim().max(100).nullable().optional(),
  is_active:  z.boolean().optional(),
}).strict();

// ── Profile ─────────────────────────────────────────────────────────────────
// L'avatar est stocké en base64 dans Postgres (user_profiles.avatar_url) et
// renvoyé dans les payloads du chat et du leaderboard : chaque octet accepté ici
// se paye en stockage Neon ET en egress, à chaque lecture. Le client produit
// désormais un 256×256 WebP (~20 ko, ~27 ko une fois en base64) — le plafond de
// 400 000 caractères (~300 ko binaire) est une marge de sécurité, pas une cible.
// Il est volontairement plus bas que la limite de body de la route (600 ko) pour
// qu'un dépassement renvoie un 400 explicite plutôt qu'un 413 opaque.
export const avatarSchema = z.object({
  avatarDataUrl: z.string()
    .startsWith('data:image/', 'avatarDataUrl must be an image data URI')
    .max(400_000, 'Image too large — please choose a smaller one'),
});

// `user_profiles.rule_weights` (migration 017) est un JSONB écrit tel quel depuis
// le corps d'un PATCH : sans borne, un compte peut y ranger un objet arbitraire,
// facturé en stockage Neon et relu à chaque `GET /users/me`.
//
// La forme réelle est celle du store client : famille → { idFacteur → poids }.
// Les familles sont les 8 de `factorModel.ts` (match, totals, period, margin, ot,
// player_off, player_phys, goalie) et les ids de facteurs sont alphanumériques ;
// les plafonds ci-dessous laissent de la marge sans rendre le champ extensible
// (16 × 32 clés bornées ≈ 25 ko au pire).
// Les clés `__proto__` / `__defineGetter__`… traversent `z.record` comme des clés
// propres : elles sont refusées ici plutôt que stockées, pour qu'aucun objet relu
// plus tard ne porte de nom réservé.
const factorKey = z.string().regex(/^(?!__)[A-Za-z0-9_]{1,40}$/, 'invalid factor id');

export const ruleWeightsSchema = z
  .record(
    z.string().regex(/^(?!__)[a-z0-9_]{1,32}$/, 'invalid factor family'),
    z
      .record(factorKey, z.number().finite().min(0).max(100))
      .refine((m) => Object.keys(m).length <= 32, 'too many factors in a family'),
  )
  .refine((m) => Object.keys(m).length <= 16, 'too many factor families');

export type RuleWeightsMap = z.infer<typeof ruleWeightsSchema>;

/**
 * Corps de `PATCH /api/users/me`.
 *
 * Cette route recevait `req.body` **tel quel** : chaque champ partait en base
 * sans borne de taille, dans des colonnes `TEXT` qui n'en posent aucune non plus.
 * Un compte pouvait donc y ranger ~100 ko (le plafond du body parser) de bio à
 * chaque requête — payé en stockage Neon, puis **en egress à chaque lecture de
 * profil**, y compris dans les charges utiles de chat et de leaderboard.
 *
 * Les bornes ci-dessous sont calées sur les écrans qui écrivent réellement
 * (`SettingsTab`, `RuleFactorEditor`), avec de la marge : elles doivent refuser
 * l'abus, pas une saisie légitime.
 *
 * `username` reste volontairement large ici : sa vraie règle (3-20, minuscules)
 * vit dans `ProfileService.updateProfile`, avec le message d'erreur que l'UI
 * affiche et le contrôle d'unicité. La dupliquer ici ferait diverger les deux.
 *
 * Les clés inconnues sont **silencieusement retirées** (comportement zod par
 * défaut) : le corps qui atteint le service est une liste blanche.
 */
export const profileUpdateSchema = z.object({
  username:         z.string().trim().max(50).optional(),
  displayName:      z.string().trim().max(60).optional(),
  bio:              z.string().trim().max(500).optional(),
  favoriteTeam:     z.string().trim().max(40).optional(),
  isPublic:         z.boolean().optional(),
  showSlips:        z.boolean().optional(),
  notifyValueBets:  z.boolean().optional(),
  // Le service reborne ensuite à 0-50 ; ici on refuse seulement l'absurde.
  valueBetMinEvPct: z.number().finite().min(0).max(100).optional(),
  avatar:           z.string().max(40).optional(),
  // Le client n'écrit ici qu'une URL de drapeau ; les data-URI d'avatar passent
  // par `POST /me/avatar`. Le plafond réel est celui du body parser (100 ko sur
  // cette route) — ce max ne fait que refuser proprement au lieu d'écrire.
  avatarUrl:        z.string().max(100_000).nullable().optional(),
  openaiApiKey:     z.string().max(200).nullable().optional(),
  ruleWeights:      ruleWeightsSchema.nullable().optional(),
});


// ── Saisie manuelle (`manual_data`, migration 034) ────────────────────────────
//
// `PUT /api/injuries/:key` n'avait AUCUNE validation : la route recopiait les
// tableaux du corps dans un JSON écrit sur disque. Les colonnes visées sont
// maintenant un JSONB, donc un corps non borné devient une ligne non bornée en
// base — et surtout, un `impact` de 50 au lieu de 0.05 déplace une probabilité
// sans que rien ne le refuse. Les bornes ci-dessous sont celles du barème
// documenté dans SAISIE_MANUELLE.md, avec de la marge.

/** Abréviation d'équipe NHL. Clé d'objet, donc validée comme chaîne. */
const teamAbbrKey  = z.string().trim().regex(/^[A-Za-z]{2,4}$/, 'abréviation d\'équipe invalide');
/** Orthographe MoneyPuck — le service Python matche par nom exact. */
const manualPlayer = z.string().trim().min(2).max(80);

const injuryPlayerSchema = z.object({
  player: manualPlayer,
  role:   z.string().trim().max(10).optional(),
  status: z.string().trim().max(20).optional(),
  // Barème : gardien partant 0.12, joueur clé 0.06, role player 0.03. Le
  // plafond à 0.5 laisse la place à un cas extrême sans permettre l'absurde —
  // au-delà, ce n'est plus un facteur, c'est un pronostic écrit à la main.
  impact: z.number().finite().min(0).max(0.5),
});

export const injuriesEntrySchema = z.object({
  home:       z.array(injuryPlayerSchema).max(12).optional(),
  away:       z.array(injuryPlayerSchema).max(12).optional(),
  // Même plage que le curseur de la carte admin.
  lineupAdj:  z.number().finite().min(-0.1).max(0.1).optional(),
  lineupNote: z.string().trim().max(200).optional(),
});

/**
 * Une journée de gardiens partants et/ou d'absents.
 *
 * Les deux champs sont facultatifs mais l'un des deux est requis : un PUT vide
 * ne veut rien dire, et l'accepter écrirait une ligne inutile.
 * Le nombre de clés est plafonné — la NHL compte 32 équipes, et un objet à
 * clés libres est sinon un moyen de faire grossir une ligne JSONB sans limite.
 */
export const lineupsEntrySchema = z.object({
  goalies:   z.record(teamAbbrKey, manualPlayer).optional(),
  scratches: z.record(teamAbbrKey, z.array(manualPlayer).max(12)).optional(),
})
  .refine((v) => v.goalies !== undefined || v.scratches !== undefined,
          { message: 'goalies ou scratches est requis' })
  .refine((v) => Object.keys(v.goalies ?? {}).length <= 40
              && Object.keys(v.scratches ?? {}).length <= 40,
          { message: 'trop d\'équipes' });

/** Table de tendance des arbitres — saisie en une passe par saison. */
export const refereesTableSchema = z.object({
  // Occasions de power-play par match, deux équipes cumulées (~6.2 en NHL).
  leagueAvgPpPerGame: z.number().finite().min(1).max(20).optional(),
  referees: z.array(z.object({
    name:      z.string().trim().min(2).max(60),
    ppPerGame: z.number().finite().min(0).max(20),
    note:      z.string().trim().max(120).optional(),
  })).max(200).optional(),
}).refine((v) => v.leagueAvgPpPerGame !== undefined || v.referees !== undefined,
          { message: 'leagueAvgPpPerGame ou referees est requis' });

/** Assignation manuelle : un match NHL a un ou deux arbitres. */
export const refAssignmentSchema = z.object({
  refs: z.array(z.string().trim().min(2).max(60)).min(1).max(4),
});


// ── Prédiction (`/api/predict/*`) ─────────────────────────────────────────────
//
// Ces routes étaient les dernières routes publiques sans validation, et ce sont
// les plus chères du serveur : une requête entrante gratuite déclenche des
// appels sortants vers l'API NHL, `buildRealFactors`, `buildGameFeatures` et le
// service ML Python. Le facteur d'amplification est le vrai sujet ici — pas
// l'injection : chaque identifiant inédit rate les caches TTL (`nhlApiClient`,
// `mlApiClient`) et paye le trajet complet.
//
// POURQUOI DES CHAÎNES BORNÉES ET NON DES ENUMS pour `marketType` / `propType` :
// `computeProbability` traite `last_goal_scorer`, qui n'est PAS dans l'union
// `BetMarketType` du routeur. Une enum construite sur l'union refuserait donc un
// marché que le moteur sait calculer, et chaque nouveau marché devrait être
// ajouté à deux endroits — une omission se paierait en 400 en production. Le
// motif ci-dessous refuse le corps poubelle (objets, chaînes de 10 ko, clés
// réservées) sans jamais se mettre en travers du moteur, qui retombe déjà sur
// 50 % pour un marché qu'il ne connaît pas.
const marketType = z.string().trim().regex(/^[a-z0-9_]{1,40}$/, 'marketType invalide');

// Identifiant NHL : soit un id numérique, soit une abréviation d'équipe. Pas de
// `min(1)` : `GamePrediction.tsx` envoie `teamId: ""` (le match seul suffit,
// `resolveSubjects` déduit les équipes depuis `gameId`), et le refuser casserait
// la page de prédiction d'un match.
const nhlSubjectId = z.string().trim().max(40);

// « over », « under », ou une abréviation d'équipe.
const selectionValue = z.string().trim().max(40);

// Une ligne de pari : -1.5 (puck line) à ~120 (prop de saison en points). Les
// bornes refusent l'absurde, pas une ligne réelle. `finite()` est le point
// important : sans lui, `null`/`Infinity` traversent et ressortent en `NaN` dans
// une probabilité affichée à l'utilisateur.
const betLine = z.number().finite().min(-50).max(500);

/** Corps de `POST /api/predict/single`. */
export const singlePredictionSchema = z.object({
  marketType,
  gameId:     nhlSubjectId.optional(),
  teamId:     nhlSubjectId.optional(),
  opponentId: nhlSubjectId.optional(),
  playerId:   nhlSubjectId.optional(),
  selection:  selectionValue.optional(),
  line:       betLine.optional(),
  isHome:     z.boolean().optional(),
});
// `period` et `seasonContext` sont envoyés par le type client `PredictionRequest`
// mais ne sont lus NULLE PART côté serveur : ils sont volontairement absents ici
// et donc silencieusement retirés (comportement zod par défaut). Les déclarer
// donnerait l'illusion qu'ils comptent.

/**
 * Corps de `POST /api/predict/parlay`.
 *
 * `probability` est le champ qui comptait : la route multipliait les jambes sans
 * rien vérifier, donc une jambe non numérique renvoyait `combinedProbability:
 * NaN` au client, qui l'affichait. La borne 0-100 est celle du reste du produit.
 *
 * Le plafond de 30 jambes est calé sur `slipSubmitSchema` À DESSEIN : un coupon
 * de 25 jambes est soumettable, donc refuser d'en calculer la probabilité
 * combinée casserait un coupon par ailleurs valide.
 */
export const parlayPredictionSchema = z.object({
  legs: z.array(z.object({
    marketType,
    probability: z.number().finite().min(0).max(100),
    // `correlation` a été RETIRÉ. Il était accepté puis JAMAIS lu, et servait
    // d'alibi à une docstring client qui promettait une gestion des
    // corrélations inexistante. Un client ne connaît pas la corrélation de ses
    // propres jambes : elle se déduit de leur IDENTITÉ, d'où les trois champs
    // ci-dessous.
    //
    // ⚠️ zod RETIRE les clés non déclarées. Tant qu'elles n'étaient pas dans ce
    // schéma, `gameId`, `selection` et `line` n'atteignaient jamais la route,
    // même envoyées par le client — deux jambes du même match y arrivaient
    // indiscernables.
    //
    // Optionnels : un coupon qui ne les porte pas est traité comme des jambes
    // indépendantes, soit l'ancien comportement.
    gameId:    z.string().trim().max(40).optional(),
    selection: selectionValue.optional(),
    line:      betLine.optional(),
    // Équipes du match : ce qu'il faut pour construire la loi jointe des scores
    // et chiffrer EXACTEMENT des jambes corrélées du même match. Sans elles, le
    // coupon retombe sur le produit, qui sous-estime.
    teamId:     nhlSubjectId.optional(),
    opponentId: nhlSubjectId.optional(),
    isHome:     z.boolean().optional(),
  })).min(1, 'legs array is required').max(30, 'too many legs'),
});

/**
 * Corps de `POST /api/predict/factors`.
 *
 * `type` est une enum ici — contrairement à `marketType` — parce que
 * `buildRealFactors` ne connaît que deux branches : `'team'`, et tout le reste
 * qui part sur le chemin joueur. Une chaîne libre y entrait donc comme
 * « joueur », et `fetchPlayerById` partait chercher n'importe quel identifiant.
 */
export const predictFactorsSchema = z.object({
  type: z.enum(['team', 'player']),
  id:   nhlSubjectId,
  // Seul `fallbackPct` est lu ; le reste du contexte est retiré.
  context: z.object({
    fallbackPct: z.number().finite().min(0).max(100).optional(),
  }).optional(),
});

/** Corps de `POST /api/predict/player-prop` (prop de saison). */
export const playerPropSchema = z.object({
  playerName: z.string().trim().min(1).max(80),
  propType:   z.enum(['goals', 'points', 'assists', 'award']),
  line:       betLine,
  playerId:   nhlSubjectId.optional(),
});
// `season`, `currentGoals`, `currentPoints`, `currentAssists` et `gamesPlayed`
// sont envoyés par `PlayerPropPrediction.tsx` mais le handler les recalcule
// depuis `fetchPlayerById` : ils sont retirés plutôt que déclarés, pour qu'on ne
// croie jamais qu'un chiffre venu du client entre dans le calcul.

/** Corps de `POST /api/predict/futures`. */
export const predictFuturesSchema = z.object({
  teamName: z.string().trim().min(1).max(60),
  teamId:   nhlSubjectId.optional(),
  propType: z.enum(['cup', 'conf', 'playoff']),
});

/**
 * Corps de `POST /api/predict/ml` — la route la plus chère du serveur :
 * `buildGameFeatures` interroge l'API NHL avant que le service Python ne soit
 * appelé. `subjectId` est le seul champ obligatoire non vide : c'est la clé de
 * cache de `mlApiClient`, donc le levier d'amplification.
 */
export const predictMlSchema = z.object({
  type:       z.enum(['game', 'player', 'team']),
  subjectId:  z.string().trim().min(1, 'subjectId is required').max(40),
  opponentId: nhlSubjectId.optional(),
  propType:   marketType.optional(),
  line:       betLine.optional(),
  selection:  selectionValue.optional(),
  // Le sujet reçoit-il ? Sans ce champ, la route passait le sujet comme équipe
  // à DOMICILE au service Python : les deux tuiles moneyline d'un même match
  // recevaient chacune l'avantage de la glace et totalisaient 109–112 %.
  // Optionnel, défaut `true`, pour que les corps déjà en circulation passent.
  isHome:     z.boolean().optional(),
});


// ── Chat ────────────────────────────────────────────────────────────────────
//
// `chat.service.ts` borne DÉJÀ tout ce qui entre en base : `stripControlChars`,
// `MAX_TEXT_LENGTH`, `MAX_NOTE_LENGTH`, `REPORT_REASONS`, et un `slice()` sur
// chaque champ libre. Ces schémas ne le remplacent pas — ils refusent à la
// FRONTIÈRE ce qui serait de toute façon tronqué plus loin, pour deux raisons :
//
//  1. **Un `slice()` accepte en silence.** Un client qui envoie 3 000
//     caractères recevait un message tronqué sans jamais l'apprendre ; il reçoit
//     maintenant un 400 qui dit la limite. (Côté client, l'input du chat n'a
//     toujours pas de `maxLength` — c'est un point ouvert de l'audit, §3.)
//  2. La défense en profondeur : le service reste la dernière ligne, il n'est
//     PAS allégé par ces schémas. Retirer une de ses vérifications en croyant
//     qu'elle fait doublon serait l'erreur à ne pas commettre — les mêmes
//     fonctions servent le chemin SOCKET, qui ne passe par aucun de ces
//     schémas.
//
// `pin` et `role` n'ont volontairement pas de schéma : la route coerce déjà
// (`!!req.body.pinned`) et `setRole` valide son énumération en base.

/** Aligné sur `MAX_TEXT_LENGTH` de `chat.service.ts`. Les deux doivent bouger ensemble. */
const CHAT_MAX_TEXT = 1000;
/** Aligné sur `MAX_NOTE_LENGTH` de `chat.service.ts`. */
const CHAT_MAX_NOTE = 500;

export const chatCreateRoomSchema = z.object({
  name:        z.string().trim().min(1, 'name is required').max(100),
  icon:        z.string().max(20).optional(),
  description: z.string().trim().max(300).optional(),
  isPrivate:   z.boolean().optional(),
  // Le format est vérifié par `sanitizeColor` côté service (qui retombe sur
  // null) : ici on ne borne que la taille, pour ne pas refuser une couleur que
  // le service sait déjà normaliser.
  color:       z.string().max(20).optional(),
});

export const chatJoinByCodeSchema = z.object({
  code: z.string().trim().min(1, 'code is required').max(32),
});

export const chatSendMessageSchema = z.object({
  text: z.string().min(1, 'text is required').max(CHAT_MAX_TEXT, `Message too long (max ${CHAT_MAX_TEXT} chars)`),
  tag:  z.enum(['pick', 'analysis', 'hot']).optional(),
  // Citation de réponse. Recopiée telle quelle en base (le service la tronque) :
  // c'est du texte fourni par le client, pas une référence vérifiée à un
  // message — le borner ici évite qu'une citation pèse plus lourd que le
  // message qui la porte.
  replyTo: z.object({
    username: z.string().max(100).optional(),
    text:     z.string().max(300).optional(),
  }).optional(),
  // Coupon joint au message. ⚠️ On ne reçoit qu'un IDENTIFIANT : la carte est
  // reconstruite côté serveur depuis `bet_slips`, filtrée sur le propriétaire.
  // Accepter ici le contenu de la carte laisserait n'importe qui afficher un
  // « parlay à 96 % » qu'il n'a jamais verrouillé.
  slipId: z.string().min(1).max(80).optional(),
});

export const chatReactionSchema = z.object({
  // 8 caractères : la limite du service. Un emoji composé (drapeau, famille,
  // modificateur de teint) dépasse largement un « caractère ».
  emoji: z.string().min(1, 'emoji is required').max(8),
});

export const chatReportSchema = z.object({
  reason: z.enum(['spam', 'harassment', 'hate', 'sexual', 'other']),
  note:   z.string().max(CHAT_MAX_NOTE).optional(),
});

// ── Web Push ────────────────────────────────────────────────────────────────
//
// `endpoint` est une URL fournie par le navigateur, écrite telle quelle en base
// et RÉUTILISÉE comme clé unique (`ON CONFLICT (endpoint)`). C'était le seul
// champ de l'API stocké sans aucune borne : rien n'empêchait un mégaoctet de
// texte d'entrer dans un index. Le schéma la contraint à une URL https bornée.
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().startsWith('https://', 'endpoint must be https').max(2_000),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth:   z.string().min(1).max(256),
  }),
});
// NB : `sub.toJSON()` du navigateur porte aussi `expirationTime`. zod le retire
// (mode « strip » par défaut) et personne ne le lit — c'est voulu.

export const pushUnsubscribeSchema = z.object({
  endpoint: z.string().url().max(2_000),
});

// ── Abonnement ──────────────────────────────────────────────────────────────
//
// Le code promo est comparé à un catalogue en mémoire après `trim().toUpperCase()`,
// donc un code invalide ne touche jamais la base — mais il n'était borné ni en
// taille ni en alphabet, et `redeemLimiter` (par compte) laisse passer assez de
// tentatives pour que la taille compte.
export const redeemPromoSchema = z.object({
  code: z.string().trim().min(1, 'Code required').max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid promo code'),
});

// `POST /subscription/checkout` — la cadence de facturation choisie sur /pro.
//
// Le champ s'appelle `period` et non `plan` : `plan` désigne déjà le NIVEAU
// d'abonnement (`free` / `pro`) dans la table et dans `SubscriptionStatus`.
//
// Le corps entier est `.optional()`, et ce n'est pas de la complaisance : la
// route n'envoyait AUCUN corps avant l'ajout de la cadence annuelle, donc un
// bundle client resté en cache pendant le déploiement poste toujours à vide.
// Refuser ce cas casserait le paiement pendant toute la fenêtre de déploiement,
// pour rien — une cadence absente retombe simplement sur le mensuel, l'ancien
// comportement. L'énumération, elle, reste stricte : la cadence choisit une
// variable d'environnement, elle ne doit jamais venir d'une chaîne libre.
export const checkoutSchema = z
  .object({ period: z.enum(['monthly', 'yearly']).optional() })
  .optional();
