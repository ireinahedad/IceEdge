/**
 * IceedgeLogo — inline SVG brand mark.
 * 4 diagonal speed-stripes (blue→cyan gradient, full opacity) + bold E.
 * Transparent background.
 */

interface IceedgeLogoProps {
  size?: number;
  wordmark?: boolean;
  className?: string;
}

export function IceedgeLogo({ size = 40, wordmark = true, className = "" }: IceedgeLogoProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`} style={{ lineHeight: 1 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="ie-sg" x1="8" y1="0" x2="58" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stopColor="#0A2BAA" />
            <stop offset="50%"  stopColor="#1A8AFF" />
            <stop offset="100%" stopColor="#30E0FF" />
          </linearGradient>
        </defs>

        {/* 4 parallelogram stripes — same height as E (y=27→85) */}
        <polygon points="19,18 22,18 11,76 8,76"  fill="url(#ie-sg)" />
        <polygon points="26,18 31,18 20,76 15,76" fill="url(#ie-sg)" />
        <polygon points="34,18 41,18 30,76 23,76" fill="url(#ie-sg)" />
        <polygon points="44,18 54,18 43,76 33,76" fill="url(#ie-sg)" />

        {/* Bold E — right-anchored, skewX for italic lean */}
        <text
          x="103"
          y="76"
          textAnchor="end"
          fontSize="70"
          fontWeight="900"
          fontFamily="Impact, 'Arial Black', Arial, sans-serif"
          fill="white"
          transform="skewX(-12)"
        >E</text>
      </svg>

      {wordmark && (
        <span
          style={{
            fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
            fontWeight: 700,
            fontSize: size * 0.4,
            letterSpacing: "0.12em",
            color: "white",
            textTransform: "uppercase" as const,
          }}
        >
          ICEEDGE
        </span>
      )}
    </div>
  );
}
