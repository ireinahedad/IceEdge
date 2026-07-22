/**
 * IceedgeLogo — ArakIce brand mark.
 * Renders the raster logo asset (/arakice-logo.png) directly.
 */

interface IceedgeLogoProps {
  size?: number;
  wordmark?: boolean;
  className?: string;
}

export function IceedgeLogo({ size = 40, wordmark = true, className = "" }: IceedgeLogoProps) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`} style={{ lineHeight: 1 }}>
      <img
        src="/arakice-logo.png"
        alt="ArakIce"
        width={size}
        height={size}
        style={{ width: size, height: size, objectFit: "contain", display: "block" }}
      />

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
