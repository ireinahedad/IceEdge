import { useI18n } from "../i18n";

/**
 * App-styled confirmation modal — replaces window.confirm() so destructive
 * actions (cancel subscription, log out everywhere, etc.) match the rest of
 * the app's dark bottom-sheet aesthetic instead of the native browser dialog.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[430px] md:max-w-lg icy-card rounded-t-3xl p-6 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
        <p className="text-white font-bold text-base mb-1.5">{title}</p>
        {description && <p className="text-white/60 text-xs mb-5">{description}</p>}
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-2xl border border-white/10 text-white/70 text-sm"
          >
            {cancelLabel ?? t("common.cancel")}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-3 rounded-2xl text-sm font-bold transition-all ${
              destructive ? "bg-red-500 text-white" : "bg-[#22ff00] text-[#072E49]"
            }`}
          >
            {confirmLabel ?? t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
