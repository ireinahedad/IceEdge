/**
 * TeamCarousel.tsx — bandeau des 32 équipes, en haut de la glace.
 *
 * Ajouté le 2026-08-21. Six tuiles visibles à la fois, défilement continu
 * droite → gauche, mis en pause au survol (ou quand une tuile est ouverte au
 * toucher). Chaque tuile montre le maillot de l'équipe sur un fond aux couleurs
 * du club ; au survol (desktop) ou au clic (mobile), le maillot se floute et
 * laisse apparaître deux destinations : Stats (Charts) ou Prédiction.
 *
 * Les visuels de maillots vivent dans `client/public/jerseys/<ABBR>.png` et ne
 * viennent PAS de l'API NHL. Tant qu'un fichier manque, `onError` bascule sur le
 * logo officiel : la page reste correcte sans aucun asset.
 *
 * `--jersey-w` / `--jersey-duration` sont mesurés ici plutôt qu'en CSS : la piste
 * est en `max-content`, donc un pourcentage CSS s'y résoudrait circulairement.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { nhlApiService } from "../../services/nhlApiService";
import { jerseyUrl, teamColors } from "../../data/teamEmoji";
import { useI18n } from "../../i18n";
import type { NHLTeamInfo } from "../../types/bet";

/** Tuiles visibles simultanément (demandé : 6). */
const VISIBLE = 6;
/** Largeur plancher : en dessous, les deux boutons du survol deviennent intapables. */
const MIN_TILE = 84;
/** Vitesse de défilement, en pixels par seconde. */
const SPEED_PX_S = 34;

function TeamTile({
  team,
  isOpen,
  onToggle,
}: {
  team: NHLTeamInfo;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [fallback, setFallback] = useState(false);

  const abbr = (team.abbreviation ?? "").toUpperCase();
  const slug = abbr.toLowerCase();
  const { primary, secondary } = teamColors(abbr);

  return (
    <div
      className={`jersey-tile${isOpen ? " is-open" : ""}`}
      style={{ background: `linear-gradient(160deg, ${primary}, ${secondary})` }}
      role="group"
      aria-label={team.name ?? abbr}
      onClick={onToggle}
    >
      {fallback ? (
        /* Pas de logo NHL en repli : l'abréviation, en gros, sur les couleurs du club. */
        <span className="jersey-fallback">{abbr}</span>
      ) : (
        <img
          src={jerseyUrl(abbr)}
          alt={team.name ?? abbr}
          loading="lazy"
          draggable={false}
          className="jersey-img"
          onError={() => setFallback(true)}
        />
      )}

      {!fallback && <span className="jersey-abbr">{abbr}</span>}

      <div className="jersey-overlay">
        <button
          type="button"
          className="jersey-choice"
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/stats/chart/team/${slug}`);
          }}
        >
          {t("home.teamStats")}
        </button>
        <button
          type="button"
          className="jersey-choice"
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/stats/prediction/team/${slug}`);
          }}
        >
          {t("home.teamPrediction")}
        </button>
      </div>
    </div>
  );
}

export function TeamCarousel() {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [teams, setTeams] = useState<NHLTeamInfo[]>([]);
  const [tileW, setTileW] = useState(MIN_TILE);
  const [openAbbr, setOpenAbbr] = useState<string | null>(null);

  // Liste des équipes — même source que le reste de l'app.
  useEffect(() => {
    let alive = true;
    nhlApiService
      .getAllTeams()
      .then((list) => {
        if (alive) setTeams(list.filter((x) => !!x.abbreviation));
      })
      .catch((err) => {
        console.warn("[TeamCarousel] getAllTeams failed:", err);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Largeur d'une tuile = (largeur visible − 5 espaces) / 6, avec un plancher.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const gap = parseFloat(getComputedStyle(el).getPropertyValue("--marquee-gap")) || 8;
    const measure = () => {
      const w = el.clientWidth;
      if (!w) return;
      setTileW(Math.max(MIN_TILE, Math.round((w - (VISIBLE - 1) * gap) / VISIBLE)));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Une boucle = la moitié de la piste. Durée = distance / vitesse, pour que la
  // vitesse perçue reste constante quelle que soit la taille des tuiles.
  const duration = useMemo(() => {
    if (!teams.length) return 60;
    return Math.round((teams.length * (tileW + 8)) / SPEED_PX_S);
  }, [teams.length, tileW]);

  // Refermer le choix quand on touche ailleurs (mobile : pas de "mouse leave").
  useEffect(() => {
    if (!openAbbr) return;
    const close = (e: Event) => {
      if (!viewportRef.current?.contains(e.target as Node)) setOpenAbbr(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [openAbbr]);

  if (!teams.length) {
    return <div className="h-[124px] rounded-2xl icy-tile animate-pulse" aria-hidden />;
  }

  // La liste est rendue deux fois : le défilement boucle sans coupure visible.
  const loop = [...teams, ...teams];

  return (
    <section aria-label={t("home.allTeams")}>
      <h2 className="text-white text-sm font-bold uppercase tracking-wider mb-2">
        {t("home.allTeams")}
      </h2>
      <div
        ref={viewportRef}
        className="jersey-viewport"
        data-paused={openAbbr ? "true" : "false"}
        style={
          {
            "--jersey-w": `${tileW}px`,
            "--jersey-duration": `${duration}s`,
          } as React.CSSProperties
        }
      >
        <div className="jersey-track">
          {loop.map((team, i) => {
            const abbr = (team.abbreviation ?? "").toUpperCase();
            return (
              <TeamTile
                key={`${abbr}-${i}`}
                team={team}
                isOpen={openAbbr === `${abbr}-${i}`}
                onToggle={() =>
                  setOpenAbbr((cur) => (cur === `${abbr}-${i}` ? null : `${abbr}-${i}`))
                }
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
