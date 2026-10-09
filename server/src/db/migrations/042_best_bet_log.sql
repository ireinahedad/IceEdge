-- 042_best_bet_log.sql
-- Journal des Best Bets affichés à l'accueil — la matière de /dev/profit.
--
-- ── POURQUOI (2026-10-09) ───────────────────────────────────────────────────
--
-- Les Best Bets sont calculés à la volée (cache 60 s) et n'étaient gardés
-- nulle part : impossible de répondre à « combien j'aurais gagné en misant 20 $
-- sur chaque best bet du jour ». Cette table garde chaque pari qui est entré
-- dans la liste, avec son prix et son rang, puis son résultat une fois réglé.
--
-- ── CE QU'UNE LIGNE EST ────────────────────────────────────────────────────
--
-- Une SÉLECTION (match × id du best bet), pas une apparition. La première
-- apparition fixe `first_*` ; les suivantes mettent à jour `last_*` et
-- `best_rank` (le meilleur rang jamais atteint). Plusieurs instances qui
-- calculent la même liste écrivent la même ligne (`ON CONFLICT … DO UPDATE`).
--
-- L'id d'un best bet joueur (`bb-p-<joueur>-<marché>`) ne contient pas le match :
-- la clé est donc (game_id, bet_id).
--
-- ── RÈGLEMENT ──────────────────────────────────────────────────────────────
--
-- `outcome` part à 'pending' et est réglé à la lecture de /api/dev/best-bets-profit
-- par la même logique que les coupons (`settleStandaloneLegs`). 'void' = pari
-- indécidable (égalité sur la ligne, joueur absent du boxscore…) : mise rendue.
--
-- Purge : aucune. Quelques dizaines de lignes par soir.

CREATE TABLE IF NOT EXISTS best_bet_log (
  id               BIGSERIAL    PRIMARY KEY,
  bet_id           TEXT         NOT NULL,          -- BestBet.id
  game_id          TEXT         NOT NULL,
  game_date        DATE         NOT NULL,          -- jour NHL (heure de l'Est)
  start_time_utc   TIMESTAMPTZ,
  home_team        TEXT,
  away_team        TEXT,
  subject_type     TEXT         NOT NULL CHECK (subject_type IN ('game', 'player')),
  subject_id       TEXT         NOT NULL,          -- id du match ou du joueur
  subject_name     TEXT         NOT NULL,
  market_type      TEXT         NOT NULL,
  market_label     TEXT         NOT NULL,
  label            TEXT         NOT NULL,          -- « BOS to win », « McDavid anytime goal »
  selection_value  TEXT         NOT NULL,
  line             NUMERIC,
  source           TEXT         NOT NULL,          -- 'ml' | 'rules'
  -- Première apparition dans la liste.
  first_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  first_rank       INT          NOT NULL,
  first_score      NUMERIC      NOT NULL,          -- probabilité affichée, en %
  first_price      NUMERIC      CHECK (first_price IS NULL OR first_price > 1),   -- cote décimale
  -- Dernière apparition (la plus proche de la mise au jeu).
  last_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_rank        INT          NOT NULL,
  last_score       NUMERIC      NOT NULL,
  last_price       NUMERIC      CHECK (last_price IS NULL OR last_price > 1),
  best_rank        INT          NOT NULL,
  book_title       TEXT,
  -- Règlement.
  outcome          TEXT         NOT NULL DEFAULT 'pending'
                                CHECK (outcome IN ('pending', 'win', 'loss', 'void')),
  settled_at       TIMESTAMPTZ,
  UNIQUE (game_id, bet_id)
);

CREATE INDEX IF NOT EXISTS idx_best_bet_log_date    ON best_bet_log (game_date);
CREATE INDEX IF NOT EXISTS idx_best_bet_log_pending ON best_bet_log (start_time_utc) WHERE outcome = 'pending';
