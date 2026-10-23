/**
 * ManualEntryPage.tsx — la saisie d'avant-match, sur sa propre page.
 * Route : /dev/saisie   (admin uniquement, comme le reste de /dev)
 *
 * Remplace `components/ManualEntryCard.tsx` (carte au fond des Réglages) le
 * 2026-09-27. Même API (`manualDataService`), mêmes données en base ; ce qui
 * change, c'est à qui l'écran s'adresse : quelqu'un qui n'est PAS développeur
 * et qui fait la saisie sur son téléphone, une heure avant le match.
 *
 * ── Une seule liste d'absents par équipe (décision du 2026-09-27) ───────────
 * Avant, un joueur absent se saisissait DEUX fois, dans deux onglets :
 *   • « Blessures » — par match (`injuries`, clé VISITEUR@MAISON), avec un
 *     poids ; alimente les facteurs Blessures / Alignement des RÈGLES ;
 *   • « Compos du soir » — par équipe et par date (`scratches`) ; alimente le
 *     modèle IA.
 * Ici, la question est posée une fois (« Qui ne joue pas ce soir ? ») et
 * l'enregistrement écrit LES DEUX. À la lecture, les deux sources sont
 * fusionnées (union des noms, poids repris de `injuries` quand il existe).
 *
 * ── Les noms viennent de l'effectif NHL ─────────────────────────────────────
 * Le modèle apparie par nom EXACT et ignore en silence une faute de frappe.
 * Les gardiens se choisissent donc dans une liste, et les absents se tapent
 * avec l'autocomplétion de l'effectif ; un nom hors effectif reste permis
 * (effectif pas encore publié, rappel du jour même) mais il est signalé.
 *
 * ── Enregistrement match par match ──────────────────────────────────────────
 * `PUT /lineups/:date` remplace la JOURNÉE entière. On envoie donc l'état
 * SERVEUR du jour, dans lequel seules les deux équipes du match enregistré
 * sont remplacées : les brouillons non enregistrés des autres matchs ne
 * partent pas par la bande.
 *
 * ── Blessés de longue durée (ajout du 2026-09-27) ───────────────────────────
 * Un absent coché « longue durée » ne part NI dans `injuries` NI dans
 * `scratches` : il est rangé par équipe (`/manual/long-injuries`) et c'est le
 * serveur qui l'ajoute à chaque match de l'équipe, jusqu'à ce qu'on le retire.
 * Le ranger aussi dans les deux autres tables le ferait survivre à son retrait.
 *
 * ── Blessés posés par la synchro (ajout du 2026-09-29) ─────────────────────
 * `npm run injuries:sync` range des blessés longue durée `source: 'auto'` avec
 * une date de fin (`until`). L'écran les montre marqués « synchro » ; passé leur
 * date de fin, ils ne comptent plus et ne sont pas repris dans les cartes. Les
 * retirer (« Revenu au jeu ») ou changer leur importance, c'est le serveur qui
 * s'en souvient : la synchro suivante ne les remet pas / ne les écrase pas.
 *
 * Les champs font 16 px : en dessous, iOS zoome à chaque focus.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "../toast";
import { useAuth } from "../context/AuthContext";
import { nhlApiService } from "../services/nhlApiService";
import {
  fetchAllInjuries,
  saveInjuries,
  deleteInjuries,
  fetchLineups,
  saveLineups,
  fetchLongInjuries,
  saveLongInjuries,
  type LongInjury,
  type GameInjuries,
  type InjuryPlayer,
  type GoalieDay,
  type ScratchDay,
  addNewsLink,
} from "../services/manualDataService";
import type { NHLGame, NHLPlayerInfo } from "../types/bet";
import { nhlLogoUrl } from "../data/teamEmoji";

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Les trois poids historiques de la carte admin, dits en mots. */
const LEVELS: { value: number; label: string }[] = [
  { value: 0.12, label: "Gardien n° 1" },
  { value: 0.06, label: "Joueur clé" },
  { value: 0.03, label: "Joueur de soutien" },
];

const FIELD =
  "bg-black/25 border border-white/25 rounded-xl px-3 py-2.5 text-[16px] text-white placeholder-white/30 outline-none focus:border-[#86d1ea]";

const ACCENT = "#86d1ea";

// ─── Types et helpers ─────────────────────────────────────────────────────────

type Side = "home" | "away";
interface Absent { player: string; impact: number; longTerm?: boolean; since?: string; until?: string; auto?: boolean }
interface TeamDraft { goalie: string; absents: Absent[] }
interface GameDraft { away: TeamDraft; home: TeamDraft; lineupAdj: number; lineupNote: string }
interface Day { goalies: GoalieDay; scratches: ScratchDay }
type RosterState = NHLPlayerInfo[] | "loading" | "error";

const abbrOf = (t: any): string => String(t?.abbreviation ?? t?.abbrev ?? "?").toUpperCase();
const keyOf  = (g: NHLGame) => `${abbrOf(g.awayTeam)}@${abbrOf(g.homeTeam)}`;
const norm   = (s: string) => s.trim().toLowerCase();

/** Jour de match en heure de l'Est — la référence du serveur et de la NHL. */
function easternDate(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/** Un blessé longue durée compte-t-il ce jour-là ? Sans date de fin, toujours. */
const activeOn = (p: LongInjury, date: string) => !p.until || p.until >= date;

function buildTeam(
  abbr: string, side: Side, key: string, day: Day,
  injuries: Record<string, GameInjuries>, long: Record<string, LongInjury[]>, date: string,
): TeamDraft {
  const byName = new Map<string, Absent>();
  // Les blessés longue durée d'abord : s'ils traînent aussi dans une ancienne
  // saisie du soir, c'est leur statut « longue durée » qui l'emporte. Ceux dont
  // la date de fin est passée ne comptent plus — le serveur les ignore aussi.
  for (const p of long[abbr] ?? []) {
    if (!p.player?.trim() || !activeOn(p, date)) continue;
    byName.set(norm(p.player), {
      player: p.player.trim(), impact: p.impact, longTerm: true, since: p.since,
      ...(p.until ? { until: p.until } : {}), ...(p.source === "auto" ? { auto: true } : {}),
    });
  }
  for (const p of injuries[key]?.[side] ?? []) {
    if (byName.has(norm(p.player ?? ""))) continue;
    if (p.player?.trim()) byName.set(norm(p.player), { player: p.player.trim(), impact: p.impact });
  }
  for (const name of day.scratches[abbr] ?? []) {
    if (name.trim() && !byName.has(norm(name))) byName.set(norm(name), { player: name.trim(), impact: 0.06 });
  }
  return { goalie: day.goalies[abbr] ?? "", absents: [...byName.values()] };
}

function buildDraft(
  g: NHLGame, day: Day, injuries: Record<string, GameInjuries>, long: Record<string, LongInjury[]>, date: string,
): GameDraft {
  const key = keyOf(g);
  return {
    away: buildTeam(abbrOf(g.awayTeam), "away", key, day, injuries, long, date),
    home: buildTeam(abbrOf(g.homeTeam), "home", key, day, injuries, long, date),
    lineupAdj:  injuries[key]?.lineupAdj ?? 0,
    lineupNote: injuries[key]?.lineupNote ?? "",
  };
}

const cleanAbsents = (list: Absent[]): Absent[] => {
  const seen = new Set<string>();
  return list
    .map((a) => ({ ...a, player: a.player.trim() }))
    .filter((a) => a.player && !seen.has(norm(a.player)) && seen.add(norm(a.player)));
};

const hasContent = (d: GameDraft | undefined) =>
  !!d && (!!d.away.goalie.trim() || !!d.home.goalie.trim()
    // Les blessés longue durée ne comptent pas : ils sont là tout seuls, ils ne
    // disent pas que la vérification du soir a été faite.
    || d.away.absents.some((a) => !a.longTerm) || d.home.absents.some((a) => !a.longTerm)
    || !!d.lineupAdj || !!d.lineupNote.trim());

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ManualEntryPage() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user?.role === "admin";

  const [date, setDate]         = useState<string>(() => easternDate());
  const [games, setGames]       = useState<NHLGame[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // État SERVEUR (ce qui est réellement enregistré) — la base des envois.
  const [injuries, setInjuries] = useState<Record<string, GameInjuries>>({});
  const [day, setDay]           = useState<Day>({ goalies: {}, scratches: {} });
  const [long, setLong]         = useState<Record<string, LongInjury[]>>({});
  // Brouillons à l'écran, et leur dernière version enregistrée (pour « modifié »).
  const [drafts, setDrafts]     = useState<Record<string, GameDraft>>({});
  const [saved, setSaved]       = useState<Record<string, string>>({});
  const [openKey, setOpenKey]   = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [rosters, setRosters]   = useState<Record<string, RosterState>>({});

  // Même courtoisie que les autres écrans /dev : le serveur refuse déjà (403).
  useEffect(() => {
    if (!authLoading && user && user.role !== "admin") navigate("/", { replace: true });
  }, [authLoading, user, navigate]);

  const load = useCallback(async (d: string) => {
    setGames(null);
    setLoadError(null);
    setOpenKey(null);
    try {
      const [g, inj, lineups, longInj] = await Promise.all([
        nhlApiService.getGamesByDate(d),
        fetchAllInjuries(),
        fetchLineups(d),
        fetchLongInjuries(),
      ]);
      const sortedGames = [...g].sort((a, b) =>
        String(a.startTimeUTC ?? a.startTime).localeCompare(String(b.startTimeUTC ?? b.startTime)));
      const dayState: Day = { goalies: lineups.goalies ?? {}, scratches: lineups.scratches ?? {} };
      const nextDrafts: Record<string, GameDraft> = {};
      const nextSaved: Record<string, string> = {};
      for (const game of sortedGames) {
        const draft = buildDraft(game, dayState, inj, longInj, d);
        nextDrafts[keyOf(game)] = draft;
        nextSaved[keyOf(game)]  = JSON.stringify(draft);
      }
      setInjuries(inj);
      setDay(dayState);
      setLong(longInj);
      setDrafts(nextDrafts);
      setSaved(nextSaved);
      setGames(sortedGames);
    } catch (e: any) {
      setLoadError(e?.message ?? "Impossible de charger les matchs");
      setGames([]);
    }
  }, []);

  useEffect(() => { if (isAdmin) void load(date); }, [isAdmin, date, load]);

  // L'effectif d'une équipe n'est chargé qu'à l'ouverture de son match.
  // Le registre des demandes vit dans une ref : un appel réseau lancé depuis un
  // updater de `setState` partirait deux fois sous StrictMode.
  const requested = useRef(new Set<string>());
  const ensureRoster = useCallback((abbr: string) => {
    if (requested.current.has(abbr)) return;
    requested.current.add(abbr);
    setRosters((r) => ({ ...r, [abbr]: "loading" }));
    nhlApiService.getTeamRoster(abbr)
      .then((list) => setRosters((x) => ({ ...x, [abbr]: list })))
      .catch(() => {
        requested.current.delete(abbr);   // on retentera à la prochaine ouverture
        setRosters((x) => ({ ...x, [abbr]: "error" }));
      });
  }, []);

  const isDirty = (key: string) => !!drafts[key] && JSON.stringify(drafts[key]) !== saved[key];
  const anyDirty = useMemo(
    () => Object.keys(drafts).some((k) => JSON.stringify(drafts[k]) !== saved[k]),
    [drafts, saved],
  );

  // Quitter la page avec une saisie non enregistrée : le navigateur demande.
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  function toggle(g: NHLGame) {
    const key = keyOf(g);
    setOpenKey((k) => (k === key ? null : key));
    ensureRoster(abbrOf(g.awayTeam));
    ensureRoster(abbrOf(g.homeTeam));
  }

  function patch(key: string, fn: (d: GameDraft) => GameDraft) {
    setDrafts((all) => ({ ...all, [key]: fn(all[key]) }));
  }

  /** Journée serveur dans laquelle les deux équipes du match sont remplacées. */
  function dayWith(g: NHLGame, teams: Partial<Record<string, TeamDraft>>): Day {
    const goalies: GoalieDay = { ...day.goalies };
    const scratches: ScratchDay = { ...day.scratches };
    for (const abbr of [abbrOf(g.awayTeam), abbrOf(g.homeTeam)]) {
      delete goalies[abbr];
      delete scratches[abbr];
      const t = teams[abbr];
      if (!t) continue;
      if (t.goalie.trim()) goalies[abbr] = t.goalie.trim();
      const names = cleanAbsents(t.absents).filter((a) => !a.longTerm).map((a) => a.player);
      if (names.length) scratches[abbr] = names;
    }
    return { goalies, scratches };
  }

  async function handleSave(g: NHLGame) {
    const key = keyOf(g);
    const d = drafts[key];
    if (!d) return;
    const away = { ...d.away, absents: cleanAbsents(d.away.absents) };
    const home = { ...d.home, absents: cleanAbsents(d.home.absents) };
    // Les champs `role` / `status` d'une ancienne saisie sont conservés.
    const keep = (side: Side, a: Absent): InjuryPlayer => {
      const old = injuries[key]?.[side]?.find((p) => norm(p.player) === norm(a.player));
      return { ...old, player: a.player, impact: a.impact };
    };
    const tonight = (t: TeamDraft) => t.absents.filter((a) => !a.longTerm);
    const toLong  = (t: TeamDraft): LongInjury[] =>
      t.absents.filter((a) => a.longTerm).map((a) => ({
        player: a.player, impact: a.impact, since: a.since ?? date, ...(a.until ? { until: a.until } : {}),
      }));
    const entry: GameInjuries = {
      away: tonight(away).map((a) => keep("away", a)),
      home: tonight(home).map((a) => keep("home", a)),
      lineupAdj:  d.lineupAdj || 0,
      lineupNote: d.lineupNote.trim(),
    };
    const nextDay = dayWith(g, { [abbrOf(g.awayTeam)]: away, [abbrOf(g.homeTeam)]: home });

    setSavingKey(key);
    try {
      // Les blessés expirés ne sont pas dans les cartes, mais ils restent en
      // base : on les renvoie tels quels, sinon le serveur les lirait comme
      // « retirés à la main ».
      const expired = (abbr: string) => (long[abbr] ?? []).filter((p) => !activeOn(p, date));
      const awayLong = [...toLong(away), ...expired(abbrOf(g.awayTeam))];
      const homeLong = [...toLong(home), ...expired(abbrOf(g.homeTeam))];
      const [, savedDay, awaySaved, homeSaved] = await Promise.all([
        saveInjuries(key, entry),
        saveLineups(date, nextDay),
        saveLongInjuries(abbrOf(g.awayTeam), awayLong),
        saveLongInjuries(abbrOf(g.homeTeam), homeLong),
      ]);
      // La réponse du SERVEUR fait foi : c'est lui qui décide si une entrée de
      // la synchro le reste (importance inchangée) ou devient manuelle.
      const awayNow = awaySaved?.players ?? awayLong;
      const homeNow = homeSaved?.players ?? homeLong;
      setLong((all) => {
        const next = { ...all };
        for (const [abbr, list] of [[abbrOf(g.awayTeam), awayNow], [abbrOf(g.homeTeam), homeNow]] as const) {
          if (list.length) next[abbr] = list; else delete next[abbr];
        }
        return next;
      });
      const autoNames = new Set([...awayNow, ...homeNow].filter((p) => p.source === "auto").map((p) => norm(p.player)));
      const empty = !entry.away?.length && !entry.home?.length && !entry.lineupAdj && !entry.lineupNote;
      setInjuries((all) => {
        const next = { ...all };
        if (empty) delete next[key]; else next[key] = entry;
        return next;
      });
      setDay({ goalies: savedDay?.goalies ?? nextDay.goalies, scratches: savedDay?.scratches ?? nextDay.scratches });
      // `since` renseigné sur les nouveaux blessés longue durée, pour que la
      // carte ne se relise pas « modifiée » juste après l'enregistrement.
      const stamp = (t: TeamDraft): TeamDraft => ({
        ...t,
        absents: t.absents.map((a) => {
          if (!a.longTerm) return { ...a, since: undefined, until: undefined, auto: undefined };
          const { auto: _auto, ...rest } = a;
          return { ...rest, since: a.since ?? date, ...(autoNames.has(norm(a.player)) ? { auto: true } : {}) };
        }),
      });
      const clean: GameDraft = { ...d, away: stamp(away), home: stamp(home), lineupNote: entry.lineupNote ?? "" };
      setDrafts((all) => ({ ...all, [key]: clean }));
      setSaved((all) => ({ ...all, [key]: JSON.stringify(clean) }));
      toast.success(`${key.replace("@", " @ ")} enregistré.`);
      setOpenKey(null);
    } catch (e: any) {
      toast.error(e?.message ?? "L'enregistrement a échoué. Réessaie.");
    } finally {
      setSavingKey(null);
    }
  }

  async function handleClear(g: NHLGame) {
    const key = keyOf(g);
    setSavingKey(key);
    try {
      await Promise.all([
        injuries[key] ? deleteInjuries(key) : Promise.resolve(),
        saveLineups(date, dayWith(g, {})),
      ]);
      const nextDay = dayWith(g, {});
      const nextInj = { ...injuries };
      delete nextInj[key];
      // « Tout effacer » vise la saisie du SOIR : les blessés longue durée
      // restent (ils se retirent un par un, « Revenu au jeu »).
      const empty = buildDraft(g, nextDay, nextInj, long, date);
      setInjuries(nextInj);
      setDay(nextDay);
      setDrafts((all) => ({ ...all, [key]: empty }));
      setSaved((all) => ({ ...all, [key]: JSON.stringify(empty) }));
      toast.success("Saisie du match effacée.");
    } catch (e: any) {
      toast.error(e?.message ?? "L'effacement a échoué.");
    } finally {
      setSavingKey(null);
    }
  }

  /** « Revenu au jeu » : retire un blessé longue durée, tout de suite. */
  async function handleRecovered(abbr: string, player: string) {
    const rest = (long[abbr] ?? []).filter((p) => norm(p.player) !== norm(player));
    try {
      await saveLongInjuries(abbr, rest);
      setLong((all) => {
        const next = { ...all };
        if (rest.length) next[abbr] = rest; else delete next[abbr];
        return next;
      });
      // Le joueur disparaît aussi des cartes ouvertes, brouillon ET version
      // enregistrée, pour que la carte ne se dise pas « modifiée ».
      const drop = (d: GameDraft): GameDraft => {
        const fix = (t: TeamDraft): TeamDraft =>
          ({ ...t, absents: t.absents.filter((a) => !(a.longTerm && norm(a.player) === norm(player))) });
        return { ...d, away: fix(d.away), home: fix(d.home) };
      };
      const touches = (k: string) => k.split("@").includes(abbr);
      setDrafts((all) => Object.fromEntries(Object.entries(all).map(([k, d]) => [k, touches(k) ? drop(d) : d])));
      setSaved((all) => Object.fromEntries(Object.entries(all).map(([k, s]) => [k, touches(k) ? JSON.stringify(drop(JSON.parse(s))) : s])));
      toast.success(`${player} est de retour au jeu.`);
    } catch (e: any) {
      toast.error(e?.message ?? "Le retrait a échoué. Réessaie.");
    }
  }

  const filled = (games ?? []).filter((g) => hasContent(saved[keyOf(g)] ? JSON.parse(saved[keyOf(g)]) : undefined)).length;
  const today = easternDate();
  const tomorrow = easternDate(1);

  if (!isAdmin) return null;

  return (
    <div className="flex flex-col min-h-screen text-white max-w-[900px] mx-auto px-4 pt-14 pb-24" style={{ background: "#0A0E0C" }}>
      <div className="flex items-center gap-3 mb-4">
        <button onClick={() => navigate("/dev")} className="tap-44 text-[#bfc8cc] text-lg" aria-label="Retour">←</button>
        <h1 className="text-white text-lg font-bold flex-1">Saisie d'avant-match</h1>
      </div>

      <HowTo />

      {/* ── 1. Le jour ── */}
      <section className="icy-card rounded-2xl p-4 mb-4">
        <p className="text-white text-[14px] font-bold mb-3">Quel jour ?</p>
        <div className="flex flex-wrap items-center gap-2">
          {[{ d: today, label: "Aujourd'hui" }, { d: tomorrow, label: "Demain" }].map(({ d, label }) => (
            <button
              key={d}
              onClick={() => setDate(d)}
              className="tap-44 px-4 py-2 rounded-full text-[13px] font-semibold"
              style={date === d ? { background: ACCENT, color: "#0A0E0C" } : { background: "rgba(255,255,255,0.08)", color: "#d6e2e6" }}
            >
              {label}
            </button>
          ))}
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className={FIELD} aria-label="Autre date" />
        </div>
        <p className="text-white/45 text-[12px] mt-2">Heure de l'Est (Montréal, Toronto, New York).</p>
      </section>

      <LongInjuriesCard long={long} date={date} onRecovered={(abbr, p) => void handleRecovered(abbr, p)} />

      <NewsLinkCard teams={games ? [...new Set(games.flatMap((g) => [g.awayTeam.abbreviation, g.homeTeam.abbreviation]))].sort() : []} />

      {/* ── 2. Les matchs ── */}
      {loadError && (
        <div role="alert" className="rounded-2xl p-4 mb-4 bg-red-500/10 border border-red-500/30">
          <p className="text-red-300 text-[14px] font-semibold">Les matchs n'ont pas pu être chargés.</p>
          <p className="text-red-300/80 text-[12px] mt-1">{loadError}</p>
          <button onClick={() => void load(date)} className="tap-44 mt-3 px-4 py-2 rounded-xl text-[13px] font-bold" style={{ background: ACCENT, color: "#0A0E0C" }}>
            Réessayer
          </button>
        </div>
      )}

      {games === null && !loadError && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 icy-tile rounded-2xl animate-pulse" />)}
        </div>
      )}

      {games && games.length === 0 && !loadError && (
        <div className="icy-card rounded-2xl p-6 text-center">
          <p className="text-white text-[14px] font-semibold">Aucun match ce jour-là.</p>
          <p className="text-white/50 text-[12px] mt-1">Rien à saisir. Essaie un autre jour.</p>
        </div>
      )}

      {games && games.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-2 px-1">
            <p className="text-white text-[14px] font-bold">Les matchs</p>
            <p className="text-white/60 text-[12px] tabular-nums">{filled} sur {games.length} remplis</p>
          </div>
          <div className="flex flex-col gap-2">
            {games.map((g) => {
              const key = keyOf(g);
              const d = drafts[key];
              if (!d) return null;
              return (
                <GameCard
                  key={key}
                  game={g}
                  draft={d}
                  open={openKey === key}
                  dirty={isDirty(key)}
                  filled={hasContent(saved[key] ? JSON.parse(saved[key]) : undefined)}
                  saving={savingKey === key}
                  rosters={rosters}
                  onToggle={() => toggle(g)}
                  onPatch={(fn) => patch(key, fn)}
                  onSave={() => void handleSave(g)}
                  onClear={() => void handleClear(g)}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Mode d'emploi ────────────────────────────────────────────────────────────

function HowTo() {
  const steps = [
    "Choisis le jour.",
    "Ouvre un match et réponds aux deux questions pour chaque équipe : qui est dans le but, et qui ne joue pas.",
    "Appuie sur « Enregistrer ce match ». Le match passe au vert.",
  ];
  return (
    <section className="rounded-2xl p-4 mb-4 border" style={{ background: "rgba(134,209,234,0.07)", borderColor: "rgba(134,209,234,0.25)" }}>
      <p className="text-white text-[14px] font-bold mb-2">Comment ça marche</p>
      <ol className="flex flex-col gap-1.5 mb-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-2.5 text-[13px] text-white/85 leading-snug">
            <span className="flex-shrink-0 w-5 h-5 rounded-full text-[11px] font-bold flex items-center justify-center" style={{ background: ACCENT, color: "#0A0E0C" }}>{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      <p className="text-white/60 text-[12px] leading-relaxed">
        <strong className="text-white/80">Quand ?</strong> Environ 1 à 2 h avant le match, une fois les gardiens annoncés.
        <br />
        <strong className="text-white/80">Pas sûr ?</strong> Laisse vide. Un champ vide ne change rien aux prédictions ; une erreur, si.
        <br />
        <strong className="text-white/80">Blessé pour plusieurs matchs ?</strong> Coche « Blessé longue durée » : il restera absent à chaque match, sans rien retaper.
      </p>
    </section>
  );
}

// ─── Blessés de longue durée ──────────────────────────────────────────────────

function formatSince(iso?: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" });
}

/** « synchro · jusqu'au 12 oct. », « depuis le 3 oct. », « expiré le 1 oct. ». */
function longInjuryDetail(p: LongInjury, date: string): string {
  const parts: string[] = [];
  if (p.source === "auto") parts.push("synchro");
  if (p.until) parts.push(activeOn(p, date) ? `jusqu'au ${formatSince(p.until)}` : `expiré le ${formatSince(p.until)}`);
  else if (p.since && p.source !== "auto") parts.push(`depuis le ${formatSince(p.since)}`);
  return parts.join(" · ");
}

function LongInjuriesCard({
  long, date, onRecovered,
}: {
  long: Record<string, LongInjury[]>;
  date: string;
  onRecovered: (abbr: string, player: string) => void;
}) {
  const teams = Object.keys(long).sort();
  const total = teams.reduce((n, t) => n + long[t].length, 0);
  if (total === 0) return null;
  return (
    <section className="icy-card rounded-2xl p-4 mb-4">
      <p className="text-white text-[14px] font-bold">Blessés longue durée ({total})</p>
      <p className="text-white/50 text-[12px] mt-0.5 mb-3 leading-relaxed">
        Comptés comme absents à CHAQUE match de leur équipe, sans rien ressaisir.
        Quand un joueur revient, appuie sur « Revenu au jeu ». Ceux marqués
        « synchro » viennent de la mise à jour automatique : ils s'effacent
        seuls à leur date de fin.
      </p>
      <div className="flex flex-col gap-1.5">
        {teams.flatMap((abbr) => long[abbr].map((p) => (
          <div key={`${abbr}-${p.player}`} className="flex items-center gap-2.5 rounded-xl px-3 py-2 bg-black/20">
            <img src={nhlLogoUrl(abbr)} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
            <span className="flex-1 min-w-0">
              <span className="block text-white text-[14px] truncate">{p.player}</span>
              <span className="block text-white/40 text-[11px]">
                {abbr}{longInjuryDetail(p, date) ? ` · ${longInjuryDetail(p, date)}` : ""}
              </span>
            </span>
            <button
              onClick={() => onRecovered(abbr, p.player)}
              className="tap-44 flex-shrink-0 px-3 py-1.5 rounded-full text-[12px] font-semibold"
              style={{ background: "rgba(74,222,128,0.15)", color: "#4ade80" }}
            >
              Revenu au jeu
            </button>
          </div>
        )))}
      </div>
    </section>
  );
}

// ─── Fil de nouvelles : coller un lien (F1) ───────────────────────────────────
// Une nouvelle vue sur X ou sur Discord qu'aucune source Bluesky ne couvre. Le
// lien apparaît sur la page du match dans les 2 min (cache du serveur).

const NEWS_FLAGS = [
  { key: "lineup", label: "Absent / retour" },
  { key: "goalie", label: "Gardien" },
  { key: "transaction", label: "Transaction" },
] as const;

function NewsLinkCard({ teams }: { teams: string[] }) {
  const [url, setUrl] = useState("");
  const [team, setTeam] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [flags, setFlags] = useState<Array<"goalie" | "lineup" | "transaction">>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!url.trim() || !team) return;
    setBusy(true);
    try {
      await addNewsLink({ url: url.trim(), teams: [team], excerpt: excerpt.trim(), flags });
      toast.success("Lien ajouté au fil");
      setUrl(""); setExcerpt(""); setFlags([]);
    } catch (e: any) {
      toast.error(e?.message ?? "Échec de l'ajout");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="icy-card rounded-2xl p-4 mb-4">
      <p className="text-white text-[14px] font-bold">Ajouter une nouvelle au fil</p>
      <p className="text-white/50 text-[12px] mt-0.5 mb-3 leading-relaxed">
        Colle le lien d'une publication (x.com, bsky.app, nhl.com). Elle s'affiche
        sur la page du match. Pense aussi à saisir l'absent ou le gardien plus bas :
        le fil n'alimente pas le modèle.
      </p>
      <div className="flex flex-col gap-2">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://x.com/…/status/…" className={FIELD} aria-label="Lien" />
        <select value={team} onChange={(e) => setTeam(e.target.value)} className={FIELD} aria-label="Équipe">
          <option value="">Équipe…</option>
          {teams.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={excerpt} onChange={(e) => setExcerpt(e.target.value)} maxLength={200} placeholder="Résumé court (optionnel) — ex. Marner absent ce soir" className={FIELD} aria-label="Résumé" />
        <div className="flex flex-wrap gap-2">
          {NEWS_FLAGS.map((f) => {
            const on = flags.includes(f.key);
            return (
              <button
                key={f.key}
                onClick={() => setFlags(on ? flags.filter((x) => x !== f.key) : [...flags, f.key])}
                className="tap-44 px-3 py-1.5 rounded-full text-[12px] font-semibold"
                style={on ? { background: ACCENT, color: "#0A0E0C" } : { background: "rgba(255,255,255,0.08)", color: "#d6e2e6" }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
        <button
          onClick={() => void submit()}
          disabled={busy || !url.trim() || !team}
          className="tap-44 mt-1 px-4 py-2 rounded-xl text-[13px] font-bold disabled:opacity-40"
          style={{ background: ACCENT, color: "#0A0E0C" }}
        >
          {busy ? "Ajout…" : "Ajouter"}
        </button>
      </div>
    </section>
  );
}

// ─── Un match ─────────────────────────────────────────────────────────────────

function GameCard({
  game, draft, open, dirty, filled, saving, rosters, onToggle, onPatch, onSave, onClear,
}: {
  game: NHLGame;
  draft: GameDraft;
  open: boolean;
  dirty: boolean;
  filled: boolean;
  saving: boolean;
  rosters: Record<string, RosterState>;
  onToggle: () => void;
  onPatch: (fn: (d: GameDraft) => GameDraft) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const away = abbrOf(game.awayTeam);
  const home = abbrOf(game.homeTeam);
  const status = dirty
    ? { label: "Pas enregistré", bg: "rgba(250,204,21,0.15)", fg: "#facc15" }
    : filled
      ? { label: "Rempli", bg: "rgba(74,222,128,0.15)", fg: "#4ade80" }
      : { label: "À faire", bg: "rgba(255,255,255,0.08)", fg: "#bfc8cc" };
  const [advanced, setAdvanced] = useState(!!draft.lineupAdj || !!draft.lineupNote);

  return (
    <div className="icy-card rounded-2xl overflow-hidden" style={open ? { borderColor: "rgba(134,209,234,0.45)" } : undefined}>
      <button onClick={onToggle} className="w-full flex items-center gap-3 px-4 py-3.5 text-left" aria-expanded={open}>
        <img src={nhlLogoUrl(away)} alt="" className="w-7 h-7 object-contain" />
        <span className="text-white text-[15px] font-bold">{away}</span>
        <span className="text-white/40 text-[13px]">@</span>
        <img src={nhlLogoUrl(home)} alt="" className="w-7 h-7 object-contain" />
        <span className="text-white text-[15px] font-bold">{home}</span>
        <span className="text-white/45 text-[12px] ml-1 truncate">{game.startTime}</span>
        <span className="ml-auto flex-shrink-0 px-2.5 py-1 rounded-full text-[11px] font-bold" style={{ background: status.bg, color: status.fg }}>
          {status.label}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 flex flex-col gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TeamBlock
              abbr={away} sideLabel="Visiteur" team={draft.away} roster={rosters[away]}
              onChange={(t) => onPatch((d) => ({ ...d, away: t }))}
            />
            <TeamBlock
              abbr={home} sideLabel="Maison" team={draft.home} roster={rosters[home]}
              onChange={(t) => onPatch((d) => ({ ...d, home: t }))}
            />
          </div>

          {/* Le curseur d'alignement et la note : utiles, mais pas pour une
              première saisie. Repliés, sauf s'ils contiennent déjà quelque chose. */}
          <div>
            <button onClick={() => setAdvanced((a) => !a)} className="text-white/55 text-[12px] font-semibold py-1" aria-expanded={advanced}>
              {advanced ? "▾" : "▸"} Options avancées
            </button>
            {advanced && (
              <div className="mt-2 rounded-xl p-3 bg-black/20 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-white/80 text-[13px] font-semibold">Avantage d'alignement</span>
                  <span className="text-[13px] font-bold tabular-nums" style={{ color: ACCENT }}>
                    {draft.lineupAdj > 0 ? `+${Math.round(draft.lineupAdj * 100)} % ${home}`
                      : draft.lineupAdj < 0 ? `+${Math.round(-draft.lineupAdj * 100)} % ${away}` : "neutre"}
                  </span>
                </div>
                <input
                  type="range" min={-0.1} max={0.1} step={0.01} value={draft.lineupAdj}
                  onChange={(e) => onPatch((d) => ({ ...d, lineupAdj: Number(e.target.value) }))}
                  className="w-full h-8" style={{ accentColor: ACCENT }}
                  aria-label="Avantage d'alignement"
                />
                <div className="flex justify-between text-white/40 text-[11px]">
                  <span>← avantage {away}</span><span>avantage {home} →</span>
                </div>
                <input
                  value={draft.lineupNote}
                  onChange={(e) => onPatch((d) => ({ ...d, lineupNote: e.target.value }))}
                  placeholder="Note (ex. trios remaniés)"
                  className={`w-full ${FIELD}`}
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={onSave} disabled={saving}
              className="tap-44 flex-1 md:flex-none px-6 py-3 rounded-xl text-[14px] font-bold disabled:opacity-50"
              style={{ background: ACCENT, color: "#0A0E0C" }}
            >
              {saving ? "Enregistrement…" : "Enregistrer ce match"}
            </button>
            {filled && (
              <button
                onClick={onClear} disabled={saving}
                className="tap-44 px-4 py-3 rounded-xl text-[13px] font-semibold text-red-400 border border-red-400/30 disabled:opacity-50"
              >
                Tout effacer
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Une équipe ───────────────────────────────────────────────────────────────

const OTHER = "__autre__";

function TeamBlock({
  abbr, sideLabel, team, roster, onChange,
}: {
  abbr: string;
  sideLabel: string;
  team: TeamDraft;
  roster: RosterState | undefined;
  onChange: (t: TeamDraft) => void;
}) {
  const players = Array.isArray(roster) ? roster : [];
  const goalies = players.filter((p) => p.position === "G").map((p) => p.name);
  const known = new Set(players.map((p) => norm(p.name)));
  const rosterReady = players.length > 0;

  // Un gardien déjà saisi qui n'est pas dans l'effectif ouvre directement le
  // champ libre, pour qu'on le voie tel qu'il est enregistré.
  const [typing, setTyping] = useState(false);
  const freeGoalie = typing || !rosterReady || (!!team.goalie && !goalies.some((n) => norm(n) === norm(team.goalie)));

  const [draftName, setDraftName] = useState("");
  const listId = `roster-${abbr}`;

  function addAbsent() {
    const name = draftName.trim();
    if (!name) return;
    if (team.absents.some((a) => norm(a.player) === norm(name))) { setDraftName(""); return; }
    const isGoalie = players.find((p) => norm(p.name) === norm(name))?.position === "G";
    onChange({ ...team, absents: [...team.absents, { player: name, impact: isGoalie ? 0.12 : 0.06 }] });
    setDraftName("");
  }

  return (
    <div className="rounded-xl p-3 bg-black/20 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <img src={nhlLogoUrl(abbr)} alt="" className="w-6 h-6 object-contain" />
        <span className="text-white text-[14px] font-bold">{abbr}</span>
        <span className="text-white/45 text-[12px]">{sideLabel}</span>
        {roster === "loading" && <span className="ml-auto text-white/35 text-[11px]">effectif…</span>}
      </div>

      {/* Question 1 */}
      <div className="flex flex-col gap-1.5">
        <label className="text-white/85 text-[13px] font-semibold">Qui garde le but ce soir ?</label>
        {!freeGoalie ? (
          <select
            value={team.goalie}
            onChange={(e) => {
              if (e.target.value === OTHER) { setTyping(true); return; }
              onChange({ ...team, goalie: e.target.value });
            }}
            className={`w-full ${FIELD}`}
          >
            <option value="" className="bg-[#0A0E0C]">Le gardien habituel (rien à signaler)</option>
            {goalies.map((n) => <option key={n} value={n} className="bg-[#0A0E0C]">{n}</option>)}
            <option value={OTHER} className="bg-[#0A0E0C]">Un autre nom…</option>
          </select>
        ) : (
          <div className="flex gap-1.5">
            <input
              value={team.goalie}
              onChange={(e) => onChange({ ...team, goalie: e.target.value })}
              placeholder="Prénom Nom du gardien"
              autoCapitalize="words" autoCorrect="off"
              className={`flex-1 min-w-0 ${FIELD}`}
            />
            {rosterReady && (
              <button
                onClick={() => { setTyping(false); onChange({ ...team, goalie: "" }); }}
                className="tap-44 px-3 rounded-xl text-[12px] text-white/70 border border-white/20"
              >
                Liste
              </button>
            )}
          </div>
        )}
        <p className="text-white/40 text-[11px]">À remplir seulement si ce n'est PAS le gardien habituel.</p>
      </div>

      {/* Question 2 */}
      <div className="flex flex-col gap-1.5">
        <label className="text-white/85 text-[13px] font-semibold">Qui ne joue pas ce soir ?</label>
        {team.absents.length === 0 && <p className="text-white/35 text-[12px]">Personne pour l'instant.</p>}
        {team.absents.map((a, i) => (
          <div key={`${a.player}-${i}`} className="flex flex-col gap-1 rounded-lg p-2 bg-white/[0.04]">
            <div className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-white text-[14px] truncate">{a.player}</span>
              <button
                onClick={() => onChange({ ...team, absents: team.absents.filter((_, j) => j !== i) })}
                aria-label={`Retirer ${a.player}`}
                className="tap-44 text-red-400 text-[18px] px-2"
              >
                ×
              </button>
            </div>
            <div className="flex gap-1 flex-wrap">
              {[...LEVELS, ...(LEVELS.some((l) => l.value === a.impact) ? [] : [{ value: a.impact, label: `Autre (${a.impact})` }])].map((l) => (
                <button
                  key={l.value}
                  onClick={() => onChange({ ...team, absents: team.absents.map((x, j) => (j === i ? { ...x, impact: l.value } : x)) })}
                  className="px-2.5 py-1 rounded-full text-[11px] font-semibold"
                  style={a.impact === l.value ? { background: ACCENT, color: "#0A0E0C" } : { background: "rgba(255,255,255,0.07)", color: "#bfc8cc" }}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 mt-0.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!a.longTerm}
                onChange={(e) => onChange({ ...team, absents: team.absents.map((x, j) => (j === i ? { ...x, longTerm: e.target.checked } : x)) })}
                className="w-4 h-4"
                style={{ accentColor: ACCENT }}
              />
              <span className="text-white/75 text-[12px]">
                Blessé longue durée
                {a.longTerm && (
                  <span className="text-white/40">
                    {a.auto
                      ? ` · synchro${a.until ? `, jusqu'au ${formatSince(a.until)}` : ""}`
                      : a.since ? ` · depuis le ${formatSince(a.since)}` : " · restera absent jusqu'à ce qu'on le retire"}
                  </span>
                )}
              </span>
            </label>
            {rosterReady && !known.has(norm(a.player)) && (
              <p className="text-yellow-300/90 text-[11px]">Nom introuvable dans l'effectif : vérifie l'orthographe.</p>
            )}
          </div>
        ))}
        <div className="flex gap-1.5">
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addAbsent(); } }}
            list={rosterReady ? listId : undefined}
            placeholder="Tape un nom…"
            autoCapitalize="words" autoCorrect="off"
            className={`flex-1 min-w-0 ${FIELD}`}
          />
          <button
            onClick={addAbsent} disabled={!draftName.trim()}
            className="tap-44 px-4 rounded-xl text-[13px] font-bold disabled:opacity-40"
            style={{ background: "rgba(134,209,234,0.15)", color: ACCENT }}
          >
            Ajouter
          </button>
        </div>
        {rosterReady && (
          <datalist id={listId}>
            {players.map((p) => <option key={p.id} value={p.name} />)}
          </datalist>
        )}
      </div>
    </div>
  );
}
