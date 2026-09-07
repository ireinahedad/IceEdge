// pages/league/PlayerSearchBar.tsx
//
// La recherche de joueur de la page League, remontée sous les onglets pour
// qu'elle serve aux DEUX onglets. Elle vivait dans le caisson du tableau
// indicateur : on ne pouvait donc chercher quelqu'un qu'après être passé sur
// Classement, alors que le besoin naît surtout depuis le chat.
//
// ── Un seul propriétaire de la requête ──────────────────────────────────────
// `usePlayerSearch()` est le SEUL endroit qui appelle /users/search. La barre
// l'affiche, le classement en reçoit le résultat en props. Deux effets de
// recherche concurrents (un dans la barre, un dans le tableau) taperaient le
// serveur deux fois pour la même frappe et pourraient diverger.
//
// ⚠️ `/users/search` exige un JWT : pour un visiteur non connecté, la requête
// partirait en 401 silencieux et la barre resterait vide sans explication.
// D'où le passage par AuthGate à la première frappe.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { profileApiService } from "../../services/userService";
import { useAuthGate } from "../../context/AuthGateContext";
import { useI18n } from "../../i18n";
import { FrozenName } from "../../components/brand/FrozenName";
import type { LeaderboardEntry } from "../../types/user";

/** Longueur minimale — le serveur rend [] en dessous, autant ne pas l'appeler. */
const MIN_QUERY = 2;
/** Anti-rebond : une frappe rapide ne doit produire qu'un appel. */
const DEBOUNCE_MS = 350;

export interface PlayerSearch {
  query: string;
  setQuery: (q: string) => void;
  results: LeaderboardEntry[];
  loading: boolean;
}

/** L'état de recherche, tenu par la page pour être partagé barre ↔ classement. */
export function usePlayerSearch(): PlayerSearch {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    setResults([]);
    if (q.length < MIN_QUERY) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      profileApiService.searchUsers(q)
        .then(setResults)
        // Volontairement muet : un 401 (invité) ou un réseau coupé ne doit pas
        // faire surgir une alerte pendant qu'on tape. La liste reste vide.
        .catch(() => {})
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return { query, setQuery, results, loading };
}

export function PlayerSearchBar({
  search,
  showResults,
}: {
  search: PlayerSearch;
  /** Sur l'onglet Classement, le tableau affiche DÉJÀ les résultats fusionnés
   *  à son propre contenu : une liste déroulante par-dessus ferait doublon. */
  showResults: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { requireAuth } = useAuthGate();
  const { query, setQuery, results, loading } = search;
  const [focused, setFocused] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Refermer la liste au clic ailleurs. `mousedown` et pas `click` : sinon le
  // clic sur un résultat démonte la liste avant que son onClick ne parte.
  useEffect(() => {
    if (!focused) return;
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setFocused(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [focused]);

  function handleChange(value: string) {
    // Le portillon s'ouvre à la première frappe, pas au focus : toucher un
    // champ de recherche ne devrait pas déclencher une modale de connexion.
    if (value.length > 0 && !requireAuth("gate.searchPlayers")) return;
    setQuery(value);
  }

  const trimmed = query.trim();
  const open = showResults && focused && trimmed.length >= MIN_QUERY;

  return (
    <div ref={boxRef} className="relative">
      <div className="chat-tile rounded-2xl flex items-center gap-2 px-3 py-2.5">
        <span className="text-white/40 text-sm">🔎</span>
        <input
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => setFocused(true)}
          placeholder={t("league.searchPlayer")}
          aria-label={t("league.searchPlayer")}
          className="flex-1 bg-transparent text-white text-xs outline-none placeholder-white/30"
        />
        {loading && (
          <span className="w-3 h-3 rounded-full border border-[#90C9F0]/40 border-t-[#90C9F0] animate-spin flex-shrink-0" />
        )}
        {query && !loading && (
          <button onClick={() => setQuery("")} className="tap-44 text-white/50 text-xs" aria-label={t("common.close")}>✕</button>
        )}
      </div>

      {open && (
        /* Liste flottante : la page ne doit pas se réorganiser sous les doigts
           à chaque lettre. z-30 la met sous l'en-tête collant (z-40). */
        <div className="absolute left-0 right-0 top-full mt-2 z-30 rounded-2xl overflow-hidden border border-[#86d1ea]/20 bg-[#0A0E0C]/95 backdrop-blur-md shadow-xl shadow-black/50 max-h-[45vh] overflow-y-auto">
          {results.length === 0 ? (
            <p className="text-white/40 text-[11px] px-4 py-3 text-center">
              {loading ? t("common.loading") : t("league.noPlayerFound")}
            </p>
          ) : (
            results.map((entry) => (
              <button
                key={entry.userId}
                onClick={() => {
                  setFocused(false);
                  // La page joueur exige un compte, et le mur Pro pour les
                  // coupons d'autrui est appliqué par le serveur (402).
                  navigate(`/player/${entry.userId}`);
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-white/5 last:border-b-0 active:bg-white/5"
              >
                {entry.avatarUrl ? (
                  <img src={entry.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover border border-[#86d1ea]/25 flex-shrink-0" />
                ) : (
                  <span className="w-8 h-8 rounded-full bg-white/8 border border-[#86d1ea]/25 flex items-center justify-center text-sm flex-shrink-0">
                    {entry.avatar || "👤"}
                  </span>
                )}
                <span className="flex-1 min-w-0">
                  <span className="block truncate">
                    <FrozenName name={entry.displayName} score={entry.performanceScore} size={11} />
                  </span>
                  <span className="block text-white/35 text-[11px] truncate">@{entry.username}</span>
                </span>
                <span className="scoreboard-digit text-sm leading-none flex-shrink-0">{entry.performanceScore}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
