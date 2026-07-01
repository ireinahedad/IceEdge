/**
 * IceedgeLogo — inline SVG brand mark.
 * Blue diagonal stripes + bold italic "E" wordmark.
 */

interface IceedgeLogoProps {
  size?: number;
  wordmark?: boolean;
  className?: string;
}

export function IceedgeLogo({ size = 40, wordmark = true, className = "" }: IceedgeLogoProps) {
  const s = size;
  return (
    <div className={`flex items-center gap-2.5 ${className}`} style={{ lineHeight: 1 }}>
      {/* Mark */}
      <svg width={s} height={s} viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="40" height="40" rx="10" fill="#0A1628" />
        {/* Blue diagonal stripes */}
        <clipPath id="mark-clip">
          <rect width="40" height="40" rx="10" />
        </clipPath>
        <g clipPath="url(#mark-clip)">
          <rect x="-4" y="26" width="48" height="5" rx="2.5" fill="#1A8AFF" opacity="0.25" transform="rotate(-35 20 20)" />
          <rect x="-4" y="18" width="48" height="5" rx="2.5" fill="#1A8AFF" opacity="0.45" transform="rotate(-35 20 20)" />
          <rect x="-4" y="10" width="48" height="5" rx="2.5" fill="#1A8AFF" opacity="0.7"  transform="rotate(-35 20 20)" />
          <rect x="-4" y="2"  width="48" height="5" rx="2.5" fill="#1A8AFF"                transform="rotate(-35 20 20)" />
        </g>
        {/* Bold italic E */}
        <text
          x="20" y="27"
          textAnchor="middle"
          fontSize="22"
          fontWeight="900"
          fontStyle="italic"
          fontFamily="Arial Black, Arial, sans-serif"
          fill="white"
          letterSpacing="-1"
        >E</text>
      </svg>

      {/* Wordmark */}
      {wordmark && (
        <span
          style={{
            fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
            fontWeight: 700,
            fontSize: s * 0.4,
            letterSpacing: "0.12em",
            color: "white",
            textTransform: "uppercase",
          }}
        >
          ICEEDGE
        </span>
      )}
    </div>
  );
}
