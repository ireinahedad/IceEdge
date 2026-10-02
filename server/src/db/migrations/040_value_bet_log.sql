-- 040_value_bet_log.sql
-- Journal des value bets détectés — la matière du CLV des value bets.
--
-- ── POURQUOI (2026-10-02) ───────────────────────────────────────────────────
--
-- Un value bet affiché à l'accueil ou poussé en alerte n'a de sens que s'il bat
-- la cote de CLÔTURE. Le ROI réalisé ne tranchera jamais à ce volume (A3 :
-- ~13 000 paris pour lire 2 % de ROI, ~160 pour lire 0,5 % de CLV). Il faut
-- donc garder, pour chaque value bet, le PRIX auquel il a été proposé et
-- l'heure, pour le comparer plus tard à la clôture de `odds_snapshots`.
--
-- ── CE QU'UNE LIGNE EST ────────────────────────────────────────────────────
--
-- Une SÉLECTION (match × marché × équipe), pas une détection : la première
-- détection fixe `first_*` (le prix réellement proposé en premier, celui que
-- le CLV juge), les suivantes ne mettent à jour que `last_*`. Plusieurs
-- instances qui détectent la même sélection écrivent donc la même ligne
-- (`ON CONFLICT … DO UPDATE`), sans doublon.
--
-- ── POUR LE CLV, PLUS TARD ──────────────────────────────────────────────────
--
-- `game_date`, `home_team`, `away_team` sont les clés de `odds_snapshots`
-- (abréviations NHL, date du calendrier). La clôture y est celle du livre de
-- collecte (`odds_snapshots.bookmaker`), pas forcément celui d'affichage
-- (`bookmaker` ici) : comparer `p_clôture_dé-viggée × first_price − 1`, comme
-- la colonne « ROI selon la clôture » d'A3, mélange donc deux livres sans
-- fausser la mesure. `model_prob` est gardé pour rejouer le placebo d'A3 —
-- sans placebo, sélectionner sur l'edge fabrique un CLV positif même pour un
-- modèle sans information.
--
-- Purge : aucune. Une ligne par sélection retenue, quelques-unes par soir.

CREATE TABLE IF NOT EXISTS value_bet_log (
  id                BIGSERIAL    PRIMARY KEY,
  game_id           TEXT         NOT NULL,
  game_date         DATE         NOT NULL,
  home_team         TEXT         NOT NULL,          -- abréviation NHL
  away_team         TEXT         NOT NULL,
  commence_time     TIMESTAMPTZ,
  market            TEXT         NOT NULL CHECK (market IN ('moneyline', 'puck_line')),
  team              TEXT         NOT NULL,          -- abréviation de la sélection
  line              NUMERIC,                        -- −1.5 (puck line) ; NULL (vainqueur)
  bookmaker         TEXT         NOT NULL,          -- clé The Odds API du prix
  -- Première détection : c'est elle que le CLV juge.
  first_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  first_price       NUMERIC      NOT NULL CHECK (first_price > 1),
  first_model_prob  NUMERIC      NOT NULL CHECK (first_model_prob > 0 AND first_model_prob < 1),
  first_market_prob NUMERIC      NOT NULL CHECK (first_market_prob > 0 AND first_market_prob < 1),
  first_edge        NUMERIC      NOT NULL,
  -- Dernière détection : jusqu'où la sélection est restée une value.
  last_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_price        NUMERIC      NOT NULL CHECK (last_price > 1),
  last_edge         NUMERIC      NOT NULL,
  UNIQUE (game_id, market, team)
);

CREATE INDEX IF NOT EXISTS idx_value_bet_log_date ON value_bet_log (game_date);
