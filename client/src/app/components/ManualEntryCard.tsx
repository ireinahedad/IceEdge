/**
 * ManualEntryCard.tsx — écran ADMIN de saisie manuelle. Rendu uniquement pour
 * un compte admin.
 *
 * Anciennement `InjuriesAdminCard`. Renommé parce qu'il ne fait plus que les
 * blessures : les gardiens partants et les absents du soir s'y saisissent
 * désormais aussi.
 *
 * ── Pourquoi ces deux-là arrivent ici ───────────────────────────────────────
 * Ils se saisissaient dans `ml/data/starting_goalies.json` et
 * `ml/data/scratches.json`, à la main, sur la machine de développement, 1-2 h
 * avant la mise au jeu. Deux problèmes, dont un rédhibitoire :
 *   • le dossier `ml/` n'est pas dans l'image du serveur, donc ces deux entrées
 *     étaient TOUJOURS vides en production ;
 *   • les matchs NHL commencent le soir en Amérique. Éditer un fichier local à
 *     ce moment-là suppose d'être devant son ordinateur, ce qui n'arrive pas.
 * Or SAISIE_MANUELLE.md les désigne comme les deux saisies prioritaires : « si
 * tu n'as que 5 minutes, lignes 1 et 2. Le gardien partant est l'information qui
 * déplace le plus les probabilités. » Une saisie prioritaire qui n'est pas
 * faisable au moment où elle compte n'est pas une saisie.
 *
 * ── Les champs font 16 px, contrairement au reste de l'app ──────────────────
 * Volontaire, et local à cet écran. Safari et le WKWebView zooment la page dès
 * qu'un champ fait moins de 16 px, et ne dézooment pas ensuite. Cet écran-ci est
 * utilisé sur téléphone, sous pression, juste avant un match : c'est celui où le
 * zoom parasite coûte le plus cher. Le reste de l'app a le même problème et
 * attend une règle CSS globale.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import { nhlApiService } from "../services/nhlApiService";
import {
  fetchAllInjuries,
  saveInjuries,
  deleteInjuries,
  fetchLineups,
  saveLineups,
  GameInjuries,
  InjuryPlayer,
  GoalieDay,
  ScratchDay,
} from "../services/manualDataService";
import type { NHLGame } from "../types/bet";

const IMPACT_PRESETS = [
  { label: "Gardien partant (0.12)", value: 0.12 },
  { label: "Joueur clé (0.06)", value: 0.06 },
  { label: "Role player (0.03)", value: 0.03 },
];

/** 16 px : voir l'en-tête — en dessous, iOS zoome à chaque focus. */
const FIELD =
  "bg-black/20 border border-white/25 rounded-lg px-2.5 py-2 text-[16px] text-white placeholder-white/25 outline-none focus:border-[#90C9F0]/60";

function emptyEntry(): GameInjuries {
  return { home: [], away: [], lineupAdj: 0, lineupNote: "" };
}

/** Date locale Est — la même référence que le serveur et le calendrier NHL. */
function easternToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

const teamAbbr = (t: any) => t?.abbreviation ?? t?.abbrev ?? "?";

type Tab = "injuries" | "lineups";

export function ManualEntryCard() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [tab, setTab] = useState<Tab>("injuries");
  const [games, setGames] = useState<NHLGame[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    nhlApiService
      .getGamesByDate()
      .then(setGames)
      // Une erreur affichée, pas avalée : sans les matchs du jour cet écran ne
      // sert à rien, et une liste vide se lit à tort comme « pas de match ».
      .catch((e) => setLoadError(e?.message ?? "Impossible de charger les matchs du jour"));
  }, [isAdmin]);

  if (!isAdmin) return null;

  return (
    <div className="icy-card rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-white text-xs font-medium">Saisie manuelle</p>
        <span className="text-[#86d1ea] text-[11px] font-bold uppercase tracking-wider">admin</span>
      </div>

      <div className="flex gap-1 p-1 rounded-xl bg-black/20">
        {([
          ["injuries", "Blessures"],
          ["lineups", "Compos du soir"],
        ] as Array<[Tab, string]>).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className="flex-1 rounded-lg py-2 text-[12px] font-semibold transition-colors"
            style={
              tab === id
                ? { background: "#86d1ea", color: "#0A0E0C" }
                : { color: "rgba(255,255,255,0.55)" }
            }
          >
            {label}
          </button>
        ))}
      </div>

      {loadError && (
        <p role="alert" className="text-red-400 text-[11px]">
          {loadError}
        </p>
      )}

      {tab === "injuries" ? <InjuriesTab games={games} /> : <LineupsTab games={games} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Onglet 1 — blessures / alignement, par match
// ═══════════════════════════════════════════════════════════════════════════

function InjuriesTab({ games }: { games: NHLGame[] }) {
  const [all, setAll] = useState<Record<string, GameInjuries>>({});
  const [key, setKey] = useState<string>("");
  const [entry, setEntry] = useState<GameInjuries>(emptyEntry());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchAllInjuries()
      .then(setAll)
      .catch((e) => toast.error(e?.message ?? "Impossible de charger les blessures saisies"));
  }, []);

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
      // Le serveur supprime une entrée devenue vide — l'état local suit, sinon
      // la pastille « ● » resterait sur un match qui n'a plus rien de saisi.
      const isEmpty =
        !clean.home?.length && !clean.away?.length && !clean.lineupAdj && !clean.lineupNote?.trim();
      setAll((a) => {
        const next = { ...a };
        if (isEmpty) delete next[key];
        else next[key] = clean;
        return next;
      });
      toast.success(isEmpty ? "Entrée vidée." : "Blessures / alignement enregistrés.");
    } catch (e: any) {
      toast.error(e?.message ?? "Échec de l'enregistrement.");
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

  function PlayerRows({ side, label }: { side: "home" | "away"; label: string }) {
    const list = entry[side] ?? [];
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-white/70 text-[11px] font-semibold uppercase tracking-wider">{label}</span>
          <button
            type="button"
            onClick={() => addPlayer(side)}
            className="text-[#86d1ea] text-[12px] font-bold px-2 py-1 -mr-2"
          >
            + ajouter
          </button>
        </div>
        {list.length === 0 && <p className="text-white/30 text-[11px]">aucun joueur</p>}
        {list.map((p, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={p.player}
              onChange={(e) => updatePlayer(side, i, { player: e.target.value })}
              placeholder="Nom du joueur"
              autoCapitalize="words"
              autoCorrect="off"
              className={`flex-1 min-w-0 ${FIELD}`}
            />
            <select
              value={p.impact}
              onChange={(e) => updatePlayer(side, i, { impact: Number(e.target.value) })}
              className="bg-black/20 border border-white/25 rounded-lg px-1.5 py-2 text-[14px] text-white outline-none"
            >
              {IMPACT_PRESETS.map((o) => (
                <option key={o.value} value={o.value} className="bg-[#0A0E0C]">
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => removePlayer(side, i)}
              aria-label={`Retirer ${p.player || "ce joueur"}`}
              className="text-red-400 text-[16px] px-2 py-1 min-w-[32px]"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    );
  }

  const selectedGame = games.find((g) => `${teamAbbr(g.awayTeam)}@${teamAbbr(g.homeTeam)}` === key);

  return (
    <>
      <p className="text-white/50 text-[11px] leading-relaxed">
        Sélectionne un match du jour et saisis les joueurs blessés/absents. Ces
        infos alimentent les facteurs « Blessures » et « Alignement » des règles.
      </p>

      <select
        value={key}
        onChange={(e) => selectGame(e.target.value)}
        className={`w-full ${FIELD}`}
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
              <label className="text-white/70 text-[11px] font-semibold uppercase tracking-wider">
                Ajustement alignement
              </label>
              <span className="text-[#90C9F0] text-[12px] font-bold tabular-nums">
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
              className="w-full accent-[#86d1ea] h-8"
            />
            <p className="text-white/35 text-[11px]">− favorise le visiteur · + favorise la maison</p>
            <input
              value={entry.lineupNote ?? ""}
              onChange={(e) => setEntry((x) => ({ ...x, lineupNote: e.target.value }))}
              placeholder="Note d'alignement (ex. trios remaniés)"
              className={`mt-1 w-full ${FIELD}`}
            />
          </div>

          <div className="flex items-center gap-2 mt-1">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2.5 rounded-lg text-[13px] font-bold disabled:opacity-50"
              style={{ background: "#86d1ea", color: "#0A0E0C" }}
            >
              {saving ? "…" : "Enregistrer"}
            </button>
            {all[key] && (
              <button
                type="button"
                onClick={handleDelete}
                className="px-4 py-2.5 rounded-lg text-[13px] font-semibold text-red-400 border border-red-400/30"
              >
                Supprimer
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Onglet 2 — gardiens partants + absents, par équipe et par date
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Les absents se saisissent en une ligne séparée par des virgules plutôt qu'en
 * liste cliquable. C'est délibéré : la saisie se fait sous contrainte de temps,
 * souvent au pouce, et taper « Matthews, Guhle » est plus rapide que deux
 * appuis sur « + ajouter ». La conversion vers le tableau attendu par le serveur
 * se fait à l'enregistrement.
 */
function splitNames(raw: string): string[] {
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

function LineupsTab({ games }: { games: NHLGame[] }) {
  const [date, setDate] = useState<string>(easternToday());
  const [goalies, setGoalies] = useState<GoalieDay>({});
  const [scratchText, setScratchText] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (d: string) => {
    setLoading(true);
    try {
      const day = await fetchLineups(d);
      setGoalies(day.goalies ?? {});
      const text: Record<string, string> = {};
      for (const [abbr, list] of Object.entries(day.scratches ?? {})) {
        text[abbr] = (list ?? []).join(", ");
      }
      setScratchText(text);
    } catch (e: any) {
      toast.error(e?.message ?? "Impossible de charger les compos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(date); }, [date, load]);

  // Une ligne par équipe qui joue, groupée par match — c'est l'ordre dans lequel
  // les compos sortent, match par match.
  const rows = games.flatMap((g) => {
    const home = teamAbbr(g.homeTeam);
    const away = teamAbbr(g.awayTeam);
    return [
      { abbr: away, matchup: `${away} @ ${home}`, side: "visiteur" as const },
      { abbr: home, matchup: `${away} @ ${home}`, side: "maison" as const },
    ];
  });

  async function handleSave() {
    setSaving(true);
    try {
      const scratches: ScratchDay = {};
      for (const [abbr, raw] of Object.entries(scratchText)) {
        const names = splitNames(raw);
        if (names.length) scratches[abbr] = names;
      }
      const cleanGoalies: GoalieDay = {};
      for (const [abbr, name] of Object.entries(goalies)) {
        if (name?.trim()) cleanGoalies[abbr] = name.trim();
      }
      // Les deux champs sont toujours envoyés : c'est ce qui permet de RETIRER
      // un gardien saisi par erreur. Un envoi partiel ne saurait qu'ajouter.
      await saveLineups(date, { goalies: cleanGoalies, scratches });
      toast.success("Compos enregistrées.");
    } catch (e: any) {
      toast.error(e?.message ?? "Échec de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <p className="text-white/50 text-[11px] leading-relaxed">
        Gardiens partants (uniquement les <strong>exceptions</strong> : backup qui
        part, n° 1 blessé) et absents confirmés. Orthographe MoneyPuck —
        « Joseph Woll », pas « J. Woll » : le modèle matche par nom exact et
        ignore en silence un nom mal orthographié.
      </p>

      <label className="flex items-center gap-2">
        <span className="text-white/70 text-[11px] font-semibold uppercase tracking-wider">Date</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={FIELD}
        />
      </label>

      {loading && <p className="text-white/40 text-[12px]">Chargement…</p>}

      {!loading && rows.length === 0 && (
        <p className="text-white/40 text-[12px]">
          Aucun match ce jour-là — rien à saisir.
        </p>
      )}

      {!loading &&
        rows.map((r, i) => (
          <div
            key={`${r.matchup}-${r.abbr}`}
            className="flex flex-col gap-1.5 pt-2"
            style={i > 0 ? { borderTop: "1px solid rgba(255,255,255,0.06)" } : undefined}
          >
            <div className="flex items-center gap-2">
              <span className="text-white text-[13px] font-bold">{r.abbr}</span>
              <span className="text-white/35 text-[11px]">
                {r.matchup} · {r.side}
              </span>
            </div>
            <input
              value={goalies[r.abbr] ?? ""}
              onChange={(e) => setGoalies((g) => ({ ...g, [r.abbr]: e.target.value }))}
              placeholder="Gardien partant (si exception)"
              autoCapitalize="words"
              autoCorrect="off"
              className={`w-full ${FIELD}`}
            />
            <input
              value={scratchText[r.abbr] ?? ""}
              onChange={(e) => setScratchText((s) => ({ ...s, [r.abbr]: e.target.value }))}
              placeholder="Absents, séparés par des virgules"
              autoCapitalize="words"
              autoCorrect="off"
              className={`w-full ${FIELD}`}
            />
          </div>
        ))}

      {!loading && rows.length > 0 && (
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="mt-1 self-start px-4 py-2.5 rounded-lg text-[13px] font-bold disabled:opacity-50"
          style={{ background: "#86d1ea", color: "#0A0E0C" }}
        >
          {saving ? "…" : "Enregistrer les compos"}
        </button>
      )}
    </>
  );
}
