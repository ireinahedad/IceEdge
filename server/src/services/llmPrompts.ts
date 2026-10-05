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
 *   - `ask_followup`       — question de suivi posée APRÈS cette analyse, dans
 *     la même fiche (demande du user, 2026-09-29). Même chemin de clé et même
 *     quota qu'`explain_bet` : un appel = une requête ;
 *   - `parse_bet_command`  — le « Bet builder IA » (≠ Analyse LLM ci-dessus) : traduit une
 *     phrase en intentions (SLIP_COMMANDE_PLAN.md § 5). Son invite n'est PAS
 *     ici : elle embarque les matchs et joueurs du moment, elle est donc
 *     construite à chaque appel par `slipCommandLlm.buildParsePrompt`.
 */
export const LLM_TASK_TYPES = ['explain_bet', 'ask_followup', 'parse_bet_command'] as const;
export type LlmTaskType = typeof LLM_TASK_TYPES[number];

export type LlmLocale = 'fr' | 'en';

/**
 * Consigne de langue, ajoutée à la FIN de chaque invite système (2026-10-04).
 *
 * Les invites étaient déjà écrites dans la langue de l'app, mais aucune ne
 * disait EXPLICITEMENT dans quelle langue répondre. Or le message utilisateur
 * mélange souvent les langues : question tapée en anglais dans une app en
 * français, noms de joueurs, sigles, `propType` (`anytime_goal`…), lignes de
 * faits préparées côté client. Le modèle suivait alors parfois la langue du
 * message plutôt que celle de l'app. Placée en dernier, la consigne est celle
 * que le modèle lit juste avant de répondre.
 *
 * ⚠️ Compte dans la borne de 2 000 caractères des invites (`llmQuota.service`).
 */
export const LANGUAGE_RULE: Record<LlmLocale, string> = {
  fr: "Langue : réponds TOUJOURS en français, même si la question, des noms ou des données sont en anglais ; " +
      "garde tels quels les noms propres et les sigles d'équipes.",
  en: "Language: ALWAYS reply in English, even if the question, names or data are in another language; " +
      "keep proper names and team abbreviations as-is.",
};

/**
 * Invite d'`explain_bet` (`PredictionSheet`, bouton « Analyse IA »). Le texte est celui qui
 * vivait dans `client/src/app/pages/prediction/PredictionSheet.tsx`, déplacé
 * sans être réécrit — le format de réponse attendu ne change donc pas.
 */
/**
 * ⚠️ 2026-10-04 : ceci est l'invite LEGACY de l'« Analyse IA » (texte libre :
 * Analyse / À vérifier / Verdict). Elle ne sert plus que de repli — ancien
 * bundle client, ou faits du pari indisponibles. Le chemin normal est
 * l'analyse v2 : `llmFacts.ts` (faits calculés par le code), `llmAnalysis.ts`
 * (invite JSON `EXPLAIN_BET_V2`, validation, repli déterministe).
 */
const EXPLAIN_BET: Record<LlmLocale, string> = {
  fr:
    "Tu es un analyste de paris LNH pointu dont la valeur est le contexte qu'un modèle statistique manque. " +
    "Tu n'as AUCUNE donnée en temps réel et ta connaissance a une date limite — n'affirme jamais une blessure, " +
    "un alignement ou un gardien actuel comme un fait. " +
    "Quand des « Données de l'application » sont fournies, considère-les comme la vérité et fonde ton « Analyse » dessus. " +
    "Si tu t'adresses au lecteur, vouvoie-le (l'application vouvoie partout). " +
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

/**
 * Invite d'`ask_followup` : la personne a lu l'analyse d'`explain_bet` et pose
 * une question dessus. Le message utilisateur porte les données du pari,
 * l'analyse précédente, les derniers échanges et la question (construit par
 * `PredictionSheet`).
 *
 * Le cadre est le même que pour l'analyse (pas de données en direct, les
 * « Données de l'application » font foi) ; le format, lui, est libre et
 * court. Une question hors sujet est déclinée en une phrase : cette tâche
 * tourne sur la clé de l'opérateur pour un compte Pro, elle ne doit pas
 * devenir un assistant généraliste (voir l'en-tête de ce fichier).
 */
const ASK_FOLLOWUP: Record<LlmLocale, string> = {
  fr:
    "Tu es un analyste de paris LNH. Tu as déjà noté un pari ; la personne te pose une question de suivi. " +
    "Tu n'as AUCUNE donnée en temps réel et ta connaissance est périmée : n'affirme jamais une blessure, " +
    "un alignement ou un gardien actuel comme un fait. " +
    "Le bloc FAITS (PARI, Modèle ML, Marché, Cote juste, STATUT, RÉSERVE, SENSIBILITÉ GARDIEN, CANDIDATS) est la seule vérité : " +
    "réponds à partir de lui et de ton analyse précédente. Cite au moins un chiffre du bloc ; n'en invente aucun et ne fais " +
    "aucun calcul nouveau (reprends la SENSIBILITÉ GARDIEN pour « et si le gardien change »). " +
    "Les facteurs MAJEUR comptent plus que les SECONDAIRE ; respecte POUR / CONTRE. " +
    "Si le bloc n'a pas la réponse, dis précisément ce qui manque (par ex. « le bloc ne contient pas de stats de blessés »), sans broder. " +
    "Réponds directement en 2 à 4 phrases courtes, sans introduction ni politesse, en texte simple, sans conseil de mise. " +
    "Si tu t'adresses à la personne, vouvoie-la (l'application vouvoie partout). " +
    "Hors sujet (autre que ce pari, ce match, ces équipes ou les paris LNH) : dis-le en une phrase.",
  en:
    "You are an NHL betting analyst. You already wrote up a bet; the person asks a follow-up question. " +
    "You have NO live data and your knowledge is stale: never state a current injury, lineup or goalie start as fact. " +
    "The FACTS block (BET, ML model, Market, Fair odds, STATUS, CAVEAT, GOALIE SENSITIVITY, CANDIDATES) is the only truth: " +
    "answer from it and your previous analysis. Cite at least one number from the block; invent none and do no new " +
    "calculation (reuse GOALIE SENSITIVITY for \"what if the goalie changes\"). " +
    "MAJOR factors matter more than MINOR ones; respect FOR / AGAINST. " +
    "If the block lacks the answer, say exactly what is missing (e.g. \"the block has no injury data\"), without padding. " +
    "Answer directly in 2 to 4 short sentences, no intro or pleasantries, plain text, no staking advice. " +
    "Off-topic (not this bet, game, teams or NHL betting): say so in one sentence.",
};

/** Les tâches à invite FIXE. `parse_bet_command` n'y est pas : voir `LLM_TASK_TYPES`. */
export type FixedPromptTask = Exclude<LlmTaskType, 'parse_bet_command'>;

/** Les invites FIXES. */
const PROMPTS: Record<FixedPromptTask, Record<LlmLocale, string>> = {
  explain_bet: EXPLAIN_BET,
  ask_followup: ASK_FOLLOWUP,
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
export function systemPromptFor(taskType: FixedPromptTask, locale: LlmLocale): string {
  return `${PROMPTS[taskType][locale]}\n${LANGUAGE_RULE[locale]}`;
}
