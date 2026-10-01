/**
 * SlipCommandSheet.tsx — le « Bet builder IA » (SLIP_COMMANDE_PLAN.md, étape 3).
 *
 * ⚠️ Nom affiché : « Bet builder IA » (« AI bet builder »), PARTOUT — bouton,
 * titre, compteur, messages (décision du user, 2026-09-29). À ne pas confondre
 * avec l'« Analyse LLM » d'un pari individuel (`PredictionSheet`,
 * `explain_bet`), qui partage le quota Pro mais pas la fonction.
 *
 * Le joueur tape « Canadien gagne ce soir » ; l'analyseur LOCAL
 * (`server/src/services/slipCommand.ts`, sans réseau, gratuit) en tire des
 * intentions, `buildLeg` les chiffre avec le modèle et elles entrent au
 * coupon.
 *
 * Renfort LLM (étape 4, décisions du user du 2026-09-28) : quand l'analyseur
 * local rend `unknown` — et seulement là, une ambiguïté a déjà ses choix —,
 * la phrase part AUTOMATIQUEMENT au LLM (`askParseCommand`) pour un compte
 * connecté. Les intentions rendues ont déjà été validées par le serveur ; elles
 * le sont une seconde fois ici contre le contexte de l'écran, puis suivent le
 * même chemin (`addIntents` → `buildLeg`). Une ligne discrète affiche le quota
 * IA d'un compte Pro ou sur clé perso — PAS les essais gratuits restants d'un
 * compte Free (retirée à la demande du user, 2026-09-29 ; le compteur reste
 * dans les Réglages). Au quota gratuit épuisé, la phrase du user « Passe Pro
 * pour que l'IA comprenne des paris plus complexes » s'affiche partout, et le
 * bouton vers /pro seulement si `features.proUpgrade` (décision 3.1.1, iOS).
 *
 * Fautes de frappe (2026-09-29) : un nom de joueur ou d'équipe mal écrit rend
 * un échec `spelling` avec les noms proches en choix cliquables (« Suzuky » →
 * Nick Suzuki). C'est un `ambiguous`, donc il ne part PAS au LLM : le choix
 * est gratuit et ne consomme aucun essai.
 *
 * Décisions du user (2026-09-28) :
 *   - un bouton sur la page Stats (au-dessus des trois onglets) et sur la page
 *     Coupon (au-dessus de « Browse markets », puis à côté de « + Ajouter ») ;
 *   - il ouvre cette feuille, même gabarit que « + Ajouter » ;
 *   - chaque jambe ajoutée laisse une ligne « ✓ … Annuler » sous le champ ;
 *   - une ambiguïté se résout par des choix CLIQUABLES, que l'analyseur fournit
 *     sous forme de commande réécrite (`SlipChoice.text`) ;
 *   - dans une phrase à plusieurs paris, ce qui marche est ajouté, le reste
 *     est signalé.
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Sparkles, X, Check } from "lucide-react";
import {
  parseSlipCommand, validateIntent, SLIP_COMMAND_MAX_LENGTH,
  type SlipChoice, type SlipFailure,
} from "../../../../server/src/services/slipCommand";
import { useBet } from "../context/BetContext";
import { useI18n } from "../i18n";
import { useSlipCommandData } from "../hooks/useSlipCommandData";
import { addIntents, type CommandLegResult } from "../services/slipCommandLegs";
import { UPCOMING_DAYS } from "../pages/prediction/predictionShared";
import { useAuth } from "../context/AuthContext";
import { features } from "../platform";
import { askParseCommand, getLLMUsage, type LLMError, type ParseUsage } from "../services/llmService";

type T = ReturnType<typeof useI18n>["t"];

/** « new york » → « New York » : l'analyseur rend les noms normalisés. */
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Le message d'un échec de l'analyseur, et le libellé de ses choix. */
function failureText(f: SlipFailure, t: T): string {
  const d = f.detail;
  switch (d?.kind) {
    case "team":         return t("cmd.whichTeam", { alias: titleCase(d.alias) });
    case "player":       return t("cmd.whichPlayer", { alias: titleCase(d.alias) });
    case "spelling":     return t("cmd.didYouMean", { word: titleCase(d.word) });
    case "line_missing": return t("cmd.whichLine");
    case "line":         return t("cmd.lineNotOffered", { line: d.line });
    case "total_scope":  return t("cmd.whichTotal", { team: d.team });
    case "game_missing": return t("cmd.gameMissing");
    case "position":     return t("cmd.position");
    case "too_long":     return t("cmd.tooLong", { max: d.max });
    case "too_many":     return t("cmd.tooMany", { max: d.max });
    case "no_game":
      return d.window === "today" ? t("cmd.noGameToday", { subject: d.subject })
        : d.window === "tomorrow" ? t("cmd.noGameTomorrow", { subject: d.subject })
        : t("cmd.noGameNext", { subject: d.subject, days: UPCOMING_DAYS });
    default:
      return f.chunk ? t("cmd.unknown", { chunk: f.chunk }) : t("cmd.empty");
  }
}

function choiceLabel(c: SlipChoice, f: SlipFailure, t: T, teamName: (abbr: string) => string): string {
  switch (c.kind) {
    case "team":       return teamName(c.abbr);
    case "player":     return `${c.name} · ${c.teamAbbr}`;
    case "game_total": return t("cmd.gameTotal", { line: c.line });
    case "line":       return f.detail?.kind === "total_scope" ? `${f.detail.team} ${c.line}` : String(c.line);
  }
}

/** Le quota IA tel que la ligne discrète l'affiche (jamais pour un compte Free). */
type AiQuota =
  | { kind: "pro"; used: number; limit: number }
  | { kind: "own_key" };

/** Ce que le renfort LLM a dit de la dernière phrase incomprise. */
type AiNote =
  | { kind: "working" }
  | { kind: "clarify"; text: string }
  | { kind: "unclear" }
  | { kind: "free_quota"; limit: number }
  | { kind: "error"; message: string };

function quotaFromUsage(u: ParseUsage): AiQuota | null {
  if (u.kind === "own_key") return u;
  return u.kind === "free" ? null : { kind: "pro", used: u.used, limit: u.limit };
}

type Row =
  | { key: string; kind: "added"; legId: string; label: string; removed: boolean }
  | { key: string; kind: "duplicate" | "unavailable" | "missing"; label: string };

export function SlipCommandSheet({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n();
  const { addLeg, removeLeg, hasLeg } = useBet();
  const { ctx, data, loading, error } = useSlipCommandData();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SlipFailure | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [aiQuota, setAiQuota] = useState<AiQuota | null>(null);
  const [aiNote, setAiNote] = useState<AiNote | null>(null);

  // Quota IA, lu une fois à l'ouverture (compte connecté seulement). Rien pour
  // un compte Free : ses essais restants ne s'affichent plus ici.
  // Un échec laisse la ligne absente : elle informe, elle ne conditionne rien.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    getLLMUsage()
      .then((u) => {
        if (!alive) return;
        if (u.pro && u.limit != null) setAiQuota({ kind: "pro", used: u.used ?? 0, limit: u.limit });
        else if (u.ownKey) setAiQuota({ kind: "own_key" });
      })
      .catch(() => { /* ligne absente */ });
    return () => { alive = false; };
  }, [user]);

  const noGames = !!ctx && ctx.games.length === 0;
  const ready = !!ctx && !noGames && !busy;
  const examples = [t("cmd.ex1"), t("cmd.ex2"), t("cmd.ex3")];
  const teamName = (abbr: string) => data.getTeamById(abbr.toLowerCase())?.name ?? abbr;

  async function submit(command: string) {
    if (!ctx || busy || !command.trim()) return;
    setAiNote(null);
    const parsed = parseSlipCommand(command, ctx);
    if (!parsed.ok) {
      setFailure(parsed);
      // Renfort LLM : seulement pour une phrase INCOMPRISE, et pour un compte
      // connecté (l'appel est authentifié et décompté).
      if (parsed.reason === "unknown" && parsed.chunk && user) await askAi(command);
      return;
    }
    setFailure(null);
    await addAll(parsed.intents);
  }

  async function askAi(command: string) {
    if (!ctx) return;
    setBusy(true);
    setAiNote({ kind: "working" });
    try {
      const r = await askParseCommand(command, lang);
      setAiQuota(quotaFromUsage(r.usage));
      // Le serveur a validé contre SON contexte ; on revalide contre celui de
      // l'écran, qui fournira les matchs et joueurs à `buildLeg`.
      if (r.ok && r.intents.every((i) => validateIntent(i, ctx).ok)) {
        setAiNote(null);
        setFailure(null);
        setBusy(false);
        await addAll(r.intents);
        return;
      }
      setAiNote(!r.ok && r.clarification ? { kind: "clarify", text: r.clarification } : { kind: "unclear" });
    } catch (e) {
      const err = e as Partial<LLMError>;
      if (err.type === "free_parse_quota") {
        setAiNote({ kind: "free_quota", limit: err.limit ?? 0 });
      } else {
        setAiNote({ kind: "error", message: err.type === "monthly_quota" && err.message ? err.message : t("cmd.aiError") });
      }
    } finally {
      setBusy(false);
    }
  }

  async function addAll(intents: Parameters<typeof addIntents>[0]) {
    setBusy(true);
    try {
      const results: CommandLegResult[] = await addIntents(intents, data, { hasLeg, addLeg });
      const stamp = Date.now();
      setRows(results.map((r, i): Row => r.status === "added"
        ? { key: `${stamp}-${i}`, kind: "added", legId: r.leg.id, label: `${r.leg.selection} · ${r.leg.gameInfo ?? ""}`, removed: false }
        : { key: `${stamp}-${i}`, kind: r.status, label: r.label }));
      if (results.some((r) => r.status === "added")) setText("");
    } finally {
      setBusy(false);
    }
  }

  function undo(row: Extract<Row, { kind: "added" }>) {
    removeLeg(row.legId);
    setRows((rs) => rs.map((r) => (r.key === row.key ? { ...row, removed: true } : r)));
  }

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative bg-[#0A0E0C] rounded-3xl border border-white/20 max-h-[85vh] flex flex-col max-w-[430px] w-full mx-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("cmd.title")}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/20 rounded-t-3xl">
          <p className="text-white font-bold">{t("cmd.title")}</p>
          <button
            onClick={onClose}
            aria-label={t("cmd.close")}
            className="tap-44 w-8 h-8 rounded-full bg-[#1B2419] flex items-center justify-center text-[#bfc8cc]"
          ><X size={14} /></button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4 overflow-y-auto">
          {/* Champ — 16 px : iOS zoome sur tout champ plus petit. */}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); void submit(text); }}
          >
            <input
              className="flex-1 min-w-0 bg-[#131A12] border border-white/20 rounded-2xl px-3 py-2.5 text-white text-base outline-none placeholder:text-[#bfc8cc] disabled:opacity-60"
              placeholder={t("cmd.placeholder")}
              value={text}
              maxLength={SLIP_COMMAND_MAX_LENGTH}
              onChange={(e) => setText(e.target.value)}
              disabled={!ctx || noGames}
              autoFocus
              enterKeyHint="send"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              type="submit"
              disabled={!ready || !text.trim()}
              className="tap-44 flex-shrink-0 bg-[#86d1ea] text-[#0A0E0C] font-bold text-sm rounded-2xl px-4 py-2.5 disabled:bg-[#1B2419] disabled:text-[#bfc8cc]"
            >
              {busy ? t("cmd.working") : t("cmd.submit")}
            </button>
          </form>

          {/* État du calendrier */}
          {loading && <p className="text-[#bfc8cc] text-xs">{t("cmd.loading")}</p>}
          {error && <p className="text-amber-300 text-xs">{t("cmd.loadError")}</p>}
          {noGames && <p className="text-[#bfc8cc] text-xs">{t("cmd.noGames", { days: UPCOMING_DAYS })}</p>}

          {/* Quota IA (Pro ou clé perso) — une ligne discrète, qui informe sans rien conditionner. */}
          {aiQuota && (
            <p className="text-[#bfc8cc] text-[11px]">
              {aiQuota.kind === "pro" ? t("cmd.aiProUsed", { used: aiQuota.used, limit: aiQuota.limit }) : t("cmd.aiOwnKey")}
            </p>
          )}

          {/* Ce que l'IA a dit d'une phrase que l'analyseur local n'a pas comprise */}
          {aiNote && (
            <div className="bg-[#131A12] border border-amber-300/30 rounded-2xl px-3 py-2.5" role="status">
              <p className={`text-xs font-semibold ${aiNote.kind === "working" ? "text-[#86d1ea]" : "text-amber-300"}`}>
                {aiNote.kind === "working" ? t("cmd.aiWorking")
                  : aiNote.kind === "clarify" ? aiNote.text
                  : aiNote.kind === "unclear" ? t("cmd.aiUnclear")
                  : aiNote.kind === "free_quota" ? t("cmd.aiFreeQuota", { limit: aiNote.limit })
                  : aiNote.message}
              </p>
              {aiNote.kind === "free_quota" && features.proUpgrade && (
                /* `state.from` : /pro ne peut pas revenir par l'historique (voir ProLock). */
                <button
                  onClick={() => navigate("/pro", { state: { from: location.pathname + location.search } })}
                  className="tap-44 mt-2 px-3 py-1.5 rounded-full text-xs font-bold bg-[#86d1ea] text-[#0A0E0C] active:scale-95 transition-transform"
                >
                  {t("home.proHeadline")}
                </button>
              )}
            </div>
          )}

          {/* Échec de l'analyse, avec ses choix cliquables — remplacé par la note
              de l'IA dès que celle-ci a pris le relais. */}
          {failure && !aiNote && (
            <div className="bg-[#131A12] border border-amber-300/30 rounded-2xl px-3 py-2.5">
              <p className="text-amber-300 text-xs font-semibold">{failureText(failure, t)}</p>
              {failure.choices && failure.choices.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {failure.choices.map((c) => (
                    <button
                      key={c.text}
                      onClick={() => { setText(c.text); void submit(c.text); }}
                      disabled={!ready}
                      className="tap-44 px-3 py-1.5 rounded-full text-xs font-medium bg-[#86d1ea]/10 border border-[#86d1ea]/30 text-[#86d1ea] active:scale-95 transition-transform"
                    >
                      {choiceLabel(c, failure, t, teamName)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Ce que la dernière commande a fait */}
          {rows.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center gap-2 bg-[#131A12] border border-white/20 rounded-xl px-3 py-2">
                  {r.kind === "added" ? (
                    <>
                      <span className={`flex-1 min-w-0 text-xs ${r.removed ? "text-[#bfc8cc] line-through" : "text-white"}`}>
                        {!r.removed && <Check size={11} strokeWidth={3} className="inline mr-1 -mt-0.5 text-[#4ade80]" />}{r.label}
                      </span>
                      {r.removed ? (
                        <span className="text-[#bfc8cc] text-[11px]">{t("cmd.undone")}</span>
                      ) : (
                        <button onClick={() => undo(r)} className="tap-44 text-[#86d1ea] text-xs font-semibold flex-shrink-0">
                          {t("cmd.undo")}
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="flex-1 min-w-0 text-xs text-amber-300">
                      {t(r.kind === "duplicate" ? "cmd.duplicate" : r.kind === "unavailable" ? "cmd.unavailable" : "cmd.missing", { label: r.label })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {/* Exemples — tant que rien n'a été tenté, ou après une phrase incomprise */}
          {ctx && !noGames && (rows.length === 0 || failure?.reason === "unknown") && (
            <div>
              <p className="text-[#bfc8cc] text-[11px] uppercase tracking-wider mb-1.5">{t("cmd.examples")}</p>
              <div className="flex flex-wrap gap-1.5">
                {examples.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => setText(ex)}
                    className="tap-44 px-3 py-1.5 rounded-full text-xs bg-[#131A12] border border-white/20 text-[#bfc8cc] active:scale-95 transition-transform"
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Le bouton « Bet builder IA » et sa feuille. `pill` : à côté de
 * « + Ajouter » ; `block` : pleine largeur (Stats, coupon vide).
 */
/**
 * `chip` (2026-09-29) : même gabarit que « Comment ça marche » de la page
 * Prédiction, posé juste en dessous — même taille, même bordure accent.
 */
const LAUNCHER_CLS: Record<"pill" | "block" | "chip", string> = {
  pill:  "tap-44 flex items-center gap-1 text-[#90C9F0] text-xs bg-[#90C9F0]/10 border border-[#90C9F0]/25 rounded-full px-3 py-1.5 active:scale-95 transition-transform",
  block: "tap-44 w-full text-[#86d1ea] text-sm font-bold bg-[#86d1ea]/10 border border-[#86d1ea]/30 rounded-2xl px-4 py-3 active:scale-95 transition-transform",
  chip:  "tap-44 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-[#86d1ea] bg-[#86d1ea]/10 border border-[#86d1ea]/30 active:scale-95 transition-all",
};

export function SlipCommandLauncher({ variant }: { variant: "pill" | "block" | "chip" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className={LAUNCHER_CLS[variant]}>
        {variant === "chip" && <Sparkles size={13} />}
        {t("cmd.open")}
      </button>
      {open && <SlipCommandSheet onClose={() => setOpen(false)} />}
    </>
  );
}
