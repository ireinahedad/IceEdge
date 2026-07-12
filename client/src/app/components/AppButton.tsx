import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Shared CTA button — replaces the many one-off hand-styled buttons that had
 * drifted to different accent colors/radii across pages (cyan, green, purple,
 * light-blue all used inconsistently for similar actions).
 *
 * Fixed palette:
 *   primary   → cyan  #86d1ea  (main call to action: sign in, submit, lock slip)
 *   secondary → green #3bc47a  (positive/confirm: create, save, join)
 *   tertiary  → purple #a78bfa (auxiliary/ML-flavoured actions, badges-as-buttons)
 *   ghost     → transparent, outlined — cancel / low-emphasis actions
 */
type Variant = "primary" | "secondary" | "tertiary" | "ghost" | "destructive";

const VARIANT_STYLE: Record<Variant, { background?: string; color: string; border?: string }> = {
  primary:     { background: "#86d1ea", color: "#0A0E0C" },
  secondary:   { background: "#3bc47a", color: "#072E49" },
  tertiary:    { background: "#a78bfa", color: "#0A0E0C" },
  ghost:       { color: "#bfc8cc", border: "1px solid rgba(255,255,255,0.15)" },
  destructive: { color: "#f87171", border: "1px solid rgba(248,113,113,0.3)" },
};

export function AppButton({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  disabled,
  children,
  className = "",
  ...rest
}: {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  fullWidth?: boolean;
  loading?: boolean;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const style = VARIANT_STYLE[variant];
  const sizeCls = size === "sm" ? "text-xs px-3 py-1.5" : size === "lg" ? "text-sm px-6 py-3.5" : "text-sm px-4 py-2.5";

  return (
    <button
      disabled={disabled || loading}
      className={`rounded-xl font-bold transition-all active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 ${sizeCls} ${fullWidth ? "w-full" : ""} ${className}`}
      style={{ background: style.background ?? "transparent", color: style.color, border: style.border }}
      {...rest}
    >
      {loading ? "…" : children}
    </button>
  );
}
