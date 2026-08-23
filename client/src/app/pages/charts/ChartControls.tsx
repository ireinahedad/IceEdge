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
import { BG_CELL, SortDir } from "./chartsTheme";

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
      <span className="text-[9px] w-2">{active ? (dir === "asc" ? "▲" : "▼") : ""}</span>
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
      <div
        className="flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2"
        style={{ background: BG_CELL }}
      >
        <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#5c6f63]"
        />
        {query && (
          <button onClick={() => setQuery("")} className="text-[#8a9ea6] hover:text-white transition-colors">
            <X size={13} />
          </button>
        )}
      </div>

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
                <span className="text-[#8a9ea6] text-[10px] flex-shrink-0">
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
