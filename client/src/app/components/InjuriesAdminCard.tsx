/**
 * InjuriesAdminCard.tsx
 * Interface ADMIN de saisie manuelle des blessures / joueurs manquants /
 * alignement, par match du jour. Rendu uniquement si l'utilisateur est admin.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import { nhlApiService } from "../services/nhlApiService";
import {
  fetchAllInjuries,
  saveInjuries,
  deleteInjuries,
  GameInjuries,
  InjuryPlayer,
} from "../services/injuriesAdminService";
import type { NHLGame } from "../types/bet";

const IMPACT_PRESETS = [
  { label: "Gardien partant (0.12)", value: 0.12 },
  { label: "Joueur clé (0.06)", value: 0.06 },
  { label: "Role player (0.03)", value: 0.03 },
];

function emptyEntry(): GameInjuries {
  return { home: [], away: [], lineupAdj: 0, lineupNote: "" };
}

export function InjuriesAdminCard() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [games, setGames] = useState<NHLGame[]>([]);
  const [all, setAll] = useState<Record<string, GameInjuries>>({});
  const [key, setKey] = useState<string>("");
  const [entry, setEntry] = useState<GameInjuries>(emptyEntry());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    (async () => {
      try {
        const [g, inj] = await Promise.all([nhlApiService.getGamesByDate(), fetchAllInjuries()]);
        setGames(g);
        setAll(inj);
      } catch {
        /* silencieux : l'admin verra la liste vide */
      }
    })();
  }, [isAdmin]);

  if (!isAdmin) return null;

  function selectGame(k: string) {
    setKey(k);
    setEntry(k && all[k] ? { ...emptyEntry(), ...all[k] } : emptyEntry());
  }

  function addPlayer(side: "home" | "away") {
    setEntry((e) => ({ ...e, [side]: [...(e[side] ?? []), { player: "", impact: 0.06 }] }));
  }
  function updatePlayer(side: "home" | "away", i: number, patch: Partial<InjuryPlayer>) {
    setEntry((e) => {
      const list = [...(e[side] ?? [])];
      list[i] = { ...list[i], ...patch };
      return { ...e, [side]: list };
    });
  }
  function removePlayer(side: "home" | "away", i: number) {
    setEntry((e) => ({ ...e, [side]: (e[side] ?? []).filter((_, j) => j !== i) }));
  }

  async function handleSave() {
    if (!key) return;
    setSaving(true);
    try {
      const clean: GameInjuries = {
        home: (entry.home ?? []).filter((p) => p.player.trim()),
        away: (entry.away ?? []).filter((p) => p.player.trim()),
        lineupAdj: entry.lineupAdj || 0,
        lineupNote: entry.lineupNote || "",
      };
      await saveInjuries(key, clean);
      setAll((a) => ({ ...a, [key]: clean }));
      toast.success("Blessures/alignement enregistrés.");
    } catch (e: any) {
      toast.error(e?.message ?? "Échec de l’enregistrement (admin requis).");
    } finally {
      setSaving(false);
    }
  }
  async function handleDelete() {
    if (!key) return;
    try {
      await deleteInjuries(key);
      setAll((a) => {
        const c = { ...a };
        delete c[key];
        return c;
      });
      setEntry(emptyEntry());
      toast.success("Entrée supprimée.");
    } catch (e: any) {
      toast.error(e?.message ?? "Échec de la suppression.");
    }
  }

  const teamAbbr = (t: any) => t?.abbreviation ?? t?.abbrev ?? "?";

  function PlayerRows({ side, label }: { side: "home" | "away"; label: string }) {
    const list = entry[side] ?? [];
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-white/70 text-[10px] font-semibold uppercase tracking-wider">{label}</span>
          <button onClick={() => addPlayer(side)} className="text-[#86d1ea] text-[10px] font-bold">
            + ajouter
          </button>
        </div>
        {list.length === 0 && <p className="text-white/30 text-[9px]">aucun joueur</p>}
        {list.map((p, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={p.player}
              onChange={(e) => updatePlayer(side, i, { player: e.target.value })}
              placeholder="Nom du joueur"
              className="flex-1 bg-black/20 border border-white/25 rounded-lg px-2 py-1.5 text-[10px] text-white placeholder-white/25 outline-none focus:border-[#90C9F0]/60"
            />
            <select
              value={p.impact}
              onChange={(e) => updatePlayer(side, i, { impact: Number(e.target.value) })}
              className="bg-black/20 border border-white/25 rounded-lg px-1.5 py-1.5 text-[10px] text-white outline-none"
            >
              {IMPACT_PRESETS.map((o) => (
                <option key={o.value} value={o.value} className="bg-[#0A0E0C]">
                  {o.label}
                </option>
              ))}
            </select>
            <button onClick={() => removePlayer(side, i)} className="text-red-400 text-[12px] px-1">
              ×
            </button>
          </div>
        ))}
      </div>
    );
  }

  const selectedGame = games.find((g) => `${teamAbbr(g.awayTeam)}@${teamAbbr(g.homeTeam)}` === key);

  return (
    <div className="icy-card rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-white text-xs font-medium">Blessures / alignement (admin)</p>
        <span className="text-[#86d1ea] text-[9px] font-bold uppercase tracking-wider">admin</span>
      </div>

      <p className="text-white/50 text-[10px] leading-relaxed">
        Sélectionne un match du jour et saisis les joueurs blessés/absents. Ces
        infos alimentent les facteurs « Blessures » et « Alignement » des règles.
      </p>

      <select
        value={key}
        onChange={(e) => selectGame(e.target.value)}
        className="w-full bg-black/20 border border-white/30 rounded-lg px-2.5 py-2 text-[11px] text-white outline-none focus:border-[#90C9F0]/60"
      >
        <option value="" className="bg-[#0A0E0C]">— choisir un match —</option>
        {games.map((g) => {
          const k = `${teamAbbr(g.awayTeam)}@${teamAbbr(g.homeTeam)}`;
          return (
            <option key={g.id} value={k} className="bg-[#0A0E0C]">
              {teamAbbr(g.awayTeam)} @ {teamAbbr(g.homeTeam)}
              {all[k] ? "  ●" : ""}
            </option>
          );
        })}
      </select>

      {key && (
        <>
          <PlayerRows side="home" label={`Maison — ${selectedGame ? teamAbbr(selectedGame.homeTeam) : ""}`} />
          <PlayerRows side="away" label={`Visiteur — ${selectedGame ? teamAbbr(selectedGame.awayTeam) : ""}`} />

          <div className="flex flex-col gap-1 mt-1">
            <div className="flex items-center justify-between">
              <label className="text-white/70 text-[10px] font-semibold uppercase tracking-wider">
                Ajustement alignement
              </label>
              <span className="text-[#90C9F0] text-[11px] font-bold tabular-nums">
                {entry.lineupAdj && entry.lineupAdj > 0 ? "+" : ""}
                {Math.round((entry.lineupAdj ?? 0) * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={-0.1}
              max={0.1}
              step={0.01}
              value={entry.lineupAdj ?? 0}
              onChange={(e) => setEntry((x) => ({ ...x, lineupAdj: Number(e.target.value) }))}
              className="w-full accent-[#86d1ea]"
            />
            <p className="text-white/35 text-[9px]">− favorise le visiteur · + favorise la maison</p>
            <input
              value={entry.lineupNote ?? ""}
              onChange={(e) => setEntry((x) => ({ ...x, lineupNote: e.target.value }))}
              placeholder="Note d’alignement (ex. trios remaniés)"
              className="mt-1 w-full bg-black/20 border border-white/25 rounded-lg px-2 py-1.5 text-[10px] text-white placeholder-white/25 outline-none focus:border-[#90C9F0]/60"
            />
          </div>

          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold disabled:opacity-50"
              style={{ background: "#86d1ea", color: "#0A0E0C" }}
            >
              {saving ? "…" : "Enregistrer"}
            </button>
            {all[key] && (
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-red-400 border border-red-400/30 hover:text-red-300"
              >
                Supprimer
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
