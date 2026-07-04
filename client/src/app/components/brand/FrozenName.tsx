/**
 * FrozenName — a user's display name.
 *
 * The ice treatment (cube, puddle, frosty gradient) has been removed; the
 * name now renders as plain bold text and inherits the surrounding theme
 * colour (black inside the frosted "ink-black" cards, white elsewhere).
 * The `score` prop is kept for API compatibility with existing call sites.
 */

export function FrozenName({
  name,
  size = 14,
  className = "",
}: {
  name: string;
  score?: number | null | undefined;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`text-white ${className}`}
      style={{ fontWeight: 700, fontSize: size }}
    >
      {name}
    </span>
  );
}
