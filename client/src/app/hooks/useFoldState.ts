/**
 * useFoldState — l'état plié / déplié d'une section, gardé en mémoire
 * (2026-10-11, demande du user) : quand on revient sur la page d'accueil,
 * chaque section se retrouve comme on l'a laissée.
 *
 * `localStorage` (pas `sessionStorage`) : le choix survit à la fermeture de
 * l'onglet et de l'app. Une clé par section, sous un préfixe commun.
 *
 * `defaultCollapsed` ne joue qu'à la toute première visite, tant que
 * l'utilisateur n'a jamais touché la section. Stockage indisponible (onglet
 * privé verrouillé) : on retombe sur la valeur par défaut, sans mémoire.
 */
import { useCallback, useState } from "react";

const PREFIX = "iceedge_fold:";

function read(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v === "1" ? true : v === "0" ? false : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, collapsed: boolean) {
  try { localStorage.setItem(PREFIX + key, collapsed ? "1" : "0"); } catch { /* stockage indisponible */ }
}

/** Renvoie `[collapsed, toggle]`. */
export function useFoldState(key: string, defaultCollapsed: boolean): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => read(key, defaultCollapsed));
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      write(key, next);
      return next;
    });
  }, [key]);
  return [collapsed, toggle];
}
