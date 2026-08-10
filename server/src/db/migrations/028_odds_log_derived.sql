-- 028_odds_log_derived.sql
-- Marchés dérivés dans le journal des cotes + état du quota The Odds API.
--
-- POURQUOI — `odds_log` (migration 027) ne stocke que le moneyline et la
-- LIGNE de total. Le prix over/under et la puck line étaient demandés à
-- l'API… puis jetés. Or ce sont exactement les marchés que le modèle de score
-- price le mieux, et les seuls pour lesquels un ROI reste à établir : sans
-- prix, aucune rentabilité n'est calculable.
--
-- L'archive historique (sportsbookreviewsonline) s'arrête à 2022-23 et ne sera
-- plus mise à jour ; l'endpoint historique de The Odds API n'est pas servi aux
-- clés gratuites. La collecte au fil de l'eau est donc la SEULE façon de
-- constituer ce jeu de données — et elle ne rattrape pas le passé : la cote de
-- clôture d'un match d'hier n'existe plus nulle part.
--
-- OUVERTURE / CLÔTURE — même principe qu'en 027 : la première passe d'une
-- journée pose l'ouverture, les suivantes ne mettent à jour que la clôture.
-- L'écart entre les deux est le mouvement de cote, matière première du CLV
-- (« suis-je du bon côté du mouvement ? »), qui converge bien plus vite qu'un
-- ROI et reste mesurable sur quelques centaines de paris.

ALTER TABLE odds_log
  -- Prix des deux côtés du total. La LIGNE est déjà dans total_open/close.
  ADD COLUMN IF NOT EXISTS total_open_over    NUMERIC,
  ADD COLUMN IF NOT EXISTS total_open_under   NUMERIC,
  ADD COLUMN IF NOT EXISTS total_close_over   NUMERIC,
  ADD COLUMN IF NOT EXISTS total_close_under  NUMERIC,
  -- Puck line : handicap du DOMICILE (−1.5 s'il est favori, +1.5 sinon),
  -- et le prix de chaque camp.
  ADD COLUMN IF NOT EXISTS puck_line_home     NUMERIC,
  ADD COLUMN IF NOT EXISTS pl_home_price_open  NUMERIC,
  ADD COLUMN IF NOT EXISTS pl_away_price_open  NUMERIC,
  ADD COLUMN IF NOT EXISTS pl_home_price      NUMERIC,
  ADD COLUMN IF NOT EXISTS pl_away_price      NUMERIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- État du quota The Odds API, partagé entre la collecte et le proxy public.
--
-- POURQUOI EN BASE — le solde ne vit que dans l'en-tête `x-requests-remaining`
-- de la dernière réponse. Gardé en mémoire, il est perdu à chaque redéploiement
-- (Railway en fait souvent), et le processus redémarre en croyant le quota
-- intact : il dépense alors sans le savoir. Une seule ligne suffit.
--
-- La règle d'arbitrage vit dans le code (`oddsQuota.ts`), pas ici : la collecte
-- s'arrête au-dessus d'un plancher réservé aux utilisateurs, ces derniers
-- peuvent descendre jusqu'à zéro. Le but est qu'un visiteur ne voie jamais une
-- page vide parce qu'un job de fond a consommé le mois.
CREATE TABLE IF NOT EXISTS odds_quota_state (
  id           SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  remaining    INTEGER,
  used         INTEGER,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO odds_quota_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
