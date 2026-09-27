/**
 * manualData.service.ts — la seule porte vers la table `manual_data`.
 *
 * Remplace quatre lectures de fichiers qui étaient MORTES en production (voir
 * `db/migrations/034_manual_data.sql` pour le détail : `tsc` n'émet pas les
 * `.json`, le Dockerfile ne copie que `dist/`, et le dossier `ml/` n'est pas
 * dans l'image). Les quatre jeux vivent désormais en base, donc ils survivent
 * au redéploiement et sont vus par toutes les instances.
 *
 * ── Le cache est la raison d'être de ce module ──────────────────────────────
 * `buildGameMarkets` et `buildGameFeatures` consultent ces données à CHAQUE
 * prédiction. Sans cache, la page d'accueil d'un soir à douze matchs ferait
 * quelques dizaines de requêtes pour lire trois lignes qui ne bougent pas.
 *
 * Le TTL est de 90 s (30 s jusqu'au 2026-09-18 — voir `TTL_MS` plus bas pour
 * la mesure qui a motivé le changement) : une saisie faite depuis la carte
 * admin est visible au plus tard 90 s après, sans redémarrage. C'est ce qui
 * permet à la routine « 1-2 h avant la mise au jeu » de rester utilisable.
 *
 * Une écriture invalide immédiatement les entrées concernées SUR CETTE
 * INSTANCE ; les autres attendent l'expiration. Différence sans conséquence
 * pratique ici (une seule personne saisit, et 90 s de retard sur un facteur de
 * blessure ne changent rien) — mais il faut la connaître.
 *
 * ── Les absences sont mises en cache, elles aussi ───────────────────────────
 * La plupart des matchs n'ont AUCUNE saisie. Si seules les valeurs trouvées
 * étaient mises en cache, le cas majoritaire — « rien pour ce match » —
 * repartirait en base à chaque prédiction, c'est-à-dire exactement le contraire
 * du but. D'où la boîte `{ v }` : `TtlCache` distingue « pas en cache » de
 * « en cache, et la valeur est null » uniquement si null est emballé.
 *
 * ── Les pannes sont journalisées, plus silencieuses ─────────────────────────
 * L'ancien code répondait à toute erreur par un `catch {}` muet et une valeur
 * neutre. Le repli neutre est conservé — une base indisponible ne doit pas
 * casser une prédiction, elle doit lui retirer un facteur — mais il passe
 * désormais par `logger.warn`. C'est précisément ce qui manquait pour que la
 * panne de production se voie.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { TtlCache } from './ttlCache';

// ── Jeux de données ──────────────────────────────────────────────────────────

export type ManualKind =
  /** clé = 'AWAY@HOME' — blessés/absents et ajustement d'alignement */
  | 'injuries'
  /** clé = 'YYYY-MM-DD' (heure Est) — { ABBR: "Nom MoneyPuck" } */
  | 'starting_goalies'
  /** clé = 'YYYY-MM-DD' (heure Est) — { ABBR: ["Nom MoneyPuck", …] } */
  | 'scratches'
  /**
   * clé = ABBR — { players: [{ player, impact, since }] }. Blessés de longue
   * durée : ajoutés AUTOMATIQUEMENT aux absents du jour (`scratches.ts`) et au
   * facteur Blessures de chaque match de l'équipe (`injuryStore.ts`), jusqu'à
   * ce qu'on les retire. Voir `longInjuries.ts`.
   */
  | 'long_injuries'
  /** clé = nom d'arbitre normalisé — { name, ppPerGame, note? }, SAISI À LA MAIN */
  | 'ref_tendency'
  /**
   * clé = nom d'arbitre normalisé — { name, ppPerGame, source }, RELEVÉ
   * AUTOMATIQUEMENT dans les billets Scouting the Refs par `refereeStore`.
   *
   * Séparé de `ref_tendency` pour que le relevé n'écrase jamais une saisie
   * humaine : `loadTendencies` lit l'automatique puis le manuel, qui gagne.
   * La carte admin, elle, ne montre et ne modifie que `ref_tendency`.
   */
  | 'ref_tendency_auto'
  /** clé = 'AWAY@HOME' — { refs: [...] }, secours si le scrape STR casse */
  | 'ref_assignment'
  /** clé = 'league' — { avgPpPerGame } */
  | 'ref_config';

export interface ManualRow<T = unknown> {
  key: string;
  payload: T;
  updatedAt: string;
  updatedBy: string | null;
}

// ── Cache ────────────────────────────────────────────────────────────────────

/**
 * 90 s, et pas 30. La valeur n'est pas « alignée » sur le TTL de `best-bets`
 * (60 s) : elle lui est STRICTEMENT SUPÉRIEURE, et c'est la seule chose qui
 * marche.
 *
 * MESURÉ (banc `b6-concurrence.ts`, 2026-09-18) : sur une charge soutenue, ce
 * cache affichait **0 hit** — `hits 0 / misses 2 / dedup 28`. Avec 30 s de TTL
 * et un recalcul de `best-bets` toutes les 60 s, chaque lecture retombait
 * exactement dans la fenêtre où l'entrée venait d'expirer : le cache ne servait
 * jamais, il ne faisait que dédoublonner les appels simultanés d'une même
 * passe. Deux requêtes SQL payées par recalcul, pour rien.
 *
 * VÉRIFIÉ APRÈS CORRECTION, sur deux passes espacées de 65 s : le second
 * recalcul de `best-bets` émet **0 requête `manual_data`** (contre 2), et le
 * cache passe de 0 à 30 hits.
 *
 * Un TTL de cache n'a pas de valeur « naturelle » : il vaut ce qu'il vaut par
 * rapport à la CADENCE DE SON APPELANT. Et l'égalité ne suffit pas — à 60 s
 * contre 60 s, l'entrée expire à l'instant même où la passe suivante la
 * demande : c'est un tirage au sort, pas un cache. Il faut la marge.
 *
 * Contrepartie assumée : une saisie manuelle (gardien partant, absent de
 * dernière minute) met jusqu'à 90 s au lieu de 30 à se voir dans les
 * prédictions. Les écritures invalident déjà explicitement leurs clés, donc le
 * délai ne concerne que les autres instances.
 */
const TTL_MS = Number(process.env.MANUAL_DATA_TTL_MS) || 90_000;

/**
 * Plafond volontairement large au regard du volume réel (une poignée de matchs
 * par jour, une date par jour, quelques dizaines d'arbitres), mais borné quand
 * même : `entry_key` vient d'une entrée utilisateur sur les routes de lecture,
 * et un cache non plafonné dont les clés viennent de l'extérieur est un DoS
 * mémoire. Même règle que partout ailleurs dans ce dépôt.
 */
const MAX_ENTRIES = Number(process.env.MANUAL_DATA_CACHE_MAX) || 400;

/** La boîte qui rend `null` cachable — voir l'en-tête. */
interface Boxed<T> { v: T }

const cache = new TtlCache<Boxed<unknown>>(TTL_MS, MAX_ENTRIES, 'manual');

const oneKey  = (kind: ManualKind, key: string) => `${kind}:${key}`;
const listKey = (kind: ManualKind)              => `${kind}:*`;

/** Une écriture rend fausses l'entrée ET la liste de son kind. */
function invalidate(kind: ManualKind, key: string): void {
  cache.delete(oneKey(kind, key));
  cache.delete(listKey(kind));
}

// ── Lecture ──────────────────────────────────────────────────────────────────

/**
 * Une entrée, ou `null` si elle n'existe pas.
 *
 * Ne lève jamais : une base injoignable rend `null`, donc un facteur neutre,
 * comme le faisait le `catch` de l'ancien code — mais avec une trace.
 */
export async function getEntry<T>(kind: ManualKind, key: string): Promise<T | null> {
  try {
    const boxed = await cache.wrap(oneKey(kind, key), async () => {
      const { rows } = await pool.query(
        'SELECT payload FROM manual_data WHERE kind = $1 AND entry_key = $2',
        [kind, key],
      );
      return { v: (rows[0]?.payload ?? null) as unknown };
    });
    return boxed.v as T | null;
  } catch (err: any) {
    logger.warn({ err: err?.message ?? err, kind, key }, '[manualData] lecture impossible — repli neutre');
    return null;
  }
}

/** Toutes les entrées d'un jeu de données, les plus récemment modifiées d'abord. */
export async function listEntries<T>(kind: ManualKind): Promise<ManualRow<T>[]> {
  try {
    const boxed = await cache.wrap(listKey(kind), async () => {
      const { rows } = await pool.query(
        `SELECT entry_key AS "key", payload, updated_at AS "updatedAt", updated_by AS "updatedBy"
           FROM manual_data
          WHERE kind = $1
          ORDER BY updated_at DESC`,
        [kind],
      );
      return { v: rows as unknown };
    });
    return (boxed.v as ManualRow<T>[]) ?? [];
  } catch (err: any) {
    logger.warn({ err: err?.message ?? err, kind }, '[manualData] liste impossible — repli vide');
    return [];
  }
}

/** Les entrées d'un jeu de données sous forme d'objet `{ clé: payload }`. */
export async function mapEntries<T>(kind: ManualKind): Promise<Record<string, T>> {
  const rows = await listEntries<T>(kind);
  const out: Record<string, T> = {};
  for (const r of rows) out[r.key] = r.payload;
  return out;
}

// ── Écriture ─────────────────────────────────────────────────────────────────
//
// Les écritures, elles, LÈVENT. Un admin qui enregistre une saisie doit savoir
// qu'elle n'est pas passée : c'est le seul moment où quelqu'un attend devant
// l'écran, et un échec silencieux lui ferait croire que le facteur est pris en
// compte alors qu'il ne l'est pas.

/** Crée ou remplace une entrée. */
export async function setEntry(
  kind: ManualKind,
  key: string,
  payload: unknown,
  updatedBy?: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO manual_data (kind, entry_key, payload, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, NOW())
     ON CONFLICT (kind, entry_key)
     DO UPDATE SET payload = EXCLUDED.payload,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = NOW()`,
    [kind, key, JSON.stringify(payload), updatedBy ?? null],
  );
  invalidate(kind, key);
}

/** Supprime une entrée. Rend `true` si elle existait. */
export async function deleteEntry(kind: ManualKind, key: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM manual_data WHERE kind = $1 AND entry_key = $2',
    [kind, key],
  );
  invalidate(kind, key);
  return (rowCount ?? 0) > 0;
}

/**
 * Remplace TOUT le contenu d'un jeu de données, en une transaction.
 *
 * Existe pour la table des tendances d'arbitres, qui se saisit en une passe en
 * début de saison depuis Scouting the Refs : un remplacement atomique évite
 * l'état intermédiaire où la moitié des arbitres viennent de la saison passée
 * et l'autre de la nouvelle.
 */
export async function replaceKind(
  kind: ManualKind,
  entries: Array<{ key: string; payload: unknown }>,
  updatedBy?: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM manual_data WHERE kind = $1', [kind]);
    for (const e of entries) {
      await client.query(
        `INSERT INTO manual_data (kind, entry_key, payload, updated_by)
         VALUES ($1, $2, $3::jsonb, $4)`,
        [kind, e.key, JSON.stringify(e.payload), updatedBy ?? null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  cache.clear();
}

/**
 * Purge les entrées datées antérieures à `beforeDate` (exclue).
 *
 * Les gardiens partants et les absents sont datés : passé le match, l'entrée est
 * inerte mais elle reste. L'ancienne consigne était « purge-les de temps en
 * temps pour la lisibilité », c'est-à-dire jamais. Appelée par le job de
 * nettoyage quotidien.
 */
export async function purgeDatedBefore(beforeDate: string): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM manual_data
      WHERE kind IN ('starting_goalies', 'scratches')
        AND entry_key < $1`,
    [beforeDate],
  );
  if (rowCount) cache.clear();
  return rowCount ?? 0;
}

/**
 * Combien d'entrées par jeu de données.
 *
 * ── Pourquoi cette fonction existe ──────────────────────────────────────────
 * La panne d'origine (quatre sources de données mortes en production pendant
 * des mois) n'était pas une erreur, c'était un SILENCE : le repli neutre est
 * indiscernable d'une vraie absence de blessés. La migration 034 a réparé le
 * chemin de lecture et rendu les échecs journalisés — mais une table simplement
 * VIDE ne dit toujours rien, et une table vide donne exactement les mêmes
 * probabilités qu'un fichier introuvable.
 *
 * Ce relevé est ce qui manquait : un chiffre, tous les jours dans les journaux
 * et à la demande sur la carte admin, qui dit si le modèle est nourri.
 */
export async function coverage(): Promise<Record<string, number>> {
  try {
    const { rows } = await pool.query(
      'SELECT kind, COUNT(*)::int AS n FROM manual_data GROUP BY kind',
    );
    const out: Record<string, number> = {};
    for (const r of rows as Array<{ kind: string; n: number }>) out[r.kind] = r.n;
    return out;
  } catch (err: any) {
    logger.warn({ err: err?.message ?? err }, '[manualData] relevé de couverture impossible');
    return {};
  }
}

/** Vide le cache. Tests, et invalidation manuelle après un import en masse. */
export function clearManualDataCache(): void {
  cache.clear();
}
