import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    // 5 s (défaut) ne suffit pas sous la suite complète, en parallèle, sous
    // Windows (2026-09-27) : plusieurs tests importent leur module de routes à
    // FROID dans le corps du test (`await import('./ml.routes')`, qui tire le
    // modèle, l'API NHL…), et celui du writeLimiter enchaîne ~1 000 requêtes.
    // Ils échouaient en « timed out », pas sur une assertion. 20 s attrape
    // toujours un vrai blocage.
    testTimeout: 20_000,
  },
});
