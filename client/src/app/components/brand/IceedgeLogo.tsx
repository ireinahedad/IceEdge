/**
 * IceedgeLogo — inline SVG brand mark for ArakIce.
 * 3 diagonal speed-stripes (blue→cyan) + bold italic "A"
 * with a blue→white gradient. Transparent background.
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
          {/* Stripes: deep blue → cyan, along the diagonal */}
          <linearGradient id="ai-stripes" x1="6" y1="82" x2="46" y2="18" gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stopColor="#1E4BFF" />
            <stop offset="100%" stopColor="#30E0FF" />
          </linearGradient>
          {/* Letter: blue (left) → white (right), matching the brand mark */}
          <linearGradient id="ai-letter" x1="40" y1="0" x2="99" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stopColor="#1A8AFF" />
            <stop offset="55%"  stopColor="#8FCBFF" />
            <stop offset="100%" stopColor="#FFFFFF" />
          </linearGradient>
        </defs>

        {/* 3 parallelogram speed-stripes, parallel to the A's left leg */}
        <polygon points="18,20 24,20 12,80 6,80"  fill="url(#ai-stripes)" />
        <polygon points="27,20 33,20 21,80 15,80" fill="url(#ai-stripes)" />
        <polygon points="36,20 43,20 31,80 24,80" fill="url(#ai-stripes)" />

        {/* Bold italic A — right-anchored, skewX for the forward lean */}
        <text
          x="100"
          y="80"
          textAnchor="end"
          fontSize="80"
          fontWeight="900"
          fontFamily="Impact, 'Arial Black', Arial, sans-serif"
          fill="url(#ai-letter)"
          transform="skewX(-10)"
        >A</text>
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
          ARAKICE
        </span>
      )}
    </div>
  );
}
