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
  // One retry, not two, and a flaky pass is a failed run. Two retries plus a
  // silent "1 flaky" is how the sign-in bounce (issue #298) rode through CI for
  // weeks: the test failed on attempt 1, passed on attempt 3, and the job went
  // green. One retry still absorbs genuine runner flake (a cold preview server,
  // a dropped port) without hiding a real defect. Checked before turning this
  // on: across the last 14 green CI runs the only test that ever passed on
  // retry was auth.spec.js:49, which is that bug and is now fixed.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  // Two workers on a 4 vCPU GitHub runner: the suite is fullyParallel and the
  // backend is mocked per context, so nothing is shared between tests. One
  // worker made the e2e job the longest in CI and set the pace of every merge.
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    // Every browser context runs on campus time (issue #225). Specs that seed
    // instants and assert a weekday or a due date used to depend on the
    // runner's timezone (UTC on CI, whatever the laptop has locally); one
    // ended up pinned to Asia/Seoul as a regression case (tasks.spec.js) and
    // keeps its own override.
    timezoneId: 'America/Indiana/Indianapolis',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // When E2E_BASE_URL is supplied (e.g. an already-running preview), skip the
  // managed server entirely.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // No `--` before the vite flags: pnpm passes it through to vite, which
        // then ignores --port and --strictPort and serves on its default 4173.
        command:
          'pnpm -C boilerindy-react run build && pnpm -C boilerindy-react run preview --port ' +
          PORT +
          ' --strictPort',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
})
