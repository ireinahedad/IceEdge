/**
 * OcrLabPage — banc d'essai de l'OCR sur l'appareil (SCAN_TICKET_PLAN § 7, S1).
 * Route : /dev/ocr   (admin uniquement)
 *
 * Sert à mesurer Apple Vision là où il tourne vraiment : dans l'app iOS. On
 * choisit une ou plusieurs captures, l'écran montre ce que l'OCR a lu (lignes,
 * boîtes, confiance, temps) et « Partager le JSON » envoie les lectures (format
 * `OcrResult`, un objet `{ nom: lecture }`) pour les ranger dans
 * `server/src/services/__fixtures__/slipScan/ocr/vision/`. Sur le web, même
 * écran avec Tesseract.
 *
 * Rien ne part sur le réseau : l'image reste sur l'appareil, et le JSON ne sort
 * que si l'admin le partage lui-même.
 *
 * ⚠️ Build iOS : présent SEULEMENT si VITE_OCR_LAB=true (case « ocr_lab » du
 * workflow « iOS → TestFlight »), pour un build de test. Un tel build ne doit
 * PAS être soumis à l'App Store (écran caché = Guideline 2.3.1). Liaison
 * conditionnelle dans routes.tsx, comme les autres écrans /dev.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { isIOS } from "../platform";
import { recognize, OcrError, type OcrResult } from "../services/ocr/ocrService";

interface LabItem {
  name: string;
  url: string;
  result?: OcrResult;
  error?: string;
}

/** `IMG_1234.PNG` → `img-1234` : un nom de fixture propre, à renommer ensuite. */
const fixtureName = (file: string) =>
  file.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "capture";

export function OcrLabPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [items, setItems] = useState<LabItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(0);
  const [shareMsg, setShareMsg] = useState("");

  useEffect(() => {
    if (!loading && user && user.role !== "admin") navigate("/", { replace: true });
  }, [loading, user, navigate]);

  // Aperçus (object URLs) : libérés à la sélection suivante et en quittant l'écran.
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    urls.current.forEach((u) => URL.revokeObjectURL(u));
    const list: LabItem[] = Array.from(files).map((f) => ({ name: fixtureName(f.name), url: URL.createObjectURL(f) }));
    urls.current = list.map((i) => i.url);
    setItems(list);
    setOpen(0);
    setShareMsg("");
    setBusy(true);
    const blobs = Array.from(files);
    // Une à une : Tesseract n'a qu'un worker, Vision sature aussi le CPU.
    for (let i = 0; i < blobs.length; i++) {
      try {
        const result = await recognize(blobs[i]);
        setItems((prev) => prev.map((it, k) => (k === i ? { ...it, result } : it)));
      } catch (err) {
        const msg = err instanceof OcrError ? err.code : String(err);
        setItems((prev) => prev.map((it, k) => (k === i ? { ...it, error: msg } : it)));
      }
    }
    setBusy(false);
  }

  async function share() {
    const done = items.filter((i) => i.result);
    if (!done.length) return;
    const payload: Record<string, OcrResult> = {};
    for (const i of done) payload[i.name] = i.result!;
    const engine = done[0].result!.engine;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const filename = `ocr-${engine}-${stamp}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    try {
      if (isIOS) {
        const { shareFileNative } = await import("../services/nativeShare");
        await shareFileNative(blob, filename, "Lectures OCR");
      } else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
      setShareMsg(`${done.length} lecture(s) — ${filename}`);
    } catch (err) {
      setShareMsg(`Échec du partage : ${String(err)}`);
    }
  }

  const done = items.filter((i) => i.result);
  const avgMs = done.length ? Math.round(done.reduce((a, i) => a + i.result!.ms, 0) / done.length) : 0;

  return (
    <div
      className="flex flex-col min-h-screen text-white max-w-[430px] mx-auto px-4 pt-14 pb-16"
      style={{ background: "#0A0E0C" }}
    >
      <div className="flex items-center gap-3 mb-1">
        <button onClick={() => navigate(-1)} className="tap-44 text-[#bfc8cc] text-lg">←</button>
        <h1 className="text-white text-base font-bold flex-1">Labo OCR</h1>
        <span className="text-[#86d1ea] text-[10px] font-bold uppercase tracking-wider">
          {isIOS ? "Apple Vision" : "Tesseract"}
        </span>
      </div>
      <p className="text-white/40 text-[10px] mb-5">
        Admin. Lecture 100 % sur l'appareil — rien n'est envoyé. Partage le JSON pour les fixtures.
      </p>

      <label className="icy-card rounded-2xl p-4 flex items-center justify-center text-xs font-bold cursor-pointer active:scale-[0.99] transition-transform">
        {busy ? "Lecture en cours…" : "Choisir des captures"}
        <input
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          disabled={busy}
          onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }}
        />
      </label>

      {done.length > 0 && (
        <div className="flex items-center gap-3 mt-4">
          <p className="flex-1 text-white/60 text-[11px]">
            {done.length}/{items.length} lue(s) · {avgMs} ms en moyenne
          </p>
          <button
            onClick={() => void share()}
            disabled={busy}
            className="px-4 py-2 rounded-xl font-bold text-xs disabled:opacity-40"
            style={{ background: "#86d1ea", color: "#072E49" }}
          >
            Partager le JSON
          </button>
        </div>
      )}
      {shareMsg && <p className="text-white/50 text-[10px] mt-2 break-all">{shareMsg}</p>}

      <div className="flex flex-col gap-3 mt-4">
        {items.map((it, idx) => (
          <div key={it.url} className="icy-card rounded-2xl overflow-hidden">
            <button
              onClick={() => setOpen(open === idx ? null : idx)}
              className="w-full flex items-center gap-2 p-3 text-left"
            >
              <span className="flex-1 min-w-0 text-xs font-medium truncate">{it.name}</span>
              <span className="text-[10px] text-white/50">
                {it.error ? `erreur : ${it.error}` : it.result ? `${it.result.lines.length} lignes · ${it.result.ms} ms` : "…"}
              </span>
            </button>
            {open === idx && it.result && <LabResult url={it.url} result={it.result} />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** La capture avec les boîtes lues par-dessus, puis la liste des lignes. */
function LabResult({ url, result }: { url: string; result: OcrResult }) {
  const [hover, setHover] = useState<number | null>(null);
  const { width, height, lines } = result;
  return (
    <div className="px-3 pb-3">
      <div className="relative w-full" style={{ aspectRatio: `${width} / ${height}` }}>
        <img src={url} alt="" className="absolute inset-0 w-full h-full" />
        <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 w-full h-full" aria-hidden>
          {lines.map((l, i) => (
            <rect
              key={i}
              x={l.box.x}
              y={l.box.y}
              width={l.box.w}
              height={l.box.h}
              fill={hover === i ? "rgba(134,209,234,0.35)" : "none"}
              stroke={l.confidence < 0.6 ? "#f87171" : "#86d1ea"}
              strokeWidth={Math.max(2, width / 400)}
            />
          ))}
        </svg>
      </div>
      <ol className="mt-3 flex flex-col gap-1">
        {lines.map((l, i) => (
          <li
            key={i}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onClick={() => setHover(hover === i ? null : i)}
            className="flex gap-2 text-[11px] leading-snug"
          >
            <span className={`w-8 shrink-0 text-right tabular-nums ${l.confidence < 0.6 ? "text-red-400" : "text-white/40"}`}>
              {Math.round(l.confidence * 100)}
            </span>
            <span className="flex-1 min-w-0 break-words font-mono">{l.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
