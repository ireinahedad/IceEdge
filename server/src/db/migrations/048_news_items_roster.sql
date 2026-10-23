-- 048_news_items_roster.sql
-- F4 (NEWS_CONSENSUS_PLAN.md, étape 3) : les transactions déduites des effectifs LNH.
--
-- `newsRoster.service.ts` compare chaque jour (1er tour de NewsSync après midi
-- ET) les effectifs `v1/roster/{équipe}/current` à ceux de la veille, gardés
-- dans `job_state` (une clé `news-roster:<ÉQUIPE>`, pas de table de plus).
-- Chaque joueur ajouté / retiré / passé d'une équipe à l'autre devient une
-- ligne `news_items` avec `source = 'nhl_roster'` et le drapeau `transaction`.
--
-- Seul changement de schéma : élargir le CHECK de `source` (047). Le nom est
-- celui que Postgres donne à un CHECK de colonne : <table>_<colonne>_check.
--
-- Ordre de déploiement : sans cette migration, le service tourne quand même —
-- son INSERT est refusé, la transaction annulée, les veilles ne bougent pas,
-- et les écarts reviennent le lendemain. Rien n'est perdu.

ALTER TABLE news_items DROP CONSTRAINT IF EXISTS news_items_source_check;
ALTER TABLE news_items
  ADD CONSTRAINT news_items_source_check CHECK (source IN ('bluesky', 'manual', 'nhl_roster'));
