import { useState } from "react";
import { useI18n } from "../../../i18n";
import { REPORT_REASONS, type ReportReason, type ChatMessage } from "../../../types/user";

/**
 * ReportModal — PRE_IOS_PLAN.md R4.3b.
 *
 * Feuille du bas, comme ConfirmDialog : c'est le geste modal que l'app utilise
 * déjà partout. Un motif est OBLIGATOIRE — le serveur refuse en 400 sans lui,
 * et un signalement sans motif ne se traite pas de toute façon. La note est
 * facultative et tronquée à 500 caractères côté serveur ; on l'annonce ici
 * plutôt que de la laisser disparaître silencieusement.
 *
 * Le texte signalé est rappelé au-dessus : sur mobile la feuille couvre la
 * conversation, et sans rappel on signale de mémoire.
 */

const MAX_NOTE = 500;

export function ReportModal({
  message,
  submitting,
  onSubmit,
  onCancel,
}: {
  message: ChatMessage;
  submitting: boolean;
  onSubmit: (payload: { reason: ReportReason; note?: string }) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[430px] md:max-w-lg icy-card rounded-t-3xl p-6 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
        <p className="text-white font-bold text-base mb-1.5">{t("report.title")}</p>
        <p className="text-white/60 text-xs mb-4">{t("report.subtitle")}</p>

        {/* Rappel du message visé */}
        <div className="chat-tile rounded-xl px-3 py-2 mb-4">
          <p className="text-[#90C9F0] text-[9px] font-medium mb-0.5">@{message.username}</p>
          <p className="text-white/60 text-[10px] line-clamp-3">{message.text}</p>
        </div>

        <div className="flex flex-col gap-1.5 mb-4">
          {REPORT_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => setReason(r)}
              className={`flex items-center justify-between px-3 py-2.5 rounded-xl border text-left text-xs transition-all ${
                reason === r
                  ? "bg-[#90C9F0]/15 border-[#90C9F0]/50 text-[#90C9F0]"
                  : "border-white/10 text-white/70"
              }`}
            >
              <span>{t(`report.reason.${r}`)}</span>
              {reason === r && <span>✓</span>}
            </button>
          ))}
        </div>

        <label className="block text-white/60 text-[10px] mb-1.5">{t("report.noteLabel")}</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, MAX_NOTE))}
          placeholder={t("report.notePlaceholder")}
          rows={3}
          className="w-full chat-tile rounded-xl px-3 py-2 text-white text-xs outline-none placeholder-white/30 resize-none mb-1"
        />
        <p className="text-white/30 text-[9px] text-right mb-5">{note.length}/{MAX_NOTE}</p>

        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 py-3 rounded-2xl border border-white/10 text-white/70 text-sm"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => reason && onSubmit({ reason, note: note.trim() || undefined })}
            disabled={!reason || submitting}
            className={`flex-1 py-3 rounded-2xl text-sm font-bold transition-all ${
              reason && !submitting ? "bg-red-500 text-white" : "bg-white/10 text-white/30"
            }`}
          >
            {submitting ? t("report.sending") : t("report.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
