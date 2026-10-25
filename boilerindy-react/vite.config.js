import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { PAGE_PREVIEWS, pagePreviewHtml } from './src/lib/pagePreviews.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const apiTarget = env.VITE_API_PROXY || 'http://127.0.0.1:3000'
  // Sourcemap upload (issue #50) only runs where SENTRY_AUTH_TOKEN is set
  // (Vercel). Locally/CI the plugin is omitted and no maps are generated.
  const uploadSourceMaps = Boolean(env.SENTRY_AUTH_TOKEN)

  // Minted per build: the query cache persister's buster (issue #251), so
  // every deploy discards the previous build's persisted rows, and the service
  // worker's own id (below).
  const buildId = Date.now().toString(36)

  return {
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [
      react(),
      tailwindcss(),
      // A browser installs a new service worker only when sw.js changes byte
      // for byte, and public/ is copied as is, so a release that did not edit
      // sw.js never produced a waiting worker and the refresh prompt never
      // showed (R68). Stamp this build's id into the copied file. It throws if
      // the line is gone, so the stamp cannot silently stop happening.
      {
        name: 'stamp-service-worker',
        apply: 'build',
        writeBundle(options) {
          const file = join(options.dir, 'sw.js')
          const source = readFileSync(file, 'utf8')
          const stamped = source.replace("const BUILD_ID = 'dev'", `const BUILD_ID = '${buildId}'`)
          if (stamped === source) throw new Error("dist/sw.js has no const BUILD_ID = 'dev' line to stamp")
          writeFileSync(file, stamped)
        },
      },
      // Link previews (docs/share-links.md): a chat app unfurls a link from
      // the HTML it fetches, without running the app, so each shared page gets
      // a copy of the built index.html with its own title, description and
      // image (dist/transit.html, dist/dining.html, dist/free-food.html), which
      // vercel.json rewrites the page's path to. pagePreviewHtml throws when a
      // tag it rewrites is gone from index.html, so the copies cannot quietly
      // fall back to the home card.
      {
        name: 'page-previews',
        apply: 'build',
        writeBundle(options) {
          const indexHtml = readFileSync(join(options.dir, 'index.html'), 'utf8')
          for (const page of Object.values(PAGE_PREVIEWS)) {
            writeFileSync(join(options.dir, page.file), pagePreviewHtml(indexHtml, page))
          }
        },
      },
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
          // Opaque, hash-only filenames. Readable names like "GradeTracker"
          // ("track"), "AdminAdvertisers" ("advert") or "analytics" match
          // ad-blocker filter lists, which block the request (ERR_BLOCKED_BY_CLIENT)
          // and blank the page for the ~many students who run ad blockers.
          entryFileNames: 'assets/[hash].js',
          chunkFileNames: 'assets/[hash].js',
          assetFileNames: 'assets/[hash][extname]',
          // Split stable vendor libs into their own long-cached chunks so an app
          // code change doesn't force users to re-download React/Supabase/etc.
          // (Leaflet already isolates itself via the lazy /map route.)
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('leaflet')) return 'leaflet'
            if (id.includes('@sentry')) return 'sentry'
            if (id.includes('@supabase')) return 'supabase'
            if (id.includes('@tanstack')) return 'query'
            // react-markdown pulls in the whole remark/unified tree; keep it out
            // of the main bundle since only AI surfaces need it.
            if (/[\\/](react-markdown|remark-.*|micromark.*|mdast-.*|unist-.*|hast-.*|unified|vfile.*|devlop|decode-named-character-reference|character-entities.*|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|trim-lines|zwitch|longest-streak|ccount|markdown-table|escape-string-regexp|bail|is-plain-obj|trough|extend|estree-.*)[\\/]/.test(id)) return 'markdown'
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
        // Only Purdue server routes - do not proxy /auth/callback (React + Supabase email/OAuth).
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
