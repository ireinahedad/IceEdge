-- 024_llm_usage.sql
-- P1-6 — Consommation LLM par utilisateur et par mois, et plafond global.
--
-- ── CE QUI EST FACTURÉ À QUI ────────────────────────────────────────────────
--
-- Un seul chemin coûte de l'argent à l'opérateur : le chemin **Pro**, qui passe
-- par le token GitHub Models de l'application. Les utilisateurs Free utilisent
-- leur propre clé OpenAI — leur consommation n'est pas notre problème et n'est
-- donc pas comptée ici.
--
-- ── POURQUOI EN BASE ────────────────────────────────────────────────────────
--
-- Le compteur vivait en mémoire du process. Trois trous, tous exploitables sans
-- mauvaise intention :
--   • un redéploiement remettait tous les compteurs à zéro — le quota était donc
--     contournable en attendant une mise en production ;
--   • en multi-instance, N instances = N× le quota, chacune comptant pour elle ;
--   • l'éviction du cache (plafond d'entrées) remettait aussi le compteur à zéro.
--
-- Une ligne par (utilisateur, mois). Pas de purge nécessaire : ~12 lignes par
-- utilisateur et par an, quelques dizaines d'octets chacune.
CREATE TABLE IF NOT EXISTS llm_usage (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Mois calendaire 'YYYY-MM' en UTC. Une colonne texte plutôt qu'une date
  -- tronquée : la clé est calculée côté application, donc la borne du mois est
  -- explicite et testable, et non dépendante du fuseau de la session Postgres.
  month      TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, month)
);

-- Compteur global, toutes personnes confondues, par mois.
--
-- Le plafond par utilisateur borne déjà la dépense totale par construction
-- (coût total ≤ somme des plafonds ≤ somme des abonnements). Ce compteur-ci est
-- un DISJONCTEUR, pas une seconde ceinture : il couvre le cas où le plafond par
-- utilisateur aurait été mal calculé — erreur de prix, changement de tarif du
-- fournisseur, ou vague d'abus. Sans lui, une erreur d'un facteur 10 dans un
-- paramètre ne se découvre que sur la facture.
CREATE TABLE IF NOT EXISTS llm_usage_global (
  month      TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
