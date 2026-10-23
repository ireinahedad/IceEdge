-- 046_parlay_log.sql
-- Journal des combinés publiés en vidéo (MARKETING_PLAN.md, Phase B).
--
-- ── POURQUOI (2026-10-22) ───────────────────────────────────────────────────
--
-- Chaque jour, les 2 combinés gratuits de l'accueil (`getBestParlays`,
-- `FREE_PARLAYS`) sont publiés sur YouTube Shorts / TikTok AVANT les matchs,
-- puis leur résultat le lendemain avec un bilan cumulé. Le bilan n'a de valeur
-- que si ce qui a été publié ne bouge plus : cette table est ce gel.
--
-- ── RÈGLES ─────────────────────────────────────────────────────────────────
--
-- • Une ligne = un combiné publié (jour NHL × rang). Gelé UNE fois par jour
--   (`freezeDailyParlays`) ; ensuite `legs` et `probability` ne sont jamais
--   modifiés, et aucune ligne n'est supprimée — perdus compris.
-- • Le bilan démarre au premier gel : aucun historique reconstruit après coup.
-- • `leg_results` garde le verdict de chaque jambe (✅/❌ de la vidéo résultat),
--   écrit par `settlePendingParlays` avec la logique des coupons.
-- • Les drapeaux `youtube_*` / `tiktok_*` rendent le workflow idempotent : un
--   run relancé ne republie jamais.
--
-- Purge : aucune. Deux lignes par soir.

CREATE TABLE IF NOT EXISTS parlay_log (
  id                     BIGSERIAL    PRIMARY KEY,
  date                   DATE         NOT NULL,          -- jour NHL (heure de l'Est)
  rank                   INT          NOT NULL CHECK (rank >= 1),
  parlay_id              TEXT         NOT NULL,          -- BestParlay.id au moment du gel
  kind                   TEXT         NOT NULL CHECK (kind IN ('moneyline', 'mixed')),
  legs                   JSONB        NOT NULL,          -- BestBet[], comme un coupon
  probability            NUMERIC      NOT NULL,          -- %, corrélations comprises
  book_price             NUMERIC      CHECK (book_price IS NULL OR book_price > 1),
  first_start_utc        TIMESTAMPTZ,                    -- 1re mise au jeu des jambes
  frozen_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Règlement.
  status                 TEXT         NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending', 'won', 'lost', 'void')),
  leg_results            JSONB,                          -- ('win'|'loss'|'void'|'unknown')[]
  settled_at             TIMESTAMPTZ,
  -- Publication (posés par le workflow, jamais effacés).
  youtube_pick_id        TEXT,
  youtube_result_id      TEXT,
  tiktok_pick_sent_at    TIMESTAMPTZ,
  tiktok_result_sent_at  TIMESTAMPTZ,
  UNIQUE (date, rank)
);

CREATE INDEX IF NOT EXISTS idx_parlay_log_pending ON parlay_log (first_start_utc) WHERE status = 'pending';
