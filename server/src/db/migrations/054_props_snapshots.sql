-- 054_props_snapshots.sql
-- Série temporelle des cotes de PROPS JOUEUR — la référence de marché qui manque
-- au modèle joueur.
--
-- POURQUOI (2026-11-16). Le modèle joueur (section 5 du document technique)
-- prédit neuf statistiques et sert des marchés plus / moins, mais il n'a jamais
-- été comparé à un marché : le jeu de données ne contient aucune cote de props,
-- seulement des cotes de match. Il n'est donc jugé que contre une règle simple,
-- alors que le modèle de match, lui, se mesure contre la clôture. The Odds API
-- ne vend pas d'historique de props pour la LNH : la seule façon d'en avoir est
-- d'en capturer à partir de maintenant. Chaque semaine non collectée est perdue
-- définitivement.
--
-- MÊME FORME QUE `odds_snapshots` (031/041), pour la même raison : le CLV se
-- mesure entre le prix pris et le prix de clôture, donc il faut savoir ce qui
-- était affiché à un instant donné. `observed_at` est identique pour toute une
-- passe, calculé côté Node, afin de pouvoir regrouper « l'état du marché à
-- 15 h 25 UTC ».
--
-- CE QUE ÇA COÛTE. L'endpoint par événement facture les marchés RENVOYÉS ×
-- les régions : 4 marchés sur 1 région = 4 crédits par match. Sept matchs,
-- deux passes par jour ≈ 56 crédits/jour. Le plafond vit dans
-- `ODDS_PROPS_DAILY_BUDGET` et la réserve visiteur d'`oddsQuota` reste
-- prioritaire. En lignes : ~15 joueurs × 4 marchés × 7 matchs × 2 passes ×
-- 190 jours ≈ 160 000 lignes par saison.
--
-- `line` EST NULLABLE : les marchés oui/non (`player_goal_scorer_anytime`,
-- `player_goal_scorer_first`) n'ont pas de seuil. Pour eux, `over_price` porte
-- le prix du « oui » et `under_price` celui du « non ». Les marchés plus/moins
-- remplissent les trois colonnes.
--
-- `player` EST LE NOM TEL QUE LE LIVRE L'ÉCRIT (champ `description` de The Odds
-- API), sans normalisation : l'appariement avec les identifiants MoneyPuck se
-- fera côté ML, où il est mesurable et corrigeable. Normaliser ici perdrait
-- l'information d'origine sans possibilité de retour.

CREATE TABLE IF NOT EXISTS props_snapshots (
  game_date      DATE        NOT NULL,
  home_team      TEXT        NOT NULL,          -- abréviation NHL (spine)
  away_team      TEXT        NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL,          -- identique pour toute la passe
  commence_time  TIMESTAMPTZ,                   -- mise au jeu, pour le T−N h
  pass_kind      TEXT        NOT NULL,          -- 'open' | 'close'
  bookmaker      TEXT        NOT NULL,
  market         TEXT        NOT NULL,          -- player_points, player_shots_on_goal, ...
  player         TEXT        NOT NULL,          -- nom brut du livre
  line           NUMERIC,                       -- NULL pour les marchés oui/non
  over_price     NUMERIC,                       -- « oui » pour les marchés oui/non
  under_price    NUMERIC                        -- « non » pour les marchés oui/non
);

-- Un seul prix par (match, passe, livre, marché, joueur, seuil). `line` étant
-- nullable, l'unicité passe par COALESCE — même raison que l'index de la 041.
CREATE UNIQUE INDEX IF NOT EXISTS uq_props_snapshots
  ON props_snapshots (game_date, home_team, away_team, observed_at,
                      bookmaker, market, player, (COALESCE(line, -999)));

-- L'export lit par plage de dates.
CREATE INDEX IF NOT EXISTS idx_props_snapshots_date
  ON props_snapshots (game_date);

-- L'analyse lit un joueur et un marché dans le temps.
CREATE INDEX IF NOT EXISTS idx_props_snapshots_player
  ON props_snapshots (market, player, game_date);
