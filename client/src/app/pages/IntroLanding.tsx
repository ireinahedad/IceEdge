/**
 * IntroLanding.tsx — la page d'accueil des visiteurs NON CONNECTÉS (2026-11-19,
 * maquette « ArakIce — Landing page » validée par le user).
 *
 *   1. ARAKICE au-dessus d'une patinoire de nuit où un entraîneur dessine une
 *      jouée (CoachRink), puis « Voir ArakIce » et « Se connecter ».
 *   2. Plus bas : trois cartes (ce que fait ArakIce), quatre chiffres,
 *      la calibration (« quand il dit 55 %, l'équipe gagne 54 % ») et le top 3
 *      des prédictions du prochain match (les plus proches de 100 % selon le modèle).
 *
 * « Voir ArakIce » appelle `onEnter` : HomeRoute (routes.tsx) affiche alors
 * l'accueil habituel (HockeyLanding, les matchs de ce soir) pour le reste de
 * la session. Un utilisateur connecté ne voit jamais cette page.
 *
 * Les chiffres de précision viennent de `data/accuracyRecord.ts` (copie de la
 * page publique). Le top 3 est calculé ici, sur les marchés et le paquet ML
 * du match — les mêmes données, gratuites, que la page du match.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { CoachRink } from "../components/landing-intro/CoachRink";
import { useI18n, type Lang } from "../i18n";
import { marketText } from "../i18n/serverText";
import { accuracyRecord, ACCURACY_PAGE } from "../data/accuracyRecord";
import { nhlApiService } from "../services/nhlApiService";
import { fetchGameMlBundle, type GameMlBundle } from "../services/mlApi";
import { homeWeek } from "../data/gameDay";
import type { NHLGame } from "../types/bet";
import "./intro-landing.css";

type TFn = (k: string, p?: Record<string, string | number>) => string;

export function IntroLanding({ onEnter }: { onEnter: () => void }) {
  const { t, lang, setLang } = useI18n();
  const navigate = useNavigate();
  const fmt = (n: number, digits = 1) =>
    n.toLocaleString(lang === "fr" ? "fr-CA" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const r = accuracyRecord;
  const head = r.bins.find((b) => b.range === r.headlineBin) ?? r.bins[2];

  return (
    <main className="il-page">
      <section className="il-hero">
        <div className="il-lang" role="group" aria-label={t("intro.langAria")}>
          {(["en", "fr"] as const).map((l) => (
            <button key={l} type="button" className="il-lang-btn" aria-pressed={lang === l} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <h1 className="il-wordmark">ARAKICE</h1>
        <div className="il-rink">
          <CoachRink />
        </div>
        <div className="il-ctas">
          <button type="button" className="il-cta" onClick={onEnter}>{t("intro.see")}</button>
          <button type="button" className="il-ghost" onClick={() => navigate("/login")}>{t("intro.login")}</button>
        </div>
        <a href="#how" className="il-scroll">
          {t("intro.how")}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </a>
      </section>

      <section id="how" className="il-how">
        <div className="il-grid il-grid-3">
          {(["1", "2", "3"] as const).map((n) => (
            <div key={n} className="il-card il-card-feat">
              <h2 className="il-feat-title">{t(`intro.f${n}.t`)}</h2>
              <p className="il-feat-body">{t(`intro.f${n}.b`)}</p>
            </div>
          ))}
        </div>

        <div className="il-grid il-grid-4">
          <Stat value={r.games.toLocaleString(lang === "fr" ? "fr-CA" : "en-US")} label={t("intro.st.games")} />
          <Stat value={`${fmt(r.winnerPct)}\u00a0%`} label={t("intro.st.winners")} />
          <Stat value={`${fmt(r.bins[r.bins.length - 1].wonPct)}\u00a0%`} label={t("intro.st.favs", { lo: 70, hi: 80 })} />
          <Stat value={t("intro.st.marketsValue")} label={t("intro.st.markets")} />
        </div>

        <div className="il-grid il-grid-2">
          <div className="il-card il-pad">
            <h3 className="il-card-title">{t("intro.trust.title", { said: Math.round(head.saidPct), won: Math.round(head.wonPct) })}</h3>
            <div className="il-bands">
              {r.bins.map((b) => {
                const hl = b.range === r.headlineBin;
                return (
                  <div key={b.range} className={`il-band${hl ? " il-band-hl" : ""}`}>
                    <span className="il-band-said">{t("intro.trust.said", { n: Math.round(b.saidPct) })}</span>
                    <div className="il-band-track" role="img" aria-label={t("intro.trust.rowAria", { said: fmt(b.saidPct), won: fmt(b.wonPct), games: b.games })}>
                      <div className="il-band-bar" style={{ width: `${b.wonPct}%` }} />
                      <div className="il-band-tick" style={{ left: `${b.saidPct}%` }} />
                    </div>
                    <span className="il-band-won">{t("intro.trust.won", { n: Math.round(b.wonPct) })}</span>
                  </div>
                );
              })}
            </div>
            <p className="il-note">{t("intro.trust.note", { games: r.games.toLocaleString(lang === "fr" ? "fr-CA" : "en-US") })}</p>
            <a className="il-link" href={ACCURACY_PAGE}>{t("intro.trust.more")}</a>
          </div>

          <TonightCard t={t} lang={lang} onEnter={onEnter} />
        </div>

        <p className="il-disclaimer">{t("intro.disclaimer")}</p>
      </section>
    </main>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="il-card il-stat">
      <div className="il-stat-value">{value}</div>
      <div className="il-stat-label">{label}</div>
    </div>
  );
}

/* ─── Ce soir, match par match ────────────────────────────────────────────── */

type Pick = { label: string; market: string; pct: number };
type Tonight = { game: NHLGame; homePct: number | null; picks: Pick[]; source: "ml" | "rules" };

type ApiOption = { id: string; label?: string; rulePct?: number };
type ApiGroup = { id: string; title?: string; options?: ApiOption[] };

/** Probabilité d'arakiceML pour une tuile (paquet ML du match), sinon `null`. */
function mlPct(o: ApiOption, bundle: GameMlBundle | null): number | null {
  const p = bundle?.byId[o.id]?.probability;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

/**
 * Le top 3 (demandes du user, 2026-11-19) : les paris du match entre 70 et
 * 90 % — assez sûrs pour impressionner, sans les évidences à 95 % (« moins de
 * 8,5 buts »). Classés du plus probable au moins probable, tous marchés du
 * match confondus.
 *
 * Source : arakiceML (paquet ML du match). Si le ML ne répond pas ou ne chiffre
 * aucune tuile, on prend les chiffres des RÈGLES (`rulePct`), et la carte le
 * dit (`source: "rules"`). Moins de trois paris dans la fourchette : on
 * complète avec les plus proches de la fourchette.
 *
 * Les libellés restent ceux du serveur (anglais) ; ils sont traduits au rendu
 * par `marketText`, comme sur la page du match.
 */
const TOP_MIN = 70, TOP_MAX = 90;
function topPicks(groups: ApiGroup[], bundle: GameMlBundle | null): { homePct: number | null; picks: Pick[]; source: "ml" | "rules" } {
  const collect = (src: "ml" | "rules") => {
    const out: Pick[] = [];
    for (const g of groups) {
      for (const o of g.options ?? []) {
        const pct = src === "ml" ? mlPct(o, bundle) : (typeof o.rulePct === "number" ? o.rulePct : null);
        if (pct == null || !o.label) continue;
        out.push({ label: o.label, market: g.title ?? "", pct });
      }
    }
    return out;
  };
  let source: "ml" | "rules" = "ml";
  let all = collect("ml");
  if (all.length === 0) { source = "rules"; all = collect("rules"); }

  const dist = (p: number) => (p < TOP_MIN ? TOP_MIN - p : p > TOP_MAX ? p - TOP_MAX : 0);
  const seen = new Set<string>();
  const picks = all
    .sort((x, y) => dist(x.pct) - dist(y.pct) || y.pct - x.pct)
    .filter((x) => (seen.has(x.label) ? false : (seen.add(x.label), true)))
    .slice(0, 3)
    .sort((x, y) => y.pct - x.pct);

  const ml = groups.find((x) => x.id === "moneyline")?.options?.find((o) => o.id === "mw-home");
  const homePct = ml ? ((source === "ml" ? mlPct(ml, bundle) : null) ?? (typeof ml.rulePct === "number" ? ml.rulePct : null)) : null;
  return { homePct, picks, source };
}

/** Prochain match à venir de la semaine (ce soir d'abord), comme l'accueil. */
async function loadTonight(): Promise<Tonight | null> {
  const days = homeWeek().filter((d) => d.offset >= 0);
  const range = await nhlApiService.getGamesRange(days[0].dateStr, days[days.length - 1].dateStr);
  const ms = (g: NHLGame) => (g.startTimeUTC ? new Date(g.startTimeUTC).getTime() : Number.MAX_SAFE_INTEGER);
  const next = range
    .filter((g) => (g.status as string) === "scheduled" || (g.status as string) === "preview")
    .sort((a, b) => ms(a) - ms(b))[0];
  if (!next) return null;
  const [groups, bundle] = await Promise.all([
    nhlApiService.getGamePredictions(String(next.id)) as Promise<ApiGroup[]>,
    fetchGameMlBundle(String(next.id)).catch(() => null),
  ]);
  return { game: next, ...topPicks(Array.isArray(groups) ? groups : [], bundle) };
}

function TonightCard({ t, lang, onEnter }: { t: TFn; lang: Lang; onEnter: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready" | "empty" | "error"; data?: Tonight }>({ status: "idle" });

  // Rien n'est demandé avant que la carte approche de l'écran : la plupart des
  // visiteurs cliquent « Voir ArakIce » sans descendre.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const start = () => {
      setState({ status: "loading" });
      loadTonight()
        .then((data) => { if (!cancelled) setState(data ? { status: "ready", data } : { status: "empty" }); })
        .catch(() => { if (!cancelled) setState({ status: "error" }); });
    };
    if (typeof IntersectionObserver === "undefined") { start(); return () => { cancelled = true; }; }
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { io.disconnect(); start(); } }, { rootMargin: "300px" });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, []);

  const d = state.data;
  const time = d?.game.startTimeUTC
    ? new Date(d.game.startTimeUTC).toLocaleString(lang === "fr" ? "fr-CA" : "en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })
    : "";

  return (
    <div ref={ref} className="il-card il-pad">
      <h3 className="il-card-title">{t("intro.tonight.title")}</h3>
      {state.status === "ready" && d ? (
        <>
          <p className="il-note">{d.game.awayTeam.name} @ {d.game.homeTeam.name}{time ? ` · ${time}` : ""}</p>
          {d.homePct != null && (
            <div className="il-teams">
              <TeamBar team={d.game.awayTeam.name} pct={100 - d.homePct} color="#2f6fd0" />
              <TeamBar team={d.game.homeTeam.name} pct={d.homePct} color="#86d1ea" />
            </div>
          )}
          <div className="il-top">
            <div className="il-top-head">{t("intro.tonight.top3")}</div>
            {d.source === "rules" && <p className="il-note">{t("intro.tonight.rules")}</p>}
            {d.picks.map((p, i) => (
              <div key={p.label} className="il-top-row">
                <span className="il-top-rank">{i + 1}</span>
                <div className="il-top-text"><span className="il-top-pick">{marketText(p.label, lang)}</span><span className="il-top-mkt">{marketText(p.market, lang)}</span></div>
                <span className="il-top-pct">{Math.round(p.pct)}{"\u00a0%"}</span>
              </div>
            ))}
          </div>
        </>
      ) : state.status === "empty" || state.status === "error" ? (
        <p className="il-note">{t(state.status === "empty" ? "intro.tonight.none" : "intro.tonight.error")}</p>
      ) : (
        <div className="il-skeleton" aria-busy="true" />
      )}
      <button type="button" className="il-link il-link-btn" onClick={onEnter}>{t("intro.tonight.cta")}</button>
    </div>
  );
}

function TeamBar({ team, pct, color }: { team: string; pct: number; color: string }) {
  return (
    <div className="il-team">
      <div className="il-team-row"><span>{team}</span><span className="il-team-pct">{Math.round(pct)}{"\u00a0%"}</span></div>
      <div className="il-team-track"><div className="il-team-bar" style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}
