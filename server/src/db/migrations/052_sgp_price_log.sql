-- 052_sgp_price_log.sql
-- Journal ANONYME des prix SGP (plan de croissance « The Parlay Tax Engine »,
-- Claude Doc, « It builds a data moat » ; métrique « Grades per week »).
--
-- Chaque SGP chiffré par « Scanner un ticket » (après « Analyser ce ticket ») laisse
-- UNE ligne : la cote payée, le bookmaker, les marchés, la probabilité du modèle
-- (corrélation du même match) et le produit naïf des jambes. Sur une saison, c'est
-- ce qui montre comment un livre prix les corrélations NHL — donnée qu'aucune API
-- de cotes ne publie pour les SGP.
--
-- ANONYME, par construction :
--   • aucune colonne user_id, aucune IP, aucun appareil, aucune mise ni gain ;
--   • `logged_hour` arrondi à l'heure : on ne peut pas recouper une ligne avec
--     `slip_scan_daily.updated_at` (qui, lui, porte un user_id) ;
--   • `fingerprint` = sha256 du SGP (match, livre, cote, jambes) : deux scans du
--     MÊME ticket au MÊME prix → une ligne, `seen_count` + 1. Ne dit rien de qui.
-- Les identifiants de joueurs/équipes dans `legs` sont ceux, publics, de la NHL.
--
-- Pas de purge : c'est la donnée qu'on accumule (quelques milliers de lignes par saison).
CREATE TABLE IF NOT EXISTS sgp_price_log (
  id               BIGSERIAL PRIMARY KEY,
  fingerprint      TEXT        NOT NULL UNIQUE,
  logged_hour      TIMESTAMPTZ NOT NULL,
  game_id          TEXT        NOT NULL,
  -- Pas de liste fermée : un livre ajouté au scanner (FanDuel…) ne doit pas casser le journal.
  bookmaker        TEXT        NOT NULL CHECK (bookmaker ~ '^[a-z0-9_]{2,20}$'),
  lang             TEXT        CHECK (lang IN ('fr', 'en')),
  odds_format      TEXT        CHECK (odds_format IN ('american', 'decimal', 'fractional')),
  -- Cote telle qu'affichée sur le ticket (« +600 », « 7.00 ») et sa valeur décimale.
  paid_odds        TEXT        NOT NULL,
  paid_decimal     NUMERIC(10, 3) NOT NULL CHECK (paid_decimal > 1),
  implied_pct      NUMERIC(5, 2)  NOT NULL,
  -- Probabilité du modèle pour le groupe, corrélation comprise (0–100).
  model_pct        NUMERIC(5, 2)  NOT NULL CHECK (model_pct > 0 AND model_pct < 100),
  -- `server` = /predict/parlay (loi jointe) ; `local` = repli hors ligne `combineParlayLegs`.
  model_source     TEXT        NOT NULL CHECK (model_source IN ('server', 'local')),
  -- Produit des jambes comme si elles étaient indépendantes (0–100) : l'écart avec
  -- model_pct est la corrélation que le modèle voit ; avec implied_pct, celle que le livre fait payer.
  independent_pct  NUMERIC(6, 3)  NOT NULL,
  -- 1 − p × cote décimale, en % (même définition que content/parlayTax.ts et slipScanValue.ts).
  tax_pct          NUMERIC(6, 2)  NOT NULL,
  n_legs           SMALLINT    NOT NULL CHECK (n_legs BETWEEN 2 AND 12),
  -- Marchés triés et joints par « + » (« goals_ou+player_points ») : pour les GROUP BY.
  market_key       TEXT        NOT NULL,
  -- [{ market, subjectType, subjectId, selection, line, modelPct }]
  legs             JSONB       NOT NULL,
  seen_count       INTEGER     NOT NULL DEFAULT 1,
  last_seen_hour   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sgp_price_log_hour_idx   ON sgp_price_log (logged_hour);
CREATE INDEX IF NOT EXISTS sgp_price_log_market_idx ON sgp_price_log (bookmaker, market_key);
