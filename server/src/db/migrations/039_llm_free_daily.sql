-- 039_llm_free_daily.sql
-- Appels LLM gratuits du Bet builder IA (SLIP_COMMANDE_PLAN.md § 5.2).
--
-- ── CE QUE CETTE TABLE COMPTE ───────────────────────────────────────────────
--
-- Un compte GRATUIT a droit à LLM_FREE_PARSE_DAILY (2 par défaut) appels par
-- jour à la tâche `parse_bet_command`, sur la clé de l'OPÉRATEUR (décision du
-- user, 2026-09-28). C'est le premier usage gratuit payé par l'opérateur :
-- le compteur doit donc survivre aux redéploiements et au multi-instance,
-- comme `llm_usage` (024). Le compteur journalier en mémoire de la route ne
-- convient pas : il protège le serveur, pas un budget.
--
-- Ils ont LEUR PROPRE disjoncteur mensuel, `llm_free_global` ci-dessous, et ne
-- touchent PAS `llm_usage_global` (celui de Pro). Décision du user, 2026-09-29 :
-- avec un disjoncteur commun, quelques centaines de comptes gratuits actifs
-- suffisaient à couper l'IA aux abonnés Pro.
--
-- Une ligne par (utilisateur, jour UTC), et seulement les jours où il s'en est
-- servi. Purgée au-delà de 7 jours par `cleanup.service.ts`.
CREATE TABLE IF NOT EXISTS llm_free_daily (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Jour calendaire 'YYYY-MM-DD' en UTC, calculé côté application — même
  -- choix que `llm_usage.month` : une borne explicite et testable.
  day        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day)
);

-- Disjoncteur mensuel des appels GRATUITS, toutes personnes confondues
-- (`LLM_FREE_GLOBAL_MONTHLY_CAP`, 5 000 par défaut). Même rôle que
-- `llm_usage_global` pour Pro : borner la dépense de l'opérateur quoi qu'il
-- arrive au compteur par utilisateur.
CREATE TABLE IF NOT EXISTS llm_free_global (
  month      TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
