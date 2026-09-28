/**
 * SlipCommandSheet.tsx — « Construire un pari avec l'IA » (SLIP_COMMANDE_PLAN.md, étape 3).
 *
 * Le joueur tape « Canadien gagne ce soir » ; l'analyseur LOCAL
 * (`server/src/services/slipCommand.ts`, sans réseau, gratuit) en tire des
 * intentions, `buildLeg` les chiffre avec le modèle et elles entrent au
 * coupon. Aucun appel au LLM à cette étape (il viendra en renfort, étape 4).
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

import { useState } from "react";
import {
  parseSlipCommand, SLIP_COMMAND_MAX_LENGTH,
  type SlipChoice, type SlipFailure,
} from "../../../../server/src/services/slipCommand";
import { useBet } from "../context/BetContext";
import { useI18n } from "../i18n";
import { useSlipCommandData } from "../hooks/useSlipCommandData";
import { addIntents, type CommandLegResult } from "../services/slipCommandLegs";
import { UPCOMING_DAYS } from "../pages/prediction/predictionShared";

type T = ReturnType<typeof useI18n>["t"];

/** « new york » → « New York » : l'analyseur rend les noms normalisés. */
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Le message d'un échec de l'analyseur, et le libellé de ses choix. */
function failureText(f: SlipFailure, t: T): string {
  const d = f.detail;
  switch (d?.kind) {
    case "team":         return t("cmd.whichTeam", { alias: titleCase(d.alias) });
    case "player":       return t("cmd.whichPlayer", { alias: titleCase(d.alias) });
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

type Row =
  | { key: string; kind: "added"; legId: string; label: string; removed: boolean }
  | { key: string; kind: "duplicate" | "unavailable" | "missing"; label: string };

export function SlipCommandSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { addLeg, removeLeg, hasLeg } = useBet();
  const { ctx, data, loading, error } = useSlipCommandData();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SlipFailure | null>(null);
  const [rows, setRows] = useState<Row[]>([]);

  const noGames = !!ctx && ctx.games.length === 0;
  const ready = !!ctx && !noGames && !busy;
  const examples = [t("cmd.ex1"), t("cmd.ex2"), t("cmd.ex3")];
  const teamName = (abbr: string) => data.getTeamById(abbr.toLowerCase())?.name ?? abbr;

  async function submit(command: string) {
    if (!ctx || busy || !command.trim()) return;
    const parsed = parseSlipCommand(command, ctx);
    if (!parsed.ok) { setFailure(parsed); return; }
    setFailure(null);
    setBusy(true);
    try {
      const results: CommandLegResult[] = await addIntents(parsed.intents, data, { hasLeg, addLeg });
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
          >✕</button>
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

          {/* Échec de l'analyse, avec ses choix cliquables */}
          {failure && (
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
                        {r.removed ? "" : "✓ "}{r.label}
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
 * Le bouton « Construire un pari avec l'IA » et sa feuille. `pill` : à côté de
 * « + Ajouter » ; `block` : pleine largeur (Stats, coupon vide).
 */
export function SlipCommandLauncher({ variant }: { variant: "pill" | "block" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={variant === "pill"
          ? "tap-44 flex items-center gap-1 text-[#90C9F0] text-xs bg-[#90C9F0]/10 border border-[#90C9F0]/25 rounded-full px-3 py-1.5 active:scale-95 transition-transform"
          : "tap-44 w-full text-[#86d1ea] text-sm font-bold bg-[#86d1ea]/10 border border-[#86d1ea]/30 rounded-2xl px-4 py-3 active:scale-95 transition-transform"}
      >
        {t("cmd.open")}
      </button>
      {open && <SlipCommandSheet onClose={() => setOpen(false)} />}
    </>
  );
}
