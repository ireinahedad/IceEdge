-- 050_pickem_model.sql
-- F3, pick'em ICEEDGE — session B (NEWS_CONSENSUS_PLAN.md, étape 5).
--
-- Le classement hebdomadaire affiche « le taux du modèle ICEEDGE sur les mêmes
-- matchs ». Aucune table ne gardait le choix du modèle AVANT un match : la page
-- de précision est statique, et recalculer après coup donnerait un modèle qui
-- connaît déjà les alignements et le gardien. On FIGE donc son choix :
--
-- • Quand : dans l'heure qui précède la mise au jeu, aux tours de NewsSync
--   (15 min dans la fenêtre des matchs), seulement pour les matchs qui ont au
--   moins un vote. Le dernier tour avant la mise au jeu gagne.
-- • Quoi : `home_pct` = probabilité de victoire du domicile, prolongation et
--   tirs de barrage compris (marché `moneyline` du paquet ML) — la même
--   question que le pick'em. `pick` = l'équipe au-dessus de 50 % (égalité →
--   domicile).
-- • Règlement : `correct` rempli par la passe de rattrapage du règlement, en
--   même temps que `pickem_votes.correct`. Une ligne réglée ne bouge plus.
--
-- Pas de purge : une ligne par match voté, quelques milliers par saison.

CREATE TABLE IF NOT EXISTS pickem_model (
  game_id      TEXT         PRIMARY KEY CHECK (game_id ~ '^[0-9]{6,12}$'),
  home_team    TEXT         NOT NULL,
  away_team    TEXT         NOT NULL,
  game_start   TIMESTAMPTZ  NOT NULL,
  home_pct     NUMERIC(5,2) NOT NULL CHECK (home_pct >= 0 AND home_pct <= 100),
  pick         TEXT         NOT NULL,
  recorded_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  correct      BOOLEAN
);

-- Règlement : votes encore ouverts, par heure de match.
CREATE INDEX IF NOT EXISTS pickem_votes_unsettled_idx ON pickem_votes (game_start) WHERE correct IS NULL;
