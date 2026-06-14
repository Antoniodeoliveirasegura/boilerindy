import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const apiTarget = env.VITE_API_PROXY || 'http://127.0.0.1:3000'
  // Sourcemap upload (issue #50) only runs where SENTRY_AUTH_TOKEN is set
  // (Vercel). Locally/CI the plugin is omitted and no maps are generated.
  const uploadSourceMaps = Boolean(env.SENTRY_AUTH_TOKEN)

  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(uploadSourceMaps
        ? [
            sentryVitePlugin({
              org: env.SENTRY_ORG,
              project: env.SENTRY_PROJECT,
              authToken: env.SENTRY_AUTH_TOKEN,
              telemetry: false,
            }),
          ]
        : []),
    ],
    build: {
      // "hidden" emits maps for Sentry without referencing them publicly.
      sourcemap: uploadSourceMaps ? 'hidden' : false,
      rollupOptions: {
        output: {
          // Split stable vendor libs into their own long-cached chunks so an app
          // code change doesn't force users to re-download React/Supabase/etc.
          // (Leaflet already isolates itself via the lazy /map route.)
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('leaflet')) return 'leaflet'
            if (id.includes('@sentry')) return 'sentry'
            if (id.includes('@supabase')) return 'supabase'
            if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react-vendor'
          },
        },
      },
    },
    server: {
      // Allow importing repo-root shared modules (e.g. dashboardLayout.mjs,
      // shared verbatim with the server). The local pnpm-workspace.yaml makes
      // Vite treat this folder as the workspace root, so the parent must be
      // allowed explicitly or the dev server 403s on those imports.
      fs: { allow: ['..'] },
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        // Only Purdue server routes — do not proxy /auth/callback (React + Supabase email/OAuth).
        '/auth/purdue': { target: apiTarget, changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './vitest.setup.js',
      css: false,
    },
  }
})
