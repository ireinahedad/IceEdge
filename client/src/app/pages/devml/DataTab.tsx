/** devml/DataTab.tsx — onglet « Données » du dashboard ML (`../DevMLDashboard.tsx`). */

import { Card, Metric, PanelState, fmt, timeAgo } from "./shared";
import type { DataHealthResponse, MLReportsResponse } from "./shared";

// ── Onglet Données ────────────────────────────────────────────────────────────

export function DataTab({
  health, loading, error, reports,
}: { health: DataHealthResponse | null; loading: boolean; error: string | null; reports: MLReportsResponse | null }) {
  if (!health) return <PanelState loading={loading} error={error} />;

  const ol = health.odds_log ?? {};
  const q  = health.odds_quota ?? {};
  const s  = health.slips ?? {};
  const sn = health.odds_snapshots ?? {};

  const lastWrite = timeAgo(ol.last_write);
  const quotaAge  = timeAgo(q.observed_at);
  const stateAge  = timeAgo(reports?.runtime?.inference_state_as_of);

  // Une collecte qui n'a rien écrit depuis 2 jours pendant la saison est morte.
  const collectStale = lastWrite.days != null && lastWrite.days > 2;
  const quotaLow     = q.remaining != null && q.remaining < 100;
  const movementPct  = ol.rows ? (100 * (ol.with_ml_movement ?? 0)) / ol.rows : null;

  // 6 passes/jour au calendrier (2 `full` + 4 `spreads`). En dessous, le
  // planificateur ne se replanifie pas — typiquement une instance qui redémarre.
  // À 0 pendant la saison, la série temporelle du CLV ne se constitue pas, et
  // c'est irrattrapable : la cote de clôture d'hier n'existe plus nulle part.
  const snapObserved = timeAgo(sn.last_observed);
  const snapStale    = snapObserved.days != null && snapObserved.days > 2;
  const passesShort  = (sn.passes_today ?? 0) > 0 && (sn.passes_today ?? 0) < 6;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      <Card title="Collecte des cotes (odds_log)"
            hint="Seule source de cotes récentes : l'archive publique s'arrête en 2022-23 et une cote de clôture manquée ne se rattrape pas.">
        {ol.error ? (
          <p className="text-red-400 text-xs">{ol.error}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
              <Metric label="Matchs journalisés" value={String(ol.rows ?? 0)} />
              <Metric label="Dernière écriture" value={lastWrite.label}
                color={collectStale ? "#facc15" : "#4ade80"} warn={collectStale} />
              <Metric label="Couverture" value={ol.first_date ? `${ol.first_date} → ${ol.last_date}` : "—"} />
              <Metric label="Clôture ML" value={String(ol.with_ml_close ?? 0)} />
              <Metric label="Clôture total" value={String(ol.with_total_close ?? 0)} />
              <Metric label="Clôture puck line" value={String(ol.with_puckline_close ?? 0)} />
            </div>
            <div className="p-3 rounded-xl border border-white/8 bg-[#0A0E0C]/60">
              <p className="text-[9px] uppercase tracking-wider text-[#bfc8cc]/70 mb-1">
                Lignes avec mouvement open ≠ close
              </p>
              <p className="text-lg font-black leading-none"
                 style={{ color: (movementPct ?? 0) > 20 ? "#4ade80" : "#facc15" }}>
                {ol.with_ml_movement ?? 0}
                <span className="text-xs font-normal text-[#bfc8cc]"> · {fmt(movementPct, 1, " %")}</span>
              </p>
              <p className="text-[10px] text-[#bfc8cc]/60 mt-1.5 leading-relaxed">
                Si ce chiffre stagne près de zéro pendant que le volume monte, la
                collecte ne passe qu'une fois par jour : l'ouverture et la clôture
                sont le même prix, et le CLV devient structurellement inmesurable.
              </p>
            </div>
          </>
        )}
      </Card>

      <div className="flex flex-col gap-4">
        <Card title="Quota The Odds API">
          {q.error ? (
            <p className="text-red-400 text-xs">{q.error}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Metric label="Restant" value={String(q.remaining ?? "—")}
                color={quotaLow ? "#f87171" : "#4ade80"} warn={quotaLow} />
              <Metric label="Consommé" value={String(q.used ?? "—")} />
              <Metric label="Mesuré" value={quotaAge.label} />
            </div>
          )}
        </Card>

        <Card title="État d'inférence & artefacts"
              hint="Ce que le service ML sert vraiment, par opposition à ce qui traîne sur le disque.">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <Metric label="inference_state as_of" value={reports?.runtime?.inference_state_as_of ?? "—"}
              sub={stateAge.label}
              color={stateAge.days != null && stateAge.days > 14 ? "#facc15" : undefined}
              warn={stateAge.days != null && stateAge.days > 14} />
            <Metric label="Équipes en état" value={String(reports?.runtime?.inference_state_teams ?? "—")} />
            <Metric label="Équipes ELO" value={String(reports?.runtime?.elo_teams ?? "—")} />
          </div>
          {!reports && (
            <p className="text-[10px] text-[#bfc8cc]/50 mt-2">
              Ouvre l'onglet Modèle pour charger les rapports du service ML.
            </p>
          )}
        </Card>

        <Card title="Série temporelle des cotes (odds_snapshots)"
              hint="La table qu'A1bis existe pour remplir. Son échec est SILENCIEUX : insertSnapshots avale son erreur pour ne jamais faire perdre la clôture du jour à odds_log — donc des logs normaux ne prouvent rien, seul ce bloc le fait.">
          {sn.error ? (
            <p className="text-red-400 text-xs">{sn.error}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
                <Metric label="Snapshots" value={String(sn.rows ?? 0)} />
                <Metric label="Passes (24 h)" value={`${sn.passes_today ?? 0} / 6`}
                  color={passesShort ? "#facc15" : (sn.passes_today ?? 0) === 6 ? "#4ade80" : undefined}
                  warn={passesShort} />
                <Metric label="Dernière passe" value={snapObserved.label}
                  color={snapStale ? "#facc15" : undefined} warn={snapStale} />
                <Metric label="Passes full" value={String(sn.rows_full ?? 0)} />
                <Metric label="Passes spreads" value={String(sn.rows_spreads ?? 0)} />
                <Metric label="Avec puck line" value={String(sn.with_puckline ?? 0)}
                  color={(sn.rows ?? 0) > 0 && (sn.with_puckline ?? 0) === 0 ? "#f87171" : undefined}
                  warn={(sn.rows ?? 0) > 0 && (sn.with_puckline ?? 0) === 0} />
              </div>
              <p className="text-[10px] text-[#bfc8cc]/60 leading-relaxed">
                Hors saison, 0 partout est normal : la collecte sort sur le
                garde-fou <code>isSeasonActive()</code> avant d'écrire. Ce qui ne
                l'est pas : « table indisponible » (migration 031 absente), ou un
                compteur à 0 pendant que <em>odds_log</em> monte. « Avec puck
                line » à 0 alors que des lignes existent veut dire que les quatre
                passes <em>spreads</em> ramènent du vide — 4 crédits/jour perdus
                sur le seul marché encore vivant.
              </p>
            </>
          )}
        </Card>

        <Card title="Paris & règlement"
              hint="Un arriéré de tickets en attente veut dire que le job de règlement ne tourne plus — et sans règlement, aucune mesure de performance live.">
          {s.error ? (
            <p className="text-red-400 text-xs">{s.error}</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <Metric label="Tickets total" value={String(s.total ?? 0)} />
              <Metric label="Réglés" value={String(s.settled ?? 0)} />
              <Metric label="En attente" value={String(s.pending ?? 0)} />
              <Metric label="En attente > 2 j" value={String(s.stale_pending ?? 0)}
                color={(s.stale_pending ?? 0) > 0 ? "#facc15" : "#4ade80"}
                warn={(s.stale_pending ?? 0) > 0} />
              <Metric label="Dernier pari" value={timeAgo(s.last_placed).label} />
              <Metric label="Dernier règlement" value={timeAgo(s.last_resolved).label} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
