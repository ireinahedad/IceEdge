/**
 * llmQuota.service.ts
 * ------------------------------------------------------------------
 * Plafond de consommation LLM, dérivé du prix de l'abonnement.
 *
 * ── LA GARANTIE ────────────────────────────────────────────────────────────
 *
 * « Ne jamais payer plus que ce que l'utilisateur paie. »
 *
 * Elle n'est pas obtenue en surveillant une facture, mais par construction : le
 * nombre de requêtes qu'un abonné Pro peut envoyer sur NOTRE compte est calculé
 * à partir de ce qu'il paie, du coût PIRE-CAS d'une requête, et de la part de
 * l'abonnement qu'on accepte de dépenser en IA.
 *
 *     plafond = (prix × part IA) ÷ coût pire-cas d'une requête
 *
 * Le « pire cas » est essentiel : dimensionner sur une requête moyenne rendrait
 * la garantie fausse précisément quand elle compte, c'est-à-dire face à
 * quelqu'un qui envoie systématiquement des prompts au maximum autorisé. Le coût
 * unitaire est donc calculé avec les plafonds de taille que la route impose
 * déjà (`LLM_MAX_PROMPT_CHARS`, `LLM_MAX_SYSTEM_CHARS`) et le budget de sortie
 * (`max_tokens`), pas avec une moyenne observée.
 *
 * Conséquence directe : la dépense IA totale est bornée par la somme des
 * plafonds individuels, elle-même bornée par le revenu des abonnements. Un
 * utilisateur Free ne peut rien coûter — il utilise sa propre clé OpenAI.
 *
 * ── POURQUOI TOUT EST EN VARIABLE D'ENVIRONNEMENT ──────────────────────────
 *
 * Les trois entrées de ce calcul changent indépendamment du code : le prix (une
 * décision commerciale), le tarif du fournisseur (une décision d'OpenAI), et le
 * modèle utilisé. Les figer dans le code garantirait que la garantie devienne
 * fausse en silence au premier changement de tarif. Elles sont donc lisibles et
 * modifiables sans redéploiement, et le plafond calculé est journalisé au
 * démarrage pour qu'une erreur de saisie se voie tout de suite.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';

const num = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// ── Entrées du calcul ───────────────────────────────────────────────────────

/**
 * Prix mensuel de l'abonnement Pro, dans la devise de facturation.
 *
 * 5,99 $ CAD depuis le 2026-09-08 (auparavant 9,99). Le plafond dérivé passe
 * donc de 763 à **457 requêtes/mois** par abonné — c'est le chiffre que la
 * bannière de démarrage journalise, et le seul endroit où vérifier.
 *
 * ⚠️ **La cadence annuelle paie moins par mois.** 60 $/an = 5,00 $/mois, et une
 * fois la commission Stripe déduite (~2,9 % + 0,30 $, prélevée UNE fois sur
 * l'année au lieu de douze) environ 4,80 $/mois net — donc un peu moins qu'un
 * abonné mensuel, qui laisse ~5,52 $ net. Dimensionner sur 5,99 surestime donc
 * de ~20 % ce que paie un abonné annuel. La garantie tient quand même largement,
 * parce que `AI_BUDGET_SHARE` ne dépense que 30 % : 1,80 $ de plafond IA face à
 * 4,80 $ encaissés. Pour dimensionner sur le moins-disant plutôt que sur le
 * mensuel, poser `PRO_PRICE_MONTHLY=5` (plafond 382/mois).
 */
const PRO_PRICE = num('PRO_PRICE_MONTHLY', 5.99);

/**
 * Part de l'abonnement qu'on accepte de dépenser en IA (0–1).
 *
 * Le reste couvre l'hébergement, la commission Stripe (~2,9 % + 0,30 $, soit
 * ~0,59 $ sur 9,99 $) et la marge. À 1.0 la garantie tient encore — on ne
 * dépasse pas ce que l'utilisateur paie — mais l'abonnement ne finance plus
 * rien d'autre.
 */
const AI_BUDGET_SHARE = Math.min(num('LLM_BUDGET_SHARE', 0.30), 1);

/**
 * Tarifs du modèle Pro, par million de tokens. Défauts = `gpt-4.1-mini`
 * (0,40 $ en entrée / 1,60 $ en sortie au 2026-07).
 *
 * À vérifier à chaque changement de modèle : c'est le seul paramètre de ce
 * fichier dont la valeur est décidée par quelqu'un d'autre que toi.
 */
const PRICE_IN_PER_M  = num('LLM_PRICE_INPUT_PER_MTOK',  0.40);
const PRICE_OUT_PER_M = num('LLM_PRICE_OUTPUT_PER_MTOK', 1.60);

/**
 * Taille maximale d'une requête, reprise des plafonds que la route applique
 * déjà. Le ratio caractères → tokens est volontairement bas (3,5 au lieu des
 * ~4 usuels en anglais) : sous-estimer le nombre de tokens surestimerait le
 * plafond de requêtes, donc casserait la garantie. On arrondit du côté prudent.
 */
const CHARS_PER_TOKEN = 3.5;
const MAX_PROMPT_CHARS = num('LLM_MAX_PROMPT_CHARS', 8_000);
const MAX_SYSTEM_CHARS = num('LLM_MAX_SYSTEM_CHARS', 2_000);
/**
 * Budget de sortie envoyé au fournisseur. Exporté et consommé par `llm.routes`
 * comme `max_tokens` : c'est la même valeur des deux côtés PAR CONSTRUCTION.
 * Deux constantes séparées finiraient par diverger, et une divergence ici fait
 * sous-estimer le coût pire-cas — donc surestimer le plafond de requêtes.
 */
export const MAX_OUTPUT_TOKENS = num('LLM_MAX_OUTPUT_TOKENS', 512);

/**
 * Coût pire-cas d'une requête, en devise.
 *
 * Majoré ×2 : `fetchWithTimeoutRetry` réessaie une fois sur 5xx ou timeout, et
 * une tentative avortée a déjà pu être facturée par le fournisseur. Compter une
 * seule tentative rendrait la garantie fausse précisément les jours où le
 * fournisseur va mal.
 */
export const WORST_CASE_COST_PER_REQUEST =
  2 * (
    ((MAX_PROMPT_CHARS + MAX_SYSTEM_CHARS) / CHARS_PER_TOKEN / 1_000_000) * PRICE_IN_PER_M +
    (MAX_OUTPUT_TOKENS / 1_000_000) * PRICE_OUT_PER_M
  );

/**
 * Plafond mensuel de requêtes par abonné Pro.
 *
 * Surchargeable par `LLM_MONTHLY_QUOTA` quand tu veux fixer un chiffre rond
 * plutôt que de le laisser dériver du calcul — utile pour communiquer une
 * promesse simple (« 500 questions par mois ») ou lors d'une opération
 * commerciale. La surcharge n'invalide la garantie que si tu la montes
 * au-dessus du calcul ; le démarrage le signale alors explicitement.
 */
export const MONTHLY_QUOTA: number = (() => {
  const derived = Math.floor((PRO_PRICE * AI_BUDGET_SHARE) / WORST_CASE_COST_PER_REQUEST);
  const override = Number(process.env.LLM_MONTHLY_QUOTA);
  return Number.isFinite(override) && override > 0 ? Math.floor(override) : Math.max(derived, 1);
})();

/**
 * Disjoncteur global mensuel, toutes personnes confondues.
 *
 * Le plafond par utilisateur borne déjà la dépense totale par construction. Ce
 * plafond-ci couvre l'erreur de paramétrage : un prix mal saisi, un tarif
 * fournisseur qui change, un modèle plus cher branché par mégarde. Défaut :
 * 10 000 requêtes/mois, soit ~36 $ au tarif ci-dessus — assez pour ne jamais
 * gêner un lancement, assez bas pour qu'une erreur d'un facteur 10 se voie
 * avant la facture.
 */
export const GLOBAL_MONTHLY_CAP = num('LLM_GLOBAL_MONTHLY_CAP', 10_000);

// Journalisé au démarrage : un plafond aberrant (0, ou 100 000) doit sauter aux
// yeux dans les logs de déploiement, pas se découvrir sur un relevé bancaire.
{
  const budget = PRO_PRICE * AI_BUDGET_SHARE;
  const derived = Math.floor(budget / WORST_CASE_COST_PER_REQUEST);
  logger.info(
    {
      proPrice: PRO_PRICE,
      aiBudgetShare: AI_BUDGET_SHARE,
      aiBudgetPerUser: Number(budget.toFixed(2)),
      worstCaseCostPerRequest: Number(WORST_CASE_COST_PER_REQUEST.toFixed(5)),
      derivedQuota: derived,
      effectiveQuota: MONTHLY_QUOTA,
      globalCap: GLOBAL_MONTHLY_CAP,
    },
    '[llmQuota] plafond mensuel par abonné Pro',
  );
  if (MONTHLY_QUOTA > derived) {
    logger.warn(
      { effectiveQuota: MONTHLY_QUOTA, derivedQuota: derived },
      '[llmQuota] LLM_MONTHLY_QUOTA dépasse le plafond calculé — le coût IA pire-cas ' +
      'peut désormais excéder la part prévue de l\'abonnement',
    );
  }
}

// ── Comptage ────────────────────────────────────────────────────────────────

/** Mois calendaire UTC, 'YYYY-MM'. */
export function currentMonth(d: Date = new Date()): string {
  return d.toISOString().slice(0, 7);
}

/** Premier instant du mois suivant — sert à dire à l'utilisateur QUAND ça repart. */
export function nextResetISO(d: Date = new Date()): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

export interface QuotaVerdict {
  allowed: boolean;
  /** 'user' = plafond personnel atteint · 'global' = disjoncteur · 'db' = base KO. */
  reason?: 'user' | 'global' | 'db';
  used: number;
  limit: number;
  /** Date ISO de remise à zéro. */
  resetsAt: string;
}

/**
 * Consomme une requête du quota Pro, si possible.
 *
 * L'incrément et le contrôle sont le MÊME énoncé : `UPDATE … WHERE count < $lim`
 * ne touche la ligne que si la place existe encore. Il n'y a donc pas de fenêtre
 * entre « lire le compteur » et « l'incrémenter » pendant laquelle deux requêtes
 * simultanées passeraient toutes les deux au-dessus du plafond — ce qui, avec un
 * limiteur à 10 req/min, serait tout à fait atteignable.
 *
 * En cas d'échec base, on REFUSE (fail-closed). C'est l'inverse du choix fait
 * pour les caches, et c'est délibéré : ici, échouer en laissant passer, c'est
 * dépenser de l'argent sans pouvoir le compter.
 */
export async function consumeProRequest(userId: string): Promise<QuotaVerdict> {
  const month = currentMonth();
  const resetsAt = nextResetISO();

  try {
    // 1. Disjoncteur global. Vérifié en premier : s'il a sauté, inutile de
    //    toucher au compteur individuel.
    const g = await pool.query(
      `INSERT INTO llm_usage_global (month, count, updated_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (month) DO UPDATE
          SET count = llm_usage_global.count + 1, updated_at = NOW()
        WHERE llm_usage_global.count < $2
       RETURNING count`,
      [month, GLOBAL_MONTHLY_CAP],
    );
    if ((g.rowCount ?? 0) === 0) {
      logger.error(
        { month, cap: GLOBAL_MONTHLY_CAP },
        '[llmQuota] DISJONCTEUR GLOBAL déclenché — vérifier le paramétrage du plafond par utilisateur',
      );
      return { allowed: false, reason: 'global', used: GLOBAL_MONTHLY_CAP, limit: GLOBAL_MONTHLY_CAP, resetsAt };
    }

    // 2. Plafond individuel.
    const u = await pool.query(
      `INSERT INTO llm_usage (user_id, month, count, updated_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (user_id, month) DO UPDATE
          SET count = llm_usage.count + 1, updated_at = NOW()
        WHERE llm_usage.count < $3
       RETURNING count`,
      [userId, month, MONTHLY_QUOTA],
    );

    if ((u.rowCount ?? 0) === 0) {
      // Plafond atteint. Le compteur global a été incrémenté juste au-dessus
      // pour une requête qui ne partira pas : on le rend, sinon le disjoncteur
      // dériverait à la hausse à cause de requêtes jamais envoyées.
      await pool.query(
        `UPDATE llm_usage_global SET count = GREATEST(count - 1, 0) WHERE month = $1`,
        [month],
      ).catch(() => { /* best-effort : au pire le disjoncteur est un peu pessimiste */ });

      return { allowed: false, reason: 'user', used: MONTHLY_QUOTA, limit: MONTHLY_QUOTA, resetsAt };
    }

    return { allowed: true, used: u.rows[0].count, limit: MONTHLY_QUOTA, resetsAt };
  } catch (err: any) {
    logger.error({ err: err?.message, userId }, '[llmQuota] comptage impossible — requête refusée');
    return { allowed: false, reason: 'db', used: 0, limit: MONTHLY_QUOTA, resetsAt };
  }
}

/**
 * Rend une requête au quota.
 *
 * Appelée quand le fournisseur n'a rien facturé : requête rejetée avant
 * inférence (4xx de validation), ou panne réseau avant d'atteindre le modèle.
 * Sans ce remboursement, une indisponibilité du fournisseur consommerait le
 * quota du mois de l'utilisateur sans lui rendre le moindre service.
 */
export async function refundProRequest(userId: string): Promise<void> {
  const month = currentMonth();
  try {
    await pool.query(
      `UPDATE llm_usage SET count = GREATEST(count - 1, 0) WHERE user_id = $1 AND month = $2`,
      [userId, month],
    );
    await pool.query(
      `UPDATE llm_usage_global SET count = GREATEST(count - 1, 0) WHERE month = $1`,
      [month],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message, userId }, '[llmQuota] remboursement échoué');
  }
}

/** Consommation du mois en cours, sans rien consommer. Pour l'affichage client. */
export async function getUsage(userId: string): Promise<{ used: number; limit: number; remaining: number; resetsAt: string }> {
  const month = currentMonth();
  let used = 0;
  try {
    const { rows } = await pool.query(
      'SELECT count FROM llm_usage WHERE user_id = $1 AND month = $2',
      [userId, month],
    );
    used = rows[0]?.count ?? 0;
  } catch (err: any) {
    logger.warn({ err: err?.message, userId }, '[llmQuota] lecture de consommation échouée');
  }
  return { used, limit: MONTHLY_QUOTA, remaining: Math.max(MONTHLY_QUOTA - used, 0), resetsAt: nextResetISO() };
}
