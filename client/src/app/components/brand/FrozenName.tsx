/**
 * FrozenName — a username encased in a melting ice cube.
 *
 * The freeze level is driven by the user's XP (performance score):
 *   0 XP    → fully frozen (cube, frost fringe, icy text)
 *   1500 XP → fully thawed (plain white text, permanent puddle)
 *
 * The cube melts with a top→bottom transparency gradient, and its outline
 * is irregular — shape, tilt, shine and cracks are seeded from the name,
 * so every user's ice block looks slightly different but stays stable.
 */

import { useMemo } from "react";
import type { CSSProperties } from "react";

const MAX_XP = 1500;

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function FrozenName({
  name,
  score,
  size = 14,
  className = "",
}: {
  name: string;
  score: number | null | undefined;
  size?: number;
  className?: string;
}) {
  const f = Math.max(0, Math.min(1, 1 - (score ?? 0) / MAX_XP));
  const seed = useMemo(() => hashCode(name || "iceedge"), [name]);

  // Deterministic pseudo-random in [min, max] from the name seed
  const rnd = (i: number, min: number, max: number) =>
    min + (((seed >> ((i * 5) % 28)) & 127) / 127) * (max - min);

  // Irregular outline: 8-value border radius + slight tilt, unique per name
  const borderRadius = `${rnd(0, 6, 16).toFixed(0)}px ${rnd(1, 5, 14).toFixed(0)}px ${rnd(2, 7, 18).toFixed(0)}px ${rnd(3, 5, 13).toFixed(0)}px / ${rnd(4, 5, 14).toFixed(0)}px ${rnd(5, 7, 16).toFixed(0)}px ${rnd(6, 5, 12).toFixed(0)}px ${rnd(7, 6, 15).toFixed(0)}px`;
  const tilt = rnd(8, -1.4, 1.4).toFixed(2);

  const padV = Math.round(size * 0.4);
  const padH = Math.round(size * 0.7);

  // Top→bottom melt: transparent above the melt line, visible below
  const maskStart = Math.round((1 - f) * 95);
  const maskEnd = Math.min(100, maskStart + 25);
  const mask = `linear-gradient(180deg, rgba(0,0,0,0) ${Math.max(0, maskStart - 20)}%, rgba(0,0,0,0.25) ${maskStart}%, rgba(0,0,0,1) ${maskEnd}%)`;

  // Frost fringe: many short rounded drips under the name
  const drips = useMemo(() => {
    const n = Math.max(10, Math.round((name?.length ?? 6) * 1.5));
    return Array.from({ length: n }, (_, i) => ({
      w: 3 + (i % 2),
      h: 3 + ((i * 3 + (seed % 5)) % 5),
    }));
  }, [name, seed]);

  // Puddle grows while melting and REMAINS once fully thawed
  const puddleOpacity = Math.max(0.5 * (1 - f), Math.min(1, 4.5 * f * (1 - f)));

  const textStyle: CSSProperties =
    f <= 0.02
      ? { color: "#ffffff" }
      : {
          background: `linear-gradient(180deg,#f2fbff 0%,#cdeeff ${Math.round(20 + 20 * f)}%,#7cc7f0 ${Math.round(55 + 10 * f)}%,#dff4ff 100%)`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          textShadow: `0 0 ${(4 + 10 * f).toFixed(0)}px rgba(160,220,255,${(0.25 + 0.45 * f).toFixed(2)})`,
          letterSpacing: `${(0.01 + 0.05 * f).toFixed(3)}em`,
        };

  return (
    <span
      className={className}
      style={{ position: "relative", display: "inline-block", padding: `${padV}px ${padH}px` }}
    >
      {f > 0.02 && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius,
            transform: `rotate(${tilt}deg)`,
            overflow: "hidden",
            pointerEvents: "none",
            background:
              "linear-gradient(160deg, rgba(215,242,255,0.38), rgba(140,200,240,0.25) 45%, rgba(230,250,255,0.42))",
            border: "1px solid rgba(210,240,255,0.55)",
            boxShadow:
              "inset 0 0 14px rgba(255,255,255,0.35), inset 0 -6px 12px rgba(120,190,235,0.3)",
            WebkitMaskImage: mask,
            maskImage: mask,
            opacity: 0.35 + 0.65 * f,
          }}
        >
          <span style={{ position: "absolute", top: "-30%", left: `${rnd(9, 5, 22).toFixed(0)}%`, width: "18%", height: "160%", background: "rgba(255,255,255,0.35)", transform: "rotate(18deg)", borderRadius: 6 }} />
          <span style={{ position: "absolute", top: `${rnd(12, 22, 38).toFixed(0)}%`, left: "38%", width: "34%", height: 1, background: "rgba(255,255,255,0.55)", transform: `rotate(${rnd(10, -30, -16).toFixed(0)}deg)` }} />
          <span style={{ position: "absolute", top: `${rnd(13, 46, 60).toFixed(0)}%`, left: "52%", width: "22%", height: 1, background: "rgba(255,255,255,0.4)", transform: `rotate(${rnd(11, 10, 22).toFixed(0)}deg)` }} />
        </span>
      )}

      {f > 0.05 && (
        <span
          aria-hidden
          style={{ position: "absolute", left: "4%", right: "4%", top: "100%", marginTop: -1, display: "flex", justifyContent: "space-between", pointerEvents: "none" }}
        >
          {drips.map((d, i) => (
            <span
              key={i}
              style={{
                width: d.w,
                height: d.h,
                borderRadius: "0 0 50% 50%",
                background: "linear-gradient(180deg, rgba(210,242,255,0.8), rgba(255,255,255,0.15))",
                transform: `scaleY(${f.toFixed(2)})`,
                transformOrigin: "top",
                opacity: 0.4 + 0.6 * f,
              }}
            />
          ))}
        </span>
      )}

      <span
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          top: "100%",
          marginTop: Math.max(6, Math.round(size * 0.4)),
          transform: "translateX(-50%)",
          height: Math.max(6, Math.round(size * 0.35)),
          width: `${Math.round(55 + (1 - f) * 55)}%`,
          borderRadius: "50%",
          background:
            "radial-gradient(ellipse at center, rgba(170,225,255,0.85), rgba(150,215,255,0.25) 60%, rgba(150,215,255,0) 80%)",
          boxShadow: "0 0 10px rgba(150,215,255,0.5)",
          opacity: puddleOpacity,
          pointerEvents: "none",
        }}
      />

      <span style={{ position: "relative", zIndex: 1, fontWeight: 700, fontSize: size, ...textStyle }}>
        {name}
      </span>
    </span>
  );
}
