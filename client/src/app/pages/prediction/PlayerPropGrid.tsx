/**
 * PlayerPropGrid.tsx — les paris joueur d'un match ou d'un club, en grille.
 *
 * ── Ce qu'elle remplace ─────────────────────────────────────────────────────
 *
 * Le tableau de statistiques qui fermait ces pages (`GamePlayersTable`) montrait
 * la ligne de saison de chaque joueur — des nombres à lire, sur lesquels on ne
 * pouvait rien miser. Pour parier sur les buts de quelqu'un, il fallait toucher
 * sa ligne, choisir « ses prédictions », atterrir sur sa page, y trouver le bon
 * groupe : cinq gestes et deux écrans pour un pari, répétés pour chaque joueur
 * qu'on voulait comparer. La comparaison, elle, était perdue en route.
 *
 * Ici, une ligne par joueur, une colonne par seuil, et chaque case EST le pari.
 * On lit la grille de haut en bas pour comparer, on touche pour miser.
 *
 * ── Les cinq premiers, puis tout le monde ───────────────────────────────────
 *
 * Une formation fait une vingtaine de patineurs. Les déployer d'emblée pousse
 * les marchés suivants hors de l'écran et noie les cinq joueurs sur lesquels
 * portent la plupart des paris. La grille s'ouvre donc sur le top 5 du
 * classement de la statistique concernée et se déplie SUR PLACE — pas de
 * navigation, pas de fiche : la page ne bouge pas sous les doigts.
 */

import { useEffect, useMemo, useState } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { BetOption } from "./PredictionSheet";
import type { BetOpt, MLProps } from "./gameMarkets";

/** Les statistiques qu'on peut miser en grille. */
export type PropMetric = "goals" | "assists" | "blocks";

interface MetricSpec {
  /** Champ de la ligne d'effectif qui porte le total de saison. */
  field: "goals" | "assists" | "blockedShots";
  /** Seuils proposés en colonnes. « 1+ » veut dire ligne 0,5. */
  thresholds: number[];
  /** Marché envoyé au moteur de probabilité. */
  propType: string;
  /** Marché canonique pour le règlement automatique du coupon. */
  settleMarket: string;
  /** Clé i18n du titre de la section. */
  titleKey: string;
}

/**
 * ⚠️ Les seuils s'arrêtent où la statistique cesse d'être crédible.
 *
 * Trois buts dans un match, c'est un tour du chapeau : rare, mais un vrai
 * marché. Quatre, c'est une probabilité qu'un modèle de Poisson calé sur une
 * moyenne de saison n'estime plus honnêtement — on ne propose pas une colonne
 * pour faire nombre. Les passes montent plus haut (elles sont plus fréquentes),
 * les tirs bloqués aussi (un défenseur en bloque deux ou trois par match).
 */
const SPECS: Record<PropMetric, MetricSpec> = {
  goals: {
    field: "goals", thresholds: [1, 2, 3],
    propType: "goals", settleMarket: "anytime_goal", titleKey: "prop.goals",
  },
  assists: {
    field: "assists", thresholds: [1, 2],
    propType: "assists", settleMarket: "assists_ou", titleKey: "prop.assists",
  },
  blocks: {
    field: "blockedShots", thresholds: [1, 2, 3],
    propType: "blocks", settleMarket: "blocked_shots_ou", titleKey: "prop.blocks",
  },
};

/**
 * P(X ≥ k) pour une cadence λ par match, loi de Poisson.
 *
 * Le même modèle que celui déjà employé par `PlayerPrediction` pour « buteur à
 * tout moment » — délibérément : deux estimations différentes du même pari
 * selon l'écran où on le regarde, c'est la chose à ne pas faire.
 *
 * Bornée à [3, 92] comme ailleurs dans l'app : au-delà, on afficherait une
 * précision qu'une moyenne de saison ne porte pas.
 */
function poissonAtLeast(lambda: number, k: number): number {
  const lam = Math.max(0.001, lambda);
  let term = Math.exp(-lam);
  let cdf = term;                       // P(X = 0)
  for (let i = 1; i < k; i++) {
    term *= lam / i;
    cdf += term;                        // P(X ≤ k-1)
  }
  return Math.min(92, Math.max(3, Math.round((1 - cdf) * 100)));
}

type RosterRow = {
  id: string; name: string; position?: string; number?: number;
  gamesPlayed?: number; goals?: number; assists?: number; blockedShots?: number;
};

/** Une ligne de la grille, prête à rendre. */
interface GridRow {
  id: string;
  name: string;
  position: string;
  /** Total de saison, affiché en tête de ligne pour situer le joueur. */
  total: number;
  /** Une option de pari par seuil. */
  opts: BetOpt[];
}

export function PlayerPropGrid({ metric, sides, gameId, accent }: {
  metric: PropMetric;
  /** Un club sur une page d'équipe, deux sur une page de match. */
  sides: { key: string; abbr: string; name: string }[];
  gameId?: string;
  accent: string;
}) {
  const { t, lang } = useI18n();
  const spec = SPECS[metric];

  const [sideKey, setSideKey] = useState(sides[0]?.key ?? "");
  const [rosters, setRosters] = useState<Record<string, RosterRow[]>>({});
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const side = sides.find(s => s.key === sideKey) ?? sides[0];
  const abbr = side?.abbr ?? "";

  useEffect(() => {
    if (!abbr || rosters[abbr]) return;
    let alive = true;
    setLoading(true);
    nhlApiService.getTeamRoster(abbr.toUpperCase())
      .then((r: any[]) => { if (alive) setRosters(prev => ({ ...prev, [abbr]: r as RosterRow[] })); })
      .catch(() => { if (alive) setRosters(prev => ({ ...prev, [abbr]: [] })); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [abbr]);

  // Changer de club referme le dépliage : on regarde une autre formation, pas
  // la suite de la précédente.
  useEffect(() => { setExpanded(false); }, [abbr]);

  const rows: GridRow[] = useMemo(() => {
    const roster = rosters[abbr] ?? [];
    return roster
      // Les gardiens n'ont ni but, ni passe, ni tir bloqué au sens de ces
      // marchés. Les laisser produirait une vingtaine de cases à 3 % en bas de
      // chaque grille.
      .filter(p => (p.position ?? "F") !== "G")
      .map((p) => {
        const gp = Math.max(1, p.gamesPlayed ?? 0);
        const total = Number(p[spec.field] ?? 0);
        const lambda = total / gp;
        const opts: BetOpt[] = spec.thresholds.map((k) => {
          const line = k - 0.5;
          const mlProps: MLProps = {
            type: "player", subjectId: p.id, propType: spec.propType, line,
            settleMarket: spec.settleMarket,
            // « anytime_goal » se règle sur `buts > ligne`, donc la ligne porte
            // déjà le seuil ; la sélection reste « oui ». Les marchés en
            // over/under attendent « over ».
            settleSelection: spec.settleMarket === "anytime_goal" ? "yes" : "over",
            gameId,
          };
          return {
            id: `${metric}-${p.id}-${k}`,
            label: `${p.name} · ${k}+ ${t(spec.titleKey)}`,
            rulePct: poissonAtLeast(lambda, k),
            ruleNote: t("prop.note", {
              name: p.name, k: String(k), metric: t(spec.titleKey).toLowerCase(),
              rate: lambda.toFixed(2), total: String(total), gp: String(gp),
            }),
            mlProps,
          };
        });
        return { id: p.id, name: p.name, position: p.position ?? "F", total, opts };
      })
      .sort((a, b) => b.total - a.total);
    // `lang` et non `t` : le contexte i18n recrée `t` à chaque rendu du
    // fournisseur. Le mettre en dépendance recalculerait toute la grille — et
    // donc chaque objet `mlProps` — à chaque rendu de la page, ce qui est
    // exactement le motif que l'audit du 2026-09-16 a dû défaire sur les tuiles
    // de marché (31 appels de prédiction par bascule, 429 dès le premier
    // aller-retour). `lang` est la seule chose dont dépendent les libellés.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosters, abbr, metric, gameId, lang, spec]);

  // Tirs bloqués non câblés pour cette équipe (amont muet, ou saison à zéro
  // match) : la grille entière vaudrait « 3 % » sur chaque case, ce qui n'est
  // pas une prédiction mais un plancher. On le dit plutôt que de l'afficher.
  const hasData = rows.some(r => r.total > 0);
  const shown = expanded ? rows : rows.slice(0, 5);

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden">
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <span className="text-white text-sm font-medium">{t(spec.titleKey)}</span>
        <span className="text-[#8a9ea6] text-[11px] ml-auto">
          {expanded ? t("prop.allPlayers") : t("prop.top5")}
        </span>
      </div>

      {/* Sélecteur de club — seulement sur une page de match */}
      {sides.length > 1 && (
        <div className="px-4 pb-3">
          <div className="flex gap-1.5 bg-[#0A0E0C] rounded-xl p-1">
            {sides.map(o => (
              <button
                key={o.key}
                onClick={() => setSideKey(o.key)}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all"
                style={sideKey === o.key ? { background: accent, color: "#0A0E0C" } : { color: "#8a9ea6" }}
              >
                <img src={nhlLogoUrl(o.abbr)} alt={o.abbr} className="w-4 h-4 object-contain" />
                {o.abbr}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="px-4 pb-4 flex flex-col gap-2">
          {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-10 bg-[#0A0E0C] rounded-lg animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[#8a9ea6] text-xs text-center py-6">{t("players.none", { abbr })}</p>
      ) : !hasData ? (
        <p className="text-[#8a9ea6] text-xs text-center py-6 px-4">{t("prop.noStat")}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-[#8a9ea6]">
                  <th className="text-left font-semibold px-3 py-2 sticky left-0 z-10" style={{ background: "#131A12" }}>
                    {t("chart.player")}
                  </th>
                  {spec.thresholds.map(k => (
                    <th key={k} className="font-semibold px-1.5 py-2 text-center whitespace-nowrap">
                      {k}+
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="border-t border-white/[0.06]">
                    <td className="px-3 py-1.5 sticky left-0 z-10 whitespace-nowrap" style={{ background: "#131A12" }}>
                      <span className="text-white font-medium">{r.name}</span>
                      <span className="text-[#5c6f63] ml-1.5">{r.position}</span>
                      {/* Le total de saison situe le joueur : sans lui, deux
                          cases à 18 % se ressemblent alors que l'une repose sur
                          40 matchs et l'autre sur 3. */}
                      <span className="text-[#5c6f63] ml-1.5 tabular-nums">({r.total})</span>
                    </td>
                    {r.opts.map(o => (
                      <td key={o.id} className="px-1 py-1.5 align-middle" style={{ minWidth: 56 }}>
                        <BetOption opt={o} accent={accent} compact />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length > 5 && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="w-full py-2.5 text-[11px] font-semibold border-t border-white/[0.06] transition-colors"
              style={{ color: accent }}
            >
              {expanded
                ? t("prop.showLess")
                : t("prop.showMore", { n: String(rows.length - 5) })}
            </button>
          )}
        </>
      )}
    </div>
  );
}
