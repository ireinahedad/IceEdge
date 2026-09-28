/**
 * llmPrompts.ts
 * Les invites SYSTÈME du proxy `/api/llm`, construites côté serveur.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────────
 *
 * Jusqu'au 2026-09-08, `systemPrompt` arrivait dans le CORPS DE REQUÊTE et
 * était relayé tel quel au fournisseur. Sur le chemin Pro — le seul facturé à
 * l'opérateur (`OPENAI_API_KEY`) — cela donnait à tout compte Pro, y
 * compris un essai gratuit ou un code promo, un **proxy LLM généraliste aux
 * frais du projet** : il suffisait d'appeler l'API avec son propre système
 * d'invite pour s'en servir à toute autre fin.
 *
 * Le client envoie désormais un `taskType` pris dans une **énumération fermée**
 * et une langue ; le texte de l'invite vit ici, et nulle part ailleurs.
 *
 * ⚠️ **Ce que ce fichier ne corrige PAS, et qu'il ne faut pas croire corrigé :**
 * le `prompt` UTILISATEUR reste libre — c'est la question de la personne, on ne
 * peut pas la fermer. Ce qui a changé, c'est que l'invite système ancre
 * désormais le modèle sur l'analyse de paris LNH au lieu d'être choisie par
 * l'appelant. Les vraies bornes de la dépense restent le plafond mensuel
 * (`llmQuota.service`) et `llmLimiter` (10 req/min/utilisateur) ; les serrer
 * davantage se ferait là-bas, pas ici.
 */

/**
 * Les tâches que le proxy accepte. Toute nouvelle valeur s'ajoute ICI.
 *
 *   - `explain_bet`        — « Analyse IA » d'un pari (`PredictionSheet`) ;
 *   - `parse_bet_command`  — le « Bet builder IA » (≠ Analyse LLM ci-dessus) : traduit une
 *     phrase en intentions (SLIP_COMMANDE_PLAN.md § 5). Son invite n'est PAS
 *     ici : elle embarque les matchs et joueurs du moment, elle est donc
 *     construite à chaque appel par `slipCommandLlm.buildParsePrompt`.
 */
export const LLM_TASK_TYPES = ['explain_bet', 'parse_bet_command'] as const;
export type LlmTaskType = typeof LLM_TASK_TYPES[number];

export type LlmLocale = 'fr' | 'en';

/**
 * Invite d'`explain_bet` (`PredictionSheet`, bouton « Analyse IA »). Le texte est celui qui
 * vivait dans `client/src/app/pages/prediction/PredictionSheet.tsx`, déplacé
 * sans être réécrit — le format de réponse attendu ne change donc pas.
 */
const EXPLAIN_BET: Record<LlmLocale, string> = {
  fr:
    "Tu es un analyste de paris LNH pointu dont la valeur est le contexte qu'un modèle statistique manque. " +
    "Tu n'as AUCUNE donnée en temps réel et ta connaissance a une date limite — n'affirme jamais une blessure, " +
    "un alignement ou un gardien actuel comme un fait. " +
    "Quand des « Données de l'application » sont fournies, considère-les comme la vérité et fonde ton « Analyse » dessus. " +
    "Réponds EXACTEMENT dans ce format, sans introduction ni paragraphe :\n" +
    "Analyse :\n" +
    "- 2 à 5 points clés courts (≤ 12 mots), facteurs hors statistiques : forme, fatigue (matchs consécutifs), " +
    "voyage, style d'affrontement, motivation (course aux séries, tanking). " +
    "N'inclus QUE des points appuyés par les données ou tes connaissances; si une information est inconnue " +
    "ou non fournie, OMETS le point — n'écris JAMAIS « inconnu », « non précisé », « N/D » ni « non spécifié ». " +
    "Mieux vaut 2 bons points que 5 avec du remplissage.\n" +
    "\n" +
    "À vérifier :\n" +
    "- REGROUPE ICI UNIQUEMENT les éléments externes en temps réel que l'application n'a pas : " +
    "blessures/absences, gardien partant confirmé, changements d'alignement de dernière minute. " +
    "N'inclus JAMAIS l'historique OT, le voyage/calendrier, la forme récente ni la fatigue — " +
    "l'application fournit déjà ces données, sers-t'en dans « Analyse » au lieu de demander de les vérifier. " +
    "Un élément par point, ≤ 10 mots, formulé comme une chose vérifiable (ex. « Gardien partant de MTL confirmé ? »).\n" +
    "\n" +
    "Verdict : Bon pari / Avantage léger / À éviter — Confiance : faible, moyenne ou élevée " +
    "(choisis UN mot pour le verdict et UN pour la confiance)",
  en:
    "You are a sharp NHL betting analyst whose value is the context a stats model misses. " +
    "You have NO live data and your knowledge has a cutoff — never state a current injury, lineup, or goalie " +
    "start as fact. " +
    "When 'App data' is provided, treat it as ground truth and base your 'Analysis' on it. " +
    "Reply in EXACTLY this format, with no intro and no paragraphs:\n" +
    "Analysis:\n" +
    "- 2-5 short key points (≤12 words), off-the-sheet factors: form, fatigue (back-to-back), travel, " +
    "style matchup, motivation (playoff race, tanking). " +
    "Include ONLY points backed by the data or your knowledge; if something is unknown or not provided, " +
    "OMIT that point — never write 'unknown', 'not specified', 'unclear' or 'N/A'. " +
    "Two solid points beat five with filler.\n" +
    "\n" +
    "To verify:\n" +
    "- GROUP HERE ONLY external live items the app does NOT have: " +
    "injuries/absences, confirmed starting goalie, last-minute lineup changes. " +
    "NEVER include OT history, travel/schedule, recent form or fatigue — the app already provides these, " +
    "so use them in 'Analysis' instead of asking to verify them. " +
    "One item per bullet, ≤10 words, phrased as a checkable question (e.g. 'MTL starting goalie confirmed?').\n" +
    "\n" +
    "Verdict: Good bet / Slight edge / Avoid — Confidence: low, medium or high " +
    "(pick ONE word for the verdict and ONE for the confidence)",
};

/** Les invites FIXES. `parse_bet_command` n'y est pas : voir `LLM_TASK_TYPES`. */
const PROMPTS: Record<'explain_bet', Record<LlmLocale, string>> = {
  explain_bet: EXPLAIN_BET,
};

/** Garde de type : vrai seulement pour une valeur de `LLM_TASK_TYPES`. */
export function isLlmTaskType(value: unknown): value is LlmTaskType {
  return typeof value === 'string' && (LLM_TASK_TYPES as readonly string[]).includes(value);
}

/**
 * Normalise la langue demandée.
 *
 * `acceptLanguage` sert de repli parce que **le client et le serveur se
 * déploient séparément** : pendant la fenêtre de déploiement, un ancien bundle
 * envoie encore `systemPrompt` et AUCUN `locale`. Sans ce repli, un
 * utilisateur francophone recevrait l'invite anglaise. Ce n'est pas un
 * correctif temporaire — l'en-tête reste la meilleure information disponible
 * quand le corps n'en porte pas.
 */
export function resolveLocale(bodyLocale: unknown, acceptLanguage?: string): LlmLocale {
  if (bodyLocale === 'fr' || bodyLocale === 'en') return bodyLocale;
  return acceptLanguage?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** L'invite système d'une tâche à invite FIXE, dans la langue demandée. */
export function systemPromptFor(taskType: 'explain_bet', locale: LlmLocale): string {
  return PROMPTS[taskType][locale];
}
