/** Doublure : compte les refresh et laisse le test décider du résultat. */
export const __refresh = { calls: 0, result: true };

export function refreshSession(): Promise<boolean> {
  __refresh.calls++;
  (window as any).__refresh = __refresh;
  return Promise.resolve(__refresh.result);
}
