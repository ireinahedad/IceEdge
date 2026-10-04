-- 041_odds_snapshots_multibook.sql
-- Plusieurs LIVRES par passe dans la série temporelle des cotes.
--
-- POURQUOI (2026-10-04). La collecte suit un livre fixe (`ODDS_COLLECT_BOOKMAKERS`,
-- DraftKings), le même que le backfill 2023-2026 : c'est la série du CLV et des
-- backtests, elle ne doit pas changer. Décision du user : collecter EN PLUS,
-- en parallèle, un livre où il peut réellement parier (`ODDS_SHADOW_BOOKMAKERS`,
-- défaut `bet99_ca_on`, le plus proche de Bet365). Dans un an, une saison
-- complète permettra de juger les value bets AUX PRIX de ce livre — ce que
-- personne ne peut mesurer aujourd'hui, The Odds API n'ayant presque aucun
-- historique des livres canadiens.
--
-- Même appel, même coût : jusqu'à 10 livres comptent pour une région.
--
-- La clé primaire (match, observed_at) ne permettait qu'UN livre par passe : le
-- second aurait été écarté par `ON CONFLICT DO NOTHING`, en silence. Elle
-- devient (match, observed_at, livre). `bookmaker` reste NULLABLE pour les lignes
-- d'avant la 038 (un défaut inventé serait pire qu'un vide) : d'où un index
-- unique sur `COALESCE(bookmaker, '')` plutôt qu'une clé primaire, qui
-- exigerait NOT NULL.
--
-- `odds_log` (une ligne par match, lue par `fetch_data_v4.py`) ne change pas :
-- il ne reçoit que le livre de collecte.

ALTER TABLE odds_snapshots DROP CONSTRAINT IF EXISTS odds_snapshots_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_snapshots_obs_book
  ON odds_snapshots (game_date, home_team, away_team, observed_at, (COALESCE(bookmaker, '')));
