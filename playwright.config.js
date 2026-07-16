import { defineConfig, devices } from '@playwright/test'

// E2E runs against the built frontend served by `vite preview`. The backend is
// mocked at the network layer (see e2e/fixtures/mock-backend.js), so the suite
// is deterministic and needs no Supabase credentials or running Express server
// - which is what lets it run in CI without secrets.

const PORT = Number(process.env.E2E_PORT || 4173)
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // When E2E_BASE_URL is supplied (e.g. an already-running preview), skip the
  // managed server entirely.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command:
          'npm --prefix boilerindy-react run build && npm --prefix boilerindy-react run preview -- --port ' +
          PORT +
          ' --strictPort',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
})
