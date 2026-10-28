import { defineConfig, type Plugin } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

// Preconnect vers l'API (index.html, PERF_PLAN P0.2). Vite remplace
// %VITE_SOCKET_URL% seulement si la variable existe. Sans elle (CI GitHub, qui
// n'a pas de .env), le littéral restait dans le HTML : un preconnect vers une
// URL relative bidon, et route-shells refusait le build. Variable absente →
// on retire ces deux indices, qui ne sont qu'une optimisation.
function apiPreconnect(): Plugin {
  let socketUrl: string | undefined
  return {
    name: 'api-preconnect',
    configResolved(config) {
      socketUrl = config.env.VITE_SOCKET_URL
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (socketUrl) return html
        return html.replace(/^[ \t]*<link rel="(?:preconnect|dns-prefetch)" href="%VITE_SOCKET_URL%"[^>]*>\r?\n/gm, '')
      },
    },
  }
}

export default defineConfig({
  plugins: [
    figmaAssetResolver(),
    apiPreconnect(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    fs: {
      // `BetContext.tsx` importe `server/src/services/parlay.ts` (module pur,
      // partagé avec la route). Il est hors de la racine client : sans cette
      // liste, `vite dev` refuse de le servir. Poser `allow` remplace la valeur
      // par défaut, d'où la racine client en premier.
      // Même règle pour l'analyseur de commandes du coupon (`slipCommand.ts`)
      // et la table de noms qu'il importe (`oddsTeamNames.ts`).
      allow: [
        __dirname,
        path.resolve(__dirname, '../server/src/services/parlay.ts'),
        path.resolve(__dirname, '../server/src/services/slipCommand.ts'),
        path.resolve(__dirname, '../server/src/services/oddsTeamNames.ts'),
        // Lignes des marchés plus/moins, partagées avec le serveur (marketLines.ts).
        path.resolve(__dirname, '../server/src/services/marketLines.ts'),
        // Lecture OCR d'un ticket → jambes (SCAN_TICKET_PLAN S2) ; ses imports de types sont effacés.
        path.resolve(__dirname, '../server/src/services/slipScan.ts'),
        path.resolve(__dirname, '../server/src/services/slipScanValue.ts'),
      ],
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  build: {
    rollupOptions: {
      output: {
        // M1 — split the heavy libraries into their own chunks so they aren't
        // in the main bundle. Combined with route-level React.lazy (see
        // app/routes.tsx), a chunk only downloads when a route that uses it is
        // visited — cutting first-paint payload on mobile.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // React d'abord, dans son propre chunk. Sans cette ligne, Rollup rangeait
          // react, react-dom et scheduler DANS `charts` (dépendances communes d'un
          // chunk manuel) : l'entrée importait alors React depuis `charts`, et
          // chaque page — landing comprise — préchargeait recharts + d3 (~154 ko
          // gzip, ~100 ko inutilisés selon Lighthouse). M1 ne servait à rien.
          // QA P4 du 2026-09-26.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
          if (id.includes('recharts') || id.includes('/d3-')) return 'charts';
          if (id.includes('/motion/') || id.includes('framer-motion')) return 'motion';
          if (id.includes('/ogl') || id.includes('/three')) return 'gfx';
        },
      },
    },
  },
})
