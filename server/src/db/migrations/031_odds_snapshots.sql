-- 031_odds_snapshots.sql
-- A3 — série temporelle des cotes, la matière première du CLV.
--
-- POURQUOI UNE TABLE DE PLUS ALORS QUE `odds_log` EXISTE.
--
-- `odds_log` (027/028) tient UNE ligne par match, avec une ouverture et une
-- clôture. C'est le bon format pour `fetch_data_v4.py`, qui veut un prix par
-- match, et il ne change pas. Mais il écrase : chaque passe du collecteur
-- réécrit les colonnes `*_close`, donc tout ce qui se passe ENTRE la première
-- et la dernière observation est perdu.
--
-- Or le CLV — « ai-je misé du bon côté du mouvement de ligne ? » — se mesure
-- entre le prix au moment de la mise et le prix de clôture. Il faut donc savoir
-- ce qui était affiché à un instant donné, pas seulement aux deux bouts. A2 a
-- rendu cette mesure obligatoire : la règle puck line ne produit que ~51 paris
-- par saison, un ROI ne conclura jamais dessus, alors que le CLV converge sur
-- quelques centaines de paris parce qu'il mesure un écart de prix et non un
-- résultat binaire.
--
-- CE QUE ÇA COÛTE : rien en crédits. Un appel à The Odds API ramène déjà tous
-- les matchs du jour avec leurs cotes du moment ; le collecteur jetait
-- simplement les passes intermédiaires. Le coût est en lignes — environ 15
-- matchs × 6 passes × 200 jours ≈ 18 000 lignes par saison.
--
-- `observed_at` EST LA MÊME VALEUR POUR TOUTE UNE PASSE, calculée une fois côté
-- Node et non par `NOW()` ligne à ligne : c'est ce qui permet de regrouper une
-- passe (« l'état du marché à 18 h 45 ») au lieu de trier des horodatages qui
-- diffèrent de quelques millisecondes.
--
-- `commence_time` EST INDISPENSABLE et n'est pas déductible de `game_date` :
-- les matchs d'une même soirée s'étalent de 19 h à 22 h 30 ET. Sans elle, on ne
-- peut pas calculer le « T−3 h » propre à chaque match, ni savoir quel snapshot
-- fait office de clôture pour quel match. C'est la colonne qui rend la table
-- exploitable ; la stocker ici évite une jointure sur le spine NHL au moment de
-- l'analyse.

CREATE TABLE IF NOT EXISTS odds_snapshots (
  game_date      DATE        NOT NULL,
  home_team      TEXT        NOT NULL,          -- abréviation NHL (spine)
  away_team      TEXT        NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL,          -- identique pour toute la passe
  commence_time  TIMESTAMPTZ,                   -- mise au jeu, pour le T−N h
  -- 'full' = h2h + spreads + totals (3 crédits) ; 'spreads' = puck line seule
  -- (1 crédit). Sans cette colonne, un moneyline absent est ambigu : marché non
  -- coté par le book, ou simplement pas demandé lors de cette passe ?
  markets        TEXT        NOT NULL,
  home_ml        NUMERIC,
  away_ml        NUMERIC,
  total          NUMERIC,                       -- la LIGNE de total
  total_over     NUMERIC,
  total_under    NUMERIC,
  puck_line_home NUMERIC,                       -- handicap du domicile (±1.5)
  pl_home_price  NUMERIC,
  pl_away_price  NUMERIC,
  PRIMARY KEY (game_date, home_team, away_team, observed_at)
);

-- L'analyse lit par plage de dates, comme l'export de `odds_log`.
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_date
  ON odds_snapshots (game_date);

-- Le CLV se lit match par match, du premier au dernier snapshot.
CREATE INDEX IF NOT EXISTS idx_odds_snapshots_game
  ON odds_snapshots (game_date, home_team, away_team, observed_at);
