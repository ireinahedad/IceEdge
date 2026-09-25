/**
 * ChartControls.tsx
 *
 * Extrait de ChartPage.tsx le 2026-08-10 (3106 lignes → 11 fichiers).
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { nhlApiService } from "../../services/nhlApiService";
import type { NHLTeamInfo, NHLPlayerInfo } from "../../types/bet";
import { BG_CARD, BG_CELL, SortDir, currentSeasonId, seasonLabel, selectCls } from "./chartsTheme";
import { DIVISIONS, divisionLabelKey, divisionOf, divisionShortKey, type Division } from "../../data/nhlDivisions";

/* ── Opponent picker (lives in the vs-column header) ──────── */
export function OpponentSelect({
  opponent,
  onChange,
  teams,
  accent,
  placeholder,
}: {
  opponent: string;
  onChange: (abbr: string) => void;
  teams: NHLTeamInfo[];
  accent: string;
  placeholder: string;
}) {
  return (
    <div className="flex items-center justify-center gap-1">
      <span className="text-[#8a9ea6]">vs</span>
      <select
        value={opponent}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold border border-white/15 outline-none max-w-[7.5rem]"
        style={{ background: BG_CELL, color: opponent ? accent : "#8a9ea6" }}
        aria-label={placeholder}
      >
        <option value="">{placeholder}</option>
        {teams.map((x) => (
          <option key={x.abbreviation} value={x.abbreviation?.toUpperCase()}>
            {x.abbreviation?.toUpperCase()}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Sortable column header. */
export function SortHead({
  label,
  active,
  dir,
  onClick,
  align = "center",
  accent,
}: {
  label: ReactNode;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "left" | "center";
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1 ${align === "left" ? "justify-start" : "justify-center"}`}
      style={{ color: active ? accent : undefined }}
    >
      <span className="font-semibold">{label}</span>
      <span className="text-[11px] w-2">{active ? (dir === "asc" ? "▲" : "▼") : ""}</span>
    </button>
  );
}

/* ── Player search box ─────────────────────────────────────
 * Debounced league-wide player lookup. Used on the charts pages to jump
 * straight to someone's stats without going through their team first.
 */
export function PlayerSearchBox({
  placeholder,
  onPick,
}: {
  placeholder: string;
  onPick: (p: NHLPlayerInfo) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NHLPlayerInfo[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const handle = setTimeout(() => {
      nhlApiService
        .searchPlayers(q)
        .then((res) => { if (alive) setResults(res); })
        .catch(() => { if (alive) setResults([]); })
        .finally(() => { if (alive) setSearching(false); });
    }, 300);
    return () => { alive = false; clearTimeout(handle); };
  }, [query]);

  return (
    <div className="relative">
      <SearchInput value={query} onChange={setQuery} placeholder={placeholder} />

      {query.trim().length >= 2 && (
        <div
          className="absolute left-0 right-0 top-full mt-1 z-20 max-h-60 overflow-y-auto rounded-xl border border-white/15 shadow-xl"
          style={{ background: "#1A2216" }}
        >
          {searching ? (
            <p className="text-[#5c6f63] text-[11px] text-center py-3">…</p>
          ) : results.length > 0 ? (
            results.map((p) => (
              <button
                key={String(p.id)}
                onClick={() => { onPick(p); setQuery(""); setResults([]); }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/[0.06] transition-colors"
              >
                <span className="text-white text-[12px] font-medium truncate">{p.name}</span>
                <span className="text-[#8a9ea6] text-[11px] flex-shrink-0">
                  {String((p as unknown as { teamId?: string }).teamId ?? "").toUpperCase()} · {p.position}
                </span>
              </button>
            ))
          ) : (
            <p className="text-[#5c6f63] text-[11px] text-center py-3">{t("chart.noResults")}</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Champ de recherche (loupe + effacer) ─────────────────── */
export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2"
      style={{ background: BG_CELL }}
    >
      <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#5c6f63]"
      />
      {value && (
        <button onClick={() => onChange("")} className="tap-44 text-[#8a9ea6] hover:text-white transition-colors">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** Les six dernières saisons, en remontant depuis la saison courante. */
const RECENT_SEASONS = Array.from({ length: 6 }, (_, i) => {
  const y = Math.floor(currentSeasonId / 10000) - i;
  return Number(`${y}${y + 1}`);
});

/* ── Sélecteur de saison (pages « toutes les équipes / tous les joueurs ») ── */
export function SeasonSelect({ season, onChange }: { season: number; onChange: (season: number) => void }) {
  const { t } = useI18n();
  return (
    <select
      value={season}
      onChange={(e) => onChange(Number(e.target.value))}
      className={selectCls}
      style={{ background: BG_CELL, color: "#c8d3cc" }}
      aria-label={t("chart.season")}
    >
      {RECENT_SEASONS.map((sid) => (
        <option key={sid} value={sid}>{seasonLabel(sid)}</option>
      ))}
    </select>
  );
}

/* ── Pastilles de tri au-dessus d'un tableau ──────────────── */
export function MetricChips({
  metrics,
  activeKey,
  dir,
  onToggle,
  accent,
}: {
  metrics: { key: string; label: ReactNode }[];
  activeKey: string;
  dir: SortDir;
  onToggle: (key: string) => void;
  accent: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {metrics.map((m) => {
        const isActive = m.key === activeKey;
        return (
          <button
            key={m.key}
            onClick={() => onToggle(m.key)}
            className="px-3 py-1 rounded-full text-[11px] font-semibold transition-colors"
            style={
              isActive
                ? { background: accent + "22", color: accent, border: `1px solid ${accent}66` }
                : { background: BG_CELL, color: "#8a9ea6", border: "1px solid transparent" }
            }
          >
            {m.label}
            {isActive && <span className="ml-1 text-[11px]">{dir === "asc" ? "▲" : "▼"}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ── Squelettes de chargement ─────────────────────────────── */
export function RowsSkeleton({ count }: { count: number }) {
  return (
    <div className="px-4 py-6 flex flex-col gap-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="h-6 rounded animate-pulse" style={{ background: BG_CELL }} />
      ))}
    </div>
  );
}

/** Emplacement du graphique à barres empilées pendant le chargement. */
export function BarSkeleton() {
  return (
    <div className="rounded-2xl border border-white/20 p-4" style={{ background: BG_CARD }}>
      <div className="h-4 w-40 rounded animate-pulse mb-3" style={{ background: BG_CELL }} />
      <div className="h-[280px] rounded-xl animate-pulse" style={{ background: BG_CELL }} />
    </div>
  );
}

/* ── Sélecteur d'équipe (graphiques joueur et équipe) ─────── */
export function TeamSelect({
  value,
  onChange,
  teams,
}: {
  value: string;
  onChange: (abbrLower: string) => void;
  teams: NHLTeamInfo[];
}) {
  const { t } = useI18n();
  const opt = (x: NHLTeamInfo) => (
    <option key={x.abbreviation} value={x.abbreviation?.toLowerCase()}>
      {x.abbreviation?.toUpperCase()}
    </option>
  );
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={selectCls}
      style={{ background: BG_CELL, color: value ? "#c8d3cc" : "#8a9ea6" }}
      aria-label={t("chart.team")}
    >
      <option value="">{t("chart.noTeam")}</option>
      {/* Regroupées par division (2026-09-25), dans l'ordre de `DIVISIONS` ; un
          club absent de la table (abréviation inattendue) reste choisissable. */}
      {DIVISIONS.map((d) => {
        const inDiv = teams.filter((x) => divisionOf(x.abbreviation) === d.key);
        if (inDiv.length === 0) return null;
        return (
          <optgroup key={d.key} label={t(divisionLabelKey(d.key))}>
            {inDiv.map(opt)}
          </optgroup>
        );
      })}
      {teams.filter((x) => !divisionOf(x.abbreviation)).map(opt)}
    </select>
  );
}

/** Carte de message centrée (invite à choisir, aucune donnée…). */
export function ChartMessage({ children, large = false }: { children: ReactNode; large?: boolean }) {
  return (
    <div className={`rounded-2xl border border-white/10 ${large ? "p-8" : "p-6"} text-center`} style={{ background: BG_CARD }}>
      <p className="text-[#8a9ea6] text-sm">{children}</p>
    </div>
  );
}

/** Trois cartes fantômes pendant le chargement d'une page de graphiques. */
export function CardsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: BG_CARD }} />
      ))}
    </div>
  );
}

/* ── Filtre par division ───────────────────────────────────
 * Accueil Statistiques et « toutes les équipes » (2026-09-25). `null` = toutes.
 * Les puces suivent l'ordre de `DIVISIONS` : Est (ATL, MÉT) puis Ouest (CEN,
 * PAC), un léger écart entre les deux conférences.
 */
export function DivisionFilter({
  value,
  onChange,
  accent,
}: {
  value: Division | null;
  onChange: (d: Division | null) => void;
  accent: string;
}) {
  const { t } = useI18n();
  const chip = (key: string, label: string, active: boolean, onClick: () => void, extra = "") => (
    <button
      key={key}
      onClick={onClick}
      aria-pressed={active}
      className={`px-3 py-1 rounded-full text-[11px] font-semibold transition-colors ${extra}`}
      style={
        active
          ? { background: accent + "22", color: accent, border: `1px solid ${accent}66` }
          : { background: BG_CELL, color: "#8a9ea6", border: "1px solid transparent" }
      }
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("div.filter")}>
      {chip("all", t("div.all"), value == null, () => onChange(null))}
      {DIVISIONS.map((d, i) =>
        chip(
          d.key,
          t(divisionLabelKey(d.key)),
          value === d.key,
          () => onChange(value === d.key ? null : d.key),
          // Petit écart entre la dernière division de l'Est et la première de l'Ouest.
          i > 0 && DIVISIONS[i - 1].conference !== d.conference ? "ml-2" : "",
        ),
      )}
    </div>
  );
}

/** Étiquette de division à côté d'un club — affichée quand aucune division n'est filtrée. */
export function DivisionTag({ abbr }: { abbr?: string }) {
  const { t } = useI18n();
  const d = divisionOf(abbr);
  if (!d) return null;
  return (
    <span
      className="inline-block rounded px-1 py-px text-[9px] font-bold tracking-wider leading-none border border-white/15 text-[#8a9ea6] align-middle"
      title={t(divisionLabelKey(d))}
    >
      {t(divisionShortKey(d))}
    </span>
  );
}
