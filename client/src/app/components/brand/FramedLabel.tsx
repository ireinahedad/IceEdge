import "./FramedLabel.css";

/**
 * FramedLabel — renders a short label (e.g. "ML", "Rules") inside an animated
 * ice-blue frame with a glowing dot travelling around the border.
 *
 * When `onClick` is provided it renders as an interactive <button> (keeping the
 * exact same visual styling), so the frame can double as a compact action chip.
 */
export function FramedLabel({
  text,
  className = "",
  onClick,
  ariaLabel,
}: {
  text: string;
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const inner = <span className="framed-label__text">{text}</span>;

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel ?? text}
        className={`framed-label framed-label--button ${className}`.trim()}
      >
        {inner}
      </button>
    );
  }

  return <span className={`framed-label ${className}`.trim()}>{inner}</span>;
}
