import type { CSSProperties } from "react";
import { useI18n } from "../i18n";

/**
 * APPLE_PLAN 2.5 — avertissement visible : informatif seulement, aucun pari,
 * aucun argent, 18+, avec deux lignes d'aide joignables d'un toucher.
 * Québec : Jeu : aide et référence (aidejeu.ca). É.-U. : 1-800-GAMBLER (NCPG),
 * soit 1-800-426-2537. Partagé web + iOS.
 */
export function ResponsibleGamblingNote({ className = "", style }: { className?: string; style?: CSSProperties }) {
  const { t } = useI18n();
  return (
    <p className={`text-[10px] leading-relaxed ${className}`} style={style}>
      {t("legal.disclaimer")}{" "}
      <a href="tel:+18004610140" className="underline underline-offset-2">{t("legal.helpQc")}</a>
      {" · "}
      <a href="tel:+18004262537" className="underline underline-offset-2">{t("legal.helpUs")}</a>
    </p>
  );
}
