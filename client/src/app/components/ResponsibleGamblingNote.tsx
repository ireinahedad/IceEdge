import type { CSSProperties } from "react";
import { useI18n } from "../i18n";
import { useGeo } from "../services/geo";
import { useBookmakerLinks } from "../services/sportsbookGate";

/**
 * APPLE_PLAN 2.5 — avertissement visible : informatif seulement, aucun pari,
 * aucun argent, avec les lignes d'aide joignables d'un toucher.
 * Québec : Jeu : aide et référence (aidejeu.ca). É.-U. : 1-800-GAMBLER (NCPG),
 * soit 1-800-426-2537. Partagé web + iOS.
 *
 * DRAFTKINGS_AFFILIATE_PLAN Phase 1 (2026-11-09) — a US visitor (Cloudflare,
 * `services/geo.ts`) gets the US version: 21+ (18+ in DC/KY/NH/WY), the
 * 1-800-GAMBLER line, and — where a DraftKings link can show — the state they
 * must be in and the affiliate disclosure. Everyone else: unchanged.
 */
export function ResponsibleGamblingNote({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const { t } = useI18n();
  const geo = useGeo();
  const linksOn = useBookmakerLinks();

  if (geo.country === "US") {
    const age = geo.minAge ?? 21;
    return (
      <p className={`text-[10px] leading-relaxed ${className}`} style={style}>
        {t("legal.disclaimerUs", { age })}{" "}
        {linksOn && geo.region && <>{t("legal.presentIn", { age, state: geo.region })}{" "}</>}
        <a href="tel:+18004262537" className="underline underline-offset-2">{t("legal.gamblingProblem")}</a>
        {linksOn && <>{" "}{t("legal.affiliate")}</>}
      </p>
    );
  }

  return (
    <p className={`text-[10px] leading-relaxed ${className}`} style={style}>
      {t("legal.disclaimer")}{" "}
      <a href="tel:+18004610140" className="underline underline-offset-2">{t("legal.helpQc")}</a>
      {" · "}
      <a href="tel:+18004262537" className="underline underline-offset-2">{t("legal.helpUs")}</a>
    </p>
  );
}

/**
 * The short line that sits under every « bet with DraftKings » button. Renders
 * nothing where no link can show, so call sites need no guard of their own.
 */
export function SportsbookDisclosure({ className = "" }: { className?: string }) {
  const { t } = useI18n();
  const geo = useGeo();
  const linksOn = useBookmakerLinks();
  if (!linksOn) return null;
  const age = geo.minAge ?? 21;
  return (
    <p className={`text-[10px] leading-snug text-white/45 ${className}`}>
      {geo.region ? t("legal.presentIn", { age, state: geo.region }) : null}{" "}
      <a href="tel:+18004262537" className="underline underline-offset-2">{t("legal.gamblingProblem")}</a>{" "}
      {t("legal.affiliate")}
    </p>
  );
}
