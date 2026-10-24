/**
 * TeamCarousel.tsx — bandeau des 32 équipes, en haut de la glace.
 *
 * Ajouté le 2026-08-21 (marquee CSS continu, tuiles 3:4, sans navigation
 * manuelle). Refait le 2026-09-27 à la demande de l'utilisatrice :
 *
 *   • tuiles CARRÉES et plus petites (72 px, 88 px sur grand écran — taille
 *     posée en CSS par `--jersey-w` sur `.jersey-carousel`) ;
 *   • FLÈCHES gauche / droite pour naviguer, et le glissement au doigt marche
 *     aussi : le bandeau est maintenant un vrai conteneur défilant
 *     (`overflow-x: auto`, barre masquée) et non plus une piste animée ;
 *   • le défilement automatique droite → gauche est conservé, piloté en JS
 *     (`requestAnimationFrame` sur `scrollLeft`). Il se met en pause au survol,
 *     quand une tuile est ouverte, et quelques secondes après chaque geste
 *     (flèche, doigt, molette), puis reprend là où la personne l'a laissé.
 *
 * La liste est rendue deux fois : quand la position dépasse la première copie,
 * on recule d'une copie (`half`) — le contenu est identique, le saut invisible.
 *
 * Chaque tuile montre le LOGO du club (`nhlLogoUrl`, CDN de la LNH, le même
 * que partout dans l'app) sur ses couleurs. Les maillots (`/jerseys/<ABBR>.png`)
 * ont été retirés le 2026-10-24 (demande de l'utilisatrice) : les fichiers
 * n'existaient pas, et chaque tuile téléchargeait `index.html` à leur place
 * (~600 ko par visite de l'accueil, PERF_PLAN.md P2.6). Un logo qui ne charge
 * pas bascule encore sur l'abréviation (`onError`).
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { nhlApiService } from "../../services/nhlApiService";
import { nhlLogoUrl, teamColors } from "../../data/teamEmoji";
import { useI18n } from "../../i18n";
import type { NHLTeamInfo } from "../../types/bet";

/** Vitesse du défilement automatique, en pixels par seconde. */
const SPEED_PX_S = 28;
/** Pause du défilement automatique après un geste de la personne. */
const RESUME_AFTER_MS = 5000;
/** Démarrage différé du défilement automatique (chargement de l'accueil). */
const START_DELAY_MS = 4000;

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
        /* Logo introuvable : l'abréviation, en gros, sur les couleurs du club. */
        <span className="jersey-fallback">{abbr}</span>
      ) : (
        <img
          src={nhlLogoUrl(abbr)}
          alt={team.name ?? abbr}
          loading="lazy"
          draggable={false}
          className="jersey-img jersey-img--logo"
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
  const [openAbbr, setOpenAbbr] = useState<string | null>(null);

  // État du défilement automatique, lu par la boucle d'animation sans la
  // relancer : des refs, pas des états.
  const hovering = useRef(false);
  const pausedUntil = useRef(0);
  const openRef = useRef<string | null>(null);
  openRef.current = openAbbr;
  /** Position flottante : `scrollLeft` s'arrondit, 0,5 px par image s'y perdrait. */
  const pos = useRef(0);
  /** Fin de l'animation d'une flèche : le recalage de `onScroll` l'interromprait. */
  const animUntil = useRef(0);

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

  const pause = () => {
    pausedUntil.current = performance.now() + RESUME_AFTER_MS;
  };

  // Défilement automatique droite → gauche.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !teams.length) return;
    const reduced = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    // Mesures mises en cache. La boucle lisait `scrollLeft`, `scrollWidth` et
    // `clientWidth` à CHAQUE image : quand React venait de modifier le DOM (une
    // réponse `/predict/.../bundle` qui remplit les cartes de match), cette
    // lecture forçait une mise en page synchrone du document entier — 749 ms,
    // 701 nœuds, en 4G lente / CPU ×4 (trace DevTools du 2026-10-06). Les tailles
    // ne bougent qu'au redimensionnement : un ResizeObserver suffit.
    let half = el.scrollWidth / 2;
    let viewW = el.clientWidth;
    const ro = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => { half = el.scrollWidth / 2; viewW = el.clientWidth; })
      : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);

    // Pas de défilement pendant le chargement de l'accueil : c'est là que les
    // données arrivent et que chaque image de la boucle coûtait le plus cher.
    pausedUntil.current = Math.max(pausedUntil.current, performance.now() + START_DELAY_MS);

    let raf = 0;
    let last = performance.now();
    pos.current = el.scrollLeft;
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      // Aucune lecture de mise en page ici. Un défilement de la personne
      // (flèche, doigt) est repris dans `onScroll`, qui recale `pos`.
      const idle = !hovering.current && !openRef.current && now >= pausedUntil.current;
      if (idle && half > viewW) {
        pos.current += (SPEED_PX_S * dt) / 1000;
        if (pos.current >= half) pos.current -= half;
        el.scrollLeft = pos.current;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [teams.length]);

  // Boucle aussi pour le défilement MANUEL : au-delà de la première copie, on
  // recule d'une copie.
  const onScroll = () => {
    const el = viewportRef.current;
    if (!el || performance.now() < animUntil.current) return;
    // La personne a bougé le bandeau : la boucle repart de là (ce recalage
    // était lu à chaque image dans la boucle, voir plus haut).
    if (Math.abs(el.scrollLeft - pos.current) > 2) pos.current = el.scrollLeft;
    const half = el.scrollWidth / 2;
    if (half > 0 && el.scrollLeft >= half) {
      el.scrollLeft -= half;
      pos.current = el.scrollLeft;
    }
  };

  /** Une « page » = autant de tuiles entières que le bandeau en montre. */
  const step = (el: HTMLDivElement) => {
    const tile = el.querySelector<HTMLElement>(".jersey-tile");
    const track = el.firstElementChild as HTMLElement | null;
    const gap = (track && parseFloat(getComputedStyle(track).columnGap)) || 8;
    const unit = (tile?.offsetWidth ?? 72) + gap;
    return Math.max(1, Math.floor(el.clientWidth / unit)) * unit;
  };

  const go = (dir: -1 | 1) => {
    const el = viewportRef.current;
    if (!el) return;
    pause();
    const half = el.scrollWidth / 2;
    const s = step(el);
    // Recaler AVANT l'animation, pour ne jamais buter sur un bord.
    if (dir < 0 && el.scrollLeft - s < 0) el.scrollLeft += half;
    if (dir > 0 && el.scrollLeft + s >= half) el.scrollLeft -= half;
    pos.current = el.scrollLeft;
    animUntil.current = performance.now() + 800;
    el.scrollBy({ left: dir * s, behavior: "smooth" });
  };

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
    return <div className="h-[100px] rounded-2xl icy-tile animate-pulse" aria-hidden />;
  }

  const loop = [...teams, ...teams];

  return (
    <section aria-label={t("home.allTeams")}>
      <h2 className="text-white text-sm font-bold uppercase tracking-wider mb-2">
        {t("home.allTeams")}
      </h2>
      <div
        className="jersey-carousel"
        onMouseEnter={() => { hovering.current = true; }}
        onMouseLeave={() => { hovering.current = false; }}
      >
        <div
          ref={viewportRef}
          className="jersey-viewport"
          onScroll={onScroll}
          onPointerDown={pause}
          onTouchStart={pause}
          onWheel={pause}
        >
          <div className="jersey-track">
            {loop.map((team, i) => {
              const abbr = (team.abbreviation ?? "").toUpperCase();
              const key = `${abbr}-${i}`;
              return (
                <TeamTile
                  key={key}
                  team={team}
                  isOpen={openAbbr === key}
                  onToggle={() => setOpenAbbr((cur) => (cur === key ? null : key))}
                />
              );
            })}
          </div>
        </div>

        {/* Flèches : 44 px de zone tactile, 28 px de rond visible. */}
        <button
          type="button"
          className="jersey-arrow jersey-arrow--prev"
          aria-label={t("home.teamsPrev")}
          onClick={() => go(-1)}
        >
          <span className="jersey-arrow-dot"><ChevronLeft size={16} /></span>
        </button>
        <button
          type="button"
          className="jersey-arrow jersey-arrow--next"
          aria-label={t("home.teamsNext")}
          onClick={() => go(1)}
        >
          <span className="jersey-arrow-dot"><ChevronRight size={16} /></span>
        </button>
      </div>
    </section>
  );
}
