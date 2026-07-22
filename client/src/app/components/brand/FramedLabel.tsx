import "./FramedLabel.css";

/**
 * FramedLabel — renders a short label (e.g. "ML", "Rules") inside an animated
 * ice-blue frame with a glowing dot travelling around the border.
 */
export function FramedLabel({ text, className = "" }: { text: string; className?: string }) {
  return (
    <span className={`framed-label ${className}`.trim()}>
      <span className="framed-label__text">{text}</span>
    </span>
  );
}
