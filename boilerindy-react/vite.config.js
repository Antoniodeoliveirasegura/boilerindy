import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const apiTarget = env.VITE_API_PROXY || 'http://127.0.0.1:3000'

  return {
    plugins: [react(), tailwindcss()],
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
