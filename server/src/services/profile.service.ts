import { pool } from '../db/connection';
// `decryptSecret` n'est plus importé ici : ce service ne déchiffre plus rien.
// La seule lecture du clair vit dans `llm.routes.ts`, au moment de s'en servir.
import { encryptSecret } from './crypto.util';
import { TtlCache } from './ttlCache';
import { profileAlreadyEnsured, markProfileEnsured } from './profileEnsured';
import { logger } from '../logger';
import { ruleWeightsSchema, type RuleWeightsMap } from '../validation/schemas';

/**
 * Edge minimum par défaut d'une alerte value bet, en % entiers.
 *
 * 2 % et pas 0 : le scan serveur refuse déjà tout edge sous `MIN_EDGE` (0,02),
 * plancher tiré du backtest walk-forward où le ROI ne devient positif que vers
 * 2 %. Un compte à 0 ne recevait donc pas plus d'alertes qu'un compte à 2 — le
 * zéro affiché dans les Réglages promettait simplement quelque chose que le
 * serveur ne fait pas. Le défaut de la colonne est posé par la migration 035.
 */
const DEFAULT_MIN_EDGE_PCT = 2;

// ─── Statistiques de paris (agrégation partagée) ─────────────────────────────

interface BetStats { decided: number; wins: number; total: number }

const EMPTY_BET_STATS: BetStats = { decided: 0, wins: 0, total: 0 };

/**
 * Compte les paris de PLUSIEURS utilisateurs en une seule requête agrégée.
 *
 * Remplace le N+1 qui faisait une requête `SELECT outcome FROM bet_slips
 * WHERE user_id = $1` par utilisateur affiché, puis comptait en JavaScript :
 * 21 allers-retours Postgres pour un leaderboard de 20, et tout l'historique
 * de paris rapatrié à chaque appel pour produire deux entiers.
 *
 * ⚠️ SOURCE CORRIGÉE LE 2026-09-20. Cet agrégat lisait `user_bets`, que plus
 * aucun chemin d'écriture n'alimente (seul `db/seed.ts` y insère encore, pour
 * le compte de démonstration). Le leaderboard et la recherche de joueurs
 * classaient donc TOUT LE MONDE à 0 pari et 0 % de réussite, sans que rien ne
 * le signale : une table vide n'est pas une erreur SQL. Les coupons réels
 * vivent dans `bet_slips` depuis `submitSlip`.
 *
 * Ici le comptage est fait par Postgres et seule une ligne par utilisateur
 * transite. Sert le leaderboard et la recherche de joueurs.
 *
 * Un utilisateur sans aucun pari n'apparaît pas dans le GROUP BY — l'appelant
 * retombe sur EMPTY_BET_STATS (même résultat qu'avant : hitRate 0, total 0).
 *
 * `outcome` est nullable : un NULL n'est compté ni dans `decided` ni dans
 * `wins` (un pari sans issue n'est pas tranché). L'ancien code JS comptait un
 * NULL comme tranché-mais-perdu, ce qui faussait le taux de réussite à la
 * baisse ; en pratique la colonne est toujours renseignée.
 */
async function fetchBetStats(userIds: string[]): Promise<Map<string, BetStats>> {
  const stats = new Map<string, BetStats>();
  if (userIds.length === 0) return stats;

  const { rows } = await pool.query(
    `SELECT user_id AS "userId",
            -- IN ('win','loss') et non <> 'pending' : depuis la migration 037
            -- un coupon peut sortir en 'void' (toutes ses jambes annulées).
            -- Il n'a été ni gagné ni perdu, donc le compter comme jugé ferait
            -- baisser le taux de réussite sans qu'aucun pari ait été perdu.
            -- (Pas d'accent grave dans ce commentaire : il vit dans un
            -- template literal, où un accent grave fermerait la chaîne.)
            COUNT(*) FILTER (WHERE outcome IN ('win', 'loss')) AS decided,
            COUNT(*) FILTER (WHERE outcome = 'win')      AS wins,
            COUNT(*)                                     AS total
       FROM bet_slips
      WHERE user_id = ANY($1::uuid[])
      GROUP BY user_id`,
    [userIds],
  );

  // COUNT(*) revient en bigint → chaîne côté pg ; Number() la normalise.
  for (const r of rows) {
    stats.set(String(r.userId), {
      decided: Number(r.decided),
      wins:    Number(r.wins),
      total:   Number(r.total),
    });
  }
  return stats;
}

/** Taux de réussite en pourcentage, une décimale (0 si aucun pari tranché). */
function hitRateOf(s: BetStats): number {
  return s.decided > 0 ? Math.round((s.wins / s.decided) * 1000) / 10 : 0;
}

// ─── Profile ─────────────────────────────────────────────────────────────────

export async function getProfileById(userId: string) {
  // Auto-create a profile row if one doesn't exist yet (e.g. for new registrations)
  //
  // …mais UNE SEULE FOIS par compte et par heure. Cette écriture partait à
  // CHAQUE lecture de `GET /api/users/me`, c'est-à-dire à chaque chargement de
  // l'application — trouvée par le banc `b10-authentifie.ts` le 2026-09-18, qui
  // l'a vue dans le détail des requêtes alors que le compte total (3) n'avait
  // rien d'alarmant. C'est le même défaut que sur le chemin de connexion, et la
  // même mémoire partagée le couvre : voir `profileEnsured.ts` pour ce que le
  // raccourci garantit et ce qu'il ne garantit pas.
  if (!profileAlreadyEnsured(userId)) {
    await pool.query(
      `INSERT INTO user_profiles (user_id, display_name, avatar, tier, performance_score, is_public, joined_at)
       SELECT id, COALESCE(first_name, username), '👤', 'rookie', 0, TRUE, NOW()
       FROM users WHERE id = $1
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    markProfileEnsured(userId);
  }

  const { rows } = await pool.query(
    `SELECT u.id, u.username, up.display_name AS "displayName", up.avatar,
            up.avatar_url AS "avatarUrl",
            up.favorite_team AS "favoriteTeam", up.bio, up.is_public AS "isPublic",
            up.show_slips AS "showSlips",
            up.notify_value_bets AS "notifyValueBets",
            up.value_bet_min_ev_pct AS "valueBetMinEvPct",
            up.tier, up.performance_score AS "performanceScore",
            up.joined_at AS "joinedAt",
            -- Le chiffré n'est PAS sélectionné : voir hasOpenaiKey plus bas.
            -- Ne pas le remettre ici « pour simplifier » — le secret quitterait
            -- de nouveau la base à chaque chargement de profil.
            (up.openai_api_key IS NOT NULL) AS "hasOpenaiKey",
            up.rule_weights AS "ruleWeights"
     FROM users u
     JOIN user_profiles up ON up.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('Profile not found'), { status: 404 });

  const profile = rows[0];
  const badges  = await getBadgesForUser(userId);

  return {
    id:               profile.id,
    username:         profile.username,
    displayName:      profile.displayName,
    avatar:           profile.avatar,
    avatarUrl:        profile.avatarUrl,
    joinedAt:         profile.joinedAt,
    favoriteTeam:     profile.favoriteTeam,
    bio:              profile.bio,
    isPublic:         profile.isPublic,
    showSlips:        profile.showSlips ?? false,
    notifyValueBets:  profile.notifyValueBets ?? false,
    valueBetMinEvPct: profile.valueBetMinEvPct ?? DEFAULT_MIN_EDGE_PCT,
    tier:             profile.tier,
    performanceScore: profile.performanceScore,
    /**
     * La clé OpenAI est en ÉCRITURE SEULE. On dit qu'il y en a une, jamais
     * laquelle.
     *
     * Avant : `openaiApiKey: decryptSecret(profile.openaiApiKey)`. Le secret
     * était chiffré au repos — précisément pour qu'une fuite de la base ne le
     * livre pas — puis déchiffré et renvoyé EN ENTIER à chaque chargement du
     * profil. Il traversait le réseau, atterrissait dans la mémoire JS de
     * l'onglet, et devenait lisible par n'importe quelle extension de
     * navigateur ou capture de trafic. Le chiffrement au repos ne protège pas
     * grand-chose quand le clair ressort à la demande.
     *
     * Pas de « quatre derniers caractères » non plus, bien que ce soit l'usage :
     * les calculer obligerait à déchiffrer à chaque lecture de profil. Un
     * booléen se dérive en SQL, donc le chiffré ne quitte même pas la base pour
     * cette requête. L'écran affiche « une clé est enregistrée » avec
     * « Remplacer » et « Retirer », ce qui couvre tout ce qu'on peut vouloir en
     * faire — on ne relit pas une clé d'API, on la remplace.
     *
     * L'écriture reste possible : `PATCH /users/me` accepte toujours
     * `openaiApiKey` — une chaîne pour l'enregistrer, `''` pour l'effacer.
     * `null` n'y touche pas (voir `updateProfile`).
     */
    hasOpenaiKey:     Boolean(profile.hasOpenaiKey),
    ruleWeights:      profile.ruleWeights ?? null,
    badges,
  };
}

async function getBadgesForUser(userId: string) {
  const { rows } = await pool.query(
    `SELECT badge_id AS "id", label, description, icon, earned_at AS "earnedAt", tier
     FROM user_badges
     WHERE user_id = $1
     ORDER BY earned_at`,
    [userId]
  );
  return rows;
}

export async function updateProfile(userId: string, updates: {
  username?: string;
  displayName?: string;
  bio?: string;
  favoriteTeam?: string;
  isPublic?: boolean;
  showSlips?: boolean;
  notifyValueBets?: boolean;
  valueBetMinEvPct?: number;
  avatar?: string;
  avatarUrl?: string | null;
  openaiApiKey?: string | null;
  /** Store de pondération du client : famille → { idFacteur → poids 0-100 }. */
  ruleWeights?: RuleWeightsMap | null;
}) {
  // Username lives on the users table — handle it separately, with a uniqueness check
  if (updates.username !== undefined) {
    const username = String(updates.username).trim().toLowerCase();

    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      throw Object.assign(
        new Error('Username must be 3-20 characters: lowercase letters, numbers or underscores'),
        { status: 400 },
      );
    }

    const taken = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = $1 AND id <> $2',
      [username, userId],
    );
    if (taken.rowCount && taken.rowCount > 0) {
      throw Object.assign(new Error('Username already taken'), { status: 409 });
    }

    try {
      await pool.query(
        'UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2',
        [username, userId],
      );
    } catch (e: any) {
      // Race-condition safety net: UNIQUE constraint violation
      if (e.code === '23505') {
        throw Object.assign(new Error('Username already taken'), { status: 409 });
      }
      throw e;
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (updates.displayName   !== undefined) { fields.push(`display_name = $${i++}`);    values.push(updates.displayName); }
  if (updates.bio           !== undefined) { fields.push(`bio = $${i++}`);             values.push(updates.bio); }
  if (updates.favoriteTeam  !== undefined) { fields.push(`favorite_team = $${i++}`);   values.push(updates.favoriteTeam); }
  if (updates.isPublic      !== undefined) { fields.push(`is_public = $${i++}`);       values.push(updates.isPublic); }
  if (updates.showSlips     !== undefined) { fields.push(`show_slips = $${i++}`);      values.push(!!updates.showSlips); }
  if (updates.notifyValueBets !== undefined) { fields.push(`notify_value_bets = $${i++}`); values.push(!!updates.notifyValueBets); }
  if (updates.valueBetMinEvPct !== undefined) {
    // Clamp to a sane 0–50 % range; ignore non-numeric input.
    const pct = Math.round(Number(updates.valueBetMinEvPct));
    const safe = Number.isFinite(pct) ? Math.min(50, Math.max(0, pct)) : 0;
    fields.push(`value_bet_min_ev_pct = $${i++}`); values.push(safe);
  }
  if (updates.avatar        !== undefined) { fields.push(`avatar = $${i++}`);           values.push(String(updates.avatar).slice(0, 20)); }
  if (updates.avatarUrl     !== undefined) { fields.push(`avatar_url = $${i++}`);       values.push(updates.avatarUrl); }
  /**
   * Trois valeurs, trois intentions — et `null` n'en est PAS une.
   *
   *   absent  → ne pas toucher à la colonne
   *   `null`  → ne pas toucher à la colonne  ← voir ci-dessous
   *   `''`    → effacer la clé
   *   sinon   → chiffrer et écrire
   *
   * Pourquoi `null` est neutre plutôt qu'un effacement, alors que c'est le
   * réflexe : depuis que la clé est en écriture seule, le champ du formulaire
   * est vide au chargement. L'ancienne version de l'écran envoyait
   * `openaiApiKey: openaiKey.trim() || null` à CHAQUE enregistrement de profil —
   * donc un bundle client resté en cache pendant le déploiement effacerait la
   * clé de son propriétaire dès qu'il modifie sa bio, en silence et sans retour
   * possible. La fenêtre est étroite, la perte est définitive, et la refermer
   * coûte cette ligne.
   *
   * L'effacement volontaire dit donc quelque chose que personne n'envoie par
   * accident : la chaîne vide. C'est ce que l'écran envoie quand on clique
   * « Retirer ».
   */
  if (updates.openaiApiKey !== undefined && updates.openaiApiKey !== null) {
    const raw = updates.openaiApiKey;
    fields.push(`openai_api_key = $${i++}`);
    values.push(raw === '' ? null : encryptSecret(raw));
  }
  if (updates.ruleWeights   !== undefined) {
    // Double barrière volontaire : la route valide déjà son corps
    // (`profileUpdateSchema`), mais ce service est aussi appelé directement —
    // par `POST /me/avatar` aujourd'hui, par un script demain. La borne reste
    // donc au point d'écriture, là où le JSONB est réellement produit. `null`
    // est accepté : c'est ainsi qu'on efface les poids d'un compte.
    let weights: string | null = null;
    if (updates.ruleWeights !== null) {
      const parsed = ruleWeightsSchema.safeParse(updates.ruleWeights);
      if (!parsed.success) {
        throw Object.assign(new Error('Invalid ruleWeights payload'), { status: 400 });
      }
      weights = JSON.stringify(parsed.data);
    }
    fields.push(`rule_weights = $${i++}`); values.push(weights);
  }

  if (fields.length === 0 && updates.username === undefined) {
    throw Object.assign(new Error('Nothing to update'), { status: 400 });
  }

  if (fields.length > 0) {
    values.push(userId);
    await pool.query(
      `UPDATE user_profiles SET ${fields.join(', ')} WHERE user_id = $${i}`,
      values
    );
  }
  return getProfileById(userId);
}

// ─── Bets ─────────────────────────────────────────────────────────────────────

/**
 * Libellés d'affichage des marchés. Partagé par l'historique et le détail par
 * marché — deux copies de cette table finiraient par diverger, et c'est le même
 * mot qui s'affiche des deux côtés de l'écran Profil.
 */
const MARKET_LABELS: Record<string, string> = {
  moneyline:    'Moneyline',
  total_goals:  'Totals',
  shots_ou:     'Shots O/U',
  anytime_goal: 'Goal Scorer',
  puck_line:    'Puck Line',
  assists_ou:   'Assists O/U',
};

/** Une jambe telle qu'elle est stockée dans `bet_slips.legs` (cf. `SlipLeg`). */
interface StoredLeg {
  marketType?:  string;
  subjectName?: string;
  subjectLogo?: string;
  selection?:   string;
  line?:        number;
  probability?: number;
  oddsLabel?:   string;
}

/**
 * Historique de paris, dans la forme `BetRecord` que sert `GET /api/users/me/bets`.
 *
 * ⚠️ LA SOURCE A CHANGÉ (2026-09-20). Cette fonction lisait `user_bets`, une
 * table que plus rien n'alimente : la seule écriture qui reste dans tout le
 * dépôt est `db/seed.ts`, pour le compte de démonstration `jdupont`. Les vrais
 * coupons partent dans `bet_slips` depuis `submitSlip`. Tout compte créé après
 * la bascule recevait donc un historique VIDE — pas une erreur, pas un log,
 * juste un tableau vide au-dessus de coupons bien présents en base.
 *
 * `BetRecord` décrit UN pari, alors qu'un coupon en porte jusqu'à douze. La
 * projection tient en deux cas :
 *   - coupon simple : la jambe EST le pari, reportée telle quelle ;
 *   - parlay : les champs de sujet résument le coupon et `parlayLegs` porte le
 *     compte. Le détail des jambes n'entre pas dans cette forme, et n'a pas à y
 *     entrer : `GET /api/slips` le sert déjà complet, et c'est lui qu'utilise
 *     l'écran « Mes coupons ».
 */
export async function getBetHistory(userId: string) {
  const { rows } = await pool.query<{
    id:                  string;
    placedAt:            Date;
    legs:                StoredLeg[] | null;
    legCount:            number;
    isParlay:            boolean;
    combinedProbability: number | null;
    outcome:             string;
  }>(
    `SELECT id, placed_at AS "placedAt", legs,
            leg_count            AS "legCount",
            is_parlay            AS "isParlay",
            combined_probability AS "combinedProbability",
            outcome
       FROM bet_slips
      WHERE user_id = $1
      ORDER BY placed_at DESC`,
    [userId],
  );

  return rows.map((slip) => {
    const first      = slip.legs?.[0] ?? {};
    const marketType = first.marketType ?? 'moneyline';
    const legLabel   = [first.selection, first.line].filter((v) => v != null).join(' ').trim();

    return {
      id:             slip.id,
      placedAt:       slip.placedAt,
      marketType,
      marketLabel:    MARKET_LABELS[marketType] ?? marketType,
      selection:      slip.isParlay ? `Parlay · ${slip.legCount} legs` : (legLabel || first.subjectName || ''),
      selectionShort: slip.isParlay ? `${slip.legCount}-leg parlay`    : (first.oddsLabel ?? legLabel),
      subjectName:    slip.isParlay ? `${slip.legCount}-leg parlay`    : (first.subjectName ?? ''),
      subjectLogo:    slip.isParlay ? '🎟️'                             : (first.subjectLogo ?? '🏒'),
      // La probabilité du COUPON quand elle existe : c'est elle qui a servi à
      // calculer l'XP, donc celle que l'utilisateur a vue en verrouillant.
      probability:    slip.combinedProbability ?? first.probability ?? 0,
      isParlay:       slip.isParlay,
      parlayLegs:     slip.isParlay ? slip.legCount : undefined,
      outcome:        slip.outcome,
    };
  });
}

// ─── Betting Stats ────────────────────────────────────────────────────────────

/** Nombre de mois civils que renvoie `monthlyStats` (ce qu'affiche le graphe). */
const MONTHLY_WINDOW = 6;

/**
 * Jambes tranchées minimum avant qu'un marché puisse être élu « meilleur ».
 *
 * Sans plancher, un marché joué UNE fois et gagné sort à 100 % et passe devant
 * un marché joué cinquante fois à 62 %. Sous le plancher pour tous les marchés,
 * `bestMarketType` vaut `null` : aucun marché ne mérite encore le titre, et le
 * dire est plus honnête que de couronner un coup de chance.
 */
const BEST_MARKET_MIN_LEGS = 5;

/**
 * Statistiques de paris du propriétaire du compte.
 *
 * ⚠️ DEUX CORRECTIFS DU 2026-09-20, à ne pas défaire séparément.
 *
 * **1. La source.** Comme `getBetHistory` ci-dessus, cette fonction agrégeait
 * `user_bets`, que plus aucun chemin d'écriture n'alimente. Tous les compteurs
 * de l'écran Profil — coupons, W-L, taux de réussite, détail par marché,
 * parlays — sortaient donc à zéro pour un compte réel.
 *
 * **2. Les trois constantes.** `calibrationScore: 81`, `currentStreak: 4` et
 * `longestWinStreak: 11` étaient écrits en dur dans le retour. Le premier
 * peignait « 81/100 · bien calibré » sur le profil de TOUS les utilisateurs, y
 * compris un compte sans un seul coupon réglé. Les séries sont désormais
 * calculées ; la calibration est SUPPRIMÉE de la réponse plutôt que devinée —
 * la mesurer vraiment demande de confronter probabilité annoncée et fréquence
 * réalisée sur un échantillon qui n'existe pas encore, et un chiffre inventé
 * sur un écran qui sert à juger un modèle est pire que pas de chiffre.
 *
 * Tri ASC et non DESC : les séries se lisent en un seul passage sur l'ordre
 * chronologique, sans retrier en mémoire.
 */
export async function getBettingStats(userId: string) {
  // `legs` est un JSONB qui porte le sujet, la cote et le libellé de chaque
  // jambe — des kilo-octets par coupon, dont ce calcul n'utilise QUE
  // `marketType`. Postgres le déplie donc ici et n'envoie qu'un tableau de
  // chaînes : un historique de mille coupons ne fait pas transiter mille
  // documents JSON pour produire une dizaine d'entiers.
  const { rows: slips } = await pool.query<{
    outcome:             'win' | 'loss' | 'pending' | 'void';
    isParlay:            boolean;
    combinedProbability: number | null;
    placedAt:            Date;
    marketTypes:         string[];
  }>(
    `SELECT outcome,
            is_parlay            AS "isParlay",
            combined_probability AS "combinedProbability",
            placed_at            AS "placedAt",
            COALESCE(
              (SELECT array_agg(leg->>'marketType')
                 FROM jsonb_array_elements(legs) AS leg
                WHERE leg->>'marketType' IS NOT NULL),
              '{}'::text[]
            )                    AS "marketTypes"
       FROM bet_slips
      WHERE user_id = $1
      ORDER BY placed_at ASC`,
    [userId],
  );

  const wins    = slips.filter((s) => s.outcome === 'win').length;
  const losses  = slips.filter((s) => s.outcome === 'loss').length;
  const pending = slips.filter((s) => s.outcome === 'pending').length;
  const total   = slips.length;

  // `decided` et non `total` au dénominateur : un coupon `void` (migration 037)
  // n'a été ni gagné ni perdu, et un coupon `pending` n'a pas encore eu lieu.
  // Les compter ferait baisser le taux sans qu'aucun pari ait été perdu.
  const decided = wins + losses;
  const hitRate = decided > 0 ? Math.round((wins / decided) * 1000) / 10 : 0;

  // Moyenne des probabilités RENSEIGNÉES. `combined_probability` est nullable
  // (migration 003) et l'ancien calcul divisait par le nombre total de paris :
  // un coupon sans probabilité exploitable tirait la moyenne vers le bas au
  // lieu d'en être exclu.
  const probs = slips
    .map((s) => s.combinedProbability)
    .filter((p): p is number => p != null);
  const avgProbability = probs.length > 0
    ? Math.round((probs.reduce((sum, p) => sum + p, 0) / probs.length) * 10) / 10
    : 0;

  // ── Séries ──
  //
  // Seuls les coupons TRANCHÉS forment la suite. Un `void` ou un `pending` ne
  // compte pas comme une victoire, mais ne COUPE pas non plus la série : le
  // trou qu'il laisse dans la chronologie ne doit pas transformer huit
  // victoires d'affilée en deux séries de quatre.
  const settled = slips
    .filter((s) => s.outcome === 'win' || s.outcome === 'loss')
    .map((s) => s.outcome as 'win' | 'loss');

  let longestWinStreak = 0;
  let run = 0;
  for (const outcome of settled) {
    run = outcome === 'win' ? run + 1 : 0;
    if (run > longestWinStreak) longestWinStreak = run;
  }

  // Série en cours, SIGNÉE : +3 = trois victoires de suite, −2 = deux défaites
  // de suite, 0 = aucun coupon tranché. Le signe évite à l'appelant de
  // redemander la dernière issue pour savoir s'il affiche « W3 » ou « L2 ».
  let currentStreak = 0;
  for (let i = settled.length - 1; i >= 0; i--) {
    const isWin = settled[i] === 'win';
    if (i === settled.length - 1)          currentStreak = isWin ? 1 : -1;
    else if (isWin  && currentStreak > 0)  currentStreak++;
    else if (!isWin && currentStreak < 0)  currentStreak--;
    else break;
  }

  // ── Détail par marché ──
  //
  // Une ligne par marché, obtenue en dépliant les jambes de chaque coupon
  // tranché. Un même marché joué deux fois dans un parlay compte deux fois :
  // ce sont deux paris.
  //
  // ⚠️ L'ISSUE ATTRIBUÉE À UNE JAMBE EST CELLE DU COUPON. Pour un coupon simple
  // c'est exact. Pour un parlay PERDU ça ne l'est pas : le coupon tombe dès
  // qu'une seule jambe échoue, et les autres — peut-être gagnantes — sont
  // comptées perdantes ici. Le taux par marché d'un joueur qui joue surtout des
  // parlays est donc tiré vers le BAS.
  //
  // C'est un choix, pas un oubli. L'autre découpage possible (ne retenir que
  // les parlays gagnants, dont on SAIT que toutes les jambes ont gagné)
  // biaiserait vers le HAUT, ce qui est pire sur un écran dont le seul usage
  // est de décider où l'on est bon. Une attribution exacte demanderait de
  // régler chaque jambe individuellement, ce que `settlement.service.ts` ne
  // stocke pas aujourd'hui.
  const marketMap = new Map<string, { wins: number; decided: number }>();
  for (const slip of slips) {
    if (slip.outcome !== 'win' && slip.outcome !== 'loss') continue;
    for (const marketType of slip.marketTypes) {
      const bucket = marketMap.get(marketType) ?? { wins: 0, decided: 0 };
      bucket.decided++;
      if (slip.outcome === 'win') bucket.wins++;
      marketMap.set(marketType, bucket);
    }
  }

  // Trié par VOLUME décroissant : le graphe à barres se lit du marché le plus
  // joué au moins joué, un ordre stable d'un chargement à l'autre. L'ancien
  // code, lui, renvoyait le tableau trié par taux — effet de bord du `.sort()`
  // en place qui servait à élire le meilleur marché juste après.
  const marketBreakdown = [...marketMap.entries()]
    .map(([marketType, d]) => ({
      marketType,
      label:   MARKET_LABELS[marketType] ?? marketType,
      bets:    d.decided,
      hitRate: Math.round((d.wins / d.decided) * 100),
    }))
    .sort((a, b) => b.bets - a.bets || a.label.localeCompare(b.label));

  const bestMarket = marketBreakdown
    .filter((m) => m.bets >= BEST_MARKET_MIN_LEGS)
    .sort((a, b) => b.hitRate - a.hitRate || b.bets - a.bets)[0] ?? null;

  // ── Historique mensuel ──
  //
  // Clé ANNÉE-mois, et fenêtre réellement bornée. L'ancien regroupement passait
  // par `toLocaleString('en', { month: 'short' })`, donc sans année : avril 2025
  // et avril 2026 tombaient dans le même seau. Et le « last 6 months » du
  // commentaire n'était borné nulle part — un compte de deux saisons produisait
  // douze points mélangés sur un graphe qui en attend six.
  const monthlyMap = new Map<string, { bets: number; wins: number; decided: number }>();
  for (const slip of slips) {
    const at  = new Date(slip.placedAt);
    const key = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
    const bucket = monthlyMap.get(key) ?? { bets: 0, wins: 0, decided: 0 };
    bucket.bets++;
    if (slip.outcome === 'win' || slip.outcome === 'loss') {
      bucket.decided++;
      if (slip.outcome === 'win') bucket.wins++;
    }
    monthlyMap.set(key, bucket);
  }

  const monthlyStats = [...monthlyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-MONTHLY_WINDOW)
    .map(([key, d]) => ({
      month: new Date(`${key}-01T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' }),
      bets:  d.bets,
      // Même définition qu'en haut du fichier : tranchés / tranchés. L'ancien
      // calcul divisait par les paris POSÉS, donc un mois encore plein de
      // coupons en attente s'affichait à un taux artificiellement bas.
      hitRate: d.decided > 0 ? Math.round((d.wins / d.decided) * 100) : 0,
    }));

  // ── Parlays ──
  //
  // Les défaites sont COMPTÉES, pas déduites. L'ancien `parlayBets.length -
  // parlayWins` rangeait dans les défaites tout parlay encore en attente ou
  // annulé : un joueur qui venait de poser trois parlays voyait « 0 - 3 » avant
  // le premier coup de patin.
  const parlays      = slips.filter((s) => s.isParlay);
  const parlayWins   = parlays.filter((s) => s.outcome === 'win').length;
  const parlayLosses = parlays.filter((s) => s.outcome === 'loss').length;

  return {
    totalBets:         total,
    wins,
    losses,
    pending,
    hitRate,
    avgProbability,
    currentStreak,
    longestWinStreak,
    parlayRecord:      { wins: parlayWins, losses: parlayLosses },
    bestMarketType:    bestMarket?.marketType ?? null,
    bestMarketHitRate: bestMarket?.hitRate    ?? 0,
    monthlyStats,
    marketBreakdown,
  };
}

/**
 * URL d'avatar courante d'un utilisateur.
 * Sert à supprimer l'objet précédent sur R2 quand l'avatar est remplacé.
 */
export async function getAvatarUrl(userId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl"
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  return rows[0]?.avatarUrl ?? null;
}

// ─── Player search ────────────────────────────────────────────────────────────

/** Search public players by username or display name. */
export async function searchUsers(q: string, limit = 20) {
  const query = String(q).trim();
  if (query.length < 2) return [];
  const like = `%${query.replace(/[%_]/g, '')}%`;

  const { rows } = await pool.query(
    `SELECT u.id AS "userId", u.username,
            COALESCE(up.display_name, u.username) AS "displayName",
            COALESCE(up.avatar, '👤') AS avatar,
            COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl",
            up.tier, up.performance_score AS "performanceScore",
            up.show_slips AS "showSlips"
     FROM users u
     JOIN user_profiles up ON up.user_id = u.id
     WHERE u.is_active = TRUE AND up.is_public = TRUE
       AND (u.username ILIKE $1 OR up.display_name ILIKE $1)
     ORDER BY up.performance_score DESC
     LIMIT $2`,
    [like, Math.min(limit, 50)],
  );

  // Une seule requête agrégée pour tous les résultats (au lieu d'une par joueur).
  const stats = await fetchBetStats(rows.map((r) => String(r.userId)));

  return rows.map((r) => {
    const s = stats.get(String(r.userId)) ?? EMPTY_BET_STATS;
    return {
      rank:             0,
      userId:           r.userId,
      username:         r.username,
      displayName:      r.displayName,
      avatar:           r.avatar,
      avatarUrl:        r.avatarUrl ?? null,
      tier:             r.tier,
      performanceScore: r.performanceScore ?? 0,
      hitRate:          hitRateOf(s),
      totalBets:        s.total,
      showSlips:        r.showSlips ?? false,
    };
  });
}

// ─── Coupons visibles par un tiers ───────────────────────────────────────────
//
// Trois filtres indépendants s'appliquent, et il faut les garder distincts :
//
//   1. QUI  — `show_slips` : le joueur peut se retirer (opt-out). Volontairement
//      DÉCOUPLÉ de `is_public`, qui commande la présence dans la recherche et au
//      classement. Les lier reviendrait à faire payer la discrétion d'un rang :
//      un « choix » de ce genre n'en est pas un.
//   2. QUAND — `PUBLIC_SLIPS_SINCE` : seuls les coupons déposés APRÈS la mise en
//      service sont exposés. L'historique antérieur a été saisi sous la promesse
//      inverse ; il reste privé pour toujours.
//   3. QUOI — `locks_at` : avant la mise au jeu, le coupon est annoncé mais ses
//      sélections ne le sont pas.
//
// Aucun de ces filtres ne s'applique au propriétaire : il voit tout son
// historique, en entier, tout le temps.

/** Fenêtre de forme affichée en en-tête, et taille minimale pour publier un %. */
const FORM_WINDOW_DAYS = 30;
const FORM_MIN_SAMPLE  = 10;

let cutoffWarned = false;

/**
 * Date à partir de laquelle un coupon peut être montré à un tiers.
 *
 * ÉCHEC FERMÉ : variable absente ou illisible → `null`, c'est-à-dire aucun
 * coupon visible, plus un avertissement au démarrage de la première lecture.
 * Même parti pris que `PRO_PROMO_CODES`, qui désactive la promo plutôt que de
 * retomber sur un code devinable. Une variable d'environnement oubliée doit
 * casser le feature, jamais la vie privée — l'inverse ne se rattrape pas.
 */
function publicSlipsSince(): Date | null {
  const raw = process.env.PUBLIC_SLIPS_SINCE?.trim();
  const at  = raw ? new Date(raw) : null;
  if (at && !Number.isNaN(at.getTime())) return at;

  if (!cutoffWarned) {
    cutoffWarned = true;
    logger.warn(
      { PUBLIC_SLIPS_SINCE: raw ?? null },
      '[profile] PUBLIC_SLIPS_SINCE absente ou invalide — aucun coupon n\'est visible aux autres joueurs',
    );
  }
  return null;
}

/**
 * Un coupon est-il encore verrouillé pour un tiers ?
 *
 * `locks_at` renseigné → verrouillé jusqu'à la mise au jeu.
 * `locks_at` NULL (coupon antérieur à la migration 029, `gameId` absent, API NHL
 * muette au moment de la saisie) → verrouillé tant que le coupon est `pending`,
 * et dévoilé une fois réglé. Un horaire non résolu doit produire un coupon trop
 * discret, jamais un coupon divulgué trop tôt.
 */
function isLocked(locksAt: Date | string | null, outcome: string): boolean {
  if (!locksAt) return outcome === 'pending';
  return Date.now() < new Date(locksAt).getTime();
}

/** Le coupon amputé de ses sélections. Construit ici, jamais « flouté » plus tard. */
function redactSlip(slip: any) {
  const { legs, ...rest } = slip;
  return { ...rest, legs: null, locked: true };
}

/**
 * Les coupons d'un joueur, tels que `viewerId` a le droit de les voir.
 *
 * L'appelant a déjà passé le mur Pro (`requirePro` dans profile.routes). Ce qui
 * se joue ici n'est pas l'abonnement mais le consentement du joueur observé.
 */
export async function getPublicSlips(targetUserId: string, viewerId: string, limit = 25) {
  const isOwner = targetUserId === viewerId;
  let cutoff: Date | null = null;

  if (!isOwner) {
    const { rows } = await pool.query(
      `SELECT up.show_slips AS "showSlips" FROM user_profiles up WHERE up.user_id = $1`,
      [targetUserId],
    );
    if (!rows[0]) throw Object.assign(new Error('Player not found'), { status: 404 });
    if (!rows[0].showSlips) {
      throw Object.assign(new Error('This player hides their slips'), {
        status: 403,
        code: 'SLIPS_HIDDEN',   // distinct du 402 PRO_REQUIRED : l'abonnement n'est pas en cause
      });
    }

    cutoff = publicSlipsSince();
    if (!cutoff) return [];   // échec fermé
  }

  const params: unknown[] = [targetUserId, Math.min(limit, 100)];
  let where = 'user_id = $1';
  if (cutoff) { params.push(cutoff); where += ` AND placed_at >= $${params.length}`; }

  const { rows } = await pool.query(
    `SELECT id, placed_at AS "placedAt", sport, legs, leg_count AS "legCount",
            is_parlay AS "isParlay", combined_probability AS "combinedProbability",
            outcome, resolved_at AS "resolvedAt", xp_awarded AS "xpAwarded",
            locks_at AS "locksAt"
     FROM bet_slips
     WHERE ${where}
     ORDER BY placed_at DESC
     LIMIT $2`,
    params,
  );

  if (isOwner) return rows;
  // La redaction se fait AVANT de rendre la main : les legs d'un coupon
  // verrouillé ne doivent jamais exister côté client, fût-ce derrière un flou CSS.
  return rows.map((r: any) => (isLocked(r.locksAt, r.outcome) ? redactSlip(r) : { ...r, locked: false }));
}

/**
 * En-tête de la page joueur : identité + forme récente.
 *
 * Les compteurs sont calculés sur les coupons RÉELLEMENT VISIBLES par
 * `viewerId`, et sur eux seuls. Afficher « 64 % sur 128 paris » au-dessus d'une
 * liste qui n'en montre que 12 recréerait exactement l'allégation invérifiable
 * que cette page est censée remplacer. Le classement, lui, agrège l'historique
 * ENTIER via `fetchBetStats` : deux chiffres, deux questions. Depuis le
 * 2026-09-20 les deux lisent la même table (`bet_slips`) — c'est le filtre de
 * visibilité qui les sépare, plus la source.
 */
export async function getPlayerSummary(targetUserId: string, viewerId: string) {
  const isOwner = targetUserId === viewerId;

  const { rows: profileRows } = await pool.query(
    `SELECT u.id AS "userId", u.username,
            COALESCE(up.display_name, u.username) AS "displayName",
            COALESCE(up.avatar, '👤') AS avatar,
            COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl",
            up.tier, up.show_slips AS "showSlips"
     FROM users u
     JOIN user_profiles up ON up.user_id = u.id
     WHERE u.id = $1 AND u.is_active = TRUE`,
    [targetUserId],
  );
  const profile = profileRows[0];
  if (!profile) throw Object.assign(new Error('Player not found'), { status: 404 });

  let cutoff: Date | null = null;
  if (!isOwner) {
    if (!profile.showSlips) {
      throw Object.assign(new Error('This player hides their slips'), {
        status: 403,
        code: 'SLIPS_HIDDEN',   // distinct du 402 PRO_REQUIRED : l'abonnement n'est pas en cause
      });
    }
    cutoff = publicSlipsSince();
  }

  const windowStart = new Date(Date.now() - FORM_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  // Sans coupure exploitable, la borne inférieure est « demain » : le compte
  // retombe à zéro plutôt que d'exposer un agrégat de coupons masqués.
  const since = isOwner ? new Date(0) : (cutoff ?? new Date(Date.now() + 86_400_000));

  const { rows } = await pool.query(
    `SELECT
       -- Voir fetchBetStats : un coupon 'void' n'est ni gagné ni perdu, donc
       -- pas un coupon jugé. (Aucun accent grave ici : ce commentaire vit dans
       -- un template literal, où il fermerait la chaîne.)
       COUNT(*) FILTER (WHERE outcome IN ('win', 'loss'))                      AS settled,
       COUNT(*) FILTER (WHERE outcome  = 'win')                                AS wins,
       COUNT(*) FILTER (WHERE outcome IN ('win', 'loss') AND placed_at >= $3)  AS "settledWindow",
       COUNT(*) FILTER (WHERE outcome  = 'win'     AND placed_at >= $3)        AS "winsWindow"
     FROM bet_slips
     WHERE user_id = $1 AND placed_at >= $2`,
    [targetUserId, since, windowStart],
  );
  const c = rows[0] ?? {};

  // Sous le plancher, on renvoie le décompte mais PAS de pourcentage. « 2 gagnés
  // sur 3 » s'affiche 67 % et ne veut rien dire ; le client doit être incapable
  // de peindre un chiffre qui n'a pas de sens, pas simplement invité à s'abstenir.
  const rate = (wins: number, settled: number) =>
    settled >= FORM_MIN_SAMPLE ? Math.round((wins / settled) * 1000) / 10 : null;

  const settled       = Number(c.settled ?? 0);
  const wins          = Number(c.wins ?? 0);
  const settledWindow = Number(c.settledWindow ?? 0);
  const winsWindow    = Number(c.winsWindow ?? 0);

  return {
    userId:      profile.userId,
    username:    profile.username,
    displayName: profile.displayName,
    avatar:      profile.avatar,
    avatarUrl:   profile.avatarUrl ?? null,
    tier:        profile.tier,
    /** Forme récente — ce que l'en-tête met en avant. */
    form: {
      windowDays: FORM_WINDOW_DAYS,
      minSample:  FORM_MIN_SAMPLE,
      settled:    settledWindow,
      wins:       winsWindow,
      hitRate:    rate(winsWindow, settledWindow),   // null = échantillon insuffisant
    },
    /** Cumul sur tout ce qui est visible — ligne secondaire. */
    overall: {
      since:   isOwner ? null : (cutoff ? cutoff.toISOString() : null),
      settled,
      wins,
      hitRate: rate(wins, settled),
    },
  };
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank:             number;
  userId:           string;
  username:         string;
  displayName:      string | null;
  avatar:           string | null;
  avatarUrl:        string | null;
  tier:             string | null;
  performanceScore: number;
  hitRate:          number;
  totalBets:        number;
}

/**
 * Cache 60 s du classement complet.
 *
 * L'endpoint `/api/leaderboard` est public et non authentifié : sans cache,
 * chaque visiteur déclenchait 21 allers-retours Postgres. Le classement est
 * identique pour tout le monde et n'a pas besoin d'être à la seconde — une
 * exécution par minute suffit, quel que soit le trafic. `wrap` dédoublonne en
 * prime les requêtes concurrentes sur un cache froid.
 *
 * Le tableau retourné est partagé entre appelants — il ne doit pas être muté.
 */
const LEADERBOARD_TTL = 60_000;
const leaderboardCache = new TtlCache<LeaderboardEntry[]>(LEADERBOARD_TTL, 1, 'leaderboard');

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  return leaderboardCache.wrap('top20', computeLeaderboard);
}

async function computeLeaderboard(): Promise<LeaderboardEntry[]> {
  const { rows } = await pool.query(
    `SELECT u.id AS "userId", u.username,
            up.display_name AS "displayName", up.avatar, up.tier,
            up.performance_score AS "performanceScore",
            COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl"
     FROM users u
     JOIN user_profiles up ON up.user_id = u.id
     ORDER BY up.performance_score DESC
     LIMIT 20`
  );

  // 21 requêtes → 2 : le comptage des paris est fait par Postgres, en une fois.
  const stats = await fetchBetStats(rows.map((r) => String(r.userId)));

  return rows.map((r, i) => {
    const s = stats.get(String(r.userId)) ?? EMPTY_BET_STATS;
    return {
      rank:             i + 1,
      userId:           r.userId,
      username:         r.username,
      displayName:      r.displayName,
      avatar:           r.avatar,
      avatarUrl:        r.avatarUrl ?? null,
      tier:             r.tier,
      performanceScore: r.performanceScore,
      hitRate:          hitRateOf(s),
      totalBets:        s.total,
    };
  });
}
