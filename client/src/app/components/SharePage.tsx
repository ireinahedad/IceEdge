import { useParams, useNavigate } from "react-router";
import { BottomNav } from "./BottomNav";

export function SharePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col min-h-screen pb-24" style={{ background: "#0A0E0C" }}>
      <div className="sticky top-0 z-40 px-4 pt-12 pb-3"
        style={{ background: "rgba(10,14,12,0.92)", backdropFilter: "blur(16px)", borderBottom: "1px solid #283323" }}>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-[#3a5060] text-lg">←</button>
          <h1 className="text-white text-base font-bold flex-1">Shared Slip</h1>
        </div>
      </div>

      <div className="flex flex-col items-center justify-center flex-1 px-6 text-center">
        <p className="text-4xl mb-4">🔗</p>
        <p className="text-white font-bold text-lg mb-2">Shared Prediction</p>
        <p className="text-[#92A08A] text-sm mb-2">Slip ID: {id}</p>
        <p className="text-[#4a6068] text-xs">Shared slips coming soon.</p>
        <button
          onClick={() => navigate("/")}
          className="mt-6 px-6 py-2.5 rounded-xl text-sm font-bold"
          style={{ background: "#86d1ea", color: "#0A0E0C" }}
        >
          Go to Home
        </button>
      </div>

      <BottomNav />
    </div>
  );
}
