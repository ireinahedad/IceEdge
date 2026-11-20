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
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { CoachRink } from "../components/landing-intro/CoachRink";
import { useI18n, type Lang } from "../i18n";
import { accuracyRecord, ACCURACY_PAGE } from "../data/accuracyRecord";
import "./intro-landing.css";

type TFn = (k: string, p?: Record<string, string | number>) => string;

/**
 * Défilement « aimanté » (demande du user, 2026-11-19) : depuis la patinoire,
 * le moindre geste vers le bas (molette, glissé du doigt) emmène directement
 * à la section « Comment ça marche » ; depuis le haut de cette section, un
 * geste vers le haut ramène à la patinoire. Plus bas dans la section, le
 * défilement redevient normal. Le clavier (flèches, Page suivante) reste natif.
 */
function useSnapToHow(pageRef: React.RefObject<HTMLElement | null>, howRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const page = pageRef.current, how = howRef.current;
    if (!page || !how) return;
    let lockUntil = 0;
    let touchY: number | null = null;
    const go = (top: number) => {
      lockUntil = Date.now() + 800;
      page.scrollTo({ top, behavior: "smooth" });
    };
    // Renvoie true si le geste a été pris en charge.
    const handle = (dy: number): boolean => {
      const y = page.scrollTop, howTop = how.offsetTop;
      if (Date.now() < lockUntil) return true;
      if (dy > 0 && y < howTop - 4) { go(howTop); return true; }
      if (dy < 0 && y > 0 && y <= howTop + 4) { go(0); return true; }
      return false;
    };
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 2) return;
      if (handle(e.deltaY)) e.preventDefault();
    };
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? null; };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY == null) return;
      const dy = touchY - (e.touches[0]?.clientY ?? touchY);
      if (Math.abs(dy) < 12) return;
      if (handle(dy)) { e.preventDefault(); touchY = null; }
    };
    page.addEventListener("wheel", onWheel, { passive: false });
    page.addEventListener("touchstart", onTouchStart, { passive: true });
    page.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      page.removeEventListener("wheel", onWheel);
      page.removeEventListener("touchstart", onTouchStart);
      page.removeEventListener("touchmove", onTouchMove);
    };
  }, [pageRef, howRef]);
}

export function IntroLanding({ onEnter }: { onEnter: () => void }) {
  const { t, lang, setLang } = useI18n();
  const pageRef = useRef<HTMLElement>(null);
  const howRef = useRef<HTMLElement>(null);
  useSnapToHow(pageRef, howRef);
  const navigate = useNavigate();
  const fmt = (n: number, digits = 1) =>
    n.toLocaleString(lang === "fr" ? "fr-CA" : "en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const r = accuracyRecord;
  const head = r.bins.find((b) => b.range === r.headlineBin) ?? r.bins[2];

  return (
    <main className="il-page" ref={pageRef}>
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

      <section id="how" className="il-how" ref={howRef}>
        <div className="il-grid il-grid-3">
          {(["1", "2", "3"] as const).map((n) => (
            <div key={n} className="il-card il-card-feat">
              <h2 className="il-feat-title">{t(`intro.f${n}.t`)}</h2>
              <p className="il-feat-body">{t(`intro.f${n}.b`)}</p>
            </div>
          ))}
        </div>

        <div className="il-grid il-grid-4">
          <Stat value={r.closingLineGames.toLocaleString(lang === "fr" ? "fr-CA" : "en-US")} label={t("intro.st.closing")} />
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

          <TonightCard t={t} onEnter={onEnter} />
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

/**
 * 2026-11-20 (demande du user) : le contenu d'ArakIce exige un compte, API
 * comprise. Cette carte montrait le top 3 des prédictions du prochain match ;
 * pour un visiteur, l'API répond maintenant 401. Elle ne charge donc plus rien
 * et invite à se connecter.
 */
function TonightCard({ t, onEnter }: { t: TFn; onEnter: () => void }) {
  return (
    <div className="il-card il-pad">
      <h3 className="il-card-title">{t("intro.tonight.title")}</h3>
      <p className="il-note">{t("intro.tonight.locked")}</p>
      <button type="button" className="il-link il-link-btn" onClick={onEnter}>{t("intro.tonight.cta")}</button>
    </div>
  );
}
